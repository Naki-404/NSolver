// Runs in Coursera Labs notebooks (*.labs.coursera.org, MAIN world): the classic Jupyter Notebook keeps its cells,
// kernel and the Coursera "Submit Assignment" button (nbextension submit-button) in window.Jupyter, which the isolated
// content script (labs.js) cannot reach. Requests come from labs.js over window.postMessage.
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    if (window.__nakiLabsMain) return;
    window.__nakiLabsMain = true;

    const CHANNEL = 'naki-labs-main';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const ANSI = /\u001b\[[0-9;]*m/g;
    const notebook = () => window.Jupyter && window.Jupyter.notebook && window.Jupyter.notebook.get_cells ? window.Jupyter.notebook : null;

    function outputText(output) {
        if (output.output_type === 'stream') return String(output.text || '');
        if (output.output_type === 'error') return `${output.ename}: ${output.evalue}\n${(output.traceback || []).slice(-6).join('\n')}`.replace(ANSI, '');
        const data = output.data || {};
        if (data['text/plain']) return String(data['text/plain']);
        return Object.keys(data).some(type => type.startsWith('image/')) ? '[image]' : '';
    }

    function cells() {
        return notebook().get_cells().map((cell, index) => {
            const outputs = cell.cell_type === 'code' && cell.output_area ? cell.output_area.outputs : [];
            return {
                index,
                type: cell.cell_type,
                text: cell.get_text(),
                output: outputs.map(outputText).join('\n').replace(ANSI, '').slice(-1500),
                error: outputs.some(output => output.output_type === 'error')
            };
        });
    }

    function status() {
        const nb = notebook();
        if (!nb) return { ready: false };
        return { ready: true, path: nb.notebook_path, cells: cells(), canSubmit: !!document.getElementById('submit-notebook-button') };
    }

    function apply(changes) {
        const all = notebook().get_cells();
        let done = 0;
        for (const { index, text } of changes) {
            const cell = all[index];
            if (!cell || cell.cell_type !== 'code') continue;
            cell.set_text(text);
            done++;
        }
        notebook().set_dirty(true);
        return { done };
    }

    const running = () => notebook().get_cells().some(cell => cell.cell_type === 'code' &&
        (cell.input_prompt_number === '*' || (cell.element && cell.element[0] && cell.element[0].classList.contains('running'))));

    // Restart the kernel and run every cell (the way the grader sees the notebook), then report the outputs.
    // onBeat: called while waiting, so the caller can tell a long training cell from a stuck page.
    async function runAll(timeoutMs, onBeat) {
        const nb = notebook();
        await nb.restart_run_all({ confirm: false });
        const end = Date.now() + timeoutMs;
        let started = false, idleChecks = 0, beat = Date.now();
        while (Date.now() < end) {
            await sleep(1000);
            if (Date.now() - beat > 20000) { onBeat(); beat = Date.now(); }
            if (running()) { started = true; idleChecks = 0; continue; }
            if (++idleChecks >= (started ? 3 : 10)) break;
        }
        return { finished: !running(), cells: cells() };
    }

    async function save() {
        await notebook().save_notebook();
        return { saved: true };
    }

    // "Submit Assignment": a dialog "Submission Status" shows "Submitting ..." and then what the grader client printed.
    async function submit() {
        const button = document.getElementById('submit-notebook-button');
        if (!button) return { submitted: false, message: 'no submit button' };
        button.click();
        let message = '';
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const modal = [...document.querySelectorAll('.modal')].find(el => el.getClientRects().length > 0 && /submission status/i.test(el.textContent)); // fixed position: no offsetParent
            const last = modal && modal.querySelector('.modal-body > div > span:last-of-type, .modal-body span:last-child');
            message = last ? last.textContent.trim() : '';
            if (modal && message && !/^submitting/i.test(message)) {
                const ok = [...modal.querySelectorAll('button')].find(b => /^ok$/i.test(b.textContent.trim()));
                if (ok) ok.click();
                break;
            }
        }
        return { submitted: !!message && !/^submitting/i.test(message), message };
    }

    window.addEventListener('message', async event => {
        const data = event.data;
        if (event.source !== window || !data || data.channel !== CHANNEL || !data.request) return;
        let result;
        try {
            if (!notebook()) result = { ready: false };
            else if (data.request === 'apply') result = apply(data.options.changes || []);
            else if (data.request === 'runAll') result = await runAll(data.options.timeoutMs || 600000, () => window.postMessage({ channel: CHANNEL, beat: data.id }, window.location.origin));
            else if (data.request === 'save') result = await save();
            else if (data.request === 'submit') result = await submit();
            else result = status();
        } catch (error) {
            result = { ready: false, error: error.message };
        }
        window.postMessage({ channel: CHANNEL, reply: data.id, result }, window.location.origin);
    });
})();
