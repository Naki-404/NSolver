// Content script on *.netacad.com: Cisco NetAcad solver that reads the question from a screenshot of the visible tab.
// Idea and approach from Cisco Netacad Auto-Solver by Sarthak Sanay (BSD-3-Clause). NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    // A copy left over from a previous extension version loses its runtime and must not block this one.
    const alive = () => !!(chrome.runtime && chrome.runtime.id);
    if (window.__nakiNetacadAlive && window.__nakiNetacadAlive()) return;
    window.__nakiNetacadAlive = alive;

    // Questions are often rendered in iframes: every frame listens for the hotkey, only the top frame has the UI.
    const isTop = window === window.top;
    const HOST_ID = 'naki-netacad';

    const state = { settings: Naki.withDefaults({}), solving: false };
    const tr = (key, vars) => Naki.t(state.settings.lang, key, vars);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // ------------------------------------------------------------------ on-page UI (top frame only)

    const ICONS = {
        bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
        spinner: '<svg class="spin" viewBox="0 0 24 24"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg>'
    };

    const ui = (() => {
        let host = null, root = null;
        let answerText = '';

        function ensure() {
            if (host && host.isConnected) return root;
            document.getElementById(HOST_ID)?.remove(); // UI of a previous extension version
            host = document.createElement('div');
            host.id = HOST_ID;
            Object.assign(host.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647' });
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>
                .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
                .card { width: 360px; max-width: calc(100vw - 40px); border-radius: 14px; color: #f5f3ff; background: rgba(20, 18, 38, .97);
                        border: 1px solid rgba(255,255,255,.08); box-shadow: 0 16px 40px -10px rgba(0,0,0,.55); overflow: hidden; }
                .card[hidden], .fab[hidden] { display: none; }
                .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; border-bottom: 1px solid rgba(255,255,255,.06); }
                .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #60a5fa; }
                .success .dot { background: #34d399; } .error .dot { background: #f87171; }
                .title { flex: 1; min-width: 0; font-size: 12px; color: #b9b3dd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .title b { color: #a78bfa; margin-right: 4px; }
                .head button { flex: none; height: 26px; padding: 0 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.1);
                               background: transparent; color: #b9b3dd; font: inherit; font-size: 11.5px; cursor: pointer; }
                .head button:hover { color: #fff; border-color: rgba(167,139,250,.6); }
                .head .close { width: 26px; padding: 0; font-size: 15px; line-height: 1; }
                .body { padding: 12px 14px; max-height: 45vh; overflow: auto; word-break: break-word; user-select: text; }
                .line { display: flex; gap: 8px; padding: 3px 0; }
                .line::before { content: "✓"; flex: none; color: #34d399; font-weight: 700; }
                .group { margin: 8px 0 2px; font-size: 11.5px; font-weight: 700; color: #a78bfa; }
                .group:first-child { margin-top: 0; }
                .message { color: #e9e6ff; }
                .fab { display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px; border: 0; border-radius: 999px; cursor: pointer;
                       color: #fff; font: inherit; font-weight: 650; font-size: 14px; background: linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%);
                       box-shadow: 0 10px 24px -8px rgba(124, 58, 237, .9); transition: transform .15s, filter .15s; }
                .fab:hover { filter: brightness(1.08); transform: translateY(-1px); }
                .fab:disabled { cursor: default; filter: saturate(.6); transform: none; }
                .fab svg { width: 16px; height: 16px; fill: currentColor; }
                .spin { animation: spin .9s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
            <div class="wrap">
                <div class="card" hidden>
                    <div class="head"><span class="dot"></span><span class="title"></span><button class="copy" type="button" hidden></button><button class="close" type="button">×</button></div>
                    <div class="body"></div>
                </div>
                <button class="fab" type="button" hidden></button>
            </div>`;
            root.querySelector('.close').addEventListener('click', () => { root.querySelector('.card').hidden = true; });
            root.querySelector('.copy').addEventListener('click', async () => {
                const button = root.querySelector('.copy');
                try {
                    await navigator.clipboard.writeText(answerText);
                    button.textContent = tr('netacadCopied');
                    setTimeout(() => { button.textContent = tr('netacadCopy'); }, 1500);
                } catch (e) {
                    console.warn('[Naki] Clipboard write failed:', e);
                }
            });
            root.querySelector('.fab').addEventListener('click', () => solve());
            (document.body || document.documentElement).appendChild(host);
            render();
            return root;
        }

        function render() {
            if (!root) return;
            const fab = root.querySelector('.fab');
            fab.hidden = !state.settings.netacadButton;
            fab.disabled = state.solving;
            fab.innerHTML = (state.solving ? ICONS.spinner : ICONS.bolt) + '<span></span>';
            fab.querySelector('span').textContent = tr('netacadSolve');
            const hotkey = state.settings.hotkeys.solve;
            fab.title = hotkey ? `NSolver — ${Naki.formatHotkey(hotkey, state.settings.lang)}` : 'NSolver';
            root.querySelector('.close').title = tr('netacadClose');
            root.querySelector('.copy').textContent = tr('netacadCopy');
        }

        // kind: info | success | error; answer: model output with one answer per line
        function show(kind, title, { message = '', answer = '' } = {}) {
            const r = ensure();
            const card = r.querySelector('.card');
            card.className = `card ${kind}`;
            card.hidden = false;
            r.querySelector('.title').innerHTML = '<b>Naki:</b><span></span>';
            r.querySelector('.title span').textContent = title;
            r.querySelector('.title').title = title;
            const body = r.querySelector('.body');
            body.textContent = '';
            if (answer) {
                for (const line of answer.split('\n')) {
                    const el = document.createElement('div');
                    const group = /^Q\d+:$/i.test(line);
                    el.className = group ? 'group' : 'line';
                    el.textContent = line;
                    body.appendChild(el);
                }
            } else {
                const el = document.createElement('div');
                el.className = 'message';
                el.textContent = message;
                body.appendChild(el);
            }
            answerText = answer;
            r.querySelector('.copy').hidden = !answer;
        }

        // Our own UI must not cover the question on the screenshot.
        async function hiddenWhile(task) {
            ensure();
            host.style.visibility = 'hidden';
            await sleep(120); // let the page repaint before the capture
            try {
                return await task();
            } finally {
                host.style.visibility = '';
            }
        }

        return { ensure, render, show, hiddenWhile };
    })();

    // ------------------------------------------------------------------ solver

    function sendMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, reply => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(reply);
            });
        });
    }

    async function solve() {
        if (state.solving) return;
        if (!Naki.activeKey(state.settings)) {
            ui.show('error', 'NSolver', { message: tr('toastNoKey') });
            return;
        }
        state.solving = true;
        ui.render();
        try {
            const shot = await ui.hiddenWhile(() => sendMessage({ type: Naki.MSG.CAPTURE }));
            if (!shot?.dataUrl) {
                if (shot?.needsPermission) ui.show('error', 'NSolver', { message: tr('netacadNeedPermission') });
                else ui.show('error', 'NSolver', { message: tr('netacadError', { error: shot?.error || tr('errImage') }) });
                return;
            }

            const settings = state.settings;
            const options = { provider: settings.provider, apiKey: Naki.activeKey(settings), modelId: Naki.activeModel(settings), lang: settings.lang };
            ui.show('info', 'NSolver', { message: tr('netacadSolving', { model: options.modelId }) });
            const started = performance.now();
            const { answer, modelId } = await ModelProvider.solveScreenshot({ ...options, imageDataUrl: shot.dataUrl });
            const sec = ((performance.now() - started) / 1000).toFixed(1);
            console.log('[Naki] NetAcad answer:', answer);
            if (!answer) ui.show('info', 'NSolver', { message: tr('netacadNoQuestion') });
            else ui.show('success', tr('netacadAnswer', { model: modelId, sec }), { answer });
        } catch (error) {
            console.error('[Naki] NetAcad solver error:', error);
            ui.show('error', 'NSolver', { message: tr('netacadError', { error: error.message }) });
        } finally {
            state.solving = false;
            ui.render();
        }
    }

    // ------------------------------------------------------------------ hotkey

    function isEditableTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    window.addEventListener('keydown', function onKeydown(event) {
        if (!alive()) {
            window.removeEventListener('keydown', onKeydown, true);
            return;
        }
        const hotkey = state.settings.hotkeys.solve;
        if (event.repeat || !Naki.hotkeyMatches(hotkey, event)) return;
        if (!Naki.hasModifier(hotkey) && isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isTop) solve();
        else chrome.runtime.sendMessage({ type: Naki.MSG.SOLVE_RELAY }).catch(() => { });
    }, true);

    // ------------------------------------------------------------------ messaging & settings

    function applySettings(settings) {
        state.settings = settings;
        if (isTop && (settings.netacadButton || document.getElementById(HOST_ID))) ui.ensure();
        if (isTop) ui.render();
    }

    if (isTop) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            switch (message?.type) {
                case Naki.MSG.SOLVE:
                    solve();
                    sendResponse({ ok: true });
                    break;
                case Naki.MSG.STATUS:
                    sendResponse({ ok: true, site: 'netacad', solving: state.solving });
                    break;
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && alive()) Naki.loadSettings().then(applySettings);
    });
    Naki.loadSettings().then(applySettings);
    if (isTop) console.log('[Naki] NSolver NetAcad mode loaded — made by Naki: https://github.com/Naki-404/NSolver');
})();
