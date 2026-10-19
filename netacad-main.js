// Runs in the NetAcad page (MAIN world, top frame). NetAcad courses are Adapt courses whose models hang on the
// course web components (element.model) and are invisible to the isolated content script: this script finds the
// loaded module's course model and marks its components complete on request from netacad.js (window.postMessage).
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    if (window.__nakiNetacadMain) return;
    window.__nakiNetacadMain = true;

    const CHANNEL = 'naki-netacad-main';
    const BATCH = 20;            // components per step: NetAcad sends a tracking statement for each one
    const BATCH_PAUSE_MS = 100;
    // Assessment screens are part of quizzes; questions are answered by the solver, not skipped.
    const NOT_SKIPPED = /^(adaptiveStartScreen|assessmentResults)$/;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const get = (model, key) => { try { return model.get(key); } catch (e) { return undefined; } };

    // Documents of this page and of its same-origin frames (the course player loads the module in an iframe).
    function documents(doc = document, out = []) {
        out.push(doc);
        for (const frame of doc.querySelectorAll('iframe, frame')) {
            try { if (frame.contentDocument && frame.contentDocument.documentElement) documents(frame.contentDocument, out); } catch (e) { }
        }
        return out;
    }

    // Any rendered course element carries its model; the course model is the root of its ancestors.
    function findCourse() {
        for (const doc of documents()) {
            const stack = [doc];
            while (stack.length) {
                const root = stack.pop();
                for (const el of root.querySelectorAll('*')) {
                    const model = el.model;
                    if (model && typeof model.getAncestorModels === 'function' && typeof model.getAllDescendantModels === 'function') {
                        const ancestors = model.getAncestorModels();
                        const course = ancestors[ancestors.length - 1] || model;
                        if (get(course, '_type') === 'course') return { course, win: doc.defaultView };
                    }
                    if (el.shadowRoot) stack.push(el.shadowRoot);
                }
            }
        }
        return null;
    }

    // The module package id is part of the course data URL: …/courses/<course>/<module>/<lang>/components.json
    function packageId(win) {
        const urls = win.performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /\/components\.json/.test(url));
        const match = (urls.pop() || '').match(/\/courses\/[^/]+\/([^/]+)\//);
        return match ? match[1] : null;
    }

    function inAssessment(model) {
        return model.getAncestorModels().some(ancestor => get(ancestor, '_assessment')?._isEnabled);
    }

    function skippable(course) {
        return course.getAllDescendantModels(true).filter(model =>
            get(model, '_type') === 'component' && !get(model, '_isComplete') && !get(model, '_isOptional') &&
            !get(model, '_isQuestionType') && !NOT_SKIPPED.test(get(model, '_component') || '') && !inAssessment(model));
    }

    function status() {
        const found = findCourse();
        if (!found) return { ready: false };
        const { course, win } = found;
        const components = course.getAllDescendantModels(true).filter(model => get(model, '_type') === 'component');
        return {
            ready: true,
            packageId: packageId(win),
            title: String(get(course, 'title') || ''),
            components: components.length,
            left: skippable(course).length
        };
    }

    async function completeModule() {
        const found = findCourse();
        if (!found) return { ready: false };
        const targets = skippable(found.course);
        let done = 0, failed = 0;
        for (let i = 0; i < targets.length; i++) {
            try {
                targets[i].setCompletionStatus();
                if (get(targets[i], '_isComplete')) done++; else failed++;
            } catch (e) {
                failed++;
            }
            if (i % BATCH === BATCH - 1) await sleep(BATCH_PAUSE_MS);
        }
        return { ready: true, done, failed, total: targets.length };
    }

    window.addEventListener('message', async event => {
        const data = event.data;
        if (event.source !== window || !data || data.channel !== CHANNEL || !data.request) return;
        let result;
        try {
            result = data.request === 'complete' ? await completeModule() : status();
        } catch (error) {
            result = { ready: false, error: error.message };
        }
        window.postMessage({ channel: CHANNEL, reply: data.id, result }, window.location.origin);
    });
})();
