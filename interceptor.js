// Runs in the page (MAIN world). Captures only the Coursera API responses the extension needs
// and forwards them to content.js via window.postMessage. NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    if (window.__nakiInterceptorInstalled) return;
    window.__nakiInterceptorInstalled = true;

    // During an autopilot run (content.js sets data-naki-autopilot) a "Leave site?" prompt would stop it on the page:
    // this listener comes first (document_start) and keeps the page's own beforeunload handlers from running.
    window.addEventListener('beforeunload', event => {
        if (document.documentElement.dataset.nakiAutopilot === '1') event.stopImmediatePropagation();
    }, true);

    const CHANNEL = 'naki-coursera';
    const WATCHED = [
        { kind: 'quizState', test: url => url.includes('opname=querystate') },
        { kind: 'courseMaterials', test: url => url.includes('ondemandcoursematerials') || url.includes('includes=modules') }
    ];
    const latest = new Map(); // kind -> last payload, replayed when content.js asks for it

    function classify(url) {
        if (!url) return null;
        const lower = String(url).toLowerCase();
        const match = WATCHED.find(entry => entry.test(lower));
        return match ? match.kind : null;
    }

    function publish(kind, url, data) {
        const payload = { channel: CHANNEL, kind, url, data };
        latest.set(kind, payload);
        window.postMessage(payload, window.location.origin);
    }

    function parseJson(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.channel !== CHANNEL || event.data.kind !== 'replay') return;
        for (const payload of latest.values()) window.postMessage(payload, window.location.origin);
    });

    // XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__nakiKind = classify(url);
        this.__nakiUrl = url;
        return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        if (this.__nakiKind) {
            this.addEventListener('load', function () {
                if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
                const data = this.responseType === 'json' ? this.response : parseJson(this.responseText);
                if (data) publish(this.__nakiKind, this.__nakiUrl, data);
            });
        }
        return originalSend.apply(this, arguments);
    };

    // fetch: the page gets its response immediately, the copy is parsed in the background.
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        const promise = originalFetch.apply(this, arguments);
        const url = input instanceof Request ? input.url : String(input || '');
        const kind = classify(url);
        if (kind) {
            promise.then(response => {
                response.clone().json().then(data => publish(kind, response.url || url, data)).catch(() => { });
            }).catch(() => { });
        }
        return promise;
    };
})();
