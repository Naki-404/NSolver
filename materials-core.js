// Materials base shared by the Coursera and NetAcad scripts: storage of course texts (chrome.storage.local) and
// retrieval of the excerpts closest to the questions (BM25 over words), which go to the model with the quiz.
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
Naki.materials = (function () {
    const KEY = 'nakiMaterials:';              // + course id → { savedAt, name, site, edited?, docs: [{ order, type, title, module, text }] }
    const INDEX_KEY = 'nakiMaterialsIndex';    // most recently used course ids; older courses are evicted
    const MAX_COURSES = 10;
    const CONTEXT_CHARS = 24000;               // course excerpts per request (~6k tokens)
    const CHUNK_CHARS = 1200;
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Course ids are storage keys and file names of the export: letters, digits, "_" and "-" only.
    const courseId = raw => String(raw || '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

    async function read(id) {
        const key = KEY + id;
        return (await chrome.storage.local.get(key))[key] || null;
    }

    // A course edited by hand is never refreshed by age; otherwise it is downloaded again after the days set in Settings.
    const isFresh = (stored, days) => !!stored && (stored.edited || Date.now() - (stored.savedAt || 0) < Math.max(1, days) * DAY_MS);

    // Courses edited by hand in the materials base (materials.html) are kept: never evicted.
    async function remember(id) {
        const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
        const next = [id, ...index.filter(other => other !== id)];
        const overflow = next.slice(MAX_COURSES);
        if (!overflow.length) {
            await chrome.storage.local.set({ [INDEX_KEY]: next });
            return;
        }
        const stored = await chrome.storage.local.get(overflow.map(other => KEY + other));
        const kept = overflow.filter(other => stored[KEY + other]?.edited);
        const evicted = overflow.filter(other => !kept.includes(other));
        await chrome.storage.local.set({ [INDEX_KEY]: [...next.slice(0, MAX_COURSES), ...kept] });
        if (evicted.length) await chrome.storage.local.remove(evicted.map(other => KEY + other));
    }

    // A fresh download keeps what was done by hand: notes, edited texts and switched-off materials.
    function mergeManual(downloaded, previous) {
        if (!previous?.length) return downloaded;
        const byKey = new Map(previous.filter(doc => doc.type !== 'note').map(doc => [`${doc.type}|${doc.title}`, doc]));
        const docs = downloaded.map(doc => {
            const old = byKey.get(`${doc.type}|${doc.title}`);
            if (!old) return doc;
            return { ...doc, ...(old.edited ? { text: old.text, edited: true } : {}), ...(old.disabled ? { disabled: true } : {}) };
        });
        return [...docs, ...previous.filter(doc => doc.type === 'note')];
    }

    async function save(id, record) {
        await chrome.storage.local.set({ [KEY + id]: record });
        await remember(id);
    }

    const STOPWORDS = new Set(('the and for that this with from what which when where who whom whose why how are was were been being have has had ' +
        'does did not but can could should would will shall may might must into onto than then them they their there these those your you our its ' +
        'his her him she also any all each other such only own same very just about above below after before between both during through under over ' +
        'again further once here more most some few nor too out off per via use used using following true false best answer question questions select ' +
        'choose correct incorrect statement statements option options describe describes which что как это для или его она они при над под все').split(' '));
    const wordsOf = text => (String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(word => !STOPWORDS.has(word));

    // Overlapping chunks, cut at word boundaries.
    function chunkDocs(docs) {
        const chunks = [];
        for (const doc of docs.filter(item => !item.disabled && item.text)) {
            let start = 0;
            while (start < doc.text.length) {
                let end = Math.min(doc.text.length, start + CHUNK_CHARS);
                if (end < doc.text.length) end = doc.text.lastIndexOf(' ', end) > start + CHUNK_CHARS / 2 ? doc.text.lastIndexOf(' ', end) : end;
                const text = doc.text.slice(start, end).trim();
                chunks.push({ doc, start, text, words: wordsOf(text) });
                if (end >= doc.text.length) break;
                start = Math.max(end - 200, start + 1);
            }
        }
        return chunks;
    }

    const LABELS = { lecture: 'Lecture', supplement: 'Reading', page: 'Page', note: 'Note' };

    // BM25 between the questions (any text with question/options) and every chunk; the quiz's module (and the one
    // before it) is preferred.
    function excerpts(chunks, questions, quizModule = null, limit = CONTEXT_CHARS) {
        const query = new Set(questions.flatMap(q => wordsOf(`${q.question || ''} ${(q.options || []).join(' ')}`)));
        if (!query.size || !chunks.length) return '';
        const df = new Map();
        for (const chunk of chunks) for (const word of new Set(chunk.words)) if (query.has(word)) df.set(word, (df.get(word) || 0) + 1);
        const total = chunks.length;
        const averageLength = chunks.reduce((sum, chunk) => sum + chunk.words.length, 0) / total || 1;
        const scored = [];
        for (const chunk of chunks) {
            const tf = new Map();
            for (const word of chunk.words) if (query.has(word)) tf.set(word, (tf.get(word) || 0) + 1);
            let score = 0;
            for (const [word, count] of tf) {
                const idf = Math.log(1 + (total - df.get(word) + 0.5) / (df.get(word) + 0.5));
                score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * chunk.words.length / averageLength));
            }
            if (!score) continue;
            const module = chunk.doc.module;
            if (quizModule !== null && quizModule !== undefined && module !== null && module !== undefined) {
                if (module === quizModule) score *= 1.5;
                else if (module === quizModule - 1) score *= 1.15;
                else if (module > quizModule) score *= 0.7;
            }
            scored.push({ chunk, score });
        }
        scored.sort((a, b) => b.score - a.score);
        const picked = [];
        let used = 0;
        for (const { chunk } of scored) {
            if (used + chunk.text.length > limit) continue;
            picked.push(chunk);
            used += chunk.text.length + 60;
            if (used > limit - 400) break;
        }
        picked.sort((a, b) => a.doc.order - b.doc.order || a.start - b.start);
        return picked.map(chunk => `[${LABELS[chunk.doc.type] || 'Material'}: ${chunk.doc.title}] ${chunk.text}`).join('\n\n');
    }

    return { KEY, INDEX_KEY, courseId, read, isFresh, remember, mergeManual, save, wordsOf, chunkDocs, excerpts };
})();
