// Content script on Cisco NetAcad (netacad.com, netacad.net, skillsforall.com): reads quiz questions as text from the
// page (course frames and Shadow DOM included), asks the selected model and selects the answers itself.
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    // A copy left over from a previous extension version loses its runtime and must not block this one.
    const alive = () => !!(chrome.runtime && chrome.runtime.id);
    if (window.__nakiNetacadAlive && window.__nakiNetacadAlive()) return;
    window.__nakiNetacadAlive = alive;

    // The course lives in an iframe of the player page (netacad.com/launch → netacad.com/content/…): every frame
    // listens for the hotkeys, the top frame has the UI and reads the same-origin course frames itself.
    const isTop = window === window.top;
    const HOST_ID = 'naki-netacad';

    const state = { settings: Naki.withDefaults({}), solving: false, skipping: false };
    const tr = (key, vars) => Naki.t(state.settings.lang, key, vars);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const normalize = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

    // ------------------------------------------------------------------ deep DOM: Shadow DOM and same-origin frames

    function shadowRootOf(el) {
        try {
            return (chrome.dom && chrome.dom.openOrClosedShadowRoot && chrome.dom.openOrClosedShadowRoot(el)) || el.shadowRoot || null;
        } catch (e) {
            return el.shadowRoot || null;
        }
    }

    // Every Document / ShadowRoot reachable from root, in document order.
    function collectRoots(root = document, out = []) {
        out.push(root);
        for (const el of root.querySelectorAll('*')) {
            if (el.id === HOST_ID) continue;
            const shadow = shadowRootOf(el);
            if (shadow) collectRoots(shadow, out);
            if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
                let doc = null;
                try { doc = el.contentDocument; } catch (e) { }
                if (doc && doc.documentElement) collectRoots(doc, out);
            }
        }
        return out;
    }

    // Parent in the composed tree (shadow root → its host); stops at the frame's document.
    function composedParent(node) {
        if (node.parentElement) return node.parentElement;
        const parent = node.parentNode;
        return parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && parent.host ? parent.host : null;
    }

    function composedContains(ancestor, node) {
        for (let current = node; current; current = composedParent(current)) {
            if (current === ancestor) return true;
        }
        return false;
    }

    function isVisible(el) {
        if (!el || !el.isConnected || !el.getClientRects().length) return false;
        return el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden';
    }

    // Screen-reader-only and control text is not part of the question.
    const SKIP_SELECTOR = 'script, style, template, noscript, button, select, textarea, input, [hidden], [aria-hidden="true"], ' +
        '.aria-label, .sr-only, .visually-hidden, .u-visually-hidden, .is-hidden, .accessibility-completion-indicator, [class*="screenReader"]';
    const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH', 'TR', 'UL', 'OL',
        'LABEL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE', 'BLOCKQUOTE', 'TABLE', 'FIGCAPTION', 'LEGEND']);

    // Text of a node including its shadow tree; nodes in skip (and their subtrees) are left out.
    function deepText(node, skip = new Set()) {
        let text = '';
        const visit = (n, isRoot) => {
            if (n.nodeType === Node.TEXT_NODE) {
                text += n.nodeValue;
                return;
            }
            if (n.nodeType !== Node.ELEMENT_NODE) return;
            if (!isRoot && (skip.has(n) || n.id === HOST_ID || n.matches(SKIP_SELECTOR))) return;
            if (n.tagName === 'IMG') {
                if (n.alt) text += ` [image: ${n.alt}] `;
                return;
            }
            if (n.tagName === 'SLOT') {
                const assigned = n.assignedNodes({ flatten: true });
                for (const child of assigned.length ? assigned : n.childNodes) visit(child, false);
                return;
            }
            const shadow = shadowRootOf(n);
            for (const child of shadow ? shadow.childNodes : n.childNodes) visit(child, false);
            if (BLOCK_TAGS.has(n.tagName)) text += ' ';
        };
        visit(node, true);
        return text.replace(/\s+/g, ' ').trim();
    }

    // Every answer control on the page, set by findQuestions(): question text must not reach into other questions.
    const CONTROL_SELECTOR = 'input, select, textarea, [role="listbox"]';
    let pageControls = [];

    // The question: the nearest ancestor that holds every control of the question and some text of its own.
    // Climbing stops at an Adapt component and before an ancestor that also holds controls of another question.
    function questionTextFor(controls, optionNodes) {
        const skip = new Set(optionNodes);
        const own = new Set(controls);
        const others = pageControls.filter(control => !own.has(control) && !skip.has(control));
        let node = controls[0];
        for (let depth = 0; node && depth < 30; depth++) {
            node = composedParent(node);
            if (!node) break;
            if (!controls.every(control => composedContains(node, control))) continue;
            if (others.some(control => composedContains(node, control))) break;
            const text = deepText(node, skip);
            if (text.length >= 12 || node.classList.contains('component')) return text.length >= 4 ? text.slice(0, 2000) : '';
        }
        return '';
    }

    // ------------------------------------------------------------------ questions on the page

    function labelOf(input) {
        if (input.labels && input.labels.length) return input.labels[0];
        if (input.id) {
            const label = input.getRootNode().querySelector?.(`label[for="${CSS.escape(input.id)}"]`);
            if (label) return label;
        }
        return input.closest('label');
    }

    function closestComposed(el, selector) {
        for (let node = el; node; node = composedParent(node)) {
            if (node.matches && node.matches(selector)) return node;
        }
        return null;
    }

    // Already answered: disabled input, or a submitted / disabled Adapt widget or label.
    function isLocked({ input, label }) {
        return input.disabled || !!(label && label.classList.contains('is-disabled')) ||
            !!closestComposed(input, '.is-submitted, .component__widget.is-disabled');
    }

    // Adapt (the NetAcad course framework) names options "<component id>-<index>-input".
    function choiceGroupKey(input, rootIndex) {
        const adapt = input.id && input.id.match(/^(.+)-\d+-input$/);
        if (adapt) return 'id:' + adapt[1];
        if (input.name) return `name:${rootIndex}:${input.name}`;
        return input.closest('fieldset, [role="radiogroup"], [role="group"]') || input.parentElement?.parentElement || input;
    }

    function choiceQuestions(roots) {
        const groups = new Map();
        roots.forEach((root, rootIndex) => {
            for (const input of root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
                const label = labelOf(input);
                if (!isVisible(label || input)) continue;
                const key = choiceGroupKey(input, rootIndex);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ input, label });
            }
        });
        const questions = [];
        for (const items of groups.values()) {
            if (items.length < 2 || items.every(isLocked)) continue; // answered or not a question
            const options = items.map(({ input, label }) => (label && deepText(label)) || input.getAttribute('aria-label') || input.value || '');
            const question = questionTextFor(items.map(item => item.input), items.flatMap(item => [item.input, item.label].filter(Boolean)));
            if (!question || options.some(option => !option)) continue;
            questions.push({
                type: 'mcq',
                multiple: items.some(item => item.input.type === 'checkbox'),
                question,
                options,
                apply: indices => applyChoice(items, indices)
            });
        }
        return questions;
    }

    function selectQuestions(roots) {
        const questions = [];
        for (const root of roots) {
            for (const select of root.querySelectorAll('select')) {
                if (select.disabled || select.multiple || !isVisible(select)) continue;
                const choices = [...select.options].filter((option, i) => option.value !== '' && !option.disabled && !(i === 0 && /select|choose|выбер/i.test(option.text)));
                if (choices.length < 2) continue;
                const question = questionTextFor([select], [select]);
                if (!question) continue;
                questions.push({
                    type: 'mcq', multiple: false, question,
                    options: choices.map(option => option.text.trim()),
                    apply: indices => applySelect(select, choices[indices[0]])
                });
            }
        }
        return questions;
    }

    // Custom dropdowns (Adapt matching / fill-the-blanks): a button that opens a [role=listbox] of [role=option].
    function listboxTrigger(listbox) {
        const root = listbox.getRootNode();
        if (listbox.id) {
            const byControls = root.querySelector?.(`[aria-controls="${CSS.escape(listbox.id)}"], [aria-owns="${CSS.escape(listbox.id)}"]`);
            if (byControls) return byControls;
        }
        const container = listbox.parentElement;
        return container?.querySelector('button, [aria-haspopup="listbox"], [role="combobox"]') || null;
    }

    function listboxQuestions(roots) {
        const questions = [];
        for (const root of roots) {
            for (const listbox of root.querySelectorAll('[role="listbox"]')) {
                const trigger = listboxTrigger(listbox);
                if (!trigger || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true' || !isVisible(trigger)) continue;
                const choices = [...listbox.querySelectorAll('[role="option"]')].filter(option => option.getAttribute('aria-disabled') !== 'true');
                const options = choices.map(option => deepText(option));
                if (choices.length < 2 || options.some(option => !option)) continue;
                const question = questionTextFor([trigger], [listbox, trigger]);
                if (!question) continue;
                questions.push({
                    type: 'mcq', multiple: false, question, options,
                    apply: indices => applyListbox(trigger, choices[indices[0]])
                });
            }
        }
        return questions;
    }

    const TEXT_FIELD_SELECTOR = 'input[type="text"], input:not([type]), input[type="number"], textarea';

    function textQuestions(roots) {
        const questions = [];
        for (const root of roots) {
            for (const field of root.querySelectorAll(TEXT_FIELD_SELECTOR)) {
                if (field.disabled || field.readOnly || !isVisible(field)) continue;
                // Only fields inside a course question component, not search boxes of the player.
                let inQuestion = false;
                for (let node = field, depth = 0; node && depth < 12; node = composedParent(node), depth++) {
                    if (/textinput|fillblank|question|component/i.test(node.className || '')) { inQuestion = true; break; }
                }
                if (!inQuestion) continue;
                const question = questionTextFor([field], [field]);
                if (!question) continue;
                questions.push({ type: 'textArea', question, options: [], apply: content => applyText(field, content) });
            }
        }
        return questions;
    }

    function findQuestions() {
        const roots = collectRoots();
        pageControls = roots.flatMap(root => [...root.querySelectorAll(CONTROL_SELECTOR)]).filter(control => {
            if (control.type === 'hidden') return false;
            if (control.matches('[role="listbox"]')) return isVisible(listboxTrigger(control));
            if (control.type === 'radio' || control.type === 'checkbox') return isVisible(labelOf(control) || control);
            return isVisible(control);
        });
        return [...choiceQuestions(roots), ...selectQuestions(roots), ...listboxQuestions(roots), ...textQuestions(roots)];
    }

    // ------------------------------------------------------------------ applying answers

    function highlight(el) {
        if (!el) return;
        const previous = { outline: el.style.outline, offset: el.style.outlineOffset };
        el.style.outline = '2px solid #34d399';
        el.style.outlineOffset = '2px';
        setTimeout(() => { el.style.outline = previous.outline; el.style.outlineOffset = previous.offset; }, 6000);
    }

    async function setChecked({ input, label }, wanted) {
        if (input.checked === wanted) return true;
        (label || input).click();
        await sleep(60);
        if (input.checked !== wanted) {
            input.click();
            await sleep(60);
        }
        return input.checked === wanted;
    }

    async function applyChoice(items, indices) {
        const wanted = new Set(indices);
        if (!wanted.size) return false;
        let ok = true;
        for (const [i, item] of items.entries()) {
            const should = wanted.has(i);
            if (item.input.type === 'radio' && !should) continue; // choosing one radio clears the others
            ok = (await setChecked(item, should)) && ok;
            if (should) highlight(item.label || item.input);
        }
        return ok;
    }

    function fireChange(el) {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    function applySelect(select, option) {
        if (!option) return false;
        select.value = option.value;
        fireChange(select);
        highlight(select);
        return select.value === option.value;
    }

    async function applyListbox(trigger, option) {
        if (!option) return false;
        trigger.click();
        await sleep(80);
        option.click();
        await sleep(80);
        highlight(trigger);
        return true;
    }

    function applyText(field, content) {
        if (!content) return false;
        field.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
        if (setter) setter.call(field, content); else field.value = content;
        fireChange(field);
        field.blur();
        highlight(field);
        return true;
    }

    // ------------------------------------------------------------------ on-page UI (top frame only)

    const ICONS = {
        bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
        spinner: '<svg class="spin" viewBox="0 0 24 24"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg>'
    };

    const ui = (() => {
        let host = null, root = null, hideTimer = null;

        function ensure() {
            if (host && host.isConnected) return root;
            document.getElementById(HOST_ID)?.remove(); // UI of a previous extension version
            host = document.createElement('div');
            host.id = HOST_ID;
            Object.assign(host.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647' });
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>
                .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
                .card { width: 340px; max-width: calc(100vw - 40px); border-radius: 14px; color: #f5f3ff; background: rgba(20, 18, 38, .97);
                        border: 1px solid rgba(255,255,255,.08); box-shadow: 0 16px 40px -10px rgba(0,0,0,.55); overflow: hidden; }
                .card[hidden], .fab[hidden] { display: none; }
                .head { display: flex; align-items: flex-start; gap: 8px; padding: 11px 10px 11px 14px; }
                .dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: #60a5fa; }
                .success .dot { background: #34d399; } .error .dot { background: #f87171; }
                .text { flex: 1; min-width: 0; word-break: break-word; }
                .text b { color: #a78bfa; margin-right: 4px; }
                .close { flex: none; width: 24px; height: 24px; padding: 0; border-radius: 7px; border: 1px solid rgba(255,255,255,.1);
                         background: transparent; color: #b9b3dd; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
                .close:hover { color: #fff; border-color: rgba(167,139,250,.6); }
                .list { padding: 0 14px 12px 30px; max-height: 40vh; overflow: auto; color: #d9d5f5; user-select: text; }
                .list:empty { display: none; }
                .list div { padding: 2px 0; }
                .list b { color: #a78bfa; margin-right: 4px; }
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
                    <div class="head"><span class="dot"></span><span class="text"><b>Naki:</b><span class="message"></span></span><button class="close" type="button">×</button></div>
                    <div class="list"></div>
                </div>
                <button class="fab" type="button" hidden></button>
            </div>`;
            root.querySelector('.close').addEventListener('click', () => { root.querySelector('.card').hidden = true; });
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
        }

        // kind: info | success | error; lines: [{ n, text }] answers the user has to pick by hand; duration 0 keeps the card.
        function show(kind, message, { lines = [], duration = 0 } = {}) {
            const r = ensure();
            const card = r.querySelector('.card');
            card.className = `card ${kind}`;
            card.hidden = false;
            r.querySelector('.message').textContent = message;
            const list = r.querySelector('.list');
            list.textContent = '';
            for (const line of lines) {
                const el = document.createElement('div');
                el.innerHTML = '<b></b><span></span>';
                el.querySelector('b').textContent = `${line.n}.`;
                el.querySelector('span').textContent = line.text;
                list.appendChild(el);
            }
            clearTimeout(hideTimer);
            if (duration > 0) hideTimer = setTimeout(() => { card.hidden = true; }, duration);
        }

        return { ensure, render, show };
    })();

    // ------------------------------------------------------------------ solver

    function answerText(question, solution) {
        if (!solution) return '';
        if (question.type === 'mcq') return (solution.correctOptionsIndex || []).map(i => question.options[i]).join(' | ');
        return solution.content || '';
    }

    async function solve() {
        if (state.solving) {
            ui.show('info', tr('toastBusySolve'), { duration: 2500 });
            return;
        }
        if (!Naki.activeKey(state.settings)) {
            ui.show('error', tr('toastNoKey'), { duration: 8000 });
            return;
        }
        state.solving = true;
        ui.render();
        try {
            const questions = findQuestions();
            console.log('[Naki] NetAcad questions:', questions.map(({ apply, ...q }) => q));
            if (!questions.length) {
                ui.show('info', tr('netacadNoQuestions'), { duration: 8000 });
                return;
            }
            const settings = state.settings;
            const options = { provider: settings.provider, apiKey: Naki.activeKey(settings), modelId: Naki.activeModel(settings), lang: settings.lang };
            ui.show('info', tr('toastSolving', { auto: '', n: questions.length, model: options.modelId }));
            const started = performance.now();
            const solutions = await ModelProvider.solveQuizQuestions(questions.map(({ apply, ...q }) => q), options);
            console.log('[Naki] NetAcad solutions:', solutions);

            let applied = 0;
            const missed = [];
            for (const [i, question] of questions.entries()) {
                const solution = solutions[i];
                let ok = false;
                try {
                    if (solution) ok = await question.apply(question.type === 'mcq' ? solution.correctOptionsIndex || [] : solution.content);
                } catch (error) {
                    console.warn('[Naki] Could not apply answer', i + 1, error);
                }
                if (ok) applied++;
                else missed.push({ n: i + 1, text: answerText(question, solution) || '—' });
            }
            const sec = ((performance.now() - started) / 1000).toFixed(1);
            if (missed.length) {
                ui.show(applied ? 'success' : 'error', tr('netacadPartial', { applied, total: questions.length, sec }), { lines: missed });
            } else {
                ui.show('success', tr('toastDone', { applied, sec }), { duration: 8000 });
            }
        } catch (error) {
            console.error('[Naki] NetAcad solver error:', error);
            ui.show('error', tr('toastSolveError', { error: error.message }));
        } finally {
            state.solving = false;
            ui.render();
        }
    }

    // ------------------------------------------------------------------ skipping course materials
    // NetAcad courses are Adapt courses: a component counts as done when it was in view (text, graphics),
    // when its media was played to the end, or when every item was opened (accordion, tabs, hotgraphic, narrative…).
    // Questions are left alone: they are completed by answering.

    const ITEM_TRIGGERS = [
        '.accordion__item-btn', '.tabs__nav-item-btn', '[role="tab"]', '.hotgraphic__pin', '.hotgraphic__tile',
        '.flipcard__item', '.narrative__strapline-btn', '.clickreveal__btn', '[class*="__item-btn"]'
    ].join(', ');
    const ITEM_PANELS = '[role="tabpanel"], .tabs__content-item, .accordion__item-content';
    const POPUP_CLOSE ='[class*="popup__close"], [class*="notify__close"], .js-notify-close-btn';
    const NARRATIVE_NEXT = '.narrative__controls-right, .js-narrative-controls-click[data-direction="right"]';

    function waitForEvent(target, name, timeoutMs) {
        return new Promise(resolve => {
            const timer = setTimeout(() => done(false), timeoutMs);
            function done(result) {
                clearTimeout(timer);
                target.removeEventListener(name, onEvent);
                resolve(result);
            }
            function onEvent() { done(true); }
            target.addEventListener(name, onEvent);
        });
    }

    const PLAY_BUTTON = '.vjs-big-play-button, .media-poster button, .mejs-overlay-play';

    async function videoOf(media) {
        let video = deepQueryAll(media, 'video')[0];
        if (video) return video;
        const play = deepQueryAll(media, PLAY_BUTTON).find(isVisible);
        if (!play) return null;
        play.click();
        for (let i = 0; i < 40 && !video; i++) {
            await sleep(250);
            video = deepQueryAll(media, 'video')[0];
        }
        return video || null;
    }

    const isComplete = component => component.classList.contains('is-complete');

    // NetAcad's player rolls back seeking ahead, but completes the component on the video's "ended" event once
    // playback has started. Fallback: play it through, fast and muted.
    async function finishVideo(video, component) {
        video.muted = true;
        const playing = waitForEvent(video, 'playing', 8000);
        try { await video.play(); } catch (e) { }
        await playing;
        video.dispatchEvent(new Event('ended'));
        await sleep(800);
        if (!component || !isComplete(component)) {
            const ended = waitForEvent(video, 'ended', 25000);
            video.playbackRate = 16;
            try { await video.play(); } catch (e) { }
            if (await ended) await sleep(500);
        }
        video.pause();
        return component ? isComplete(component) : true;
    }

    // Adobe Animate components (<play-pause>, <aa-scrubber>) complete when the animation reaches its end.
    async function finishAnimation(component) {
        const toggle = deepQueryAll(component, 'play-pause').map(el => shadowRootOf(el)?.querySelector('button') || el)[0];
        if (!toggle) return false;
        toggle.click();
        await sleep(500);
        const range = deepQueryAll(component, 'input[type="range"]')[0];
        if (range) {
            range.value = range.max;
            range.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            range.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
        for (let i = 0; i < 60 && !isComplete(component); i++) await sleep(500);
        return isComplete(component);
    }

    // Adapt counts text as read when it was fully in view; a smaller page zoom lets tall blocks fit the window.
    function zoomOut(roots) {
        const docs = [...new Set(roots.map(root => root.ownerDocument || root))].filter(doc => doc !== document && doc.querySelector);
        const saved = docs.map(doc => [doc.documentElement, doc.documentElement.style.zoom]);
        for (const [html] of saved) html.style.zoom = '0.5';
        return () => { for (const [html, zoom] of saved) html.style.zoom = zoom; };
    }

    async function bringIntoView(component) {
        component.scrollIntoView({ block: 'center' });
        await sleep(400);
        if (isComplete(component)) return;
        const frameHeight = component.ownerDocument.defaultView.innerHeight;
        if (component.getBoundingClientRect().height > frameHeight * 0.8) {
            component.scrollIntoView({ block: 'start' });
            await sleep(400);
            component.scrollIntoView({ block: 'end' });
            await sleep(400);
        }
    }

    function closePopups(roots) {
        for (const root of roots) {
            for (const button of root.querySelectorAll(POPUP_CLOSE)) if (isVisible(button)) button.click();
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }

    function deepQueryAll(node, selector) {
        const found = [...node.querySelectorAll(selector)];
        for (const el of node.querySelectorAll('*')) {
            const shadow = shadowRootOf(el);
            if (shadow) found.push(...deepQueryAll(shadow, selector));
        }
        return found;
    }

    async function openAllItems(component, roots) {
        for (const trigger of deepQueryAll(component, ITEM_TRIGGERS)) {
            if (!isVisible(trigger) || trigger.disabled) continue;
            trigger.click();
            await sleep(600);
            // NetAcad counts a tab / item as seen once its content was in view.
            const panel = deepQueryAll(component, ITEM_PANELS).find(isVisible);
            if (panel) {
                panel.scrollIntoView({ block: 'center' });
                await sleep(600);
            }
            closePopups(roots);
            // Accordion items toggle: close them again so the page stays readable.
            if (trigger.matches('.accordion__item-btn') && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
        }
        for (let i = 0; i < 30; i++) {
            const next = deepQueryAll(component, NARRATIVE_NEXT).find(button => isVisible(button) && !button.disabled && !button.classList.contains('is-disabled'));
            if (!next) break;
            next.click();
            await sleep(150);
        }
    }

    // ------------------------------------------------------------------ skipping the whole course
    // netacad-main.js (page world) marks a loaded module complete through the course models in a few seconds;
    // the player loads one module at a time, so every module is opened from the course outline in turn.

    const MAIN_CHANNEL = 'naki-netacad-main';
    let mainRequestId = 0;

    function askMain(request, timeoutMs) {
        return new Promise(resolve => {
            const id = ++mainRequestId;
            const timer = setTimeout(() => done(null), timeoutMs);
            function done(result) {
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolve(result);
            }
            function onMessage(event) {
                if (event.source === window && event.data?.channel === MAIN_CHANNEL && event.data.reply === id) done(event.data.result);
            }
            window.addEventListener('message', onMessage);
            window.postMessage({ channel: MAIN_CHANNEL, request, id }, window.location.origin);
        });
    }

    // Course outline of the player (netacad.com/launch): one "node-button-<id>" per module, but also per checkpoint
    // exam, final exam, survey… Those must never be opened (that could start an exam attempt): modules only.
    const MODULE_TITLE = /^\s*(module|модуль|módulo|modul|modulo)\s*\d+/i;
    const NOT_A_MODULE = /exam|final|survey|assessment|экзамен|опрос/i;

    function outlineModules() {
        return [...document.querySelectorAll('button[id^="node-button-"]')]
            .filter(button => MODULE_TITLE.test(button.textContent) && !NOT_A_MODULE.test(button.textContent))
            .map(button => {
                const percent = button.textContent.match(/(\d+)\s*%/);
                return {
                    id: button.id.slice('node-button-'.length),
                    button,
                    title: (button.textContent.match(/Module\s+\d+[^%]*?(?=\d+\s*%|$)/i)?.[0] || button.textContent).trim().slice(0, 60),
                    percent: percent ? Number(percent[1]) : null
                };
            });
    }

    async function openModule(module) {
        if (module.button.getAttribute('aria-expanded') !== 'true') {
            module.button.click();
            await sleep(500);
        }
        const first = document.querySelector(`[id="node-${module.id}"] button[id^="submodule-button-"]`) ||
            document.getElementById('submodule-button-' + module.id);
        if (!first) return null;
        first.click();
        for (let i = 0; i < 50; i++) {
            await sleep(400);
            const status = await askMain('status', 3000);
            // Right after a switch the previous module may still be rendered: the course title must match too.
            if (status?.ready && status.packageId === module.id && sameModuleTitle(status.title, module.title)) return status;
        }
        return null;
    }

    // "Module {{_globals._moduleNumber}}: Network Threats" (course model) vs "Module 2: Network Threats" (outline).
    function sameModuleTitle(courseTitle, outlineTitle) {
        const name = title => normalize(String(title).split(':').slice(1).join(':') || title);
        return !name(courseTitle) || !name(outlineTitle) || name(outlineTitle).startsWith(name(courseTitle).slice(0, 20));
    }

    async function skipMaterials() {
        if (state.skipping) {
            ui.show('info', tr('toastBusySkip'), { duration: 2500 });
            return;
        }
        state.skipping = true;
        try {
            const current = await askMain('status', 3000);
            if (!current?.ready) {
                await skipCurrentPage(); // not an Adapt course page: go through what is on the screen
                return;
            }
            const modules = outlineModules().filter(module => module.percent === null || module.percent < 100);
            let modulesDone = 0, componentsDone = 0;
            const failed = [];
            if (!outlineModules().length) {
                // A course frame without the player outline: this module only.
                ui.show('info', tr('netacadSkipModule', { n: 1, total: 1, title: current.title }));
                const result = await askMain('complete', 120000);
                componentsDone += result?.done || 0;
                modulesDone++;
            }
            for (const [i, module] of modules.entries()) {
                ui.show('info', tr('netacadSkipModule', { n: i + 1, total: modules.length, title: module.title }));
                const status = await openModule(module);
                if (!status) {
                    failed.push(module.title);
                    continue;
                }
                if (status.left) {
                    const result = await askMain('complete', 120000);
                    componentsDone += result?.done || 0;
                    await sleep(1000); // let the player send its tracking statements before the next module loads
                }
                modulesDone++;
            }
            console.log('[Naki] NetAcad course skip:', { modulesDone, componentsDone, failed });
            const message = tr('netacadSkipCourseDone', { modules: modulesDone, components: componentsDone }) +
                (failed.length ? tr('netacadSkipFailed', { list: failed.join(', ') }) : '');
            ui.show(failed.length && !modulesDone ? 'error' : 'success', message, { duration: 15000 });
        } catch (error) {
            console.error('[Naki] NetAcad skip error:', error);
            ui.show('error', tr('toastSkipError', { error: error.message }));
        } finally {
            state.skipping = false;
        }
    }

    // Fallback for pages without Adapt models: goes through the components on the screen like a person would.
    async function skipCurrentPage() {
        const roots = collectRoots();
        // Bare ".component" wrappers, optional spacers and hidden components do not count for progress.
        const components = roots.flatMap(root => [...root.querySelectorAll('.component')])
            .filter(component => component.classList.length > 1 && !component.classList.contains('is-question') &&
                !component.classList.contains('is-optional') && component.getClientRects().length > 0);
        const isMedia = component => component.classList.contains('media') || deepQueryAll(component, `video, ${PLAY_BUTTON}`).length > 0;
        const media = components.filter(isMedia);
        // Videos outside course components (plain pages) are finished on their own.
        const videos = roots.flatMap(root => [...root.querySelectorAll('video')]).filter(video => !media.some(m => composedContains(m, video)));
        const total = components.length + videos.length;
        console.log('[Naki] NetAcad skip:', { components: components.length, media: media.length, videos: videos.length });
        if (!total) {
            ui.show('info', tr('netacadSkipNothing'), { duration: 8000 });
            return;
        }
        let done = 0;
        const progress = () => ui.show('info', tr('netacadSkipping', { done, total }));
        progress();

        let videosDone = 0;
        const restoreZoom = zoomOut(roots);
        try {
            for (const video of videos) {
                video.scrollIntoView({ block: 'center' });
                if (await finishVideo(video, null)) videosDone++;
                done++;
                progress();
            }
            for (const component of components) {
                if (!isComplete(component)) {
                    await bringIntoView(component);
                    if (media.includes(component)) {
                        const video = await videoOf(component);
                        if (video && await finishVideo(video, component)) videosDone++;
                    } else if (deepQueryAll(component, 'play-pause').length) {
                        await finishAnimation(component);
                    } else {
                        await openAllItems(component, roots);
                    }
                } else if (media.includes(component)) {
                    videosDone++;
                }
                done++;
                progress();
            }
        } finally {
            restoreZoom();
        }
        const complete = components.filter(component => component.classList.contains('is-complete')).length;
        const summary = [
            components.length ? `${tr('netacadSkipComponents')} ${complete}/${components.length}` : '',
            media.length + videos.length ? `${tr('netacadSkipVideos')} ${videosDone}/${media.length + videos.length}` : ''
        ].filter(Boolean).join(', ');
        ui.show('success', tr('netacadSkipDone', { summary }), { duration: 12000 });
    }

    // ------------------------------------------------------------------ hotkeys

    function isEditableTarget(target) {
        return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    window.addEventListener('keydown', function onKeydown(event) {
        if (!alive()) {
            window.removeEventListener('keydown', onKeydown, true);
            return;
        }
        if (event.repeat) return;
        const { solve: solveKey, skip: skipKey } = state.settings.hotkeys;
        const type = Naki.hotkeyMatches(solveKey, event) ? Naki.MSG.SOLVE : Naki.hotkeyMatches(skipKey, event) ? Naki.MSG.SKIP : null;
        if (!type) return;
        if (!Naki.hasModifier(type === Naki.MSG.SOLVE ? solveKey : skipKey) && isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isTop) handle(type);
        else chrome.runtime.sendMessage({ type: Naki.MSG.RELAY, action: type }).catch(() => { });
    }, true);

    function handle(type) {
        if (type === Naki.MSG.SOLVE) solve();
        else if (type === Naki.MSG.SKIP) skipMaterials();
    }

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
                case Naki.MSG.SKIP:
                    handle(message.type);
                    sendResponse({ ok: true });
                    break;
                case Naki.MSG.STATUS:
                    sendResponse({ ok: true, site: 'netacad', solving: state.solving, skipping: state.skipping });
                    break;
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && alive()) Naki.loadSettings().then(applySettings);
    });
    Naki.loadSettings().then(applySettings);

    // The NetAcad course player (netacad.com/launch) re-renders the page and can drop the on-page button.
    if (isTop) {
        const timer = setInterval(() => {
            if (!alive()) clearInterval(timer);
            else if (state.settings.netacadButton && !document.getElementById(HOST_ID)) ui.ensure();
        }, 2000);
        console.log('[Naki] NSolver NetAcad mode loaded — made by Naki: https://github.com/Naki-404/NSolver');
    }
})();
