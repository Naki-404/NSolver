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
        skipping: false
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

    function readUserId() {
        for (const script of document.getElementsByTagName('script')) {
            const text = script.textContent;
            if (!text || !text.includes('window.App')) continue;
            const match = text.match(/window\.App\s*=\s*(\{.*?\});/s);
            if (!match) continue;
            try {
                return JSON.parse(match[1])?.context?.dispatcher?.stores?.ApplicationStore?.userData?.id || null;
            } catch (e) {
                return null;
            }
        }
        return null;
    }

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

    async function solveQuiz({ auto = false } = {}) {
        if (state.solving) {
            toast(tr('toastBusySolve'), 'info', 2500);
            return;
        }
        state.solving = true;
        try {
            if (!Naki.activeKey(state.settings)) {
                toast(tr('toastNoKey'), 'error');
                return;
            }
            if (!state.questions.length) {
                requestReplay();
                await waitFor(() => state.questions.length > 0, 1500, 100);
            }
            if (!state.questions.length) {
                toast(tr('toastNoQuestions'), 'info', 6000);
                return;
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
        } catch (error) {
            console.error('[Naki] Quiz solver error:', error);
            toast(tr('toastSolveError', { error: error.message }), 'error', 8000);
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
            case Naki.MSG.STATUS:
                sendResponse({
                    ok: true,
                    questions: state.questions.length,
                    onAttempt: isAttemptPage(),
                    solving: state.solving,
                    skipping: state.skipping,
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
    });
    console.log('[Naki] NSolver loaded — made by Naki: https://github.com/Naki-404/NSolver');
})();
