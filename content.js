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

    function extractQuestions(parts) {
        return parts.map(part => {
            const schema = part.questionSchema || {};
            const typename = String(schema.__typename || '').toLowerCase();
            const options = (schema.options || []).map(option => htmlToText(option?.display?.htmlWithMetadata?.html));
            const isChoice = options.length > 0 && (typename.includes('multiplechoice') || typename.includes('checkbox') || typename.includes('choice'));
            return {
                type: isChoice ? 'mcq' : 'textArea',
                multiple: typename.includes('checkbox'),
                question: htmlToText(schema.prompt?.htmlWithMetadata?.html),
                options: isChoice ? options : []
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
            toast(tr('toastSolving', { auto: auto ? tr('toastAuto') : '', n: questions.length, model: options.modelId }), 'info');
            const started = performance.now();

            const [solutions] = await Promise.all([
                ModelProvider.solveQuizQuestions(questions, options),
                waitFor(() => document.querySelector('input[type="radio"], input[type="checkbox"], textarea'), 10000)
            ]);
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
            'onDemandCourseMaterialItems.v2(name,slug,timeCommitment,contentSummary,isLocked,lockableByItem,itemLockedReasonCode,trackId,lockedStatus,itemLockSummary)' +
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

    async function answerDiscussions(items, userId, courseId) {
        const questionIds = [];
        await runLimited(items, 4, async item => {
            const response = await fetchWithTimeout(`${API}/onDemandDiscussionPrompts.v1/${userId}~${courseId}~${item.id}?fields=promptType`);
            const data = await response.json();
            const id = data?.elements?.[0]?.promptType?.definition?.courseItemForumQuestionId;
            if (id) questionIds.push(id);
            return response;
        });
        const replies = ['Interesting question, thanks for sharing.', 'Good point, I will look into this further.', 'Thanks, this helped me understand the topic better.'];
        let posted = 0;
        for (const id of questionIds) {
            const text = replies[Math.floor(Math.random() * replies.length)];
            const response = await jsonPost(`${API}/onDemandCourseForumAnswers.v1/`, {
                content: { typeName: 'cml', definition: { dtdId: 'discussion/1', value: `<co-content><text>${text}</text></co-content>` } },
                courseForumQuestionId: `${courseId}~${id.split('~')[2]}`
            });
            if (response.ok) posted++;
            await sleep(4000);
        }
        return posted;
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

            const byType = type => items.filter(item => item.contentSummary?.typeName === type);
            const lectures = byType('lecture');
            const readings = byType('supplement');
            const total = lectures.length + readings.length;
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

            let summary = tr('toastSkipSummary', { l: `${doneLectures}/${lectures.length}`, r: `${doneReadings}/${readings.length}` });
            if (state.settings.skipDiscussions) {
                const discussions = byType('discussionPrompt');
                if (discussions.length) {
                    progress.update(tr('toastDiscussions', { n: discussions.length }), 'info', 0);
                    const posted = await answerDiscussions(discussions, state.userId, courseId);
                    summary += tr('toastSkipDiscussions', { d: `${posted}/${discussions.length}` });
                }
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
    // Goes through every quiz of the course (graded "exam" and practice "quiz" items) in course order: opens it,
    // starts an attempt, solves it, accepts the Honor Code, submits, reads the grade and retakes a failed quiz as set
    // in the panel. Coursera loads a new page per item, so the run lives in chrome.storage.local and resumes on load.

    const AUTOPILOT_KEY = 'nakiAutopilot';
    const QUIZ_TYPES = ['exam', 'quiz'];
    const STEP_MS = 1500;
    const STUCK_MS = 45000; // a step that makes no progress for this long is given up, the run moves on
    const BUTTONS = {
        start: /^(start|start quiz|start assignment|resume|resume assignment|continue|continue assignment|начать|начать тест|продолжить|возобновить)$/i,
        retry: /^(try again|retry|retake|retake quiz|retake assignment|start new attempt|new attempt|повторить|повторить попытку|пройти снова|начать заново)$/i,
        submit: /^(submit|submit quiz|submit assignment|отправить|отправить тест)$/i
    };
    const HONOR_TEXT = /honor code|isn.t my own|not my own|understand that submitting|кодекс|не являющ|моей собственной/i;

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

    const itemPath = (run, item) => `/learn/${run.slug}/${item.type}/${item.id}`;
    const itemUrl = (run, item) => `https://www.coursera.org${itemPath(run, item)}/${item.slug || ''}`;

    // Quizzes in course order (modules → lessons → items); falls back to the API order.
    function courseQuizzes(materials) {
        const items = materialItems(materials);
        const byId = new Map(items.map(item => [item.id, item]));
        const linked = materials?.linked || {};
        const modules = Object.entries(linked).find(([key]) => /^onDemandCourseMaterialModules\.v\d+$/i.test(key))?.[1] || [];
        const lessons = new Map((Object.entries(linked).find(([key]) => /^onDemandCourseMaterialLessons\.v\d+$/i.test(key))?.[1] || []).map(lesson => [lesson.id, lesson]));
        const moduleOrder = materials?.elements?.[0]?.moduleIds || modules.map(module => module.id);
        const ordered = [];
        for (const moduleId of moduleOrder) {
            const module = modules.find(m => m.id === moduleId);
            for (const lessonId of module?.lessonIds || []) {
                for (const itemId of lessons.get(lessonId)?.itemIds || []) if (byId.has(itemId)) ordered.push(byId.get(itemId));
            }
        }
        return (ordered.length ? ordered : items)
            .filter(item => QUIZ_TYPES.includes(item.contentSummary?.typeName) && !item.isLocked)
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

    async function startAutopilot() {
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
        let materials = state.courseMaterials;
        if (!materials) materials = await fetchCourseMaterials(slug).catch(() => null);
        const items = materials ? courseQuizzes(materials) : [];
        if (!items.length) {
            toast(tr('autopilotNoQuizzes'), 'info', 8000);
            return;
        }
        const run = { id: String(Date.now()), slug, items, index: 0, attempt: 0, phase: 'open', phaseAt: Date.now(), retakes: state.settings.autopilotRetakes, results: [] };
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
            if (!location.pathname.startsWith(itemPath(run, item))) {
                if (run.phase !== 'navigating' || Date.now() - run.phaseAt > 20000) {
                    run.phase = 'navigating';
                    run.phaseAt = Date.now();
                    await saveRun(run);
                    location.assign(itemUrl(run, item));
                }
                return;
            }
            if (Date.now() - run.phaseAt > STUCK_MS && run.phase !== 'submitted') {
                console.warn('[Naki] Autopilot stuck on', item.name, run.phase);
                await nextItem(run, { name: item.name, pass: false, percent: null, note: tr('autopilotStuck', { step: run.phase }) });
                return;
            }
            if (isAttemptPage()) await attemptStep(run, item);
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
        await sleep(1500);
        // Timed quizzes ask for confirmation in a dialog.
        const dialog = document.querySelector('[role="dialog"], .rc-Modal');
        const confirm = dialog && (findButton(BUTTONS.start, dialog) || findButton(BUTTONS.retry, dialog));
        if (confirm) confirm.click();
    }

    async function attemptStep(run, item) {
        if (run.phase === 'submitting' || run.phase === 'submitted') return; // waiting for the feedback page
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
        await sleep(1500);
        const dialog = document.querySelector('[role="dialog"], .rc-Modal');
        const confirm = dialog && findButton(BUTTONS.submit, dialog);
        if (confirm) confirm.click();
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
        const action = Naki.hotkeyMatches(solve, event) ? solveQuiz : Naki.hotkeyMatches(skip, event) ? skipContent : null;
        if (!action) return;
        const hotkey = action === solveQuiz ? solve : skip;
        if (!Naki.hasModifier(hotkey) && isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
    }, true);

    // ------------------------------------------------------------------ messaging & settings

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message?.type) {
            case Naki.MSG.SOLVE:
                solveQuiz();
                sendResponse({ ok: true });
                break;
            case Naki.MSG.SKIP:
                skipContent();
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
