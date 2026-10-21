// AI providers for the quiz solver: OctavAPI, Claude API, ChatGPT (OpenAI) API, Gemini API. NSolver, made by Naki — https://github.com/Naki-404/NSolver
// Requests go through background.js because content scripts on coursera.org and netacad.com are subject to CORS.
var ModelProvider = (function () {
    const CHUNK_SIZE = 10;          // questions per request
    const CHUNK_CONCURRENCY = 3;    // parallel requests for long quizzes
    const RETRY_DELAYS_MS = [2000, 5000];
    const MAX_OUTPUT_TOKENS = 16000;

    // Claude models that accept the server-side refusal fallback.
    const CLAUDE_FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;

    const PROVIDERS = {
        octava: {
            name: 'OctavAPI',
            keyUrl: 'https://octavapi.shop',
            models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.5', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5']
        },
        anthropic: {
            name: 'Claude API',
            keyUrl: 'https://console.anthropic.com/settings/keys',
            models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
        },
        openai: {
            name: 'ChatGPT API',
            keyUrl: 'https://platform.openai.com/api-keys',
            models: ['gpt-5.5']
        },
        gemini: {
            name: 'Gemini API',
            keyUrl: 'https://aistudio.google.com/app/apikey',
            models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite']
        }
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const providerName = id => PROVIDERS[id]?.name || id;

    // ---------------------------------------------------------------- prompt

    // context: excerpts from the course's own lectures and readings (optional).
    function buildQuizPrompt(questions, context = '') {
        const data = questions.map((q, index) => {
            const item = { index, type: q.type, question: q.question };
            if (q.type === 'mcq') {
                item.multipleAnswers = !!q.multiple;
                item.options = q.options.map((text, i) => ({ i, text }));
            }
            return item;
        });
        return `You are an expert tutor answering an online course quiz (Coursera or Cisco Networking Academy). Read every question carefully and determine the correct answer(s).

Rules:
1. For "mcq" questions:
   - "correctOptionsIndex": array of 0-based option indices ("i") that are correct.
   - "correctOptions": array with the exact text of those options.
   - If "multipleAnswers" is false, return EXACTLY ONE index. If it is true, return ALL correct indices.
2. For "textArea" questions:
   - "content": a concise, accurate answer string (a number, word, formula or short paragraph as the question requires).
3. Every answer object must contain "index" equal to the question's "index".
4. Output ONLY a valid JSON array with exactly ${questions.length} objects, ordered by "index".
   No markdown, no code fences, no explanations.
${context ? `
Course material excerpts (lecture transcripts and readings of this very course):
<<<
${context}
>>>
Base your answers on these excerpts first: the quiz checks what this course teaches, so when the course states a
definition, number, list or recommendation, answer exactly the way the course does, even if other sources say otherwise.
Use general knowledge only for what the excerpts do not cover.
` : ''}
Questions:
${JSON.stringify(data, null, 2)}`;
    }

    function buildCorrectionPrompt(questions, problems, context = '') {
        return `${buildQuizPrompt(questions, context)}

Your previous answer was invalid: ${problems.join('; ')}.
Return the corrected JSON array only.`;
    }

    // ---------------------------------------------------------------- transport

    function sendToBackground(payload) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage({ type: Naki.MSG.API_REQUEST, ...payload }, reply => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else if (!reply) reject(new Error('no response from the extension background worker'));
                    else resolve(reply);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function errorMessageFrom(errorObject, fallback) {
        if (!errorObject) return fallback;
        if (typeof errorObject === 'string') return errorObject;
        const message = errorObject.message || errorObject.error?.message || fallback;
        const code = errorObject.code || errorObject.error?.code || errorObject.type;
        return code && !String(message).includes(String(code)) ? `${message} (${code})` : message;
    }

    // retryable: worth repeating the same request later; serverSide: worth trying another Octava protocol.
    function apiError(message, { status = 0, code, retryable = false } = {}) {
        const error = new Error(message);
        error.serverSide = status >= 500 || /^5\d{3}$/.test(String(code || '')) || /error 5\d{3}/.test(message);
        error.retryable = retryable || error.serverSide || status === 429 || status === 529;
        return error;
    }

    // Sends a request and returns {json, text}; throws localized errors for HTTP failures.
    async function call(ctx, { url, method = 'POST', headers = {}, body }) {
        let reply;
        try {
            reply = await sendToBackground({ url, method, headers, body });
        } catch (e) {
            throw apiError(Naki.t(ctx.lang, 'errNetwork', { provider: providerName(ctx.provider), error: e.message }), { retryable: true });
        }
        if (reply.networkError) {
            throw apiError(Naki.t(ctx.lang, 'errNetwork', { provider: providerName(ctx.provider), error: reply.networkError }), { retryable: true });
        }
        const status = reply.status;
        const text = reply.text || '';
        let json = null;
        try { json = JSON.parse(text); } catch (e) { }

        if (status < 200 || status >= 300) {
            const errorObject = Array.isArray(json) ? json[0]?.error : (json?.error || json);
            const error = errorMessageFrom(errorObject, text.slice(0, 300) || `HTTP ${status}`);
            const vars = { provider: providerName(ctx.provider), error, status };
            if (status === 401 || status === 403) throw apiError(Naki.t(ctx.lang, 'errAuth', vars), { status });
            if (status === 429) throw apiError(Naki.t(ctx.lang, 'errRate', vars), { status });
            if (status === 400) throw apiError(Naki.t(ctx.lang, 'errBadRequest', vars), { status, code: errorObject?.code });
            throw apiError(Naki.t(ctx.lang, 'errApi', vars), { status, code: errorObject?.code });
        }
        return { json, text, status };
    }

    // ---------------------------------------------------------------- response parsing

    function extractTextFromResponse(response) {
        if (!response) return null;
        if (typeof response === 'string') return response.trim() ? response : null;
        if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text;

        if (Array.isArray(response.output)) {
            const texts = [];
            for (const item of response.output) {
                if (!item || item.type === 'reasoning') continue;
                if (typeof item.text === 'string') texts.push(item.text);
                if (Array.isArray(item.content)) {
                    for (const part of item.content) {
                        if (part && typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'text' || !part.type)) texts.push(part.text);
                    }
                }
            }
            const joined = texts.join('');
            if (joined.trim()) return joined;
        }

        const chatContent = response.choices?.[0]?.message?.content;
        if (typeof chatContent === 'string' && chatContent.trim()) return chatContent;
        if (Array.isArray(chatContent)) {
            const joined = chatContent.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
            if (joined.trim()) return joined;
        }

        // Anthropic Messages API
        if (Array.isArray(response.content)) {
            const joined = response.content.filter(block => block?.type === 'text').map(block => block.text).join('');
            if (joined.trim()) return joined;
        }

        // Gemini generateContent
        const parts = response.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const joined = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
            if (joined.trim()) return joined;
        }

        if (typeof response.text === 'string' && response.text.trim()) return response.text;
        return null;
    }

    function parseEventStream(body) {
        let deltaText = '';
        let doneText = '';
        let finalResponse = null;
        let error = null;

        for (const rawLine of body.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let event;
            try { event = JSON.parse(data); } catch (e) { continue; }

            switch (event.type) {
                case 'response.output_text.delta':
                    if (typeof event.delta === 'string') deltaText += event.delta;
                    break;
                case 'response.output_text.done':
                    if (typeof event.text === 'string') doneText += event.text;
                    break;
                case 'response.completed':
                case 'response.incomplete':
                    finalResponse = event.response || finalResponse;
                    break;
                case 'response.failed':
                    finalResponse = event.response || finalResponse;
                    error = event.response?.error || error || { message: 'Response failed' };
                    break;
                case 'error':
                    error = event.error || event;
                    break;
                default:
                    if (event.error) error = event.error;
                    if (typeof event.choices?.[0]?.delta?.content === 'string') deltaText += event.choices[0].delta.content;
            }
        }
        const text = extractTextFromResponse(finalResponse) || doneText || deltaText || null;
        return { text, response: finalResponse, error };
    }

    function textOrThrow(ctx, text) {
        if (!text || !text.trim()) throw apiError(Naki.t(ctx.lang, 'errEmpty', { provider: providerName(ctx.provider) }), { status: 500 });
        return text;
    }

    function jsonErrorOrNull(ctx, json, status) {
        if (json && !Array.isArray(json) && json.error) {
            return apiError(Naki.t(ctx.lang, 'errApi', { provider: providerName(ctx.provider), status, error: errorMessageFrom(json.error, 'Unknown error') }), { status, code: json.error.code });
        }
        return null;
    }

    // ---------------------------------------------------------------- providers

    async function octavaRequest(ctx, prompt) {
        const headers = { Authorization: 'Bearer ' + ctx.apiKey };
        const parse = ({ json, text, status }) => {
            if (json) {
                const error = jsonErrorOrNull(ctx, json, status);
                if (error) throw error;
                return textOrThrow(ctx, extractTextFromResponse(json));
            }
            const parsed = parseEventStream(text);
            if (parsed.error && !parsed.text) {
                throw apiError(Naki.t(ctx.lang, 'errApi', { provider: 'OctavAPI', status, error: errorMessageFrom(parsed.error, 'Unknown error') }), { status, code: parsed.error.code });
            }
            return textOrThrow(ctx, parsed.text);
        };

        try {
            return parse(await call(ctx, {
                url: 'https://octavapi.shop/v1/chat/completions',
                headers,
                body: { model: ctx.model, messages: [{ role: 'user', content: prompt }] }
            }));
        } catch (chatError) {
            // GPT routes on Octava are listed with the Responses protocol; try it on server-side errors.
            if (!chatError.serverSide || !/^gpt/i.test(ctx.model)) throw chatError;
            console.warn('[Naki] Octava chat/completions failed, retrying via /v1/responses:', chatError.message);
            try {
                return parse(await call(ctx, {
                    url: 'https://octavapi.shop/v1/responses',
                    headers,
                    body: { model: ctx.model, input: prompt, stream: true }
                }));
            } catch (responsesError) {
                const combined = apiError(`${chatError.message} | /v1/responses: ${responsesError.message}`);
                combined.retryable = chatError.retryable || responsesError.retryable;
                throw combined;
            }
        }
    }

    async function anthropicRequest(ctx, prompt) {
        const headers = {
            'x-api-key': ctx.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        };
        const body = { model: ctx.model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] };
        if (CLAUDE_FALLBACK_MODELS.test(ctx.model)) {
            // Server-side fallback: if the model declines, Anthropic retries on a suitable model.
            headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
            body.fallbacks = 'default';
        }
        const { json, status } = await call(ctx, { url: 'https://api.anthropic.com/v1/messages', headers, body });
        const error = jsonErrorOrNull(ctx, json, status);
        if (error) throw error;
        if (json?.stop_reason === 'refusal') throw apiError(Naki.t(ctx.lang, 'errRefusal'));
        return textOrThrow(ctx, extractTextFromResponse(json));
    }

    async function openaiRequest(ctx, prompt) {
        const { json, status } = await call(ctx, {
            url: 'https://api.openai.com/v1/chat/completions',
            headers: { Authorization: 'Bearer ' + ctx.apiKey },
            body: { model: ctx.model, messages: [{ role: 'user', content: prompt }] }
        });
        const error = jsonErrorOrNull(ctx, json, status);
        if (error) throw error;
        if (json?.choices?.[0]?.message?.refusal) throw apiError(Naki.t(ctx.lang, 'errRefusal'));
        return textOrThrow(ctx, extractTextFromResponse(json));
    }

    async function geminiRequest(ctx, prompt) {
        const model = ctx.model.replace(/^models\//, '');
        const { json, status } = await call(ctx, {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            headers: { 'x-goog-api-key': ctx.apiKey },
            body: { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
        });
        const error = jsonErrorOrNull(ctx, json, status);
        if (error) throw error;
        if (json?.promptFeedback?.blockReason) throw apiError(Naki.t(ctx.lang, 'errRefusal') + ` (${json.promptFeedback.blockReason})`);
        return textOrThrow(ctx, extractTextFromResponse(json));
    }

    const REQUESTERS = { octava: octavaRequest, anthropic: anthropicRequest, openai: openaiRequest, gemini: geminiRequest };

    function makeContext({ provider = 'octava', apiKey, modelId, lang = 'ru' }) {
        const id = PROVIDERS[provider] ? provider : 'octava';
        if (!apiKey || !apiKey.trim()) throw new Error(Naki.t(lang, 'errNoKey', { provider: providerName(id) }));
        return { provider: id, apiKey: apiKey.trim(), model: (modelId || Naki.DEFAULT_SETTINGS.models[id]).trim(), lang };
    }

    async function generateContent(options) {
        const ctx = makeContext(options);
        for (let attempt = 0; ; attempt++) {
            try {
                const text = await REQUESTERS[ctx.provider](ctx, options.prompt);
                return { text, modelId: ctx.model, provider: ctx.provider };
            } catch (error) {
                if (!error.retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
                console.warn(`[Naki] Request failed (${error.message}), retry ${attempt + 1} in ${RETRY_DELAYS_MS[attempt]}ms`);
                await sleep(RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    async function listModels(options) {
        const ctx = makeContext(options);
        if (ctx.provider === 'octava') {
            const { json } = await call(ctx, { url: 'https://octavapi.shop/v1/models', method: 'GET', headers: { Authorization: 'Bearer ' + ctx.apiKey } });
            return (json?.data || []).map(m => m.id).filter(id => id && !/(embedding|image_gen|tts|whisper)/i.test(id));
        }
        if (ctx.provider === 'openai') {
            const { json } = await call(ctx, { url: 'https://api.openai.com/v1/models', method: 'GET', headers: { Authorization: 'Bearer ' + ctx.apiKey } });
            return (json?.data || [])
                .filter(m => /^(gpt|o\d|chatgpt)/i.test(m.id) && !/(audio|realtime|tts|transcribe|image|embedding|search|moderation)/i.test(m.id))
                .sort((x, y) => (y.created || 0) - (x.created || 0))
                .map(m => m.id);
        }
        if (ctx.provider === 'anthropic') {
            const { json } = await call(ctx, {
                url: 'https://api.anthropic.com/v1/models?limit=100',
                method: 'GET',
                headers: { 'x-api-key': ctx.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
            });
            return (json?.data || []).map(m => m.id).filter(Boolean);
        }
        const { json } = await call(ctx, { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', method: 'GET', headers: { 'x-goog-api-key': ctx.apiKey } });
        return (json?.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/(embedding|tts|image|aqa)/i.test(m.name))
            .map(m => m.name.replace(/^models\//, ''));
    }

    // ---------------------------------------------------------------- solutions

    function parseJsonResponse(text, lang = 'ru') {
        let cleaned = String(text || '').trim();
        cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced) cleaned = fenced[1].trim();
        try {
            return JSON.parse(cleaned);
        } catch (firstError) {
            const start = cleaned.search(/[\[{]/);
            const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
            if (start !== -1 && end > start) {
                try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (e) { }
            }
            throw new Error(Naki.t(lang, 'errJson', { error: firstError.message }));
        }
    }

    const normalize = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

    function toSolutionList(parsed, lang) {
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') {
            const list = Object.values(parsed).find(Array.isArray);
            if (list) return list;
        }
        throw new Error(Naki.t(lang, 'errNotArray'));
    }

    // Aligns solutions with questions and cross-checks option indices against option text.
    function normalizeSolutions(questions, rawList) {
        const byIndex = new Map();
        rawList.forEach((item, position) => {
            if (!item || typeof item !== 'object') return;
            const index = Number.isInteger(item.index) ? item.index : position;
            if (!byIndex.has(index)) byIndex.set(index, item);
        });

        const problems = [];
        const solutions = questions.map((question, index) => {
            const item = byIndex.get(index);
            if (!item) {
                problems.push(`missing answer for index ${index}`);
                return null;
            }
            if (question.type !== 'mcq') {
                const content = typeof item.content === 'string' ? item.content : (item.answer ?? '');
                if (!String(content).trim()) problems.push(`empty "content" for index ${index}`);
                return { index, content: String(content) };
            }

            const optionCount = question.options.length;
            let indices = (Array.isArray(item.correctOptionsIndex) ? item.correctOptionsIndex : [item.correctOptionsIndex])
                .map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < optionCount);

            // Prefer option text when it disagrees with the indices (models sometimes miscount).
            const texts = Array.isArray(item.correctOptions) ? item.correctOptions : (item.correctOptions ? [item.correctOptions] : []);
            const textIndices = texts.map(text => question.options.findIndex(option => normalize(option) === normalize(text))).filter(i => i >= 0);
            if (textIndices.length && textIndices.length === texts.length) {
                const same = textIndices.length === indices.length && textIndices.every(i => indices.includes(i));
                if (!same) indices = textIndices;
            }
            indices = [...new Set(indices)];

            if (!indices.length) problems.push(`no valid option index for index ${index}`);
            if (!question.multiple && indices.length > 1) {
                problems.push(`index ${index} is single-answer but got ${indices.length} options`);
                indices = indices.slice(0, 1);
            }
            return { index, correctOptionsIndex: indices, correctOptions: indices.map(i => question.options[i]) };
        });
        return { solutions, problems };
    }

    // options.contextFor(questions) → course excerpts for this chunk of questions (optional).
    async function solveChunk(questions, options) {
        let context = '';
        try { context = options.contextFor ? (await options.contextFor(questions)) || '' : ''; } catch (e) { console.warn('[Naki] Course context unavailable:', e.message); }
        const { text } = await generateContent({ ...options, prompt: buildQuizPrompt(questions, context) });
        let result;
        try {
            result = normalizeSolutions(questions, toSolutionList(parseJsonResponse(text, options.lang), options.lang));
        } catch (parseError) {
            result = { solutions: null, problems: [parseError.message] };
        }
        if (!result.problems.length) return result.solutions;

        console.warn('[Naki] Invalid answer, asking the model to correct it:', result.problems);
        const retry = await generateContent({ ...options, prompt: buildCorrectionPrompt(questions, result.problems, context) });
        const fixed = normalizeSolutions(questions, toSolutionList(parseJsonResponse(retry.text, options.lang), options.lang));
        if (fixed.problems.length) console.warn('[Naki] Answer still has problems, applying what is valid:', fixed.problems);
        return fixed.solutions;
    }

    // options: { provider, apiKey, modelId, lang }
    async function solveQuizQuestions(questions, options = {}) {
        makeContext(options); // validates the key before any work
        const list = typeof questions === 'string' ? JSON.parse(questions) : questions;
        if (!Array.isArray(list) || !list.length) return [];

        const chunks = [];
        for (let i = 0; i < list.length; i += CHUNK_SIZE) chunks.push(list.slice(i, i + CHUNK_SIZE));

        const results = new Array(chunks.length);
        let next = 0;
        async function worker() {
            while (next < chunks.length) {
                const current = next++;
                results[current] = await solveChunk(chunks[current], options);
            }
        }
        await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker));

        return results.flatMap((chunkSolutions, chunkIndex) =>
            chunkSolutions.map(solution => solution && { ...solution, index: chunkIndex * CHUNK_SIZE + solution.index }));
    }

    async function testApiKey(options) {
        const result = await generateContent({ ...options, prompt: 'Respond strictly with the single word: "READY"' });
        return { success: true, modelId: result.modelId, output: result.text.trim() };
    }

    return {
        PROVIDERS,
        providerName,
        buildQuizPrompt,
        extractTextFromResponse,
        parseJsonResponse,
        normalizeSolutions,
        generateContent,
        listModels,
        solveQuizQuestions,
        testApiKey
    };
})();
