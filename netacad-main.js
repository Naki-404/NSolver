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

    // ---------------------------------------------------------------- module texts for the materials base
    // Every page of the loaded module as plain text: component titles, bodies and items, and for questions the
    // question with its correct options (from the course data), which helps with quizzes built on the same topics.

    const courseOf = url => (url.match(/\/courses\/([^/]+)\/[^/]+\/[^/]+\/components\.json/) || [])[1] || null;
    const plain = html => {
        const text = new DOMParser().parseFromString(String(html || '').replace(/<\/(p|div|li|h[1-6]|tr|td|th)>|<br\s*\/?>/gi, '$& '), 'text/html').body.textContent || '';
        return text.replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();
    };

    function componentText(model) {
        const parts = [plain(get(model, 'displayTitle') || get(model, 'title')), plain(get(model, 'body'))];
        const items = get(model, '_items') || [];
        if (get(model, '_isQuestionType')) {
            const correct = items.filter(item => item._shouldBeSelected).map(item => plain(item.text || item.title || item.body));
            if (correct.length) parts.push(`Correct answer: ${correct.join('; ')}.`);
        } else {
            for (const item of items) parts.push([item.title, item.body, item.text, item.strapline].map(plain).filter(Boolean).join(': '));
        }
        return parts.filter(Boolean).join(' ');
    }

    // A question of the course data: its text, options and, when the data has them, the correct options.
    function questionEntry(model) {
        const items = get(model, '_items') || [];
        const known = items.length > 0 && items.every(item => typeof item._shouldBeSelected === 'boolean') && items.some(item => item._shouldBeSelected);
        return {
            id: get(model, '_id'),
            component: String(get(model, '_component') || ''),
            question: plain(get(model, 'body')) || plain(get(model, 'displayTitle') || get(model, 'title')),
            options: items.map(item => plain(item.text || item.title || item.body)),
            multiple: (get(model, '_selectable') || 1) > 1 || items.filter(item => item._shouldBeSelected).length > 1,
            correct: known ? items.filter(item => item._shouldBeSelected).map(item => plain(item.text || item.title || item.body)) : null
        };
    }
    const isChoice = entry => /mcq/i.test(entry.component) && entry.options.length >= 2 && entry.options.every(Boolean) && entry.question;

    function texts() {
        const found = findCourse();
        if (!found) return { ready: false };
        const { course: model, win } = found;
        const urls = win.performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /\/components\.json/.test(url));
        const pages = model.getAllDescendantModels(true).filter(m => get(m, '_type') === 'page');
        const docs = pages.map(page => ({
            title: plain(get(page, 'displayTitle') || get(page, 'title')) || String(get(page, '_id')),
            text: page.getAllDescendantModels(true).filter(m => get(m, '_type') === 'component').map(componentText).filter(Boolean).join('\n')
        })).filter(doc => doc.text.length > 40);
        // Questions with known answers (Check Your Understanding and others): quizzes and checkpoint exams reuse them.
        const qa = model.getAllDescendantModels(true).filter(m => get(m, '_isQuestionType')).map(questionEntry)
            .filter(entry => entry.correct && isChoice(entry)).map(({ question, options, correct }) => ({ q: question, options, correct }));
        return { ready: true, courseId: courseOf(urls.pop() || ''), packageId: packageId(win), title: String(get(model, 'title') || ''), docs, qa };
    }

    // ---------------------------------------------------------------- quizzes (Adapt assessments)
    // Every "Check Your Understanding" and module quiz is an article with _assessment._isEnabled. Flow verified on
    // NetAcad: Start → one question at a time (answer + Submit arrow) → "Submit My Assessment" (confirm checkbox +
    // Submit) → results (Reset for another attempt). The correct options are in the course data
    // (_items[]._shouldBeSelected); other questions are handed to the extension's AI solver (netacad.js).

    const visible = el => el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;

    function allElements(doc) {
        const out = [];
        const stack = [doc];
        while (stack.length) {
            const root = stack.pop();
            for (const el of root.querySelectorAll('*')) {
                out.push(el);
                if (el.shadowRoot) stack.push(el.shadowRoot);
            }
        }
        return out;
    }

    const findDeep = (doc, test) => allElements(doc).find(test);
    const modelId = el => (el.model && typeof el.model.get === 'function' ? get(el.model, '_id') : undefined);

    function belongsTo(model, articleId) {
        return get(model, '_id') === articleId || model.getAncestorModels().some(ancestor => get(ancestor, '_id') === articleId);
    }

    function assessmentArticles(course) {
        return course.getAllDescendantModels(true).filter(model => get(model, '_type') === 'article' && get(model, '_assessment')?._isEnabled);
    }

    function articleState(article) {
        return {
            id: get(article, '_id'),
            title: String(get(article, 'title') || get(article, 'displayTitle') || '').replace(/\{\{[^}]*\}\}/g, '').trim(),
            complete: !!get(article, '_isAssessmentComplete'),
            pass: !!get(article, '_isPass'),
            percent: Math.round(get(article, '_scoreAsPercent') || 0)
        };
    }

    function currentArticle(articleId) {
        const found = findCourse();
        if (!found) return null;
        const article = found.course.getAllDescendantModels(true).find(model => get(model, '_id') === articleId);
        return article ? { article, doc: found.win.document, win: found.win } : null;
    }

    async function waitFor(check, timeoutMs, stepMs = 250) {
        for (let waited = 0; waited < timeoutMs; waited += stepMs) {
            const value = check();
            if (value) return value;
            await sleep(stepMs);
        }
        return check();
    }

    // The course router scrolls to an article given its id: #/courses/<course>/<module>/id/<article>
    async function openArticle(articleId) {
        const loaded = currentArticle(articleId);
        if (!loaded) return null;
        const { win } = loaded;
        if (/\/id\//.test(win.location.hash)) win.location.hash = win.location.hash.replace(/\/id\/[^/?]+/, '/id/' + articleId);
        const view = await waitFor(() => {
            const current = currentArticle(articleId);
            return current && findDeep(current.doc, el => modelId(el) === articleId && visible(el));
        }, 12000);
        if (view) {
            view.scrollIntoView({ block: 'start' });
            await sleep(400);
        }
        return view;
    }

    function clickVisible(doc, test) {
        const el = allElements(doc).find(e => visible(e) && test(e));
        if (el) el.click();
        return !!el;
    }

    const aiRequests = new Map();
    function askAi(questionId) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { aiRequests.delete(questionId); resolve(false); }, 120000);
            aiRequests.set(questionId, ok => { clearTimeout(timer); resolve(ok); });
            window.postMessage({ channel: CHANNEL, event: 'need-ai', questionId }, window.location.origin);
        });
    }

    // All questions of an assessment without answers in the data go to netacad.js at once: it answers from the
    // course's question bank (materials base) and asks the model about the rest in one request, not one per question.
    const batchAnswers = new Map(); // question id → option indices
    function askAiBatch(questions) {
        return new Promise(resolve => {
            const id = `batch-${Date.now()}`;
            const timer = setTimeout(() => { aiRequests.delete(id); resolve(null); }, 240000);
            aiRequests.set(id, answers => { clearTimeout(timer); resolve(answers); });
            window.postMessage({ channel: CHANNEL, event: 'need-ai-batch', batchId: id, questions }, window.location.origin);
        });
    }

    async function prefetchAnswers(articleId) {
        const current = currentArticle(articleId);
        if (!current) return;
        const questions = current.article.getAllDescendantModels(true).filter(m => get(m, '_isQuestionType')).map(questionEntry)
            .filter(entry => !entry.correct && isChoice(entry) && !batchAnswers.has(entry.id))
            .map(({ id, question, options, multiple }) => ({ id, question, options, multiple }));
        if (!questions.length) return;
        const answers = await askAiBatch(questions);
        for (const [id, indices] of Object.entries(answers || {})) if (Array.isArray(indices) && indices.length) batchAnswers.set(id, indices);
    }

    // Options are labelled "<question id>-<index>-label" (inputs "-input").
    async function selectOptions(doc, id, wanted) {
        for (let i = 0; i < wanted.length; i++) {
            const label = findDeep(doc, el => el.id === `${id}-${i}-label`);
            if (!label) return false;
            const input = label.getRootNode().querySelector(`[id="${id}-${i}-input"]`);
            if (!!(input && input.checked) !== wanted[i]) {
                label.click();
                await sleep(60);
            }
        }
        return true;
    }

    async function answerFromData(doc, question) {
        const id = get(question, '_id');
        const items = get(question, '_items') || [];
        if (items.length && items.every(item => typeof item._shouldBeSelected === 'boolean')) return selectOptions(doc, id, items.map(item => item._shouldBeSelected));
        if (batchAnswers.has(id)) return selectOptions(doc, id, items.map((_, i) => batchAnswers.get(id).includes(i)));
        return false;
    }

    async function submitQuestion(doc, view) {
        if (clickVisible(doc, el => el.matches('button.submit-button') && !el.disabled)) return true;
        // Classic Adapt: a Submit button inside the question itself.
        const inner = allElements(view.shadowRoot || view).find(el => visible(el) && el.matches('button') && /^\s*submit\s*$/i.test(el.textContent) && !el.disabled);
        if (inner) inner.click();
        return !!inner;
    }

    async function answerQuestions(articleId, log) {
        const answered = new Set();
        const openQuestion = doc => allElements(doc).find(el => el.model && typeof el.model.get === 'function' && get(el.model, '_isQuestionType') &&
            visible(el) && !answered.has(get(el.model, '_id')) && !get(el.model, '_isSubmitted') && belongsTo(el.model, articleId));
        const confirmShown = doc => findDeep(doc, el => el.id === 'confirm-exam' && visible(el)); // "Submit My Assessment"
        for (let step = 0; step < 300; step++) {
            const current = currentArticle(articleId);
            if (!current) return;
            const { doc } = current;
            const view = openQuestion(doc);
            if (!view) {
                if (confirmShown(doc)) return;
                // Between questions: wait for the next one or for the confirmation screen.
                const next = await waitFor(() => {
                    const again = currentArticle(articleId);
                    return again && (openQuestion(again.doc) || confirmShown(again.doc));
                }, 4000);
                if (!next) return;
                continue;
            }
            const question = view.model;
            const id = get(question, '_id');
            answered.add(id);
            let fromData = await answerFromData(doc, question);
            if (!fromData && isChoice(questionEntry(question))) {
                // "1 question at a time" exams load each question when it comes: the bank (or the model) for it now.
                await prefetchAnswers(articleId);
                fromData = await answerFromData(doc, question);
            }
            if (!fromData) {
                log.ai = (log.ai || 0) + 1;
                await askAi(id);
            }
            log.fromData = (log.fromData || 0) + (fromData ? 1 : 0);
            await sleep(150);
            if (!await submitQuestion(doc, view)) return;
            log.answered = (log.answered || 0) + 1;
            await waitFor(() => !visible(view) || !view.isConnected || get(question, '_isSubmitted'), 3000);
            await sleep(300);
        }
    }

    async function confirmSubmission(articleId) {
        const current = currentArticle(articleId);
        if (!current) return false;
        const box = findDeep(current.doc, el => el.id === 'confirm-exam' && visible(el));
        if (!box) return false;
        if (!box.checked) (box.labels && box.labels[0] || box).click();
        await sleep(200);
        if (!clickVisible(current.doc, el => el.matches('button.adaptive-assessment-submit'))) return false;
        return !!await waitFor(() => {
            const again = currentArticle(articleId);
            return again && get(again.article, '_isAssessmentComplete');
        }, 15000);
    }

    async function resetAssessment(articleId) {
        const current = currentArticle(articleId);
        if (!current) return false;
        const clicked = clickVisible(current.doc, el => el.matches('button, [role="button"], .btn') &&
            /^\s*(reset|retake|retry|try again|пройти снова|сбросить)\s*$/i.test(el.textContent) &&
            el.getRootNode().host && belongsTo(el.getRootNode().host.model || current.article, articleId));
        if (!clicked) return false;
        // NetAcad reloads the page on reset: wait for a fresh, not completed assessment.
        await sleep(1500);
        return !!await waitFor(() => {
            const again = currentArticle(articleId);
            return again && !get(again.article, '_isAssessmentComplete');
        }, 20000);
    }

    async function runAssessment(articleId, retakes, dryRun) {
        const log = { attempts: 0 };
        const allowed = 1 + Math.max(0, retakes);
        for (;;) {
            const current = currentArticle(articleId);
            if (!current) return { ...log, error: 'not loaded' };
            const state = articleState(current.article);
            if (state.complete && state.pass) return { ...log, ...state };
            if (dryRun || log.attempts >= allowed) return { ...log, ...state, dryRun };
            if (!await openArticle(articleId)) return { ...log, ...state, error: 'not opened' };
            if (state.complete && !await resetAssessment(articleId)) return { ...log, ...state, error: 'no reset' };
            await openArticle(articleId);
            const fresh = currentArticle(articleId);
            clickVisible(fresh.doc, el => el.matches('.start-button') && belongsTo((el.getRootNode().host || {}).model || fresh.article, articleId));
            await sleep(1200);
            log.attempts++;
            if (!await answerAllInOrder(articleId, log)) {
                await prefetchAnswers(articleId);
                await answerQuestions(articleId, log);
            }
            if (!await confirmSubmission(articleId)) {
                const after = currentArticle(articleId);
                return { ...log, ...(after ? articleState(after.article) : state), error: 'not submitted' };
            }
            await sleep(800);
        }
    }

    // ---------------------------------------------------------------- "Solve" on an open quiz or exam
    // The assessment on the screen (started or at its start screen) is answered question by question; it stops at
    // the "Submit My Assessment" screen, which is left to the learner.

    function activeAssessment() {
        const found = findCourse();
        if (!found) return null;
        const doc = found.win.document;
        for (const article of assessmentArticles(found.course)) {
            if (get(article, '_isAssessmentComplete')) continue;
            const id = get(article, '_id');
            const shown = findDeep(doc, el => visible(el) && el.model && typeof el.model.get === 'function' &&
                (get(el.model, '_isQuestionType') || /adaptiveStartScreen/.test(get(el.model, '_component') || '')) && belongsTo(el.model, id));
            if (shown) return id;
        }
        return null;
    }

    // Exams with "Skip All" (checkpoint exams load one question at a time): Skip All brings every question at once
    // (each with its answer in the course data), the answers of all questions are ready before the first one is
    // touched (data → question bank → one request to the model), then Q1, Q2… are opened from the question strip and
    // answered in order, up to the "Submit Page". Returns null when the assessment has no Skip All.
    const inViewport = (doc, el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left > -5 && box.left < doc.defaultView.innerWidth - 5;
    };
    const questionModels = articleId => {
        const current = currentArticle(articleId);
        return current ? current.article.getAllDescendantModels(true).filter(m => get(m, '_isQuestionType')) : [];
    };

    async function answerAllInOrder(articleId, log) {
        let current = currentArticle(articleId);
        const skipAll = current && findDeep(current.doc, el => el.id === 'skip-all-question' && belongsTo((el.getRootNode().host || {}).model || current.article, articleId));
        if (!skipAll) return null;
        if (!skipAll.checked) {
            skipAll.click();
            // Every question arrives; the strip ends with the "Submit Page".
            let count = -1;
            for (let i = 0; i < 40; i++) {
                await sleep(500);
                const now = questionModels(articleId).length;
                current = currentArticle(articleId);
                const reviewShown = current && findDeep(current.doc, el => el.matches('button.block-button.review-screen') || (el.id === 'confirm-exam' && visible(el)));
                if (reviewShown && now === count) break;
                count = now;
            }
        }
        // All answers first.
        await prefetchAnswers(articleId);
        const wantedFor = model => {
            const items = get(model, '_items') || [];
            if (items.length && items.every(item => typeof item._shouldBeSelected === 'boolean')) { log.fromData = (log.fromData || 0) + 1; return items.map(item => item._shouldBeSelected); }
            const batch = batchAnswers.get(get(model, '_id'));
            if (batch) { log.ai = (log.ai || 0) + 1; return items.map((_, i) => batch.includes(i)); }
            return null;
        };
        const strip = () => {
            const again = currentArticle(articleId);
            return again ? allElements(again.doc).filter(el => el.matches('button.block-button') && /^\s*Q\d+\s*$/.test(el.textContent)) : [];
        };
        const buttons = strip();
        for (let i = 0; i < buttons.length; i++) {
            strip()[i].click();
            // The question of that strip button slides into view.
            const view = await waitFor(() => {
                const again = currentArticle(articleId);
                return again && allElements(again.doc).find(el => el.model && typeof el.model.get === 'function' && get(el.model, '_isQuestionType') &&
                    /-VIEW$/.test(el.tagName) && el.tagName !== 'HEADING-VIEW' && belongsTo(el.model, articleId) && inViewport(again.doc, el));
            }, 6000);
            if (!view) continue;
            const doc = currentArticle(articleId).doc;
            const wanted = wantedFor(view.model);
            if (wanted) {
                await selectOptions(doc, get(view.model, '_id'), wanted);
                log.answered = (log.answered || 0) + 1;
            } else {
                // Not a choice question or no answer: the solver of netacad.js looks at the screen.
                log.ai = (log.ai || 0) + 1;
                await askAi(get(view.model, '_id'));
                log.answered = (log.answered || 0) + 1;
            }
            await sleep(250);
            // Some exams still want the per-question Submit after the answer.
            const submit = allElements(doc).find(el => el.matches('button.submit-button') && !el.disabled && visible(el) && inViewport(doc, el));
            if (submit) { submit.click(); await sleep(400); }
        }
        // The "Submit Page" with the confirmation.
        const review = allElements(currentArticle(articleId)?.doc || document).find(el => el.matches('button.block-button.review-screen'));
        if (review) review.click();
        await waitFor(() => { const again = currentArticle(articleId); return again && findDeep(again.doc, el => el.id === 'confirm-exam' && visible(el)); }, 6000);
        return log;
    }

    async function answerAssessment(articleId) {
        const log = {};
        const current = currentArticle(articleId);
        if (!current) return { ready: false };
        const questionShown = () => {
            const again = currentArticle(articleId);
            return again && findDeep(again.doc, el => visible(el) && el.model && typeof el.model.get === 'function' && get(el.model, '_isQuestionType') && belongsTo(el.model, articleId));
        };
        if (!questionShown()) {
            clickVisible(current.doc, el => el.matches('.start-button') && belongsTo((el.getRootNode().host || {}).model || current.article, articleId));
            await waitFor(questionShown, 8000);
        }
        if (!await answerAllInOrder(articleId, log)) {
            // No Skip All: one question after another as they come.
            await prefetchAnswers(articleId);
            await answerQuestions(articleId, log);
        }
        const after = currentArticle(articleId);
        const ready = !!(after && findDeep(after.doc, el => el.id === 'confirm-exam' && visible(el)));
        return { ready: true, ...log, confirm: ready, left: questionModels(articleId).length - (log.answered || 0) };
    }

    // "Check Your Understanding" activities are practice: they are not part of the course grade.
    const PRACTICE = /check your understanding|проверьте (себя|свои знания|своё понимание)|проверка понимания|compruebe su comprensión/i;
    const isPractice = article => PRACTICE.test(articleState(article).title) || get(article, '_assessment')?._assessmentWeight === 0;

    async function runQuizzes({ retakes = 0, dryRun = false, gradedOnly = true } = {}) {
        const found = findCourse();
        if (!found) return { ready: false };
        const results = [];
        for (const article of assessmentArticles(found.course)) {
            if (gradedOnly && isPractice(article)) continue;
            const id = get(article, '_id');
            const result = await runAssessment(id, retakes, dryRun);
            results.push(result);
        }
        return { ready: true, results };
    }

    window.addEventListener('message', async event => {
        const data = event.data;
        if (event.source !== window || !data || data.channel !== CHANNEL) return;
        if (data.aiDone && aiRequests.has(data.aiDone)) {
            aiRequests.get(data.aiDone)(data.answers !== undefined ? data.answers : !!data.ok);
            aiRequests.delete(data.aiDone);
            return;
        }
        if (!data.request) return;
        let result;
        try {
            if (data.request === 'complete') result = await completeModule();
            else if (data.request === 'quizzes') result = await runQuizzes(data.options || {});
            else if (data.request === 'texts') result = texts();
            else if (data.request === 'activeAssessment') result = { ready: true, articleId: activeAssessment() };
            else if (data.request === 'answerAssessment') result = await answerAssessment(data.options.articleId);
            else result = status();
        } catch (error) {
            result = { ready: false, error: error.message };
        }
        window.postMessage({ channel: CHANNEL, reply: data.id, result }, window.location.origin);
    });
})();
