// Content script in Coursera Labs notebooks (*.labs.coursera.org, the "Launch Lab" / programming assignment
// workspace): the model writes the code of the task cells, NSolver runs the whole notebook, gives the errors back to
// the model to fix (up to two rounds), saves and presses "Submit Assignment". The notebook itself is reached through
// labs-main.js (page world). The quiz autopilot of content.js hands a programming assignment over through
// chrome.storage.local ("nakiLab").
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    const alive = () => !!(chrome.runtime && chrome.runtime.id);
    if (window.__nakiLabsAlive && window.__nakiLabsAlive()) return;
    window.__nakiLabsAlive = alive;

    const MAIN_CHANNEL = 'naki-labs-main';
    const LAB_KEY = 'nakiLab';               // { runId, itemId, state: pending|working|submitted|failed, note, at }
    const RUN_TIMEOUT_MS = 15 * 60 * 1000;   // restart & run all (training cells can take minutes)
    const FIX_ROUNDS = 2;
    const NOTEBOOK_CHARS = 150000;

    const state = { settings: Naki.withDefaults({}), busy: false };
    const tr = (key, vars) => Naki.t(state.settings.lang, key, vars);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    let requestId = 0;
    function askMain(request, timeoutMs, options = {}, onBeat = null) {
        return new Promise(resolve => {
            const id = `${Date.now()}-${++requestId}`;
            let timer = setTimeout(() => done(null), timeoutMs);
            function done(result) {
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolve(result);
            }
            function onMessage(event) {
                const data = event.data;
                if (event.source !== window || data?.channel !== MAIN_CHANNEL) return;
                if (data.beat === id && onBeat) onBeat();
                if (data.reply === id) done(data.result);
            }
            window.addEventListener('message', onMessage);
            window.postMessage({ channel: MAIN_CHANNEL, request, id, options }, window.location.origin);
        });
    }

    // ------------------------------------------------------------------ toast

    const toast = (() => {
        let host = null, box = null, timer = null;
        return (message, type = 'info', duration = 0) => {
            if (!host) {
                host = document.createElement('div');
                host.id = 'naki-labs';
                const root = host.attachShadow({ mode: 'open' });
                root.innerHTML = `<style>
                    .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 420px; padding: 10px 14px; border-radius: 10px;
                        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4f4f5; background: #18181b; box-shadow: 0 8px 24px rgba(0,0,0,.35);
                        border-left: 4px solid #8b5cf6; white-space: pre-wrap; }
                    .box.success { border-left-color: #22c55e; } .box.error { border-left-color: #ef4444; } .box[hidden] { display: none; }
                    b { color: #c4b5fd; }</style><div class="box" hidden></div>`;
                box = root.querySelector('.box');
                document.documentElement.appendChild(host);
            }
            box.className = `box ${type}`;
            box.innerHTML = `<b>NSolver</b> · `;
            box.append(document.createTextNode(message));
            box.hidden = false;
            clearTimeout(timer);
            if (duration > 0) timer = setTimeout(() => { box.hidden = true; }, duration);
        };
    })();

    // ------------------------------------------------------------------ the model

    // Code cells the student has to write: solution markers, "write your code" notes, placeholders, graded functions.
    const TASK = /YOUR CODE (STARTS )?HERE|START CODE HERE|START SOLUTION|BEGIN SOLUTION|write your code|your code here|raise NotImplementedError|# ?TODO\b|GRADED FUNCTION|=\s*None\s*#/i;

    function notebookText(cells, targets) {
        let out = '';
        for (const cell of cells) {
            const mark = targets.includes(cell.index) ? ' TODO' : '';
            const text = cell.type === 'markdown' ? cell.text.replace(/<img[^>]*>/gi, '').slice(0, 3000) : cell.text;
            out += `[${cell.type} ${cell.index}${mark}]\n${text}\n`;
            if (cell.output) out += `  [output] ${cell.output.slice(-300)}\n`;
            out += '\n';
        }
        // Long notebooks: drop the middle of the markdown first, never the task cells.
        return out.length > NOTEBOOK_CHARS ? out.slice(0, NOTEBOOK_CHARS / 2) + '\n[…]\n' + out.slice(-NOTEBOOK_CHARS / 2) : out;
    }

    const RULES = `Rules:
- Return the COMPLETE new content of each cell you write.
- Keep every line outside the solution area exactly as it is: "# GRADED FUNCTION" headers, function signatures,
  docstrings, comments, return statements and test calls.
- Put the code between the solution markers when the cell has them (YOUR CODE STARTS HERE / YOUR CODE ENDS HERE,
  START CODE HERE / END CODE HERE, BEGIN SOLUTION / END SOLUTION); replace placeholders such as None, ... and
  raise NotImplementedError().
- Follow the instructions in the markdown cells: required variable names, shapes, allowed functions, no loops when
  told so. Use only libraries the notebook imports.
- No extra print statements, no new imports the notebook does not use.`;

    async function generate(prompt) {
        const settings = state.settings;
        const { text } = await ModelProvider.generateContent({ provider: settings.provider, apiKey: Naki.activeKey(settings), modelId: Naki.activeModel(settings), lang: settings.lang, prompt });
        return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    }

    // "=== CELL <n> ===" sections; code fences inside a section are dropped.
    function parseCells(text) {
        const out = new Map();
        let index = null, lines = [];
        const flush = () => {
            if (index === null) return;
            const code = lines.join('\n').replace(/^\s*```[\w-]*\s*\n/, '').replace(/\n\s*```\s*$/, '').replace(/^\n+|\s+$/g, '');
            if (code) out.set(index, code);
        };
        for (const line of text.split('\n')) {
            const marker = line.match(/^\s*={3,}\s*CELL\s+(\d+)\s*={3,}\s*$/i);
            if (marker) { flush(); index = Number(marker[1]); lines = []; }
            else if (index !== null) lines.push(line);
        }
        flush();
        return out;
    }

    // The graded header of a cell must survive the rewrite: the grader finds the functions by it.
    function keepHeader(original, code) {
        const header = original.match(/^#\s*GRADED FUNCTION[^\n]*/m)?.[0];
        return header && !code.includes(header.trim()) ? `${header}\n${code}` : code;
    }

    const FAILED_OUTPUT = /tests? failed|wrong (value|output|shape|type)|error:|expected output|assertionerror/i;

    // Errors after a run: exceptions anywhere (execution stops there) and failed tests printed by test cells.
    function failures(cells, targets) {
        const firstTarget = Math.min(...targets);
        return cells.filter(cell => cell.type === 'code' && cell.index >= firstTarget && (cell.error || FAILED_OUTPUT.test(cell.output)))
            .slice(0, 6);
    }

    // Which task cell a failure belongs to: the nearest task cell at or before it.
    const ownerOf = (failure, targets) => targets.filter(index => index <= failure.index).pop() ?? targets[0];

    async function solveNotebook({ submit = true } = {}) {
        if (state.busy) return { ok: false, note: tr('toastBusySolve') };
        if (!Naki.activeKey(state.settings)) {
            toast(tr('toastNoKey'), 'error', 8000);
            return { ok: false, note: tr('toastNoKey') };
        }
        state.busy = true;
        try {
            const status = await askMain('status', 5000);
            if (!status?.ready) return { ok: false, note: tr('labsNoNotebook') };
            const targets = status.cells.filter(cell => cell.type === 'code' && TASK.test(cell.text)).map(cell => cell.index);
            if (!targets.length) {
                toast(tr('labsNoTasks'), 'info', 8000);
                return { ok: false, note: tr('labsNoTasks') };
            }
            toast(tr('labsWriting', { n: targets.length, model: Naki.activeModel(state.settings) }));
            const answer = parseCells(await generate(`You are completing a programming assignment in a Jupyter notebook of an online course (Coursera Labs).
The autograder restarts the kernel, runs the whole notebook and checks the graded functions and variables.
Write the code of the cells marked TODO.
${RULES}

The notebook (cells in order, with their last outputs):
<<<
${notebookText(status.cells, targets)}
>>>

Answer with one section per TODO cell, nothing else:
=== CELL <n> ===
<the full new content of cell n>`));
            const byIndex = new Map(status.cells.map(cell => [cell.index, cell]));
            const changes = [...answer].filter(([index]) => targets.includes(index)).map(([index, code]) => ({ index, text: keepHeader(byIndex.get(index).text, code) }));
            if (!changes.length) throw new Error(tr('labsNoAnswer'));
            await askMain('apply', 5000, { changes });

            let run = null, broken = [];
            for (let round = 0; ; round++) {
                toast(tr('labsRunning', { round: round + 1 }));
                run = await askMain('runAll', RUN_TIMEOUT_MS + 30000, { timeoutMs: RUN_TIMEOUT_MS }, () => heartbeat());
                if (!run?.cells) throw new Error(tr('labsRunFailed'));
                broken = failures(run.cells, targets);
                if (!broken.length || round >= FIX_ROUNDS) break;
                toast(tr('labsFixing', { n: broken.length, round: round + 1 }));
                const owners = [...new Set(broken.map(failure => ownerOf(failure, targets)))];
                const fix = parseCells(await generate(`You are completing a programming assignment in a Jupyter notebook of an online course (Coursera Labs).
The notebook was run from a fresh kernel and some cells failed. Fix the code of the TODO cells that cause the failures.
${RULES}

The notebook after the run (cells in order, with their outputs):
<<<
${notebookText(run.cells, targets)}
>>>

Failures:
${broken.map(failure => `- cell ${failure.index}: ${failure.output.slice(-1200)}`).join('\n')}

Answer with one section per TODO cell you change (likely ${owners.join(', ')}), nothing else:
=== CELL <n> ===
<the full new content of cell n>`));
                const runCells = new Map(run.cells.map(cell => [cell.index, cell]));
                const fixes = [...fix].filter(([index]) => targets.includes(index)).map(([index, code]) => ({ index, text: keepHeader(runCells.get(index).text, code) }));
                if (!fixes.length) break;
                await askMain('apply', 5000, { changes: fixes });
            }
            await askMain('save', 30000);
            const errors = broken.length ? tr('labsStillFailing', { list: broken.map(failure => failure.index).join(', ') }) : '';
            if (!submit) {
                toast(tr('labsDone', { n: changes.length }) + errors, broken.length ? 'info' : 'success', 15000);
                return { ok: !broken.length, note: errors };
            }
            // The Submit Assignment button exists only in the notebook embedded in the Coursera page, and only once
            // the kernel and the submission config are ready (labs-main waits for it).
            if (window === window.top && !status.canSubmit) {
                toast(tr('labsDone', { n: changes.length }) + errors + tr('labsNoSubmit'), 'info', 20000);
                return { ok: false, note: tr('labsNoSubmit').trim() };
            }
            toast(tr('labsSubmitting'));
            const sent = await askMain('submit', 240000);
            if (sent?.message === 'no submit button') {
                toast(tr('labsDone', { n: changes.length }) + errors + tr('labsNoSubmit'), 'error', 20000);
                return { ok: false, note: tr('labsNoSubmit').trim() };
            }
            const message = sent?.message || '';
            toast(tr('labsSubmitted', { message }) + errors, sent?.submitted ? 'success' : 'error', 20000);
            return { ok: !!sent?.submitted, submitted: !!sent?.submitted, note: [message, errors].filter(Boolean).join(' ') };
        } catch (error) {
            console.error('[Naki] Notebook solver error:', error);
            toast(tr('toastSolveError', { error: error.message }), 'error', 15000);
            return { ok: false, note: error.message };
        } finally {
            state.busy = false;
        }
    }

    // ------------------------------------------------------------------ autopilot hand-over

    let labRun = null;
    const heartbeat = () => { if (labRun) chrome.storage.local.set({ [LAB_KEY]: { ...labRun, at: Date.now() } }).catch(() => { }); };

    async function takeOverLab(tries = 0) {
        if (state.busy || window === window.top || !alive()) return; // only the notebook embedded in the Coursera page
        const { [LAB_KEY]: lab } = await chrome.storage.local.get(LAB_KEY);
        if (lab?.state !== 'pending') return;
        const status = await askMain('status', 5000);
        if (!status?.ready) {
            if (tries < 60) setTimeout(() => takeOverLab(tries + 1), 3000); // the notebook and its kernel are still loading
            return;
        }
        document.documentElement.dataset.nakiAutopilot = '1'; // see labs-main.js: no "Leave site?" for the autopilot
        labRun = { ...lab, state: 'working', at: Date.now() };
        await chrome.storage.local.set({ [LAB_KEY]: labRun });
        const result = await solveNotebook({ submit: true });
        labRun = { ...labRun, state: result.submitted ? 'submitted' : 'failed', note: result.note || '', at: Date.now() };
        await chrome.storage.local.set({ [LAB_KEY]: labRun });
        labRun = null;
    }

    // ------------------------------------------------------------------ messaging, hotkey, settings

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === Naki.MSG.SOLVE) {
            askMain('status', 3000).then(status => { if (status?.ready) solveNotebook({ submit: true }); });
            sendResponse({ ok: true });
        } else if (message?.type === Naki.MSG.STATUS && window === window.top) {
            sendResponse({ ok: true, site: 'coursera', solving: state.busy, questions: 0, onAttempt: false });
        }
    });

    window.addEventListener('keydown', event => {
        if (!alive() || event.repeat || !Naki.hotkeyMatches(state.settings.hotkeys.solve, event) || !Naki.hasModifier(state.settings.hotkeys.solve)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        solveNotebook({ submit: true });
    }, true);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !alive()) return;
        if (changes[LAB_KEY]?.newValue?.state === 'pending') takeOverLab();
        Naki.loadSettings().then(settings => { state.settings = settings; });
    });
    Naki.loadSettings().then(settings => {
        state.settings = settings;
        // The notebook needs a moment after load (kernel, extensions such as the Submit button).
        setTimeout(takeOverLab, 6000);
    });
})();
