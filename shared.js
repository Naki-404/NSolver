// Shared constants, settings and translations for background, content scripts and panel. NSolver, made by Naki — https://github.com/Naki-404/NSolver
var Naki = (function () {
    const MSG = {
        SOLVE: 'naki:solve',
        SKIP: 'naki:skip',
        STATUS: 'naki:status',
        API_REQUEST: 'naki:api-request',
        RELAY: 'naki:relay',
        AUTOPILOT: 'naki:autopilot',
        MATERIALS_LOAD: 'naki:materials-load',
        LAB_DONE: 'naki:lab-done'
    };

    const PROVIDER_IDS = ['octava', 'anthropic', 'openai', 'gemini'];

    const DEFAULT_SETTINGS = {
        lang: 'ru',
        provider: 'octava',
        apiKeys: { octava: '', anthropic: '', openai: '', gemini: '' },
        models: { octava: 'gpt-6-luna', anthropic: 'claude-opus-5-5', openai: 'gpt-5.5', gemini: 'gemini-3.8-flash' },
        autoSolve: false,
        courseContext: true, // course texts from the materials base go into the prompt (Coursera and NetAcad)
        materialsTtlDays: 14, // a downloaded Coursera course is downloaded again after this many days
        courseQueueLinks: '', // Coursera course / specialization links for "Go through courses", one per line
        skipDiscussions: false,
        netacadButton: true,
        netacadCheckpoints: true, // NetAcad autopilot: checkpoint exams too (never the final exam)
        autopilotRetakes: 2, // automatic retakes of a failed quiz: 0 (leave it to the user), 2 or 3
        autopilotPeer: true, // Coursera autopilot: submit graded peer-reviewed assignments and review classmates
        autopilotProgramming: true, // Coursera autopilot: graded programming assignments (Coursera Labs notebooks)
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
        settings.materialsTtlDays = Math.round(Number(settings.materialsTtlDays));
        if (!(settings.materialsTtlDays >= 1 && settings.materialsTtlDays <= 365)) settings.materialsTtlDays = DEFAULT_SETTINGS.materialsTtlDays;
        return settings;
    }

    async function loadSettings() {
        // Only settings and legacy keys: storage also holds cached course materials (megabytes).
        const stored = await chrome.storage.local.get([...Object.keys(DEFAULT_SETTINGS), 'apiKey', 'key', 'model', 'quiz']);
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
            courseContext: 'Учитывать материалы курса', courseContextHint: 'Тексты курса из базы материалов в запросе: точнее, но больше токенов',
            toastMaterials: 'Загружаю материалы курса: {done} из {total}…', toastMaterialsReady: 'Материалы курса загружены.',
            toastWithMaterials: ' (с материалами курса)',
            toastMaterialsLoaded: 'Материалов курса в базе: {n}.',
            // materials base
            materialsTitle: 'База материалов', materialsSummary: 'Курсов: {courses} · {size}',
            materialsEmpty: 'Пока пусто: материалы собираются при первом тесте курса Coursera или NetAcad.',
            queueTitle: 'Автопроход курсов', queueHint: 'Ссылки на курсы Coursera, специализации или профессиональные сертификаты, по одной в строке. Для каждого курса по очереди NSolver записывается (только бесплатно: Enroll for free или Audit, без пробных периодов и оплаты), засчитывает материалы и проходит автосолвером всё, что идёт в оценку.',
            queuePlaceholder: 'https://www.coursera.org/learn/…\nhttps://www.coursera.org/specializations/…', queueStart: 'Пройти все курсы', queueStop: 'Остановить',
            queueIdle: 'Не запущен.', queueRunning: 'Курс {n} из {total}: {title}', queueNoLinks: 'Нет ссылок на Coursera.', queueExpanding: 'Собираю список курсов…',
            queueStarted: 'Курсов в очереди: {n}. Открываю первый…', queueStopped: 'Автопроход остановлен.',
            queueCourse: 'Автопроход — курс {n} из {total}: {title}', queueNotEnrolled: 'не удалось записаться бесплатно (платный курс?)',
            queueNothingGraded: 'материалы засчитаны, оцениваемых заданий нет', queueRunEnded: 'автосолвер остановлен',
            queueDone: 'Автопроход закончен, курсов: {n}.', queueCourseResult: 'сдано {passed}, не сдано {failed}',
            materialsTtl: 'Обновлять через, дней', materialsTtlHint: 'Coursera: курс скачивается заново, когда база старше. Курсы с ручными правками не обновляются',
            materialsOpen: 'Открыть базу', materialsLoad: 'Загрузить этот курс',
            mbHint: 'Это то, что NSolver передаёт модели вместе с вопросами Coursera и NetAcad. Выключенные материалы не используются. Ручные правки и заметки сохраняются, когда курс скачивается заново.',
            mbCourses: 'Курсы', mbNoCourses: 'Курсов в базе пока нет. Откройте курс Coursera или NetAcad и нажмите «Загрузить этот курс» в окне расширения или решите тест.',
            mbPage: 'Страница',
            mbSelect: 'Выберите курс слева.', mbSearch: 'Поиск по названию и тексту…', mbNothingFound: 'Ничего не найдено.',
            mbAddNote: 'Добавить свой материал', mbNoteTitle: 'Заголовок', mbNoteText: 'Текст: конспект, определения, ответы преподавателя…', mbAdd: 'Добавить',
            mbExport: 'Экспорт JSON', mbImport: 'Импорт JSON', mbDeleteCourse: 'Удалить курс',
            mbConfirmDelete: 'Удалить курс «{name}» из базы? Ваши заметки и правки пропадут; материалы скачаются заново при следующем тесте.',
            mbConfirmDeleteDoc: 'Удалить «{name}»?',
            mbSave: 'Сохранить', mbDelete: 'Удалить', mbUse: 'Использовать', mbCancel: 'Свернуть',
            mbLecture: 'Лекция', mbReading: 'Чтение', mbNote: 'Заметка', mbModule: 'Модуль {n}', mbChars: '{n} симв.',
            mbSaved: 'Загружено {date}', mbEdited: 'есть ручные правки', mbDocs: 'Материалов: {n}, используется {on}',
            mbImported: 'Импортировано: {name}', mbImportFailed: 'Не удалось импортировать: {error}', mbSavedOk: 'Сохранено.',
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
            netacadCheckpoints: 'Checkpoint exams', netacadCheckpointsHint: 'Автосолвер сдаёт и промежуточные экзамены; финальный экзамен не трогается',
            netacadBatch: 'Квиз: из данных курса {bank}, у модели {ai} (одним запросом)…',
            netacadExamSolving: 'Отвечаю на все вопросы теста по очереди…', netacadExamReady: 'Готово: отвечено вопросов {n} за {sec} с. Проверьте и отправьте сами: отметьте подтверждение и нажмите Submit.', netacadExamPartial: 'Отвечено вопросов: {n}, без ответа осталось {left}. Проверьте тест.',
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
            autopilotHint: 'Только задания, которые идут в оценку, по порядку, с отправкой. NetAcad: ещё и материалы и checkpoint-экзамены; финальный экзамен не трогается',
            autopilotPeer: 'Задания с взаимной проверкой', autopilotPeerHint: 'Coursera: сдать работу (текст или файл) и проверить работы других, сколько требует курс',
            autopilotProgramming: 'Programming assignments', autopilotProgrammingHint: 'Coursera Labs (Jupyter): написать код, прогнать ноутбук, исправить ошибки и нажать Submit Assignment',
            labsNoNotebook: 'Ноутбук ещё не загрузился.', labsNoTasks: 'В ноутбуке не найдено ячеек с заданиями.',
            labsWriting: 'Пишу код для {n} ячеек ({model})…', labsNoAnswer: 'модель не вернула код ячеек',
            labsRunning: 'Запускаю ноутбук целиком (проход {round})…', labsRunFailed: 'ноутбук не запустился',
            labsFixing: 'Ошибок: {n}, исправляю (раунд {round})…', labsStillFailing: ' Ошибки остались в ячейках: {list}.',
            labsDone: 'Код вписан в {n} ячеек, ноутбук сохранён.', labsNoSubmit: ' Кнопки Submit Assignment нет: откройте задание через Coursera («Launch Lab»).',
            labsSubmitting: 'Отправляю (Submit Assignment)…', labsSubmitted: 'Отправлено: {message}',
            labsAutopilot: 'Programming assignment «{title}»: жду ноутбук…', labsGrading: '«{title}» отправлено, жду оценку…',
            labsNoAnswerFromNotebook: 'ноутбук не ответил (лаборатория не запустилась?)', labsNotSubmitted: 'не отправлено',
            labsNoGrade: 'отправлено, оценки пока нет.',
            autopilotRetakes: 'Если квиз не сдан', autopilotRetakes0: 'Не пересдавать', autopilotRetakes2: '2 пересдачи', autopilotRetakes3: '3 пересдачи',
            autopilotBusy: 'Автосолвер уже работает…',
            autopilotStopped: 'Автосолвер остановлен.', autopilotStopping: 'Автосолвер остановится после текущего модуля.',
            autopilotNoCourse: 'Откройте курс в плеере NetAcad (netacad.com/launch…) и повторите.',
            autopilotModule: 'Автосолвер — модуль {n} из {total}: {title}…',
            autopilotNotOpened: 'модуль не открылся',
            autopilotDone: 'Готово: модулей {modules}, квизов сдано {passed}, не сдано {failed}, материалов засчитано {materials}.',
            autopilotNoQuizzes: 'В курсе нет оцениваемых заданий для автосолвера (практические пропускаются).',
            autopilotItem: 'Автосолвер — {n} из {total}: {title}…',
            autopilotCourseraDone: 'Готово: заданий сдано {passed}, не сдано {failed}.',
            autopilotPeerWrite: 'Взаимная проверка: пишу работу «{title}», частей готово {done} из {total}…', netacadMaterialsModule: 'База материалов — модуль {n} из {total}: {title}…', autopilotPeerUpload: 'Загружаю файл {name}…',
            autopilotPeerReview: 'Проверяю работу однокурсника {n} из {total}: {title}…',
            peerNoteManual: 'сдайте вручную: {parts}', peerNoteNotSubmitted: 'работа не отправилась', peerNoteSubmitDisabled: 'кнопка Submit неактивна, проверьте части задания',
            peerNoteDone: 'сдано, проверено работ: {n}', peerNoteNoPeers: 'сдано, проверено работ: {n}; других работ для проверки пока нет',
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
            courseContext: 'Use course materials', courseContextHint: 'Course texts from the materials base go into the prompt: more accurate, more tokens',
            toastMaterials: 'Loading course materials: {done} of {total}…', toastMaterialsReady: 'Course materials loaded.',
            toastWithMaterials: ' (with course materials)',
            toastMaterialsLoaded: 'Course materials in the base: {n}.',
            materialsTitle: 'Materials base', materialsSummary: 'Courses: {courses} · {size}',
            materialsEmpty: 'Empty so far: materials are collected with the first quiz of a Coursera or NetAcad course.',
            queueTitle: 'Go through courses', queueHint: 'Links to Coursera courses, specializations or professional certificates, one per line. Course after course NSolver enrolls (free only: Enroll for free or Audit, never a trial or a payment), marks the materials complete and runs the autopilot over everything graded.',
            queuePlaceholder: 'https://www.coursera.org/learn/…\nhttps://www.coursera.org/specializations/…', queueStart: 'Go through all courses', queueStop: 'Stop',
            queueIdle: 'Not running.', queueRunning: 'Course {n} of {total}: {title}', queueNoLinks: 'No Coursera links.', queueExpanding: 'Collecting the course list…',
            queueStarted: '{n} courses queued. Opening the first…', queueStopped: 'Stopped.',
            queueCourse: 'Courses — {n} of {total}: {title}', queueNotEnrolled: 'could not enroll for free (paid course?)',
            queueNothingGraded: 'materials completed, nothing graded', queueRunEnded: 'the autopilot was stopped',
            queueDone: 'All courses done: {n}.', queueCourseResult: '{passed} passed, {failed} failed',
            materialsTtl: 'Refresh after, days', materialsTtlHint: 'Coursera: the course is downloaded again once the base is older. Courses edited by hand are not refreshed',
            materialsOpen: 'Open the base', materialsLoad: 'Load this course',
            mbHint: 'This is what NSolver gives the model along with Coursera and NetAcad questions. Switched-off materials are not used. Manual edits and notes are kept when a course is downloaded again.',
            mbCourses: 'Courses', mbNoCourses: 'No courses yet. Open a Coursera or NetAcad course and press "Load this course" in the extension window, or solve a quiz.',
            mbPage: 'Page',
            mbSelect: 'Pick a course on the left.', mbSearch: 'Search titles and text…', mbNothingFound: 'Nothing found.',
            mbAddNote: 'Add your own material', mbNoteTitle: 'Title', mbNoteText: 'Text: notes, definitions, instructor answers…', mbAdd: 'Add',
            mbExport: 'Export JSON', mbImport: 'Import JSON', mbDeleteCourse: 'Delete course',
            mbConfirmDelete: 'Delete the course "{name}" from the base? Your notes and edits will be lost; materials are downloaded again with the next quiz.',
            mbConfirmDeleteDoc: 'Delete "{name}"?',
            mbSave: 'Save', mbDelete: 'Delete', mbUse: 'Use', mbCancel: 'Collapse',
            mbLecture: 'Lecture', mbReading: 'Reading', mbNote: 'Note', mbModule: 'Module {n}', mbChars: '{n} chars',
            mbSaved: 'Loaded {date}', mbEdited: 'edited by hand', mbDocs: 'Materials: {n}, in use {on}',
            mbImported: 'Imported: {name}', mbImportFailed: 'Could not import: {error}', mbSavedOk: 'Saved.',
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
            netacadCheckpoints: 'Checkpoint exams', netacadCheckpointsHint: 'The autopilot takes checkpoint exams too; the final exam is left alone',
            netacadBatch: 'Quiz: {bank} from the course data, {ai} from the model (one request)…',
            netacadExamSolving: 'Answering every question of the test in turn…', netacadExamReady: 'Done: {n} questions answered in {sec} s. Check and submit yourself: tick the confirmation and press Submit.', netacadExamPartial: '{n} questions answered, {left} left unanswered. Check the test.',
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
            autopilotHint: 'Only the work that counts toward the grade, in order, submitted. NetAcad: materials and checkpoint exams too; the final exam is left alone',
            autopilotPeer: 'Peer-reviewed assignments', autopilotPeerHint: 'Coursera: submit the work (text or a file) and review as many classmates as the course asks',
            autopilotProgramming: 'Programming assignments', autopilotProgrammingHint: 'Coursera Labs (Jupyter): write the code, run the notebook, fix errors and press Submit Assignment',
            labsNoNotebook: 'The notebook has not loaded yet.', labsNoTasks: 'No task cells found in the notebook.',
            labsWriting: 'Writing code for {n} cells ({model})…', labsNoAnswer: 'the model returned no cell code',
            labsRunning: 'Running the whole notebook (pass {round})…', labsRunFailed: 'the notebook did not run',
            labsFixing: '{n} errors, fixing (round {round})…', labsStillFailing: ' Errors left in cells: {list}.',
            labsDone: 'Code written into {n} cells, notebook saved.', labsNoSubmit: ' No Submit Assignment button: open the assignment from Coursera ("Launch Lab").',
            labsSubmitting: 'Submitting (Submit Assignment)…', labsSubmitted: 'Submitted: {message}',
            labsAutopilot: 'Programming assignment "{title}": waiting for the notebook…', labsGrading: '"{title}" submitted, waiting for the grade…',
            labsNoAnswerFromNotebook: 'the notebook did not answer (lab did not start?)', labsNotSubmitted: 'not submitted',
            labsNoGrade: 'submitted, no grade yet.',
            autopilotRetakes: 'If a quiz is failed', autopilotRetakes0: 'No retakes', autopilotRetakes2: '2 retakes', autopilotRetakes3: '3 retakes',
            autopilotBusy: 'The autopilot is already running…',
            autopilotStopped: 'The autopilot was stopped.', autopilotStopping: 'The autopilot will stop after the current module.',
            autopilotNoCourse: 'Open the course in the NetAcad player (netacad.com/launch…) and try again.',
            autopilotModule: 'Autopilot — module {n} of {total}: {title}…',
            autopilotNotOpened: 'module did not open',
            autopilotDone: 'Done: {modules} modules, {passed} quizzes passed, {failed} failed, {materials} materials completed.',
            autopilotNoQuizzes: 'The course has no graded work for the autopilot (practice items are skipped).',
            autopilotItem: 'Autopilot — {n} of {total}: {title}…',
            autopilotCourseraDone: 'Done: {passed} assignments passed, {failed} failed.',
            autopilotPeerWrite: 'Peer review: writing "{title}", parts done {done} of {total}…', netacadMaterialsModule: 'Materials base — module {n} of {total}: {title}…', autopilotPeerUpload: 'Uploading {name}…',
            autopilotPeerReview: 'Reviewing classmate {n} of {total}: {title}…',
            peerNoteManual: 'submit by hand: {parts}', peerNoteNotSubmitted: 'the work was not submitted', peerNoteSubmitDisabled: 'the Submit button is disabled, check the parts',
            peerNoteDone: 'submitted, reviews given: {n}', peerNoteNoPeers: 'submitted, reviews given: {n}; no more work to review yet',
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
