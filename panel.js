// Popup UI (Coursera and Cisco NetAcad). NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    const VERSION = chrome.runtime.getManifest().version;
    const REPO_URL = 'https://github.com/Naki-404/NSolver';
    const MODEL_LIST_TTL_MS = 12 * 60 * 60 * 1000;
    const CUSTOM = '__custom__';

    const ICONS = {
        bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
        skip: '<svg viewBox="0 0 24 24"><path d="M5 5.5v13a1 1 0 0 0 1.5.86L15 14.3v4.2a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.2L6.5 4.64A1 1 0 0 0 5 5.5z"/></svg>',
        spinner: '<svg class="spin" viewBox="0 0 24 24"><path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/></svg>',
        refresh: '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.74 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
        eye: '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24"><path d="M2 4.27 3.27 3 21 20.73 19.73 22l-3.08-3.08A11.8 11.8 0 0 1 12 19.5c-5 0-9.27-3.11-11-7.5a12.6 12.6 0 0 1 3.97-5.25L2 4.27zM12 7a5 5 0 0 1 4.65 6.85l2.92 2.92A12.5 12.5 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A5 5 0 0 1 12 7zm-4.47 2.8A5 5 0 0 0 14.2 16.47l-1.55-1.55A3 3 0 0 1 9.08 11.35L7.53 9.8z"/></svg>'
    };

    const providerOptions = Naki.PROVIDER_IDS.map(id => `<option value="${id}">${ModelProvider.PROVIDERS[id].name}</option>`).join('');

    document.getElementById('app').innerHTML = `
        <header class="header">
            <img src="images/48.png" alt="">
            <div class="brand">
                <h1>NSolver</h1>
                <p>made by <a class="repo-link" href="${REPO_URL}" title="GitHub: Naki-404/NSolver">Naki</a></p>
            </div>
            <div class="segmented lang" role="group" aria-label="Language">
                <button type="button" data-lang="ru">RU</button>
                <button type="button" data-lang="en">EN</button>
            </div>
        </header>

        <nav class="segmented tabs" role="tablist">
            <button type="button" data-tab="main"><span data-i18n="tabMain"></span></button>
            <button type="button" data-tab="settings"><span data-i18n="tabSettings"></span></button>
        </nav>

        <div class="page" data-page="main">
            <div class="status" id="status"><span class="dot"></span><span class="status-text" id="statusText"></span></div>

            <section class="card">
                <div class="card-title"><h2>Quiz Solver</h2><span id="modelBadge"></span></div>
                <button class="btn" id="solve" type="button">${ICONS.bolt}<span class="btn-label" data-i18n="solve"></span><kbd id="solveKbd"></kbd></button>
                <div class="row" id="autoSolveRow">
                    <label class="label-text" for="autoSolve"><span data-i18n="autoSolve"></span><small data-i18n="autoSolveHint"></small></label>
                    <label class="switch"><input type="checkbox" id="autoSolve"><span class="track"></span></label>
                </div>
            </section>

            <section class="card" id="skipCard">
                <div class="card-title"><h2 data-i18n="skipTitle"></h2></div>
                <button class="btn secondary" id="skip" type="button">${ICONS.skip}<span class="btn-label" data-i18n="skip"></span><kbd id="skipKbd" hidden></kbd></button>
                <div class="row">
                    <label class="label-text" for="skipDiscussions"><span data-i18n="skipDiscussions"></span><small data-i18n="skipDiscussionsHint"></small></label>
                    <label class="switch"><input type="checkbox" id="skipDiscussions"><span class="track"></span></label>
                </div>
            </section>

            <section class="card" id="netacadCard" hidden>
                <div class="card-title"><h2>Cisco NetAcad</h2></div>
                <div class="row">
                    <label class="label-text" for="netacadButton"><span data-i18n="netacadButton"></span><small data-i18n="netacadButtonHint"></small></label>
                    <label class="switch"><input type="checkbox" id="netacadButton"><span class="track"></span></label>
                </div>
                <div class="row">
                    <div class="label-text"><span data-i18n="capturePermission"></span><small data-i18n="capturePermissionHint"></small></div>
                    <button class="btn small secondary" id="grantCapture" type="button"><span data-i18n="grant"></span></button>
                </div>
            </section>
        </div>

        <div class="page" data-page="settings" hidden>
            <section class="card">
                <div class="field">
                    <span class="field-label" data-i18n="provider"></span>
                    <select id="provider">${providerOptions}</select>
                </div>
                <div class="field">
                    <span class="field-label" data-i18n="model"></span>
                    <div class="with-action">
                        <select id="modelSelect"></select>
                        <button type="button" class="square-btn" id="loadModels" data-i18n-title="loadModels">${ICONS.refresh}</button>
                    </div>
                    <input type="text" id="modelCustom" autocomplete="off" spellcheck="false" data-i18n-placeholder="modelCustomPlaceholder" hidden>
                </div>
                <div class="field">
                    <div class="field-label"><span data-i18n="apiKey"></span><a href="#" id="keyLink" data-i18n="getKey"></a></div>
                    <div class="key-row">
                        <div class="key-input">
                            <input type="password" id="apiKey" autocomplete="off" spellcheck="false" data-i18n-placeholder="keyPlaceholder">
                            <button type="button" id="toggleKey">${ICONS.eye}</button>
                        </div>
                        <button class="btn small" id="saveKey" type="button"><span data-i18n="save"></span></button>
                    </div>
                    <p class="message" id="keyMessage"></p>
                </div>
            </section>

            <section class="card">
                <div class="card-title"><h2 data-i18n="hotkeys"></h2></div>
                <div class="hotkey" data-action="solve">
                    <span class="name">Quiz Solver</span>
                    <button class="hotkey-btn" type="button"></button>
                    <button class="clear-btn" type="button" data-i18n-title="hotkeyReset">×</button>
                </div>
                <div class="hotkey" data-action="skip">
                    <span class="name" data-i18n="skip"></span>
                    <button class="hotkey-btn" type="button"></button>
                    <button class="clear-btn" type="button" data-i18n-title="hotkeyReset">×</button>
                </div>
                <p class="hint" data-i18n="hotkeysHint"></p>
            </section>
        </div>

        <footer class="footer">made by <a class="repo-link" href="${REPO_URL}">Naki</a> · v${VERSION} · <a class="repo-link" href="${REPO_URL}">GitHub ↗</a></footer>
    `;

    const $ = id => document.getElementById(id);
    let settings = Naki.withDefaults({});
    let modelLists = {}; // provider -> { ids: string[], at: timestamp }
    const tr = (key, vars) => Naki.t(settings.lang, key, vars);

    // ------------------------------------------------------------------ translations & tabs

    function applyTranslations() {
        document.documentElement.lang = settings.lang;
        document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tr(el.dataset.i18nTitle); });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
        document.querySelectorAll('[data-lang]').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === settings.lang));
        renderStatus();
        renderKeyMessage();
    }

    document.querySelectorAll('[data-lang]').forEach(btn => btn.addEventListener('click', () => Naki.saveSettings({ lang: btn.dataset.lang })));

    function showTab(tab) {
        document.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
        document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== tab; });
        try { localStorage.setItem('nakiTab', tab); } catch (e) { }
    }
    document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
    let initialTab = 'main';
    try { initialTab = localStorage.getItem('nakiTab') || 'main'; } catch (e) { }
    showTab(initialTab);

    // ------------------------------------------------------------------ tab status

    async function targetTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab;
    }

    // NetAcad hosts and files come from the netacad.js content script entry in the manifest.
    const NETACAD_SCRIPT = chrome.runtime.getManifest().content_scripts.find(entry => entry.js.includes('netacad.js'));
    const NETACAD_HOSTS = NETACAD_SCRIPT.matches.map(pattern => pattern.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/.*$/, ''));

    function isNetacadUrl(url) {
        try {
            const host = new URL(url).hostname;
            return NETACAD_HOSTS.some(base => host === base || host.endsWith('.' + base));
        } catch (e) {
            return false;
        }
    }

    // Chrome may skip the content script on NetAcad: site access limited for the extension, the extension reloaded
    // while the course was open, a course player opened in a way that bypassed injection. Opening this panel grants
    // activeTab, so the script can be injected from here; netacad.js ignores a second copy.
    async function injectNetacad(tab) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: NETACAD_SCRIPT.js });
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: NETACAD_SCRIPT.js })
            .catch(error => console.warn('[Naki] NetAcad frames not injected:', error.message));
    }

    async function sendToTab(message) {
        const tab = await targetTab();
        if (!tab?.id) throw new Error('no tab');
        try {
            return await chrome.tabs.sendMessage(tab.id, message);
        } catch (error) {
            if (!isNetacadUrl(tab.url)) throw error;
            console.warn('[Naki] No NetAcad script in the tab, injecting it:', error.message);
            await injectNetacad(tab);
            return chrome.tabs.sendMessage(tab.id, message);
        }
    }

    let status = { kind: '', key: 'statusChecking', vars: {}, suffix: null };
    function setStatus(kind, key, vars = {}, suffix = null) {
        status = { kind, key, vars, suffix };
        renderStatus();
    }
    function renderStatus() {
        $('status').className = `status ${status.kind}`;
        $('statusText').textContent = tr(status.key, status.vars) + (status.suffix ? tr(status.suffix) : '');
    }

    // Coursera and Cisco NetAcad share the solve button; the rest of the main page depends on the site.
    function showSite(site) {
        const netacad = site === 'netacad';
        $('autoSolveRow').hidden = netacad;
        $('skipCard').hidden = netacad;
        $('netacadCard').hidden = !netacad;
        const label = $('solve').querySelector('.btn-label');
        label.dataset.i18n = netacad ? 'solveScreen' : 'solve';
        if (!$('solve').disabled) label.textContent = tr(label.dataset.i18n);
        if (netacad) renderCapturePermission();
    }

    async function refreshStatus() {
        try {
            const result = await sendToTab({ type: Naki.MSG.STATUS });
            if (!result?.ok) throw new Error('no status');
            showSite(result.site);
            if (result.site === 'netacad') setStatus(result.solving ? 'busy' : 'ready', result.solving ? 'statusSolving' : 'statusNetacad');
            else if (result.solving) setStatus('busy', 'statusSolving');
            else if (result.skipping) setStatus('busy', 'statusSkipping');
            else if (result.questions) setStatus('ready', 'statusQuiz', { n: result.questions }, result.onAttempt ? null : 'statusOpenAttempt');
            else setStatus('course', result.onAttempt ? 'statusWaiting' : 'statusCourse');
        } catch (e) {
            const tab = await targetTab().catch(() => null);
            setStatus('', tab && isNetacadUrl(tab.url) ? 'statusNetacadNoAccess' : 'statusNoCourse');
        }
    }

    async function runAction(button, type) {
        const label = button.querySelector('.btn-label');
        const icon = button.querySelector('svg');
        const iconHtml = icon.outerHTML;
        button.disabled = true;
        icon.outerHTML = ICONS.spinner;
        label.textContent = tr('starting');
        try {
            await sendToTab({ type });
        } catch (e) {
            setStatus('', 'statusNoCourse');
        }
        setTimeout(() => {
            button.querySelector('svg').outerHTML = iconHtml;
            label.textContent = tr(label.dataset.i18n);
            button.disabled = false;
            refreshStatus();
        }, 1200);
    }

    $('solve').addEventListener('click', () => {
        if (!Naki.activeKey(settings)) {
            showTab('settings');
            setKeyMessage('keyFirst', 'error');
            $('apiKey').focus();
            return;
        }
        runAction($('solve'), Naki.MSG.SOLVE);
    });
    $('skip').addEventListener('click', () => runAction($('skip'), Naki.MSG.SKIP));

    // ------------------------------------------------------------------ settings: provider, model, key

    let keyMessage = null; // { key, kind, vars } so it can be re-translated
    function setKeyMessage(key, kind = '', vars = {}) {
        keyMessage = { key, kind, vars };
        renderKeyMessage();
    }
    function renderKeyMessage() {
        const msg = keyMessage || (Naki.activeKey(settings) ? { key: 'keySaved', kind: 'success' } : { key: 'keyMissing', kind: '' });
        $('keyMessage').textContent = tr(msg.key, msg.vars);
        $('keyMessage').className = `message ${msg.kind}`;
    }

    let customMode = false;

    function renderModelSelect() {
        const provider = settings.provider;
        const current = Naki.activeModel(settings);
        const fetched = modelLists[provider]?.ids || [];
        const ids = fetched.length ? [...fetched] : [...ModelProvider.PROVIDERS[provider].models];
        if (current && !ids.includes(current)) ids.unshift(current);

        const select = $('modelSelect');
        select.innerHTML = '';
        for (const id of ids) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = id;
            select.appendChild(option);
        }
        const custom = document.createElement('option');
        custom.value = CUSTOM;
        custom.textContent = tr('modelCustom');
        select.appendChild(custom);

        select.value = customMode ? CUSTOM : current;
        $('modelCustom').hidden = !customMode;
        if (customMode && document.activeElement !== $('modelCustom')) $('modelCustom').value = current;
    }

    function renderSettings() {
        $('provider').value = settings.provider;
        if (document.activeElement !== $('apiKey')) $('apiKey').value = settings.apiKeys[settings.provider] || '';
        $('modelBadge').textContent = `${ModelProvider.providerName(settings.provider)} · ${Naki.activeModel(settings)}`;
        $('autoSolve').checked = settings.autoSolve;
        $('skipDiscussions').checked = settings.skipDiscussions;
        $('netacadButton').checked = settings.netacadButton;
        renderModelSelect();
        renderKeyMessage();
    }

    function saveModel(id) {
        if (!id) return;
        Naki.saveSettings({ models: { ...settings.models, [settings.provider]: id } });
    }

    $('modelSelect').addEventListener('change', () => {
        if ($('modelSelect').value === CUSTOM) {
            customMode = true;
            renderModelSelect();
            $('modelCustom').focus();
            return;
        }
        customMode = false;
        saveModel($('modelSelect').value);
    });

    $('modelCustom').addEventListener('change', () => saveModel($('modelCustom').value.trim()));
    $('modelCustom').addEventListener('keydown', event => {
        if (event.key === 'Enter') $('modelCustom').blur();
    });

    // Fetches the provider's current model list; silent mode is used for automatic refreshes.
    async function loadModels({ silent = false, apiKey } = {}) {
        const provider = settings.provider;
        const key = (apiKey || settings.apiKeys[provider] || '').trim();
        if (!key) return;
        const button = $('loadModels');
        button.disabled = true;
        button.innerHTML = ICONS.spinner;
        if (!silent) setKeyMessage('modelsLoading');
        try {
            const ids = await ModelProvider.listModels({ provider, apiKey: key, lang: settings.lang });
            if (!ids.length) throw new Error('empty list');
            modelLists = { ...modelLists, [provider]: { ids, at: Date.now() } };
            await Naki.saveSettings({ modelLists });
            if (!silent) setKeyMessage('modelsLoaded', 'success', { n: ids.length });
        } catch (error) {
            if (!silent) setKeyMessage('modelsFailed', 'error', { error: error.message });
            else console.warn('[Naki] Model list refresh failed:', error.message);
        } finally {
            button.disabled = false;
            button.innerHTML = ICONS.refresh;
            renderModelSelect();
        }
    }

    function refreshModelsIfStale() {
        const entry = modelLists[settings.provider];
        if (Naki.activeKey(settings) && (!entry || Date.now() - entry.at > MODEL_LIST_TTL_MS)) loadModels({ silent: true });
    }

    $('loadModels').addEventListener('click', () => loadModels({ apiKey: $('apiKey').value }));

    $('provider').addEventListener('change', async () => {
        keyMessage = null;
        customMode = false;
        await Naki.saveSettings({ provider: $('provider').value });
        refreshModelsIfStale();
    });

    $('autoSolve').addEventListener('change', () => {
        if ($('autoSolve').checked && !Naki.activeKey(settings)) {
            $('autoSolve').checked = false;
            showTab('settings');
            setKeyMessage('keyFirst', 'error');
            $('apiKey').focus();
            return;
        }
        Naki.saveSettings({ autoSolve: $('autoSolve').checked });
    });

    $('skipDiscussions').addEventListener('change', () => Naki.saveSettings({ skipDiscussions: $('skipDiscussions').checked }));
    $('netacadButton').addEventListener('change', () => Naki.saveSettings({ netacadButton: $('netacadButton').checked }));

    // ------------------------------------------------------------------ NetAcad screenshot permission
    // Opening this panel grants activeTab, so its solve button always works; the on-page button and hotkey need <all_urls>.

    const CAPTURE_PERMISSION = { origins: ['<all_urls>'] };

    async function renderCapturePermission() {
        const granted = await chrome.permissions.contains(CAPTURE_PERMISSION).catch(() => false);
        const button = $('grantCapture');
        const label = button.querySelector('span');
        button.disabled = granted;
        label.dataset.i18n = granted ? 'granted' : 'grant';
        label.textContent = tr(label.dataset.i18n);
    }

    $('grantCapture').addEventListener('click', async () => {
        // The popup may close while Chrome shows the prompt; the grant still applies.
        await chrome.permissions.request(CAPTURE_PERMISSION).catch(error => console.warn('[Naki] Permission request failed:', error));
        renderCapturePermission();
    });

    let keyVisible = false;
    $('toggleKey').addEventListener('click', () => {
        keyVisible = !keyVisible;
        $('apiKey').type = keyVisible ? 'text' : 'password';
        $('toggleKey').innerHTML = keyVisible ? ICONS.eyeOff : ICONS.eye;
    });

    $('apiKey').addEventListener('keydown', event => {
        if (event.key === 'Enter') $('saveKey').click();
    });

    $('saveKey').addEventListener('click', async () => {
        const key = $('apiKey').value.trim();
        if (!key) {
            setKeyMessage('keyEnter', 'error');
            return;
        }
        const button = $('saveKey');
        const label = button.querySelector('span');
        const provider = settings.provider;
        button.disabled = true;
        label.textContent = tr('checking');
        await Naki.saveSettings({ apiKeys: { ...settings.apiKeys, [provider]: key } });
        // Pull the provider's full, current model list as soon as a key is saved.
        await loadModels({ silent: true, apiKey: key });
        try {
            const result = await ModelProvider.testApiKey({ provider, apiKey: key, modelId: Naki.activeModel(settings), lang: settings.lang });
            const count = modelLists[provider]?.ids?.length;
            setKeyMessage('keyOk', 'success', { model: count ? `${result.modelId}; ${tr('modelsLoaded', { n: count })}` : result.modelId });
        } catch (error) {
            setKeyMessage('keyFail', 'error', { error: error.message });
        } finally {
            button.disabled = false;
            label.textContent = tr('save');
        }
    });

    document.querySelectorAll('.repo-link').forEach(link => link.addEventListener('click', event => {
        event.preventDefault();
        chrome.tabs.create({ url: REPO_URL });
    }));

    $('keyLink').addEventListener('click', event => {
        event.preventDefault();
        chrome.tabs.create({ url: ModelProvider.PROVIDERS[settings.provider].keyUrl });
    });

    // ------------------------------------------------------------------ hotkeys

    let recording = null; // { action, button }

    function renderHotkeys() {
        for (const row of document.querySelectorAll('.hotkey')) {
            const hotkey = settings.hotkeys[row.dataset.action];
            const button = row.querySelector('.hotkey-btn');
            if (button.classList.contains('recording')) continue;
            button.textContent = Naki.formatHotkey(hotkey, settings.lang);
            button.classList.toggle('empty', !hotkey);
            row.querySelector('.clear-btn').hidden = !hotkey;
        }
        for (const [id, hotkey] of [['solveKbd', settings.hotkeys.solve], ['skipKbd', settings.hotkeys.skip]]) {
            $(id).textContent = Naki.formatHotkey(hotkey, settings.lang);
            $(id).hidden = !hotkey;
        }
    }

    function stopRecording() {
        if (!recording) return;
        recording.button.classList.remove('recording');
        recording = null;
        renderHotkeys();
    }

    for (const row of document.querySelectorAll('.hotkey')) {
        const action = row.dataset.action;
        const button = row.querySelector('.hotkey-btn');
        button.addEventListener('click', () => {
            if (recording) stopRecording();
            recording = { action, button };
            button.classList.add('recording');
            button.classList.remove('empty');
            button.textContent = tr('hotkeyPress');
        });
        row.querySelector('.clear-btn').addEventListener('click', () => {
            stopRecording();
            Naki.saveSettings({ hotkeys: { ...settings.hotkeys, [action]: null } });
        });
    }

    document.addEventListener('keydown', event => {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
            stopRecording();
            return;
        }
        const hotkey = Naki.hotkeyFromEvent(event);
        if (!hotkey) {
            const mods = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean);
            recording.button.textContent = mods.length ? mods.join('+') + '+…' : tr('hotkeyPress');
            return;
        }
        const { action } = recording;
        const other = action === 'solve' ? 'skip' : 'solve';
        const hotkeys = { ...settings.hotkeys, [action]: hotkey };
        if (settings.hotkeys[other] && Naki.formatHotkey(settings.hotkeys[other]) === Naki.formatHotkey(hotkey)) {
            hotkeys[other] = null; // one combination cannot trigger two actions
        }
        recording.button.classList.remove('recording');
        recording = null;
        Naki.saveSettings({ hotkeys });
    }, true);

    // ------------------------------------------------------------------ init

    async function reload() {
        settings = await Naki.loadSettings();
        const { modelLists: stored } = await chrome.storage.local.get('modelLists');
        modelLists = stored && typeof stored === 'object' ? stored : {};
        for (const [provider, entry] of Object.entries(modelLists)) {
            if (Array.isArray(entry)) modelLists[provider] = { ids: entry, at: 0 }; // v2.1 format
        }
        applyTranslations();
        renderSettings();
        renderHotkeys();
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') reload();
    });

    reload().then(() => {
        refreshStatus();
        refreshModelsIfStale();
    });
})();
