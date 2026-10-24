// Content script on coursera.org/learn/*: quiz solver, hotkeys, content skipping. NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    // A copy left over from a previous extension version loses its runtime and must not block this one.
    const alive = () => !!(chrome.runtime && chrome.runtime.id);
    if (window.__nakiContentAlive && window.__nakiContentAlive()) return;
    window.__nakiContentAlive = alive;

    const CHANNEL = 'naki-coursera';
    const API = 'https://www.coursera.org/api';

    const state = {
        settings: Naki.withDefaults({}),
        userId: null,
        courseMaterials: null,
        questions: [],
        questionsSignature: '',
        lastAutoSolvedSignature: '',
        solving: false,
        skipping: false,
        autopilot: false
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const tr = (key, vars) => Naki.t(state.settings.lang, key, vars);
    const normalize = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

    // ------------------------------------------------------------------ toasts

    const toast = (() => {
        let root = null;
        function ensureRoot() {
            if (root && root.host.isConnected) return root;
            const host = document.createElement('div');
            host.id = 'naki-toasts';
            Object.assign(host.style, { position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647' });
            root = host.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>
                .stack { display: flex; flex-direction: column; gap: 8px; font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
                .toast { display: flex; gap: 10px; align-items: flex-start; max-width: 360px; padding: 11px 14px; border-radius: 12px;
                         color: #f5f3ff; background: rgba(20, 18, 38, .96); border: 1px solid rgba(255,255,255,.08);
                         box-shadow: 0 12px 32px -8px rgba(0,0,0,.45); opacity: 0; transform: translateX(24px);
                         transition: opacity .25s ease, transform .3s cubic-bezier(.16,1,.3,1); word-break: break-word; }
                .toast.show { opacity: 1; transform: none; }
                .dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; }
                .info .dot { background: #60a5fa; } .success .dot { background: #34d399; } .error .dot { background: #f87171; }
                .brand { font-weight: 700; color: #a78bfa; margin-right: 4px; }
            </style><div class="stack"></div>`;
            (document.body || document.documentElement).appendChild(host);
            return root;
        }
        // duration 0 keeps the toast until update() gives it a duration; returns a handle to update it in place.
        return function show(message, type = 'info', duration = 4500) {
            const el = document.createElement('div');
            el.innerHTML = '<span class="dot"></span><span><span class="brand">Naki:</span><span class="text"></span></span>';
            let timer = null;
            const handle = {
                update(nextMessage, nextType = type, nextDuration = duration) {
                    el.className = `toast ${nextType} show`;
                    el.querySelector('.text').textContent = nextMessage;
                    if (!el.isConnected) ensureRoot().querySelector('.stack').appendChild(el);
                    clearTimeout(timer);
                    if (nextDuration > 0) {
                        timer = setTimeout(() => {
                            el.classList.remove('show');
                            setTimeout(() => el.remove(), 350);
                        }, nextDuration);
                    }
                    return handle;
                }
            };
            el.className = `toast ${type}`;
            el.querySelector('.text').textContent = message;
            ensureRoot().querySelector('.stack').appendChild(el);
            requestAnimationFrame(() => el.classList.add('show'));
            if (duration > 0) handle.update(message, type, duration);
            return handle;
        };
    })();

    // ------------------------------------------------------------------ page data

    function readUserData() {
        for (const script of document.getElementsByTagName('script')) {
            const text = script.textContent;
            if (!text || !text.includes('window.App')) continue;
            const match = text.match(/window\.App\s*=\s*(\{.*?\});/s);
            if (!match) continue;
            try {
                return JSON.parse(match[1])?.context?.dispatcher?.stores?.ApplicationStore?.userData || null;
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    const readUserId = () => readUserData()?.id || null;

    function courseSlug() {
        return window.location.pathname.match(/\/learn\/([^/]+)/)?.[1] || null;
    }

    function isAttemptPage() {
        return /\/attempt\/?$/.test(window.location.pathname);
    }

    function htmlToText(html) {
        const doc = new DOMParser().parseFromString(html ?? '', 'text/html');
        doc.querySelectorAll('img').forEach(img => img.replaceWith(img.alt ? ` [image: ${img.alt}] ` : ' [image] '));
        doc.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(tex => {
            const math = tex.closest('math');
            if (math) math.replaceWith(` ${tex.textContent} `);
        });
        return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // "Select all that apply", "Choose two", "Выберите все"… in the prompt.
    const MULTIPLE_PROMPT = /select all that apply|all that apply|choose (?:all|two|three|four|2|3|4)\b|select (?:two|three|four|2|3|4)\b|pick (?:two|three|2|3)\b|выберите (?:все|два|три|четыре|несколько|2|3|4)|отметьте все|укажите все/i;
    const MULTIPLE_TYPE = /checkbox|multiselect|multipleselect|multipleresponse|multianswer|multipleanswer/;

    // Several correct options: checkbox question type, a multi-select flag in the schema, or the prompt says so.
    // Current Coursera assignments do not always name the type "Checkbox", so every signal counts.
    function isMultipleChoice(schema, typename, prompt) {
        if (MULTIPLE_TYPE.test(typename)) return true;
        for (const [key, value] of Object.entries(schema)) {
            if (value === true && /multi|checkbox|allowmultiple/i.test(key)) return true;
            if (typeof value === 'string' && /^(checkbox|multi|multiple)/i.test(value) && /type|mode|selection/i.test(key)) return true;
        }
        return MULTIPLE_PROMPT.test(prompt);
    }

    function extractQuestions(parts) {
        return parts.map(part => {
            const schema = part.questionSchema || {};
            const typename = String(schema.__typename || '').toLowerCase();
            const options = (schema.options || []).map(option => htmlToText(option?.display?.htmlWithMetadata?.html));
            const question = htmlToText(schema.prompt?.htmlWithMetadata?.html);
            const isChoice = options.length > 0;
            return {
                type: isChoice ? 'mcq' : 'textArea',
                multiple: isChoice && isMultipleChoice(schema, typename, question),
                question,
                options: isChoice ? options : [],
                typename: schema.__typename || ''
            };
        });
    }

    function onQuizState(data) {
        const parts = data?.[0]?.data?.SubmissionState?.queryState?.attempts?.inProgressAttempt?.draft?.parts;
        if (!Array.isArray(parts) || !parts.length) return;
        state.questions = extractQuestions(parts);
        state.questionsSignature = state.questions.map(q => q.question).join('|');
        console.log(`[Naki] Captured ${state.questions.length} quiz questions`, state.questions);

        if (state.settings.autoSolve && isAttemptPage() && state.lastAutoSolvedSignature !== state.questionsSignature) {
            state.lastAutoSolvedSignature = state.questionsSignature;
            solveQuiz({ auto: true });
        }
    }

    window.addEventListener('message', event => {
        if (event.source !== window || event.data?.channel !== CHANNEL) return;
        const { kind, data } = event.data;
        if (kind === 'quizState') onQuizState(data);
        else if (kind === 'courseMaterials' && materialItems(data).length) state.courseMaterials = data;
    });

    // Course items live under linked["onDemandCourseMaterialItems.vN"].
    function materialItems(data) {
        const linked = data?.linked;
        if (!linked) return [];
        const key = Object.keys(linked).find(k => /^onDemandCourseMaterialItems\.v\d+$/i.test(k));
        return key && Array.isArray(linked[key]) ? linked[key] : [];
    }

    function requestReplay() {
        window.postMessage({ channel: CHANNEL, kind: 'replay' }, window.location.origin);
    }

    // ------------------------------------------------------------------ applying answers

    const CONTROL_SELECTOR = 'input[type="radio"], input[type="checkbox"], textarea, input[type="text"], input[type="number"], input:not([type]), [contenteditable="true"]';
    const KNOWN_CONTAINER_SELECTORS = ['div.css-1tfphom', '[data-testid^="part-Submission"]', '[data-testid="question-part"]'];

    function findContainerByText(questionText) {
        const needle = normalize(questionText).slice(0, 60);
        if (needle.length < 8) return null;
        const contains = el => normalize(el.textContent).includes(needle);
        if (!contains(document.body)) return null;
        // Descend only into the child that still contains the prompt: ends at the deepest such element.
        let best = document.body;
        for (let next = best; next;) {
            best = next;
            next = [...best.children].find(child => child.id !== 'naki-toasts' && contains(child));
        }
        for (let el = best; el && el !== document.body; el = el.parentElement) {
            if (el.querySelector(CONTROL_SELECTOR)) return el;
        }
        return null;
    }

    function findQuestionContainers(questions) {
        for (const selector of KNOWN_CONTAINER_SELECTORS) {
            const found = [...document.querySelectorAll(selector)].filter(el => el.querySelector(CONTROL_SELECTOR));
            if (found.length === questions.length) return found;
        }
        return questions.map(q => findContainerByText(q.question));
    }

    function optionLabel(input) {
        const label = input.closest('label') || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
        return normalize((label || input.parentElement)?.textContent);
    }

    // Maps option index -> input element, preferring text matching over DOM order.
    function mapOptions(container, question) {
        const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
        const labels = inputs.map(optionLabel);
        const mapping = question.options.map(option => {
            const target = normalize(option);
            if (!target) return -1;
            let index = labels.findIndex(label => label === target);
            if (index === -1) index = labels.findIndex(label => label.includes(target));
            return index;
        });
        const unique = new Set(mapping);
        const reliable = !mapping.includes(-1) && unique.size === mapping.length;
        return question.options.map((_, i) => (reliable ? inputs[mapping[i]] : inputs[i]) || null);
    }

    function setNativeValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setEditableText(el, text) {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, text)) {
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        }
    }

    // The rendered form is the most reliable signal: checkboxes mean "select all correct options".
    function markMultipleFromPage(questions) {
        const containers = findQuestionContainers(questions);
        questions.forEach((question, i) => {
            const container = containers[i];
            if (question.type !== 'mcq' || question.multiple || !container) return;
            if (container.querySelector('input[type="checkbox"], [role="checkbox"]') && !container.querySelector('input[type="radio"], [role="radio"]')) {
                question.multiple = true;
            }
        });
        console.log('[Naki] Question types:', questions.map((q, i) => `${i + 1}: ${q.type}${q.multiple ? ' (multiple)' : ''} ${q.typename || ''}`));
    }

    function applySolutions(questions, solutions) {
        const containers = findQuestionContainers(questions);
        let applied = 0;
        const missed = [];

        questions.forEach((question, i) => {
            const solution = solutions[i];
            const container = containers[i];
            if (!solution || !container) {
                missed.push(i + 1);
                return;
            }
            if (question.type === 'mcq') {
                const inputs = mapOptions(container, question);
                const wanted = new Set(solution.correctOptionsIndex || []);
                if (!wanted.size) { missed.push(i + 1); return; }
                inputs.forEach((input, optionIndex) => {
                    if (!input) return;
                    const shouldCheck = wanted.has(optionIndex);
                    if (input.type === 'radio') {
                        if (shouldCheck && !input.checked) input.click();
                    } else if (input.checked !== shouldCheck) {
                        input.click();
                    }
                });
                applied++;
            } else {
                const field = container.querySelector('textarea, input[type="text"], input[type="number"], input:not([type]), [contenteditable="true"]');
                if (!field || !solution.content) { missed.push(i + 1); return; }
                if (field.isContentEditable) setEditableText(field, solution.content);
                else setNativeValue(field, solution.content);
                applied++;
            }
        });
        return { applied, missed };
    }

    async function waitFor(check, timeoutMs, intervalMs = 250) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            if (check()) return true;
            await sleep(intervalMs);
        }
        return check();
    }

    // ------------------------------------------------------------------ course materials for the solver
    // Many quizzes check what this very course teaches. Lecture transcripts and readings are downloaded once per course
    // (kept in the materials base for the days set in Settings), cut into chunks, and every request to the model gets
    // the chunks closest to its questions (materials-core.js), preferring the quiz's own module.

    const Materials = Naki.materials;
    const materialsCache = new Map();                    // slug → docs, for this page

    async function courseMaterialsFor(slug) {
        if (materialItems(state.courseMaterials).length) return state.courseMaterials;
        const fetched = await fetchCourseMaterials(slug);
        if (materialItems(fetched).length) state.courseMaterials = fetched;
        return fetched;
    }

    async function lectureText(courseId, itemId) {
        const data = await getJson(`${API}/onDemandLectureVideos.v1/${courseId}~${itemId}?includes=video&fields=onDemandVideos.v1(subtitlesTxt)`);
        const subtitles = data?.linked?.['onDemandVideos.v1']?.[0]?.subtitlesTxt || {};
        const url = subtitles.en || subtitles.ru || Object.values(subtitles)[0];
        if (!url) return '';
        const response = await fetchWithTimeout(url.startsWith('http') ? url : `https://www.coursera.org${url}`);
        return response.ok ? response.text() : '';
    }

    // Keep paragraphs, headings and list items apart once the tags are gone.
    const blockText = html => htmlToText(String(html || '').replace(/<\/(p|div|li|h[1-6]|tr|td|th|blockquote|pre)>|<br\s*\/?>/gi, '$& '));

    async function readingText(courseId, itemId) {
        const data = await getJson(`${API}/onDemandSupplements.v1/${courseId}~${itemId}?includes=asset&fields=openCourseAssets.v1(typeName),openCourseAssets.v1(definition)`);
        const definition = data?.linked?.['openCourseAssets.v1']?.[0]?.definition || {};
        return blockText(definition.renderableHtmlWithMetadata?.renderableHtml || definition.value || '');
    }

    async function fetchCourseName(slug) {
        const data = await getJson(`${API}/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(slug)}&fields=name`).catch(() => null);
        return data?.elements?.[0]?.name || slug;
    }

    // Lecture transcripts and readings of the course (+ notes added by hand), from the base or downloaded.
    // force: download again even when the base has the course (manual edits are kept).
    async function loadCourseDocs(slug, onProgress, { force = false } = {}) {
        if (!force && materialsCache.has(slug)) return materialsCache.get(slug);
        const stored = await Materials.read(slug);
        if (!force && Materials.isFresh(stored, state.settings.materialsTtlDays) && stored.docs?.length) {
            materialsCache.set(slug, stored.docs);
            Materials.remember(slug).catch(() => { });
            return stored.docs;
        }
        const materials = await courseMaterialsFor(slug);
        const courseId = materials?.linked?.['onDemandGradingParameters.v1']?.[0]?.id || await fetchCourseId(slug);
        const sources = orderedCourseItems(materials)
            .map((entry, order) => ({ ...entry, order }))
            .filter(({ item }) => ['lecture', 'supplement'].includes(item.contentSummary?.typeName) && !item.isLocked);
        const downloaded = [];
        let done = 0;
        await runLimited(sources, 6, async ({ item, module, order }) => {
            const type = item.contentSummary.typeName;
            const raw = type === 'lecture' ? await lectureText(courseId, item.id) : await readingText(courseId, item.id);
            const text = String(raw || '').replace(/\s+/g, ' ').trim();
            if (text.length > 40) downloaded.push({ order, type, title: item.name, module, text });
        }, () => onProgress && onProgress(++done, sources.length));
        downloaded.sort((a, b) => a.order - b.order);
        const docs = Materials.mergeManual(downloaded, stored?.docs);
        if (docs.length) {
            const name = stored?.name && stored.name !== slug ? stored.name : await fetchCourseName(slug);
            await Materials.save(slug, { savedAt: Date.now(), name, site: 'coursera', docs, ...(stored?.edited ? { edited: true } : {}) });
        }
        materialsCache.set(slug, docs);
        console.log(`[Naki] Course materials: ${downloaded.length} of ${sources.length} lectures/readings, ${docs.reduce((sum, doc) => sum + doc.text.length, 0)} chars`);
        return docs;
    }

    // "Load this course" in the panel: download (again) into the materials base, keeping manual edits.
    async function loadMaterialsNow() {
        const slug = courseSlug();
        if (!slug) {
            toast(tr('toastNoCourse'), 'error');
            return;
        }
        const progress = toast(tr('toastMaterials', { done: 0, total: '…' }), 'info', 0);
        try {
            const docs = await loadCourseDocs(slug, (done, total) => progress.update(tr('toastMaterials', { done, total }), 'info', 0), { force: true });
            progress.update(tr('toastMaterialsLoaded', { n: docs.length }), docs.length ? 'success' : 'error', 6000);
        } catch (error) {
            progress.update(tr('toastSkipError', { error: error.message }), 'error', 8000);
        }
    }

    // Excerpts for any text questions ([{ question, options }]), with the module of the item open now preferred.
    async function courseExcerptsFor(questions, progressToast, limit) {
        const slug = courseSlug();
        if (!slug) return '';
        const docs = await loadCourseDocs(slug, (done, total) => progressToast?.update(tr('toastMaterials', { done, total }), 'info', 0));
        if (!docs.length) return '';
        const path = location.pathname.split('/');
        const current = orderedCourseItems(await courseMaterialsFor(slug)).find(entry => path.includes(entry.item.id));
        return Materials.excerpts(Materials.chunkDocs(docs), questions, current ? current.module : null, limit);
    }

    // contextFor(questions) for ModelProvider, or null when the course materials are off or unavailable.
    async function courseContext(progressToast) {
        if (!state.settings.courseContext) return null;
        const slug = courseSlug();
        if (!slug) return null;
        try {
            const docs = await loadCourseDocs(slug, (done, total) => progressToast?.update(tr('toastMaterials', { done, total }), 'info', 0));
            if (!docs.length) return null;
            const chunks = Materials.chunkDocs(docs);
            const path = location.pathname.split('/');
            const current = orderedCourseItems(await courseMaterialsFor(slug)).find(entry => path.includes(entry.item.id));
            const quizModule = current ? current.module : null;
            return questions => Materials.excerpts(chunks, questions, quizModule);
        } catch (error) {
            console.warn('[Naki] Course materials unavailable:', error.message);
            return null;
        }
    }

    // ------------------------------------------------------------------ quiz solver

    // Returns the number of answered questions (0 when nothing was solved).
    async function solveQuiz({ auto = false } = {}) {
        if (state.solving) {
            toast(tr('toastBusySolve'), 'info', 2500);
            return 0;
        }
        state.solving = true;
        try {
            if (!Naki.activeKey(state.settings)) {
                toast(tr('toastNoKey'), 'error');
                return 0;
            }
            if (!state.questions.length) {
                requestReplay();
                await waitFor(() => state.questions.length > 0, 1500, 100);
            }
            if (!state.questions.length) {
                toast(tr('toastNoQuestions'), 'info', 6000);
                return 0;
            }

            const questions = state.questions;
            const settings = state.settings;
            const options = { provider: settings.provider, apiKey: Naki.activeKey(settings), modelId: Naki.activeModel(settings), lang: settings.lang };
            const solvingToast = toast(tr('toastSolving', { auto: auto ? tr('toastAuto') : '', n: questions.length, model: options.modelId }), 'info', 0);
            options.contextFor = await courseContext(solvingToast);
            solvingToast.update(tr('toastSolving', { auto: auto ? tr('toastAuto') : '', n: questions.length, model: options.modelId }) +
                (options.contextFor ? tr('toastWithMaterials') : ''), 'info', 6000);
            const started = performance.now();

            await waitFor(() => document.querySelector('input[type="radio"], input[type="checkbox"], [role="checkbox"], textarea'), 10000);
            markMultipleFromPage(questions);
            const solutions = await ModelProvider.solveQuizQuestions(questions.map(({ typename, ...q }) => q), options);
            if (!solutions.length) throw new Error(tr('errEmptySolutions'));
            console.log('[Naki] Solutions:', solutions);

            const { applied, missed } = applySolutions(questions, solutions);
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            if (missed.length) {
                toast(tr('toastPartial', { applied, total: questions.length, sec: seconds, missed: missed.join(', ') }), applied ? 'success' : 'error', 8000);
            } else {
                toast(tr('toastDone', { applied, sec: seconds }), 'success', 6000);
            }
            return applied;
        } catch (error) {
            console.error('[Naki] Quiz solver error:', error);
            toast(tr('toastSolveError', { error: error.message }), 'error', 8000);
            return 0;
        } finally {
            state.solving = false;
        }
    }

    // ------------------------------------------------------------------ content skipping

    const REQUEST_TIMEOUT_MS = 20000;

    // A Coursera request that never answers must not block the final summary.
    async function fetchWithTimeout(url, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { credentials: 'include', ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async function getJson(url) {
        const response = await fetchWithTimeout(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} (${url.split('?')[0].split('/').pop()})`);
        return response.json();
    }

    function fetchCourseMaterials(slug) {
        return getJson(`${API}/onDemandCourseMaterials.v2/?q=slug&slug=${encodeURIComponent(slug)}` +
            '&includes=modules,lessons,passableItemGroups,passableItemGroupChoices,passableLessonElements,items,tracks,gradePolicy,gradingParameters' +
            '&fields=moduleIds,onDemandCourseMaterialModules.v1(name,slug,lessonIds),onDemandCourseMaterialLessons.v1(name,slug,itemIds),' +
            'onDemandCourseMaterialItems.v2(name,slug,timeCommitment,contentSummary,isLocked,lockableByItem,itemLockedReasonCode,trackId,lockedStatus,itemLockSummary),' +
            'onDemandCourseMaterialPassableLessonElements.v1(gradingWeight,isRequiredForPassing)' +
            '&showLockedItems=true');
    }

    async function fetchCourseId(slug) {
        const data = await getJson(`${API}/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(slug)}`);
        return data?.elements?.[0]?.id || null;
    }

    async function fetchUserId() {
        const data = await getJson(`${API}/adminUserPermissions.v1?q=my`);
        return data?.elements?.[0]?.id || null;
    }

    function csrfToken() {
        return document.cookie.match(/(?:^|;\s*)CSRF3-Token=([^;]+)/)?.[1] || null;
    }

    async function runLimited(items, limit, task, onProgress) {
        let next = 0, ok = 0;
        async function worker() {
            while (next < items.length) {
                const item = items[next++];
                try {
                    const response = await task(item);
                    if (!response || response.ok) ok++;
                    else console.warn('[Naki] Request rejected for item', item?.id, response.status);
                } catch (e) {
                    console.warn('[Naki] Request failed for item', item?.id, e);
                }
                if (onProgress) onProgress();
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return ok;
    }

    function jsonPost(url, body) {
        const headers = { 'Content-Type': 'application/json' };
        const token = csrfToken();
        if (token) headers['X-CSRF3-Token'] = token;
        return fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    // Items the learner already completed: nothing is sent for them again (no second forum post).
    async function fetchCompletedItems(userId, courseId) {
        try {
            const data = await getJson(`${API}/onDemandCoursesProgress.v1/${userId}~${courseId}`);
            const items = data?.elements?.[0]?.items || {};
            return new Set(Object.entries(items).filter(([, value]) => value?.progressState === 'Completed').map(([id]) => id));
        } catch (error) {
            console.warn('[Naki] Course progress unavailable:', error.message);
            return new Set();
        }
    }

    const FORUM_PAUSE_MS = 8000;

    // Returns { posted, limited }: Coursera caps forum posts per account; once it says so, posting stops.
    async function answerDiscussions(items, userId, courseId, onPosted) {
        const replies = ['Interesting question, thanks for sharing.', 'Good point, I will look into this further.', 'Thanks, this helped me understand the topic better.'];
        let posted = 0;
        for (const [i, item] of items.entries()) {
            const prompt = await getJson(`${API}/onDemandDiscussionPrompts.v1/${userId}~${courseId}~${item.id}?fields=promptType`).catch(() => null);
            const id = prompt?.elements?.[0]?.promptType?.definition?.courseItemForumQuestionId;
            if (!id) continue;
            const text = replies[Math.floor(Math.random() * replies.length)];
            const response = await jsonPost(`${API}/onDemandCourseForumAnswers.v1/`, {
                content: { typeName: 'cml', definition: { dtdId: 'discussion/1', value: `<co-content><text>${text}</text></co-content>` } },
                courseForumQuestionId: `${courseId}~${id.split('~')[2]}`
            });
            if (response.ok) {
                posted++;
                if (onPosted) onPosted();
            } else {
                const body = await response.text().catch(() => '');
                console.warn('[Naki] Forum post rejected:', response.status, body.slice(0, 300));
                if (/RATE_LIMIT|limit has been reached/i.test(body)) return { posted, limited: true };
            }
            if (i < items.length - 1) await sleep(FORUM_PAUSE_MS);
        }
        return { posted, limited: false };
    }

    // ------------------------------------------------------------------ Coach items (Dialogue, Role Play)
    // Coursera counts a Coach dialogue or role play as completed once a session is ended, even right after it
    // started (verified on Coursera): create a chat session and end it. The item does not say which mode it is,
    // so Dialogue is tried first and Role Play when Coursera answers that the mode does not match.

    const COACH_MODES = ['COACH_ITEM_DIALOGUE', 'COACH_ITEM_ROLE_PLAY'];

    async function graphql(operation, variables, query) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'apollographql-client-name': 'ondemand', 'operation-name': operation };
        const token = csrfToken();
        if (token) headers['X-CSRF3-Token'] = token;
        const response = await fetchWithTimeout(`https://www.coursera.org/graphql-gateway?opname=${operation}`, {
            method: 'POST', headers, body: JSON.stringify([{ operationName: operation, variables, query }])
        });
        const data = await response.json().catch(() => null);
        return Array.isArray(data) ? data[0] : data;
    }

    async function completeCoachItem(item, userId, courseId) {
        const courseraContext = { courseId, itemId: item.id, courseBranchId: courseId };
        for (const coachModeId of COACH_MODES) {
            const session = await graphql('AiCoachPlatform_CreateChatSession',
                { input: { title: `coachItem-${courseId}-${item.id}`, userId: String(userId) } },
                'mutation AiCoachPlatform_CreateChatSession($input: AiCoach_CreateChatSessionInput!) { AiCoach_CreateChatSession(input: $input) { id __typename } }');
            const chatSessionId = session?.data?.AiCoach_CreateChatSession?.id;
            if (!chatSessionId) return false;
            const ended = await graphql('CoachItem_EndSession',
                { input: { chatSessionId, message: 'Generate final session summary', coachModeId, terminalActionId: 'STUCK_END', courseraContext, additionalContext: [] } },
                'mutation CoachItem_EndSession($input: CoachItem_EndSessionInput!) { CoachItem_EndSession(input: $input) { chatSessionId itemCompletionHandled session { status __typename } __typename } }');
            if (ended?.data?.CoachItem_EndSession) return true;
            const message = ended?.errors?.[0]?.message || '';
            if (!/coachModeId does not match/i.test(message)) {
                console.warn('[Naki] Coach item not completed:', item.id, message);
                return false;
            }
        }
        return false;
    }

    async function skipContent() {
        if (state.skipping) {
            toast(tr('toastBusySkip'), 'info', 2500);
            return;
        }
        state.skipping = true;
        let progress = null;
        try {
            const slug = courseSlug();
            state.userId = state.userId || readUserId() || await fetchUserId().catch(error => {
                console.warn('[Naki] Could not fetch user id:', error);
                return null;
            });
            if (!slug || !state.userId) {
                toast(tr('toastNoCourse'), 'error');
                return;
            }
            if (!state.courseMaterials) {
                requestReplay();
                await waitFor(() => state.courseMaterials, 1200, 100);
            }
            if (!state.courseMaterials) {
                const fetched = await fetchCourseMaterials(slug);
                if (materialItems(fetched).length) state.courseMaterials = fetched;
            }

            const items = materialItems(state.courseMaterials);
            const linked = state.courseMaterials?.linked || {};
            const courseId = linked['onDemandGradingParameters.v1']?.[0]?.id || await fetchCourseId(slug).catch(() => null);
            console.log('[Naki] Skip:', { slug, userId: state.userId, courseId, items: items.length });
            if (!items.length || !courseId) {
                toast(tr('toastNoMaterials'), 'error');
                return;
            }

            const completed = await fetchCompletedItems(state.userId, courseId);
            const byType = type => items.filter(item => item.contentSummary?.typeName === type && !completed.has(item.id) && !item.isLocked);
            const lectures = byType('lecture');
            const readings = byType('supplement');
            const coachItems = byType('coach');
            const discussions = state.settings.skipDiscussions ? byType('discussionPrompt') : [];
            const total = lectures.length + readings.length + coachItems.length + discussions.length;
            console.log('[Naki] Skip pending:', { lectures: lectures.length, readings: readings.length, coach: coachItems.length, discussions: discussions.length, alreadyCompleted: completed.size });
            let processed = 0;
            progress = toast(tr('toastSkipping', { lectures: lectures.length, readings: readings.length }), 'info', 0);
            const tick = () => {
                processed++;
                progress.update(tr('toastSkipProgress', { done: processed, total }), 'info', 0);
            };

            const doneLectures = await runLimited(lectures, 4, item => jsonPost(
                `${API}/opencourse.v1/user/${state.userId}/course/${slug}/item/${item.id}/lecture/videoEvents/ended?autoEnroll=false`,
                { contentRequestBody: {} }), tick);
            const doneReadings = await runLimited(readings, 4, item => jsonPost(
                `${API}/onDemandSupplementCompletions.v1`,
                { userId: state.userId, courseId, itemId: item.id }), tick);

            let doneCoach = 0;
            for (const item of coachItems) {
                if (await completeCoachItem(item, state.userId, courseId).catch(() => false)) doneCoach++;
                tick();
            }

            let summary = tr('toastSkipSummary', { l: `${doneLectures}/${lectures.length}`, r: `${doneReadings}/${readings.length}` });
            if (coachItems.length) summary += tr('toastSkipCoach', { c: `${doneCoach}/${coachItems.length}` });
            if (discussions.length) {
                progress.update(tr('toastDiscussions', { n: discussions.length }), 'info', 0);
                const { posted, limited } = await answerDiscussions(discussions, state.userId, courseId, tick);
                summary += tr('toastSkipDiscussions', { d: `${posted}/${discussions.length}` });
                if (limited) summary += tr('toastForumLimit');
            }
            progress.update(tr('toastSkipDone', { summary }), 'success', 12000);
        } catch (error) {
            console.error('[Naki] Skip error:', error);
            const message = tr('toastSkipError', { error: error.message });
            if (progress) progress.update(message, 'error', 10000);
            else toast(message, 'error', 8000);
        } finally {
            state.skipping = false;
        }
    }

    // ------------------------------------------------------------------ quiz autopilot
    // Goes through the graded work of the course (items with a weight in the grade) in course order. A quiz is opened,
    // started, solved, the Honor Code accepted, submitted, the grade read and a failed quiz retaken as set in the
    // panel; a peer-reviewed assignment is written, submitted and the classmates reviewed (see below). Practice items
    // do not count toward the course and are left alone. Coursera loads a new page per item, so the run lives in
    // chrome.storage.local and resumes on load.

    const AUTOPILOT_KEY = 'nakiAutopilot';
    // "exam" / "quiz": older courses. "staffGraded" (Graded Assignment, module challenge, practice quiz) and
    // "ungradedAssignment" (Test your knowledge): current Coursera quizzes at /assignment-submission/<id>/….
    const QUIZ_TYPES = ['exam', 'quiz', 'staffGraded', 'ungradedAssignment'];
    const STEP_MS = 1500;
    const STUCK_MS = 45000; // a step that makes no progress for this long is given up, the run moves on
    const BUTTONS = {
        start: /^(start|start quiz|start assignment|resume|resume assignment|continue|continue assignment|начать|начать тест|продолжить|возобновить)$/i,
        retry: /^(try again|retry|retake|retake quiz|retake assignment|start new attempt|new attempt|повторить|повторить попытку|пройти снова|начать заново)$/i,
        submit: /^(submit|submit quiz|submit assignment|отправить|отправить тест)$/i,
        // The confirmation after Submit ("Ready to submit?", "You have unanswered questions…").
        confirm: /^(submit|submit quiz|submit assignment|submit anyway|submit now|yes,? submit|confirm|confirm submission|yes|ok|отправить|отправить тест|всё равно отправить|подтвердить|да)$/i
    };
    // Quizzes: "…work that isn't my own…"; peer-reviewed assignments: "I, <name>, understand and agree."
    const HONOR_TEXT = /honor code|isn.t my own|not my own|understand that submitting|understand and agree|кодекс|не являющ|моей собственной|понимаю и соглас/i;

    // A stopped run is remembered by id, so a step that was already in flight cannot save it back.
    const STOP_KEY = 'nakiAutopilotStop';

    async function loadRun() {
        const stored = await chrome.storage.local.get([AUTOPILOT_KEY, STOP_KEY]);
        const run = stored[AUTOPILOT_KEY] || null;
        if (run && stored[STOP_KEY] === run.id) {
            await chrome.storage.local.remove(AUTOPILOT_KEY);
            return null;
        }
        return run;
    }

    async function saveRun(run) {
        const { [STOP_KEY]: stopped } = await chrome.storage.local.get(STOP_KEY);
        if (stopped === run.id) return;
        await chrome.storage.local.set({ [AUTOPILOT_KEY]: run });
    }

    const clearRun = () => chrome.storage.local.remove(AUTOPILOT_KEY);

    async function stopRun(run) {
        await chrome.storage.local.set({ [STOP_KEY]: run.id });
        await clearRun();
    }
    const isShown = el => !!el && el.getClientRects().length > 0;
    const buttonText = el => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

    function findButton(pattern, scope = document) {
        return [...scope.querySelectorAll('button, a[role="button"], [role="button"]')]
            .find(el => isShown(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && pattern.test(buttonText(el)));
    }

    // Open dialogs with content. Every Coursera page keeps an empty role="dialog" (the AI assistant panel), so the first
    // [role="dialog"] of the document is usually not the confirmation.
    const shownDialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .rc-Modal, .cds-Dialog-dialog')]
        .filter(dialog => isShown(dialog) && (dialog.innerText || '').trim());

    // Waits for a confirmation dialog and presses its button (checking "I understand…" boxes in it first).
    async function confirmInDialog(pattern, timeoutMs) {
        const end = Date.now() + timeoutMs;
        do {
            for (const dialog of shownDialogs()) {
                const button = findButton(pattern, dialog);
                if (!button) continue;
                for (const box of dialog.querySelectorAll('input[type="checkbox"]')) if (!box.checked) (box.labels?.[0] || box).click();
                await sleep(300);
                (findButton(pattern, dialog) || button).click();
                return true;
            }
            await sleep(300);
        } while (Date.now() < end);
        return false;
    }

    // /learn/<course>/item/<id> opens any item type on its own route; every route keeps the item id in the path.
    const itemUrl = (run, item) => `https://www.coursera.org/learn/${run.slug}/item/${item.id}`;
    const onItem = (run, item) => location.pathname.startsWith(`/learn/${run.slug}/`) && location.pathname.split('/').includes(item.id);

    // Course items in course order (modules → lessons → items) with the module position; falls back to the API order.
    function orderedCourseItems(materials) {
        const items = materialItems(materials);
        const byId = new Map(items.map(item => [item.id, item]));
        const linked = materials?.linked || {};
        const modules = Object.entries(linked).find(([key]) => /^onDemandCourseMaterialModules\.v\d+$/i.test(key))?.[1] || [];
        const lessons = new Map((Object.entries(linked).find(([key]) => /^onDemandCourseMaterialLessons\.v\d+$/i.test(key))?.[1] || []).map(lesson => [lesson.id, lesson]));
        const moduleOrder = materials?.elements?.[0]?.moduleIds || modules.map(module => module.id);
        const ordered = [];
        moduleOrder.forEach((moduleId, module) => {
            const entry = modules.find(m => m.id === moduleId);
            for (const lessonId of entry?.lessonIds || []) {
                for (const itemId of lessons.get(lessonId)?.itemIds || []) if (byId.has(itemId)) ordered.push({ item: byId.get(itemId), module });
            }
        });
        return ordered.length ? ordered : items.map(item => ({ item, module: null }));
    }

    // Ids of the items that count toward the course grade ("item~<id>" elements with a grading weight), or null when
    // the course materials came without grading weights.
    function gradedItemIds(materials) {
        const linked = materials?.linked || {};
        const elements = Object.entries(linked).find(([key]) => /^onDemandCourseMaterialPassableLessonElements\.v\d+$/.test(key))?.[1];
        if (!elements?.some(element => 'gradingWeight' in element || 'isRequiredForPassing' in element)) return null;
        return new Set(elements.filter(element => element.gradingWeight > 0 || element.isRequiredForPassing)
            .map(element => String(element.id).replace(/^item~/, '')));
    }

    // Graded quizzes (and, when switched on, graded peer-reviewed assignments) in course order.
    function courseQuizzes(materials, { peer = false } = {}) {
        const graded = gradedItemIds(materials);
        return orderedCourseItems(materials).map(entry => entry.item)
            .filter(item => {
                const type = item.contentSummary?.typeName;
                if (item.isLocked) return false;
                // Without grading weights: practice quizzes ("quiz", "ungradedAssignment") are known to be ungraded.
                if (graded ? !graded.has(item.id) : ['quiz', 'ungradedAssignment'].includes(type)) return false;
                if (PEER_TYPES.includes(type)) return peer;
                // Rubric-graded items are written work reviewed by people, not quizzes.
                return QUIZ_TYPES.includes(type) && !(item.contentSummary?.definition?.assignmentFeatures || []).includes('ASSIGNMENT_RUBRICS');
            })
            .map(item => ({ id: item.id, slug: item.slug, type: item.contentSummary.typeName, name: item.name }));
    }

    // Grade on the cover / feedback page: "Your grade 85%", "To pass 80% or higher", "Congratulations! You passed!".
    function readGrade() {
        const text = document.body?.innerText || '';
        const percent = text.match(/(?:your grade|latest submission grade|grade received|highest score|ваша оценка|оценка за последнюю|полученная оценка)[^\d%]{0,40}(\d{1,3}(?:[.,]\d+)?)\s*%/i);
        const needed = text.match(/(?:to pass|для прохождения|чтобы сдать)[^\d%]{0,20}(\d{1,3})\s*%/i);
        const passedText = /congratulations|you passed|passed!|поздравляем|вы сдали|пройдено успешно/i.test(text);
        const failedText = /try again once you are ready|did not pass|didn.t pass|not passed|вы не сдали|не пройдено/i.test(text);
        if (!percent && !passedText && !failedText) return null;
        const value = percent ? Number(percent[1].replace(',', '.')) : null;
        const pass = value !== null && needed ? value >= Number(needed[1]) : passedText && !failedText;
        return { percent: value, pass };
    }

    function acceptHonorCode() {
        for (const box of document.querySelectorAll('input[type="checkbox"]')) {
            const text = (box.closest('label') || box.labels?.[0] || box.parentElement)?.textContent || '';
            if (HONOR_TEXT.test(text) && !box.checked) box.click();
        }
        const nameField = [...document.querySelectorAll('input[type="text"], input:not([type])')]
            .find(input => /legal name|full name|your name|ваше имя|полное имя|юридическое имя/i.test(`${input.placeholder} ${input.getAttribute('aria-label') || ''}`));
        const fullName = readUserData()?.fullName;
        if (nameField && !nameField.value && fullName) setNativeValue(nameField, fullName);
    }

    let runToast = null;
    function showRun(run, message, type = 'info', duration = 0) {
        runToast = runToast ? runToast.update(message, type, duration) : toast(message, type, duration);
        state.autopilot = !!run;
    }

    async function nextItem(run, result) {
        if (result) run.results.push(result);
        run.index++;
        run.attempt = 0;
        delete run.peer;
        run.phase = 'open';
        run.phaseAt = Date.now();
        await saveRun(run);
    }

    async function finishRun(run) {
        await clearRun();
        const passed = run.results.filter(result => result.pass).length;
        const failed = run.results.filter(result => !result.pass);
        const details = failed.map(result => `${result.name}: ${result.percent ?? '?'}%${result.note ? ` (${result.note})` : ''}`).join('; ');
        showRun(null, tr('autopilotCourseraDone', { passed, failed: failed.length }) + (details ? ` ${details}` : ''), failed.length ? 'info' : 'success', 20000);
        runToast = null;
        state.autopilot = false;
        console.log('[Naki] Coursera autopilot finished:', run.results);
    }

    // only: the id of one item to do (the peer-reviewed assignment open now) instead of the whole course.
    async function startAutopilot({ only = null } = {}) {
        const running = await loadRun();
        if (running) {
            // A second press stops the run.
            await stopRun(running);
            showRun(null, tr('autopilotStopped'), 'info', 6000);
            runToast = null;
            return;
        }
        if (!Naki.activeKey(state.settings)) {
            toast(tr('toastNoKey'), 'error');
            return;
        }
        const slug = courseSlug();
        if (!slug) {
            toast(tr('toastNoCourse'), 'error');
            return;
        }
        // A fresh copy: the one the page loaded may come without grading weights.
        const materials = await fetchCourseMaterials(slug).catch(() => state.courseMaterials);
        const items = !materials ? [] : only
            ? orderedCourseItems(materials).map(entry => entry.item).filter(item => item.id === only)
                .map(item => ({ id: item.id, slug: item.slug, type: item.contentSummary?.typeName, name: item.name }))
            : courseQuizzes(materials, { peer: state.settings.autopilotPeer });
        if (!items.length) {
            toast(tr('autopilotNoQuizzes'), 'info', 8000);
            return;
        }
        const userId = state.userId || readUserId() || await fetchUserId().catch(() => null);
        const courseId = materials.linked?.['onDemandGradingParameters.v1']?.[0]?.id || await fetchCourseId(slug).catch(() => null);
        if (state.settings.courseContext) {
            const loading = toast(tr('toastMaterials', { done: 0, total: '…' }), 'info', 0);
            await loadCourseDocs(slug, (done, total) => loading.update(tr('toastMaterials', { done, total }), 'info', 0)).catch(error => console.warn('[Naki] Course materials unavailable:', error.message));
            loading.update(tr('toastMaterialsReady'), 'success', 3000);
        }
        const run = { id: String(Date.now()), slug, userId, courseId, items, index: 0, attempt: 0, phase: 'open', phaseAt: Date.now(), retakes: state.settings.autopilotRetakes, results: [] };
        await saveRun(run);
        console.log('[Naki] Coursera autopilot:', items);
        runLoop();
    }

    let stepping = false;
    async function autopilotStep() {
        if (stepping || !alive()) return;
        stepping = true;
        try {
            const run = await loadRun();
            state.autopilot = !!run;
            if (!run || run.slug !== courseSlug()) return;
            const item = run.items[run.index];
            if (!item) {
                await finishRun(run);
                return;
            }
            showRun(run, tr('autopilotItem', { n: run.index + 1, total: run.items.length, title: item.name }));
            if (!onItem(run, item)) {
                if (run.phase !== 'navigating' || Date.now() - run.phaseAt > 20000) {
                    run.phase = 'navigating';
                    run.phaseAt = Date.now();
                    await saveRun(run);
                    location.assign(itemUrl(run, item));
                }
                return;
            }
            if (Date.now() - run.phaseAt > (PEER_TYPES.includes(item.type) ? PEER_STUCK_MS : STUCK_MS) && run.phase !== 'submitted') {
                console.warn('[Naki] Autopilot stuck on', item.name, run.phase);
                await nextItem(run, { name: item.name, pass: false, percent: null, note: tr('autopilotStuck', { step: run.phase }) });
                return;
            }
            if (PEER_TYPES.includes(item.type)) await peerStep(run, item);
            else if (isAttemptPage()) await attemptStep(run, item);
            else await coverStep(run, item);
        } catch (error) {
            console.error('[Naki] Autopilot step failed:', error);
        } finally {
            stepping = false;
        }
    }

    async function coverStep(run, item) {
        if (run.phase === 'submitted') {
            const grade = readGrade();
            if (!grade) {
                if (Date.now() - run.phaseAt > STUCK_MS) await nextItem(run, { name: item.name, pass: false, percent: null, note: tr('autopilotStuck', { step: 'grade' }) });
                return;
            }
            if (grade.pass || run.attempt >= 1 + run.retakes) {
                await nextItem(run, { name: item.name, ...grade, attempts: run.attempt });
                return;
            }
            run.phase = 'retry';
            run.phaseAt = Date.now();
            await saveRun(run);
        }
        if (run.phase === 'open' || run.phase === 'navigating') {
            await sleep(1500); // let the cover page render its grade
            const grade = readGrade();
            if (grade?.pass) {
                await nextItem(run, { name: item.name, ...grade, attempts: 0, note: 'already passed' });
                return;
            }
        }
        if (run.phase === 'starting' && Date.now() - run.phaseAt < 8000) return; // the attempt is opening
        const button = findButton(run.phase === 'retry' ? BUTTONS.retry : BUTTONS.start) || findButton(BUTTONS.start) || findButton(BUTTONS.retry);
        if (!button) return; // the page is still loading; STUCK_MS ends the wait
        state.questions = [];
        state.questionsSignature = '';
        if (run.phase !== 'starting') {
            run.attempt++; // a repeated click on the same attempt is not a new attempt
            run.phaseAt = Date.now();
        }
        run.phase = 'starting';
        await saveRun(run);
        button.click();
        // Timed quizzes and new attempts ask for confirmation in a dialog.
        await confirmInDialog(new RegExp(`${BUTTONS.start.source}|${BUTTONS.retry.source}`, 'i'), 3000);
    }

    async function attemptStep(run, item) {
        if (run.phase === 'submitting' || run.phase === 'submitted') {
            // Waiting for the feedback page; a confirmation that showed up late is still answered.
            await confirmInDialog(BUTTONS.confirm, 500);
            return;
        }
        if (!state.questions.length) {
            requestReplay();
            return; // questions arrive with the attempt data; STUCK_MS ends the wait
        }
        if (run.phase !== 'solving') {
            run.phase = 'solving';
            run.phaseAt = Date.now();
            await saveRun(run);
        }
        const answered = await solveQuiz({ auto: true });
        if (!answered) return;
        await sleep(800);
        acceptHonorCode();
        await sleep(500);
        const submit = findButton(BUTTONS.submit);
        if (!submit) return;
        run.phase = 'submitting';
        run.phaseAt = Date.now();
        await saveRun(run);
        submit.click();
        // "Ready to submit?" / "You have unanswered questions": the dialog's own Submit.
        await confirmInDialog(BUTTONS.confirm, 8000);
        run.phase = 'submitted';
        run.phaseAt = Date.now();
        await saveRun(run);
    }

    let loopTimer = null;
    function runLoop() {
        if (loopTimer) return;
        loopTimer = setInterval(async () => {
            if (!alive() || !(await loadRun())) {
                clearInterval(loopTimer);
                loopTimer = null;
                state.autopilot = false;
                return;
            }
            autopilotStep();
        }, STEP_MS);
        autopilotStep();
    }


    // ------------------------------------------------------------------ peer-reviewed assignments
    // My submission: the model writes the work from the instructions, the parts' prompts and the course materials;
    // text goes into the text fields, a file part gets a generated PDF (DOCX / TXT when the part asks for them), then
    // Submit and the confirmation dialog (checkbox, legal name). Peers to review: as many classmates as the course
    // requires, each graded by the model strictly by the rubric from what the submission actually contains (text and
    // the text of attached PDF / DOCX / PPTX files).

    const PEER_TYPES = ['peer', 'phasedPeer', 'gradedPeer', 'closedPeer'];
    const PEER_STUCK_MS = 4 * 60 * 1000;

    const peerUrl = (run, item, tail = '') => `https://www.coursera.org/learn/${run.slug}/peer/${item.id}/${item.slug}${tail}`;
    const peerRoute = () => location.pathname.match(/\/peer\/[^/]+\/[^/]+\/(submit|give-feedback|review\/([^/]+))\/?$/) || [];
    const cmlText = content => {
        const definition = content?.definition || {};
        return blockText(definition.renderableHtmlWithMetadata?.renderableHtml || definition.value || '').trim();
    };

    async function peerAssignment(run, item) {
        const data = await getJson(`${API}/onDemandPeerAssignmentInstructions.v1/?q=latest&userId=${run.userId}&courseId=${run.courseId}&itemId=${item.id}` +
            '&includes=gradingMetadata,reviewSchemas,submissionSchemas&fields=instructions,' +
            'onDemandPeerAssignmentGradingMetadata.v1(requiredAuthoredReviewCount,isMentorGraded,assignmentDetails),' +
            'onDemandPeerReviewSchemas.v1(reviewSchema),onDemandPeerSubmissionSchemas.v1(submissionSchema)');
        const instructions = data?.elements?.[0]?.instructions || {};
        const linked = data?.linked || {};
        return {
            instructions: [cmlText(instructions.introduction), ...(instructions.sections || []).map(section => `${section.title}: ${cmlText(section.content)}`)].filter(Boolean).join('\n\n'),
            submissionParts: linked['onDemandPeerSubmissionSchemas.v1']?.[0]?.submissionSchema?.parts || [],
            reviewParts: linked['onDemandPeerReviewSchemas.v1']?.[0]?.reviewSchema?.parts || [],
            required: linked['onDemandPeerAssignmentGradingMetadata.v1']?.[0]?.requiredAuthoredReviewCount ?? null
        };
    }

    async function peerSubmitted(run, item) {
        const data = await getJson(`${API}/onDemandPeerAssignmentPermissions.v1/${run.userId}~${run.courseId}~${item.id}/` +
            '?fields=reviewPeers,onDemandPeerSubmissionProgresses.v1(latestSubmissionSummary,latestDraftSummary,isLatestSubmissionDeleted)&includes=submissionProgress');
        const progress = data?.linked?.['onDemandPeerSubmissionProgresses.v1']?.[0];
        return !!progress?.latestSubmissionSummary && !progress.isLatestSubmissionDeleted;
    }

    function partKind(part) {
        const type = part.details?.typeName || '';
        const definition = part.details?.definition || {};
        if (Array.isArray(definition.options)) return 'options';
        if (/yesNo/i.test(type)) return 'yesNo';
        if (/file/i.test(type)) return 'file';
        if (/url/i.test(type)) return 'url';
        if (/image/i.test(type)) return 'image';
        return 'text'; // plainText, richText, multiLineInput, singleLineInput…
    }

    const optionsOf = part => partKind(part) === 'yesNo'
        ? [{ text: 'Yes', points: part.details?.definition?.yesPoints }, { text: 'No', points: part.details?.definition?.noPoints }]
        : (part.details?.definition?.options || []).map(option => ({ id: option.id, text: cmlText(option.display) || String(option.display?.definition?.value || ''), points: option.points }));

    // Controls of a submission / review part: the ones labelled by the part id, else those in the nearest container
    // of an element whose id mentions the part.
    function partControls(partId, selector) {
        const usable = el => isShown(el) && !el.readOnly && el.getAttribute('aria-hidden') !== 'true' && !/~comment$/.test(el.id);
        const mentions = el => [el.id, el.name, el.getAttribute('aria-labelledby'), el.getAttribute('aria-describedby')].some(value => value && value.includes(partId));
        const direct = [...document.querySelectorAll(selector)].filter(el => usable(el) && mentions(el));
        if (direct.length) return direct;
        let node = [...document.querySelectorAll('[id]')].find(el => el.id.includes(partId));
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
            const found = [...node.querySelectorAll(selector)].filter(usable);
            if (found.length) return found;
        }
        return [];
    }

    function chooseOption(partId, options, index) {
        const radios = partControls(partId, 'input[type="radio"]');
        if (!radios.length || !options[index]) return false;
        const labelText = radio => normalize((radio.closest('label') || radio.labels?.[0] || radio.parentElement)?.textContent || '');
        const wanted = normalize(options[index].text).slice(0, 60);
        const radio = (wanted && radios.find(r => labelText(r).includes(wanted))) || radios[index];
        if (!radio) return false;
        if (!radio.checked) (radio.labels?.[0] || radio).click();
        return true;
    }

    function fillText(partId, text) {
        const field = partControls(partId, 'textarea, [contenteditable="true"], input[type="text"], input:not([type])')[0];
        if (!field) return false;
        if (field.isContentEditable) setEditableText(field, text);
        else setNativeValue(field, text);
        return true;
    }

    // Free text from the model (written work has formulas, quotes and backslashes that break JSON answers).
    async function generateText(prompt) {
        const settings = state.settings;
        const { text } = await ModelProvider.generateContent({ provider: settings.provider, apiKey: Naki.activeKey(settings), modelId: Naki.activeModel(settings), lang: settings.lang, prompt });
        return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/, '$1').trim();
    }

    // "=== <key> ===" lines followed by the text of that section.
    function parseSections(text) {
        const sections = {};
        let key = null;
        for (const line of text.split('\n')) {
            const marker = line.match(/^\s*={3,}\s*([^=]+?)\s*={3,}\s*$/);
            if (marker) sections[key = marker[1].trim()] = '';
            else if (key !== null) sections[key] += line + '\n';
        }
        for (const name of Object.keys(sections)) sections[name] = sections[name].trim();
        return sections;
    }

    const optionNumber = value => Number(String(value).match(/-?\d+/)?.[0] ?? NaN);

    const materialsFor = async (text, limit) => state.settings.courseContext
        ? courseExcerptsFor([{ question: text }], null, limit).catch(() => '') : '';

    // One request per part (a homework of several problems is too long for one answer), several at a time.
    async function writeSubmission(run, item, assignment) {
        const parts = assignment.submissionParts.map(part => ({ part, kind: partKind(part), prompt: cmlText(part.prompt) }))
            .filter(entry => !['url', 'image'].includes(entry.kind));
        const context = await materialsFor(`${item.name} ${assignment.instructions} ${parts.map(entry => entry.prompt).join(' ')}`, 16000);
        const overview = parts.map((entry, i) => `Part ${i + 1}: ${entry.prompt.slice(0, 1500)}`).join('\n\n');
        // The peer-review rubric, when the course shows it before submission: what the graders give points for.
        const rubric = assignment.reviewParts.map(part => `- ${cmlText(part.prompt)}${optionsOf(part).length ? ` (${optionsOf(part).map(option => `${option.points ?? '?'} points: ${option.text}`).join('; ')})` : ''}`).join('\n');
        const answers = {}, errors = [];
        let done = 0;
        showRun(run, tr('autopilotPeerWrite', { title: item.name, done, total: parts.length }));
        await runLimited(parts, 3, async ({ part, kind, prompt }) => {
            const options = optionsOf(part);
            const task = kind === 'options' || kind === 'yesNo'
                ? `Choose the right option and answer with its number only:\n${options.map((option, i) => `${i}: ${option.text}`).join('\n')}`
                : kind === 'file'
                    ? `This answer becomes the document the student uploads for this part (Word or PDF). Structure it with "## " headings (one per sub-question), show the full working (reasoning, derivations, equations, intermediate results) and state each final answer clearly. Tables: markdown (| a | b |).
Every plot, graph or simulation result the task asks for must be in the document: write it as a block that is drawn into the document as a chart, right after the text about it:
\`\`\`plot
{"title": "Room temperature", "xLabel": "t", "yLabel": "T(t)", "xRange": [0, 6], "series": [{"label": "T(0) = 0, heater on", "expr": "90*(1 - exp(-t))"}, {"label": "T(0) = 120, switching", "segments": [{"from": 0, "to": 0.539, "expr": "120*exp(-t)"}, {"from": 0.539, "to": 1.232, "expr": "90 - 20*exp(-(t - 0.539))"}]}], "hlines": [{"y": 70, "label": "T = 70"}, {"y": 80, "label": "T = 80"}]}
\`\`\`
Series: "expr" (a formula in t over xRange or "from"/"to"), "segments" (piecewise: one segment per mode of a switching system, the exact solution in absolute time t), or "points": [[t, y], …] when there is no formula. Formulas: numbers, t, + - * / ^, parentheses, exp, log, sqrt, sin, cos, tan, abs, min, max, pi; always write "*". One plot per requested figure (several curves in one plot when they are compared). Compute every number carefully: the plots are graded against the answer key. Do not write that plots are attached separately.`
                    : `This answer goes into a text field. Answer completely and to the point.`;
            const text = await generateText(`You are a diligent student completing the peer-reviewed assignment "${item.name}" of an online course.
Write the student's answer for ONE part of the assignment: complete, correct and well organised work that meets every
requirement and review criterion. Use the language of the assignment. Write it as the student's own work: no mention
of AI, no placeholders such as [Your Name], no remarks about the format. Write formulas in plain text with Unicode
symbols (for example z₁(t) = z₁(0) + v·r₁·t, ż = Az + Bu, x ∈ ℝ², √, ≤, θ), not LaTeX. When the task asks for
screenshots, simulations or other hands-on results that cannot be shown as text, describe what was done and what it
shows, without inventing exact evidence such as hashes, timestamps or file names.

Assignment instructions and review criteria:
<<<
${assignment.instructions.slice(0, 12000)}
>>>
${context ? `
Course material excerpts (use them; the reviewers check against this course):
<<<
${context}
>>>
` : ''}
${rubric ? `Grading rubric (meet every point that earns credit):
${rubric.slice(0, 6000)}

` : ''}All parts of the assignment, for reference:
${overview}

Write the answer for this part only:
<<<
${prompt}
>>>
${task}
Reply with the answer itself, nothing before or after it.`).catch(error => { errors.push(error.message); throw error; });
            if (!text) errors.push('empty answer');
            answers[part.id] = text;
        }, () => showRun(run, tr('autopilotPeerWrite', { title: item.name, done: ++done, total: parts.length })));
        if (errors.length) throw new Error(errors[0]);
        return { title: item.name.slice(0, 120), parts: answers };
    }

    // The part's own heading ("Problem 1", "Task 2a"…) from its prompt, else "Part N".
    function partLabel(part, index) {
        const definition = part.prompt?.definition || {};
        const html = definition.renderableHtmlWithMetadata?.renderableHtml || definition.value || '';
        const heading = html.match(/<(h[1-6]|heading)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
        const text = heading ? htmlToText(heading)
            : cmlText(part.prompt).match(/^(problem|task|question|exercise|part|step|задача|задание|вопрос|упражнение)\s*#?\s*\d+[a-zа-я]?/i)?.[0];
        return text && text.length <= 40 ? text : `Part ${index + 1}`;
    }

    // Uppy dashboard of the part: Add File → file input → Upload (when not automatic) → the file listed in the part.
    async function uploadFile(partId, file) {
        const button = partControls(partId, 'button').find(el => /add file|upload|добавить файл|загрузить/i.test(buttonText(el))) ||
            findButton(/^(add file|upload file|добавить файл|загрузить файл)$/i);
        if (!button) return false;
        button.click();
        // The dashboard has two inputs: files and a folder (webkitdirectory).
        const FILE_INPUT = '.uppy-Dashboard input[type="file"]:not([webkitdirectory]), [role="dialog"] input[type="file"]:not([webkitdirectory])';
        if (!await waitFor(() => document.querySelector(FILE_INPUT), 8000)) return false;
        const input = document.querySelector(FILE_INPUT);
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
        const upload = findButton(/^(upload|upload \d+ files?|загрузить|загрузить \d+ файл\S*)$/i);
        if (upload) upload.click();
        // Uploaded (Coursera uploads at once and closes the dialog): the part lists the file outside the dialog,
        // with "Open uploaded file <name>" and "Upload completed".
        const scope = document.getElementById(partId) || document;
        const listed = () => [...scope.querySelectorAll('a, span, p, div, li')].some(el => !el.closest('.uppy-Dashboard, [role="dialog"], [aria-modal="true"]') &&
            ((el.getAttribute('aria-label') || '').includes(file.name) || (!el.childElementCount && el.textContent.includes(file.name))));
        await waitFor(listed, 60000, 500);
        const dashboard = document.querySelector('.uppy-Dashboard');
        if (isShown(dashboard)) {
            const done = findButton(/^(done|close|готово|закрыть)$/i, dashboard.closest('[role="dialog"]') || dashboard);
            if (done) done.click();
        }
        return listed();
    }

    async function submitPeer(run, item) {
        const assignment = await peerAssignment(run, item);
        const answer = await writeSubmission(run, item, assignment);
        const manual = [];
        const title = document.getElementById('title') || document.querySelector('input[aria-label="Project Title"]');
        if (title) setNativeValue(title, answer.title);
        for (const [index, part] of assignment.submissionParts.entries()) {
            const kind = partKind(part);
            const value = answer.parts[part.id];
            let ok = false;
            if (kind === 'file' && value) {
                // One file per part, named after it: "Problem_1.docx", "Problem_2.docx"…
                const label = partLabel(part, index);
                const file = await Naki.files.makeFile(`${answer.title} — ${label}`, String(value), part.details?.definition?.allowedFiles || [], label);
                if (file) {
                    showRun(run, tr('autopilotPeerUpload', { name: file.name }));
                    ok = await uploadFile(part.id, file);
                }
            } else if ((kind === 'options' || kind === 'yesNo') && value !== undefined) {
                ok = chooseOption(part.id, optionsOf(part), optionNumber(value));
            } else if (kind === 'text' && value) {
                ok = fillText(part.id, String(value));
            }
            // Optional parts may stay empty, but a part with an answer that did not go in means the work is incomplete.
            if (!ok && (value || part.details?.definition?.required !== false)) manual.push(cmlText(part.prompt).slice(0, 60) || kind);
            await sleep(300);
        }
        if (manual.length) return { ok: false, note: tr('peerNoteManual', { parts: manual.join('; ') }) };
        // Honor Code on the page ("I, <name>, understand and agree."): Submit stays disabled until it is checked.
        acceptHonorCode();
        await waitFor(() => findButton(/^(submit|отправить)$/i), 8000);
        const submit = findButton(/^(submit|отправить)$/i);
        if (!submit) return { ok: false, note: tr('peerNoteSubmitDisabled') };
        submit.click();
        // Confirmation: "I understand…" checkbox (and sometimes the legal name), then Submit.
        const confirmation = () => shownDialogs().find(dialog => findButton(BUTTONS.confirm, dialog));
        await waitFor(confirmation, 8000);
        const name = confirmation()?.querySelector('input[type="text"], input:not([type])');
        const fullName = readUserData()?.fullName;
        if (name && !name.value && fullName) setNativeValue(name, fullName);
        await confirmInDialog(BUTTONS.confirm, 2000);
        return { ok: true };
    }

    // The submission under review as text: text parts, links and the text of attached files.
    async function submissionText(run, item, submissionId) {
        const data = await getJson(`${API}/onDemandPeerSubmissions.v1/${run.userId}~${run.courseId}~${item.id}~${submissionId}/` +
            '?fields=submission,onDemandPeerReviewSchemas.v1(reviewSchema),onDemandPeerSubmissionSchemas.v1(submissionSchema)&includes=submissionSchemas,reviewSchemas');
        const element = data?.elements?.[0] || {};
        const schema = data?.linked?.['onDemandPeerSubmissionSchemas.v1']?.[0]?.submissionSchema?.parts || [];
        const reviewParts = data?.linked?.['onDemandPeerReviewSchemas.v1']?.[0]?.reviewSchema?.parts || null;
        const sections = [`Title: ${element.submission?.title || ''}`];
        for (const [id, part] of Object.entries(element.submission?.parts || {})) {
            const prompt = cmlText(schema.find(entry => entry.id === id)?.prompt);
            const definition = part.definition || {};
            let content = '';
            if (definition.fileUrl) {
                const text = await Naki.files.textOf(definition.fileUrl).catch(() => '');
                content = `[file "${definition.caption || definition.title || definition.fileUrl.split('/').pop()}"]\n${text || '(the file could not be read as text: an image, scan or archive)'}`;
            } else if (definition.url) {
                content = `[link] ${definition.url} ${definition.title || ''}`;
            } else if (typeof definition.plainText === 'string') {
                content = definition.plainText;
            } else if (definition.richText) {
                content = cmlText(definition.richText) || htmlToText(JSON.stringify(definition.richText));
            } else {
                content = JSON.stringify(definition).slice(0, 4000);
            }
            sections.push(`Part "${prompt || id}":\n${content}`);
        }
        return { text: sections.join('\n\n').slice(0, 30000), reviewParts };
    }

    async function reviewPeer(run, item, submissionId) {
        const assignment = await peerAssignment(run, item);
        const submission = await submissionText(run, item, submissionId);
        const parts = (submission.reviewParts || assignment.reviewParts).map(part => ({
            id: part.id, kind: partKind(part) === 'yesNo' ? 'options' : partKind(part), prompt: cmlText(part.prompt),
            ...(['options', 'yesNo'].includes(partKind(part)) ? { options: optionsOf(part).map((option, i) => ({ i, text: option.text, points: option.points })) } : {})
        }));
        const prompt = `You are reviewing a classmate's submission for the peer-reviewed assignment "${item.name}" of an online course.
Grade it honestly and fairly by the rubric: give credit only for what the submission actually contains. An empty,
unreadable or off-topic submission gets the lowest option. Feedback must be specific to this submission, constructive
and polite, 2–5 sentences, in the language of the submission.

Assignment instructions and review criteria:
<<<
${assignment.instructions.slice(0, 8000)}
>>>

The submission:
<<<
${submission.text}
>>>

Rubric (JSON):
${JSON.stringify(parts)}

Answer in exactly this format, one section per rubric item, nothing else:
=== ITEM <rubric id> ===
<the option index "i" for an "options" item, or the feedback text for a "text" item>`;
        const answer = parseSections(await generateText(prompt));
        let filled = 0;
        for (const part of parts) {
            const value = answer[`ITEM ${part.id}`] ?? answer[part.id];
            if (!value) continue;
            const ok = part.kind === 'options'
                ? chooseOption(part.id, part.options, optionNumber(value))
                : fillText(part.id, value);
            if (ok) filled++;
            await sleep(200);
        }
        if (!filled && parts.length) return false;
        await sleep(800);
        const submit = findButton(/^(submit review|отправить отзыв|отправить рецензию)$/i);
        if (!submit) return false;
        submit.click();
        await confirmInDialog(/^(submit|submit review|confirm|yes|отправить|отправить отзыв|подтвердить|да)$/i, 3000);
        return true;
    }

    const setPeerPhase = async (run, phase) => {
        run.phase = phase;
        run.phaseAt = Date.now();
        await saveRun(run);
    };

    async function peerStep(run, item) {
        run.peer = run.peer || { reviewed: [], required: null };
        const [, route = '', submissionId = null] = peerRoute();
        const page = route.split('/')[0];
        if (run.phase === 'open' || run.phase === 'navigating') {
            const assignment = await peerAssignment(run, item);
            run.peer.required = assignment.required ?? 1;
            await setPeerPhase(run, await peerSubmitted(run, item) ? 'peer-review' : 'peer-submit');
        }
        if (run.phase === 'peer-submit') {
            if (page !== 'submit') {
                location.assign(peerUrl(run, item, '/submit'));
                return;
            }
            await waitFor(() => document.getElementById('title') || findButton(/^(submit|отправить)$/i), 15000);
            if (await peerSubmitted(run, item)) {
                await setPeerPhase(run, 'peer-review');
                return;
            }
            // A failed try (the model did not answer, a timeout…) is tried once more; each try costs requests to the model.
            run.peer.tries = (run.peer.tries || 0) + 1;
            run.phaseAt = Date.now();
            await saveRun(run);
            let result;
            try {
                result = await submitPeer(run, item);
            } catch (error) {
                console.warn('[Naki] Peer submission failed:', error);
                if (run.peer.tries >= 2) await nextItem(run, { name: item.name, pass: false, percent: null, note: `${tr('peerNoteNotSubmitted')}: ${error.message}` });
                return;
            }
            if (!result.ok) {
                await nextItem(run, { name: item.name, pass: false, percent: null, note: result.note });
                return;
            }
            await setPeerPhase(run, 'peer-submitted');
            return;
        }
        if (run.phase === 'peer-submitted') {
            if (await peerSubmitted(run, item)) {
                await setPeerPhase(run, 'peer-review');
            } else if (Date.now() - run.phaseAt > 60000) {
                await nextItem(run, { name: item.name, pass: false, percent: null, note: tr('peerNoteNotSubmitted') });
            }
            return;
        }
        if (run.phase !== 'peer-review') return;
        const reviewed = run.peer.reviewed;
        if (page === 'review' && submissionId) {
            if (reviewed.includes(submissionId)) {
                location.assign(peerUrl(run, item, '/give-feedback'));
                return;
            }
            await waitFor(() => findButton(/^(submit review|отправить отзыв|отправить рецензию)$/i), 15000);
            showRun(run, tr('autopilotPeerReview', { n: reviewed.length + 1, total: run.peer.required, title: item.name }));
            const ok = await reviewPeer(run, item, submissionId).catch(error => { console.warn('[Naki] Peer review failed:', error); return false; });
            reviewed.push(submissionId);
            if (!ok) run.peer.failed = (run.peer.failed || 0) + 1;
            await setPeerPhase(run, 'peer-review');
            await sleep(1500);
            location.assign(peerUrl(run, item, '/give-feedback'));
            return;
        }
        if (page !== 'give-feedback') {
            location.assign(peerUrl(run, item, '/give-feedback'));
            return;
        }
        await waitFor(() => document.querySelector('a[href*="/review/"]') || /left to complete|осталось/i.test(document.body.innerText), 15000);
        const left = document.body.innerText.match(/(\d+)\s+(?:left to complete|reviews? left)|осталось[^\d]{0,20}(\d+)/i);
        const leftCount = left ? Number(left[1] ?? left[2]) : null;
        const done = reviewed.length - (run.peer.failed || 0);
        const finished = leftCount !== null ? leftCount === 0 : done >= run.peer.required;
        const links = [...document.querySelectorAll('a[href*="/review/"]')].map(link => link.getAttribute('href').match(/\/review\/([^/?#]+)/)?.[1]).filter(Boolean);
        const next = links.find(id => !reviewed.includes(id));
        if (finished || !next || reviewed.length >= run.peer.required + 4) {
            const note = finished ? tr('peerNoteDone', { n: done }) : tr('peerNoteNoPeers', { n: done });
            await nextItem(run, { name: item.name, pass: finished, percent: null, note });
            return;
        }
        location.assign(peerUrl(run, item, `/review/${next}`));
    }

    // The solve button / hotkey on a peer-reviewed assignment: submit it and review classmates, like the autopilot.
    const peerItemHere = () => location.pathname.match(/\/learn\/[^/]+\/peer\/([^/]+)/)?.[1] || null;
    const solveHere = () => (peerItemHere() ? startAutopilot({ only: peerItemHere() }) : solveQuiz());

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
        const { solve, skip } = state.settings.hotkeys;
        const action = Naki.hotkeyMatches(solve, event) ? solveHere : Naki.hotkeyMatches(skip, event) ? skipContent : null;
        if (!action) return;
        const hotkey = action === solveHere ? solve : skip;
        if (!Naki.hasModifier(hotkey) && isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
    }, true);

    // ------------------------------------------------------------------ messaging & settings

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message?.type) {
            case Naki.MSG.SOLVE:
                solveHere();
                sendResponse({ ok: true });
                break;
            case Naki.MSG.SKIP:
                skipContent();
                sendResponse({ ok: true });
                break;
            case Naki.MSG.MATERIALS_LOAD:
                loadMaterialsNow();
                sendResponse({ ok: true });
                break;
            case Naki.MSG.AUTOPILOT:
                startAutopilot();
                sendResponse({ ok: true });
                break;
            case Naki.MSG.STATUS:
                sendResponse({
                    ok: true,
                    questions: state.questions.length,
                    onAttempt: isAttemptPage(),
                    solving: state.solving,
                    skipping: state.skipping,
                    autopilot: !!state.autopilot,
                    courseLoaded: !!state.courseMaterials
                });
                break;
        }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') for (const key of Object.keys(changes)) if (key.startsWith(Materials.KEY)) materialsCache.delete(key.slice(Materials.KEY.length));
        if (area !== 'local') return;
        Naki.loadSettings().then(settings => { state.settings = settings; });
    });

    // Runs at document_start: page scripts with window.App are parsed later.
    document.addEventListener('DOMContentLoaded', () => { state.userId = state.userId || readUserId(); });
    // Replay responses captured before this script loaded, once settings (auto-solve) are known.
    Naki.loadSettings().then(settings => {
        state.settings = settings;
        requestReplay();
        loadRun().then(run => { if (run) runLoop(); }); // resume a quiz autopilot run after a page load
    });
    console.log('[Naki] NSolver loaded — made by Naki: https://github.com/Naki-404/NSolver');
})();
