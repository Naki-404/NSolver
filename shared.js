// Shared constants, settings and translations for background, content scripts and panel. NSolver, made by Naki — https://github.com/Naki-404/NSolver
var Naki = (function () {
    const MSG = {
        SOLVE: 'naki:solve',
        SKIP: 'naki:skip',
        STATUS: 'naki:status',
        API_REQUEST: 'naki:api-request',
        CAPTURE: 'naki:capture-tab',
        SOLVE_RELAY: 'naki:solve-relay'
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
            statusNetacad: 'Cisco NetAcad: решение по скриншоту',
            solveScreen: 'Решить вопрос на экране',
            netacadButton: 'Кнопка на странице', netacadButtonHint: 'Плавающая кнопка «Решить» в углу NetAcad',
            capturePermission: 'Скриншот без панели', capturePermissionHint: 'Нужно для кнопки и хоткея на странице',
            grant: 'Разрешить', granted: 'Разрешено',
            netacadSolve: 'Решить',
            netacadCapturing: 'Делаю скриншот…',
            netacadSolving: 'Решаю по скриншоту с помощью {model}…',
            netacadAnswer: '{model} · {sec} с',
            netacadNoQuestion: 'На экране не видно вопроса. Прокрутите к вопросу так, чтобы он и варианты были видны целиком, и повторите.',
            netacadNeedPermission: 'Chrome не дал сделать скриншот. Нажмите «Решить» в панели NSolver или включите «Скриншот без панели» в карточке Cisco NetAcad.',
            netacadError: 'Ошибка: {error}',
            netacadCopy: 'Копировать', netacadCopied: 'Скопировано', netacadClose: 'Закрыть',
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
            errEmptySolutions: 'модель вернула пустой список ответов.',
            errImage: 'Не удалось получить скриншот вкладки.'
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
            statusNetacad: 'Cisco NetAcad: solving from a screenshot',
            solveScreen: 'Solve the question on screen',
            netacadButton: 'On-page button', netacadButtonHint: 'Floating "Solve" button in the NetAcad corner',
            capturePermission: 'Screenshot without panel', capturePermissionHint: 'Needed for the on-page button and hotkey',
            grant: 'Allow', granted: 'Allowed',
            netacadSolve: 'Solve',
            netacadCapturing: 'Taking a screenshot…',
            netacadSolving: 'Solving from the screenshot with {model}…',
            netacadAnswer: '{model} · {sec}s',
            netacadNoQuestion: 'No question is visible. Scroll so the question and all its options are fully on screen and try again.',
            netacadNeedPermission: 'Chrome refused the screenshot. Press "Solve" in the NSolver panel or turn on "Screenshot without panel" in the Cisco NetAcad card.',
            netacadError: 'Error: {error}',
            netacadCopy: 'Copy', netacadCopied: 'Copied', netacadClose: 'Close',
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
            errEmptySolutions: 'the model returned an empty answer list.',
            errImage: 'Could not capture the tab screenshot.'
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
