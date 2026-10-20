// Shared constants, settings and translations for background, content scripts and panel. NSolver, made by Naki — https://github.com/Naki-404/NSolver
var Naki = (function () {
    const MSG = {
        SOLVE: 'naki:solve',
        SKIP: 'naki:skip',
        STATUS: 'naki:status',
        API_REQUEST: 'naki:api-request',
        RELAY: 'naki:relay',
        AUTOPILOT: 'naki:autopilot'
    };

    const PROVIDER_IDS = ['octava', 'anthropic', 'openai', 'gemini'];

    const DEFAULT_SETTINGS = {
        lang: 'ru',
        provider: 'octava',
        apiKeys: { octava: '', anthropic: '', openai: '', gemini: '' },
        models: { octava: 'gpt-6-luna', anthropic: 'claude-opus-5-5', openai: 'gpt-5.5', gemini: 'gemini-3.8-flash' },
        autoSolve: false,
        skipDiscussions: false,
        netacadButton: true,
        autopilotRetakes: 2, // automatic retakes of a failed quiz: 0 (leave it to the user), 2 or 3
        hotkeys: {
            solve: { code: 'KeyK', key: 'K', alt: true, ctrl: false, shift: false, meta: false },
            skip: null
        }
    };

    function withDefaults(stored = {}) {
        const settings = { ...DEFAULT_SETTINGS, ...stored };
        settings.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...stored.apiKeys };
        settings.models = { ...DEFAULT_SETTINGS.models, ...stored.models };
        settings.hotkeys = { ...DEFAULT_SETTINGS.hotkeys, ...stored.hotkeys };
        if (!PROVIDER_IDS.includes(settings.provider)) settings.provider = 'octava';
        if (settings.lang !== 'en') settings.lang = 'ru';
        if (![0, 2, 3].includes(settings.autopilotRetakes)) settings.autopilotRetakes = DEFAULT_SETTINGS.autopilotRetakes;
        return settings;
    }

    async function loadSettings() {
        const stored = await chrome.storage.local.get(null);
        // Keys used by earlier versions of the extension.
        const legacyKey = stored.apiKey || stored.key;
        if (legacyKey && !stored.apiKeys?.octava) stored.apiKeys = { ...stored.apiKeys, octava: legacyKey };
        if (stored.model && !/^gemini/i.test(stored.model) && !stored.models?.octava) stored.models = { ...stored.models, octava: stored.model };
        if (stored.autoSolve === undefined && stored.quiz !== undefined) stored.autoSolve = stored.quiz;
        return withDefaults(stored);
    }

    function saveSettings(patch) {
        return chrome.storage.local.set(patch);
    }

    const activeKey = settings => (settings.apiKeys[settings.provider] || '').trim();
    const activeModel = settings => (settings.models[settings.provider] || DEFAULT_SETTINGS.models[settings.provider]).trim();

    // ------------------------------------------------------------------ hotkeys

    const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']);

    function hotkeyFromEvent(event) {
        if (MODIFIER_CODES.has(event.code)) return null;
        let key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        // Layout-independent label for letters and digits (e.g. Russian layout).
        const letter = event.code.match(/^Key([A-Z])$/);
        const digit = event.code.match(/^Digit(\d)$/);
        if (letter) key = letter[1];
        else if (digit) key = digit[1];
        return { code: event.code, key, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey };
    }

    function hotkeyMatches(hotkey, event) {
        return !!hotkey &&
            event.code === hotkey.code &&
            event.altKey === !!hotkey.alt &&
            event.ctrlKey === !!hotkey.ctrl &&
            event.shiftKey === !!hotkey.shift &&
            event.metaKey === !!hotkey.meta;
    }

    function formatHotkey(hotkey, lang = 'ru') {
        if (!hotkey) return t(lang, 'hotkeyNone');
        const parts = [];
        if (hotkey.ctrl) parts.push('Ctrl');
        if (hotkey.alt) parts.push('Alt');
        if (hotkey.shift) parts.push('Shift');
        if (hotkey.meta) parts.push('Meta');
        parts.push(hotkey.key === ' ' ? 'Space' : hotkey.key);
        return parts.join('+');
    }

    const hasModifier = hotkey => !!hotkey && (hotkey.alt || hotkey.ctrl || hotkey.meta);

    // ------------------------------------------------------------------ translations

    const I18N = {
        ru: {
            tabMain: 'Главная', tabSettings: 'Настройки',
            statusChecking: 'Проверяю вкладку…',
            statusNoCourse: 'Откройте курс Coursera или Cisco NetAcad',
            statusSolving: 'Quiz Solver решает тест…',
            statusSkipping: 'Отмечаю материалы курса…',
            statusQuiz: 'Тест найден: {n} вопр.', statusOpenAttempt: ' (откройте попытку)',
            statusWaiting: 'Попытка открыта, жду вопросы…',
            statusCourse: 'Курс Coursera открыт',
            solve: 'Решить тест', starting: 'Запускаю…',
            autoSolve: 'Авто-решение', autoSolveHint: 'Сразу при открытии попытки теста',
            skipTitle: 'Пропуск материалов', skip: 'Пропустить материалы',
            skipDiscussions: 'Также обсуждения', skipDiscussionsHint: 'Короткий шаблонный ответ в каждом обсуждении',
            provider: 'API', model: 'Модель', loadModels: 'Обновить список моделей с API',
            modelCustom: '✎ Другая модель…', modelCustomPlaceholder: 'ID модели', modelsLoading: 'Загружаю модели…',
            modelsLoaded: 'Загружено моделей: {n}.', modelsFailed: 'Не удалось загрузить модели: {error}',
            apiKey: 'API-ключ', getKey: 'Получить ключ ↗', keyPlaceholder: 'Вставьте ключ',
            save: 'Сохранить', checking: 'Проверка…',
            keySaved: 'Ключ сохранён.', keyMissing: 'Ключ не задан.', keyEnter: 'Введите API-ключ.',
            keyOk: 'Ключ сохранён и работает ({model}).', keyFail: 'Ключ сохранён, но проверка не прошла: {error}',
            keyFirst: 'Сначала сохраните API-ключ в «Настройках».',
            hotkeys: 'Горячие клавиши', hotkeyNone: 'Нет', hotkeyPress: 'Нажмите…', hotkeyReset: 'Сбросить',
            hotkeysHint: 'Нажмите кнопку и сочетание клавиш — работает сразу на странице курса Coursera и на NetAcad. Клавиша без Ctrl/Alt не срабатывает при вводе текста.',
            language: 'Язык',
            // Cisco NetAcad
            statusNetacad: 'Cisco NetAcad: курс открыт',
            statusNetacadNoAccess: 'NetAcad: Chrome не пускает расширение на страницу. Обновите вкладку.',
            netacadButton: 'Кнопка на странице', netacadButtonHint: 'Плавающая кнопка «Решить» в углу NetAcad',
            netacadSolve: 'Решить', netacadClose: 'Закрыть',
            netacadNoQuestions: 'На странице нет неотвеченных вопросов. Откройте тест (или страницу с вопросами) и повторите.',
            netacadPartial: 'Проставлено {applied} из {total} за {sec} с. Отметьте вручную:',
            netacadSkipHint: 'Все модули курса: видео, текст, вкладки, анимации. Тесты не трогаются',
            netacadSkipModule: 'Модуль {n} из {total}: {title}…',
            netacadSkipCourseDone: 'Готово: пройдено модулей {modules}, засчитано материалов {components}. Проценты в оглавлении NetAcad обновит, когда вы откроете модуль. Тесты и «Check Your Understanding» решайте кнопкой «Решить».',
            netacadSkipFailed: ' Не открылись: {list}.',
            netacadSkipping: 'Прохожу материалы: {done} из {total}…',
            netacadSkipDone: 'Готово: {summary}. Обновите страницу курса, чтобы увидеть прогресс.',
            netacadSkipNothing: 'Материалы курса не найдены. Откройте модуль курса и повторите.',
            netacadSkipComponents: 'компоненты', netacadSkipVideos: 'видео',
            // quiz autopilot
            autopilotTitle: 'Автосолвер квизов', autopilotRun: 'Пройти весь курс', autopilotConfirm: 'Нажмите ещё раз: квизы будут отправлены',
            autopilotHint: 'Все квизы курса по порядку, с отправкой. NetAcad: ещё и материалы; экзамены не трогаются',
            autopilotRetakes: 'Если квиз не сдан', autopilotRetakes0: 'Не пересдавать', autopilotRetakes2: '2 пересдачи', autopilotRetakes3: '3 пересдачи',
            autopilotBusy: 'Автосолвер уже работает…',
            autopilotStopped: 'Автосолвер остановлен.', autopilotStopping: 'Автосолвер остановится после текущего модуля.',
            autopilotNoCourse: 'Откройте курс в плеере NetAcad (netacad.com/launch…) и повторите.',
            autopilotModule: 'Автосолвер — модуль {n} из {total}: {title}…',
            autopilotNotOpened: 'модуль не открылся',
            autopilotDone: 'Готово: модулей {modules}, квизов сдано {passed}, не сдано {failed}, материалов засчитано {materials}.',
            autopilotNoQuizzes: 'В курсе нет квизов для автосолвера.',
            autopilotItem: 'Автосолвер — {n} из {total}: {title}…',
            autopilotCourseraDone: 'Готово: квизов сдано {passed}, не сдано {failed}.',
            autopilotStuck: 'не нашёл кнопку «{step}»',
            statusAutopilot: 'Автосолвер проходит курс…',
            // content script
            toastBusySolve: 'Quiz Solver уже работает…',
            toastNoKey: 'Нужен API-ключ: откройте панель расширения → Настройки.',
            toastNoQuestions: 'Вопросы теста не найдены. Откройте попытку теста (Start/Resume) и при необходимости обновите страницу.',
            toastSolving: '{auto}решаю {n} вопр. с помощью {model}…', toastAuto: 'Авто-режим: ',
            toastPartial: 'Проставлено {applied} из {total} за {sec} с. Проверьте вручную вопросы: {missed}.',
            toastDone: 'Готово: ответы на все {applied} вопр. за {sec} с. Проверьте перед отправкой.',
            toastSolveError: 'Ошибка Quiz Solver: {error}',
            toastBusySkip: 'Пропуск материалов уже выполняется…',
            toastNoCourse: 'Не удалось определить курс или пользователя. Откройте страницу курса и обновите её.',
            toastNoMaterials: 'Материалы курса не найдены. Откройте любой модуль курса и обновите страницу.',
            toastSkipping: 'Отмечаю пройденными: {lectures} лекций и {readings} материалов…',
            toastSkipProgress: 'Отмечаю пройденными: {done} из {total}…',
            toastDiscussions: 'Отвечаю в {n} обсуждениях…',
            toastSkipSummary: 'Лекции: {l}, материалы: {r}.', toastSkipDiscussions: ' Обсуждения: {d}.',
            toastSkipCoach: ' Диалоги и role play: {c}.',
            toastForumLimit: ' Coursera ограничила число постов на форуме для вашего аккаунта — остальные обсуждения повторите позже (обычно через несколько часов).',
            toastSkipDone: '{summary} Обновите страницу, чтобы увидеть прогресс. Новые курсы могут блокировать отметку.',
            toastSkipError: 'Не удалось отметить материалы: {error}',
            // model provider
            errNoKey: 'Не указан API-ключ для {provider}. Сохраните его в настройках расширения.',
            errNetwork: 'Нет связи с {provider}: {error}',
            errAuth: 'Неверный или неактивный API-ключ {provider}: {error}',
            errRate: 'Превышен лимит запросов (429): {error}',
            errBadRequest: 'Ошибка запроса (400): {error}',
            errApi: 'Ошибка {provider} ({status}): {error}',
            errEmpty: '{provider} вернул пустой ответ.',
            errRefusal: 'Модель отказалась отвечать на запрос.',
            errJson: 'Модель вернула некорректный JSON: {error}',
            errNotArray: 'Ответ модели не является JSON-массивом решений.',
            errEmptySolutions: 'модель вернула пустой список ответов.'
        },
        en: {
            tabMain: 'Main', tabSettings: 'Settings',
            statusChecking: 'Checking the tab…',
            statusNoCourse: 'Open a Coursera or Cisco NetAcad course',
            statusSolving: 'Quiz Solver is working…',
            statusSkipping: 'Marking course materials…',
            statusQuiz: 'Quiz found: {n} questions', statusOpenAttempt: ' (open the attempt)',
            statusWaiting: 'Attempt open, waiting for questions…',
            statusCourse: 'Coursera course open',
            solve: 'Solve quiz', starting: 'Starting…',
            autoSolve: 'Auto-solve', autoSolveHint: 'Run as soon as a quiz attempt opens',
            skipTitle: 'Skip materials', skip: 'Skip materials',
            skipDiscussions: 'Discussions too', skipDiscussionsHint: 'Posts a short template reply in each discussion',
            provider: 'API', model: 'Model', loadModels: 'Refresh the model list from the API',
            modelCustom: '✎ Other model…', modelCustomPlaceholder: 'Model ID', modelsLoading: 'Loading models…',
            modelsLoaded: 'Models loaded: {n}.', modelsFailed: 'Could not load models: {error}',
            apiKey: 'API key', getKey: 'Get a key ↗', keyPlaceholder: 'Paste your key',
            save: 'Save', checking: 'Checking…',
            keySaved: 'Key saved.', keyMissing: 'No key set.', keyEnter: 'Enter an API key.',
            keyOk: 'Key saved and working ({model}).', keyFail: 'Key saved, but the check failed: {error}',
            keyFirst: 'Save an API key in Settings first.',
            hotkeys: 'Hotkeys', hotkeyNone: 'None', hotkeyPress: 'Press keys…', hotkeyReset: 'Reset',
            hotkeysHint: 'Click a button and press keys — works right away on Coursera course pages and on NetAcad. A key without Ctrl/Alt is ignored while typing.',
            language: 'Language',
            statusNetacad: 'Cisco NetAcad: course open',
            statusNetacadNoAccess: 'NetAcad: Chrome blocks the extension on this page. Reload the tab.',
            netacadButton: 'On-page button', netacadButtonHint: 'Floating "Solve" button in the NetAcad corner',
            netacadSolve: 'Solve', netacadClose: 'Close',
            netacadNoQuestions: 'No unanswered questions on the page. Open the quiz (or a page with questions) and try again.',
            netacadPartial: 'Filled {applied} of {total} in {sec}s. Select these yourself:',
            netacadSkipHint: 'Every course module: videos, text, tabs, animations. Quizzes are left alone',
            netacadSkipModule: 'Module {n} of {total}: {title}…',
            netacadSkipCourseDone: 'Done: {modules} modules gone through, {components} materials completed. NetAcad updates the outline percentages when you open a module. Solve quizzes and "Check Your Understanding" with the Solve button.',
            netacadSkipFailed: ' Could not open: {list}.',
            netacadSkipping: 'Going through materials: {done} of {total}…',
            netacadSkipDone: 'Done: {summary}. Reload the course page to see progress.',
            netacadSkipNothing: 'No course materials found. Open a course module and try again.',
            netacadSkipComponents: 'components', netacadSkipVideos: 'videos',
            autopilotTitle: 'Quiz autopilot', autopilotRun: 'Go through the course', autopilotConfirm: 'Click again: quizzes will be submitted',
            autopilotHint: 'Every quiz of the course in order, submitted. NetAcad: materials too; exams are left alone',
            autopilotRetakes: 'If a quiz is failed', autopilotRetakes0: 'No retakes', autopilotRetakes2: '2 retakes', autopilotRetakes3: '3 retakes',
            autopilotBusy: 'The autopilot is already running…',
            autopilotStopped: 'The autopilot was stopped.', autopilotStopping: 'The autopilot will stop after the current module.',
            autopilotNoCourse: 'Open the course in the NetAcad player (netacad.com/launch…) and try again.',
            autopilotModule: 'Autopilot — module {n} of {total}: {title}…',
            autopilotNotOpened: 'module did not open',
            autopilotDone: 'Done: {modules} modules, {passed} quizzes passed, {failed} failed, {materials} materials completed.',
            autopilotNoQuizzes: 'The course has no quizzes for the autopilot.',
            autopilotItem: 'Autopilot — {n} of {total}: {title}…',
            autopilotCourseraDone: 'Done: {passed} quizzes passed, {failed} failed.',
            autopilotStuck: 'could not find the "{step}" button',
            statusAutopilot: 'The autopilot is going through the course…',
            toastBusySolve: 'Quiz Solver is already running…',
            toastNoKey: 'An API key is required: open the extension panel → Settings.',
            toastNoQuestions: 'No quiz questions found. Open a quiz attempt (Start/Resume) and reload the page if needed.',
            toastSolving: '{auto}solving {n} questions with {model}…', toastAuto: 'Auto mode: ',
            toastPartial: 'Filled {applied} of {total} in {sec}s. Check these questions manually: {missed}.',
            toastDone: 'Done: answered all {applied} questions in {sec}s. Review before submitting.',
            toastSolveError: 'Quiz Solver error: {error}',
            toastBusySkip: 'Skipping is already running…',
            toastNoCourse: 'Could not detect the course or user. Open the course page and reload it.',
            toastNoMaterials: 'Course materials not found. Open any course module and reload the page.',
            toastSkipping: 'Marking {lectures} lectures and {readings} readings as completed…',
            toastSkipProgress: 'Marking as completed: {done} of {total}…',
            toastDiscussions: 'Replying in {n} discussions…',
            toastSkipSummary: 'Lectures: {l}, readings: {r}.', toastSkipDiscussions: ' Discussions: {d}.',
            toastSkipCoach: ' Dialogues and role plays: {c}.',
            toastForumLimit: ' Coursera has limited forum posts for your account — retry the remaining discussions later (usually a few hours).',
            toastSkipDone: '{summary} Reload the page to see progress. Newer courses may block completion.',
            toastSkipError: 'Could not mark materials: {error}',
            errNoKey: 'No API key for {provider}. Save it in the extension settings.',
            errNetwork: 'Cannot reach {provider}: {error}',
            errAuth: 'Invalid or inactive {provider} API key: {error}',
            errRate: 'Rate limit exceeded (429): {error}',
            errBadRequest: 'Bad request (400): {error}',
            errApi: '{provider} error ({status}): {error}',
            errEmpty: '{provider} returned an empty response.',
            errRefusal: 'The model declined to answer the request.',
            errJson: 'The model returned invalid JSON: {error}',
            errNotArray: 'The model response is not a JSON array of solutions.',
            errEmptySolutions: 'the model returned an empty answer list.'
        }
    };

    function t(lang, key, vars = {}) {
        const table = I18N[lang] || I18N.ru;
        const template = table[key] ?? I18N.ru[key] ?? key;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
    }

    return {
        MSG, PROVIDER_IDS, DEFAULT_SETTINGS, I18N,
        withDefaults, loadSettings, saveSettings, activeKey, activeModel,
        hotkeyFromEvent, hotkeyMatches, formatHotkey, hasModifier, t
    };
})();
