// Files for Coursera peer-reviewed assignments: the text of a classmate's submission (PDF, DOCX, PPTX, plain text)
// for the review, and a DOCX / PDF / TXT made from the generated answer for the upload, with tables and charts drawn
// from plot specs. No libraries: PDF text comes from the page content streams (ToUnicode maps included), Office files
// are zip archives of XML, charts are drawn on an OffscreenCanvas.
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
Naki.files = (function () {
    const MAX_TEXT = 20000;
    const latin1 = bytes => {
        let out = '';
        for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return out;
    };

    async function inflate(bytes, format) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    // ------------------------------------------------------------------ reading

    function ascii85(bytes) {
        const text = latin1(bytes).replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
        const out = [];
        let group = [];
        const flush = (values, count) => {
            let n = values.reduce((sum, v) => sum * 85 + v, 0);
            const four = [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
            out.push(...four.slice(0, count));
        };
        for (const c of text) {
            if (c === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
            group.push(c.charCodeAt(0) - 33);
            if (group.length === 5) { flush(group, 4); group = []; }
        }
        if (group.length) {
            const count = group.length - 1;
            while (group.length < 5) group.push(84);
            flush(group, count);
        }
        return new Uint8Array(out);
    }

    // Applies the stream's /Filter chain (ASCII85, ASCIIHex, Flate); null when a filter is not supported.
    async function decodeStream(data, dict) {
        const filters = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1].match(/\/\w+/g) || []).map(name => name.slice(1));
        for (const filter of filters) {
            if (filter === 'FlateDecode' || filter === 'Fl') data = await inflate(data, 'deflate').catch(() => null);
            else if (filter === 'ASCII85Decode' || filter === 'A85') data = ascii85(data);
            else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
                const hex = latin1(data).replace(/[^0-9a-fA-F]/g, '');
                data = Uint8Array.from(hex.match(/../g) || [], h => parseInt(h, 16));
            } else return null;
            if (!data) return null;
        }
        return data;
    }

    // Objects of a PDF: { dict, data } with decoded stream data, objects inside object streams included.
    async function pdfObjects(bytes) {
        const raw = latin1(bytes);
        const objects = new Map();
        const header = /(\d+)\s+\d+\s+obj\b/g;
        let match;
        while ((match = header.exec(raw))) {
            const start = header.lastIndex;
            const end = raw.indexOf('endobj', start);
            const streamAt = raw.indexOf('stream', start);
            if (streamAt !== -1 && (end === -1 || streamAt < end)) {
                const dict = raw.slice(start, streamAt);
                let dataStart = streamAt + 6;
                if (raw[dataStart] === '\r') dataStart++;
                if (raw[dataStart] === '\n') dataStart++;
                const length = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
                let dataEnd = length ? dataStart + Number(length[1]) : raw.indexOf('endstream', dataStart);
                if (dataEnd < dataStart || raw.slice(dataEnd, dataEnd + 30).indexOf('endstream') === -1) dataEnd = raw.indexOf('endstream', dataStart);
                if (dataEnd === -1) break;
                const data = await decodeStream(bytes.subarray(dataStart, dataEnd), dict);
                objects.set(Number(match[1]), { dict, data });
                header.lastIndex = dataEnd + 9;
            } else {
                objects.set(Number(match[1]), { dict: raw.slice(start, end === -1 ? undefined : end), data: null });
                if (end !== -1) header.lastIndex = end + 6;
            }
        }
        // PDF 1.5 object streams: "<num> <offset> …" followed by the objects themselves.
        for (const { dict, data } of [...objects.values()]) {
            if (!data || !/\/Type\s*\/ObjStm/.test(dict)) continue;
            const text = latin1(data);
            const first = Number(dict.match(/\/First\s+(\d+)/)?.[1] || 0);
            const pairs = text.slice(0, first).trim().split(/\s+/).map(Number);
            for (let i = 0; i < pairs.length; i += 2) {
                const from = first + pairs[i + 1];
                const to = i + 3 < pairs.length ? first + pairs[i + 3] : text.length;
                if (!objects.has(pairs[i])) objects.set(pairs[i], { dict: text.slice(from, to), data: null });
            }
        }
        return objects;
    }

    const utf16 = hex => {
        let out = '';
        for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        return out;
    };

    function parseCMap(text) {
        const map = new Map();
        let bytes = 1;
        for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
            for (const [, src, dst] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
                bytes = Math.max(bytes, src.length / 2);
                map.set(parseInt(src, 16), utf16(dst));
            }
        }
        for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
            for (const [, lo, hi, rest] of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>)/g)) {
                bytes = Math.max(bytes, lo.length / 2);
                const from = parseInt(lo, 16), to = parseInt(hi, 16);
                if (rest.startsWith('[')) {
                    const list = [...rest.matchAll(/<([0-9a-fA-F]*)>/g)].map(m => m[1]);
                    for (let code = from; code <= to && code - from < list.length; code++) map.set(code, utf16(list[code - from]));
                } else {
                    const base = rest.slice(1, -1);
                    const head = base.slice(0, -4), last = parseInt(base.slice(-4) || '0', 16);
                    for (let code = from; code <= to && code - from < 65536; code++) map.set(code, utf16(head) + String.fromCharCode(last + code - from));
                }
            }
        }
        return { map, bytes };
    }

    // Windows-1252 bytes 0x80–0x9F; the rest is Latin-1.
    const WIN_ANSI = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
    const winAnsiChar = code => (code >= 0x80 && code <= 0x9f ? WIN_ANSI[code - 0x80] : String.fromCharCode(code));

    // Literal (…) and hex <…> strings as byte strings.
    function readString(text, i) {
        if (text[i] === '<') {
            const end = text.indexOf('>', i);
            const hex = text.slice(i + 1, end).replace(/\s+/g, '');
            let out = '';
            for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt((hex.slice(k, k + 2) + '0').slice(0, 2), 16));
            return { value: out, next: end + 1 };
        }
        let depth = 1, out = '', k = i + 1;
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        while (k < text.length && depth) {
            const c = text[k];
            if (c === '\\') {
                const n = text[k + 1];
                if (escapes[n]) { out += escapes[n]; k += 2; }
                else if (/[0-7]/.test(n)) { const oct = text.slice(k + 1, k + 4).match(/^[0-7]{1,3}/)[0]; out += String.fromCharCode(parseInt(oct, 8) & 255); k += 1 + oct.length; }
                else if (n === '\r' || n === '\n') { k += n === '\r' && text[k + 2] === '\n' ? 3 : 2; }
                else { out += n; k += 2; }
                continue;
            }
            if (c === '(') depth++;
            if (c === ')' && !--depth) break;
            out += c;
            k++;
        }
        return { value: out, next: k + 1 };
    }

    function decodeShown(value, cmap) {
        if (!cmap) return [...value].map(c => winAnsiChar(c.charCodeAt(0))).join('');
        let out = '';
        for (let i = 0; i < value.length; i += cmap.bytes) {
            let code = 0;
            for (let k = 0; k < cmap.bytes; k++) code = code * 256 + (value.charCodeAt(i + k) || 0);
            out += cmap.map.get(code) ?? (cmap.bytes === 1 ? winAnsiChar(code) : '');
        }
        return out;
    }

    // Text operators of one content stream (Tf, Tj, TJ, ', ", Td, TD, Tm, T*).
    function contentText(text, fonts) {
        let out = '', font = null, operands = [], lastY = null;
        const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
        let i = 0;
        while (i < text.length) {
            const c = text[i];
            if (/\s/.test(c)) { i++; continue; }
            if (c === '%') { i = text.indexOf('\n', i) + 1 || text.length; continue; }
            if (c === '(' || (c === '<' && text[i + 1] !== '<')) {
                const { value, next } = readString(text, i);
                operands.push({ string: value });
                i = next;
                continue;
            }
            if (c === '[') { operands.push({ array: [] }); i++; continue; }
            if (c === ']') {
                const items = [];
                while (operands.length && !operands[operands.length - 1].array) items.unshift(operands.pop());
                const array = operands.pop();
                if (array) operands.push({ array: items });
                i++;
                continue;
            }
            if (c === '<' || c === '>') { i += 2; continue; }
            const token = text.slice(i).match(/^\/?[^\s()<>\[\]{}\/%]+/)?.[0] || c;
            i += token.length;
            if (token.startsWith('/')) { operands.push({ name: token.slice(1) }); continue; }
            if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) { operands.push({ number: Number(token) }); continue; }
            const shown = value => { out += decodeShown(value, fonts.get(font)); };
            switch (token) {
                case 'Tf': font = operands[operands.length - 2]?.name ?? font; break;
                case 'Tj': if (operands.at(-1)?.string !== undefined) shown(operands.at(-1).string); break;
                case "'": case '"': newline(); if (operands.at(-1)?.string !== undefined) shown(operands.at(-1).string); break;
                case 'TJ':
                    for (const part of operands.at(-1)?.array || []) {
                        if (part.string !== undefined) shown(part.string);
                        else if (part.number !== undefined && part.number < -200 && !out.endsWith(' ')) out += ' ';
                    }
                    break;
                case 'Td': case 'TD': {
                    const [x, y] = operands.slice(-2).map(o => o.number || 0);
                    if (Math.abs(y) > 0.5) newline(); else if (x > 0.5 && !out.endsWith(' ')) out += ' ';
                    break;
                }
                case 'Tm': {
                    const y = operands.at(-1)?.number;
                    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 0.5) newline(); else if (!out.endsWith(' ')) out += ' ';
                    lastY = y ?? lastY;
                    break;
                }
                case 'T*': newline(); break;
                case 'ET': if (!out.endsWith(' ') && !out.endsWith('\n')) out += ' '; break;
            }
            operands = [];
        }
        return out;
    }

    async function pdfText(bytes) {
        const objects = await pdfObjects(bytes);
        const cmaps = new Map(); // font object → ToUnicode map
        for (const [num, { dict }] of objects) {
            const ref = dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
            const target = ref && objects.get(Number(ref[1]));
            if (target?.data) cmaps.set(num, parseCMap(latin1(target.data)));
        }
        // Resource names (/F1 12 0 R) of fonts with a ToUnicode map, in /Font dictionaries anywhere in the file.
        const fonts = new Map();
        const fontDicts = [];
        for (const { dict } of objects.values()) {
            for (const m of dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) fontDicts.push(m[1]);
            for (const m of dict.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) fontDicts.push(objects.get(Number(m[1]))?.dict || '');
        }
        for (const text of fontDicts) {
            for (const [, name, num] of text.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) if (cmaps.has(Number(num))) fonts.set(name, cmaps.get(Number(num)));
        }
        let out = '';
        for (const { dict, data } of objects.values()) {
            if (!data || /\/(Type\s*\/(XRef|ObjStm|Metadata)|Subtype\s*\/Image|Length1|FontFile)/.test(dict)) continue;
            const text = latin1(data);
            if (!/\bBT\b/.test(text) || !/T[jJ]/.test(text)) continue;
            out += contentText(text, fonts) + '\n';
            if (out.length > MAX_TEXT * 2) break;
        }
        return out;
    }

    // Entries of a zip archive: name → () => Promise<Uint8Array>.
    function zipEntries(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
        if (end < 0) return new Map();
        const entries = new Map();
        let at = view.getUint32(end + 16, true);
        const count = view.getUint16(end + 10, true);
        for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n++) {
            const method = view.getUint16(at + 10, true);
            const size = view.getUint32(at + 20, true);
            const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
            const local = view.getUint32(at + 42, true);
            const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
            entries.set(name, async () => {
                const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
                const data = bytes.subarray(start, start + size);
                return method === 8 ? inflate(data, 'deflate-raw') : data;
            });
            at += 46 + nameLength + extra + comment;
        }
        return entries;
    }

    const xmlText = (xml, paragraph) => new DOMParser().parseFromString(
        `<x>${xml.replace(/<\?xml[^>]*>/, '').replace(new RegExp(`</${paragraph}>`, 'g'), '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')}</x>`, 'text/html').body.textContent;

    async function officeText(bytes) {
        const entries = zipEntries(bytes);
        const decode = async name => new TextDecoder().decode(await entries.get(name)());
        if (entries.has('word/document.xml')) return xmlText(await decode('word/document.xml'), 'w:p');
        const slides = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        let out = '';
        for (const [i, name] of slides.entries()) out += `[Slide ${i + 1}]\n${xmlText(await decode(name), 'a:p')}\n`;
        return out;
    }

    // Text of a submitted file, '' when it cannot be read (images, archives, scans).
    async function textOf(url) {
        const response = await fetch(url);
        if (!response.ok) return '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        const head = latin1(bytes.subarray(0, 5));
        let text = '';
        if (head.startsWith('%PDF')) text = await pdfText(bytes);
        else if (head.startsWith('PK')) text = await officeText(bytes);
        else {
            const decoded = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT * 4));
            const binary = (decoded.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
            if (binary < decoded.length / 50) text = /<html|<body|<p[\s>]/i.test(decoded) ? new DOMParser().parseFromString(decoded, 'text/html').body.textContent : decoded;
        }
        return text.replace(/[ \t\f\r]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, MAX_TEXT);
    }

    // ------------------------------------------------------------------ writing

    // Helvetica widths (1/1000 em) for ASCII 32–126; other characters count as 556.
    const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
        278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
        944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
        278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
    const widthOf = (text, size, bold) => [...text].reduce((sum, c) => sum + (HELVETICA[c.charCodeAt(0) - 32] || 556), 0) * size / 1000 * (bold ? 1.06 : 1);

    // Characters a standard PDF font can show (Windows-1252).
    const winAnsiCode = c => {
        const code = c.charCodeAt(0);
        if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
        const i = WIN_ANSI.indexOf(c);
        return i >= 0 ? 0x80 + i : -1;
    };
    const fitsPdf = text => [...text].every(c => c === '\n' || c === '\t' || winAnsiCode(c) >= 0);

    function wrap(line, size, bold, width) {
        const words = line.split(/(\s+)/);
        const lines = [];
        let current = '';
        for (const word of words) {
            if (widthOf(current + word, size, bold) <= width || !current.trim()) {
                current += word;
                while (widthOf(current, size, bold) > width) { // a single word longer than the line
                    let cut = current.length - 1;
                    while (cut > 1 && widthOf(current.slice(0, cut), size, bold) > width) cut--;
                    lines.push(current.slice(0, cut));
                    current = current.slice(cut);
                }
            } else {
                lines.push(current.trimEnd());
                current = word.trimStart();
            }
        }
        lines.push(current.trimEnd());
        return lines;
    }

    // ------------------------------------------------------------------ the answer as a document

    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    const TABLE_ROW = /^\s*\|.*\|\s*$/;

    // "## " headings, paragraphs ("- " items become bullets), markdown tables and ```plot blocks with a JSON spec.
    function parseBlocks(text) {
        const lines = String(text).replace(/\r/g, '').split('\n');
        const blocks = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*```\s*(plot|chart|graph)\s*$/i.test(line)) {
                const body = [];
                while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i]);
                try {
                    blocks.push({ type: 'plot', spec: JSON.parse(body.join('\n')) });
                } catch (error) {
                    console.warn('[Naki] Plot spec is not valid JSON:', error.message);
                }
                continue;
            }
            if (/^\s*```/.test(line)) continue; // other code fences: their lines stay as text
            if (TABLE_ROW.test(line)) {
                const rows = [];
                for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
                    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // |---|:---:|
                    rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim())));
                }
                i--;
                blocks.push({ type: 'table', rows });
                continue;
            }
            const heading = line.match(/^\s*#{1,4}\s+(.*)/);
            blocks.push(heading ? { type: 'heading', text: inline(heading[1]) } : { type: 'para', text: inline(line.replace(/^(\s*)[-*]\s+/, '$1• ')) });
        }
        return blocks;
    }

    // Arithmetic expressions of the plot specs: numbers, t / x, + - * / ^, parentheses, pi, e and Math functions.
    // A small parser instead of eval (not allowed in extensions).
    const FUNCTIONS = { exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, abs: Math.abs,
        min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, pow: Math.pow };
    const CONSTANTS = { pi: Math.PI, e: Math.E };

    function compile(source) {
        const text = String(source).replace(/·|×/g, '*').replace(/−/g, '-');
        const tokens = text.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|\*\*|[-+*/^(),]/gi) || [];
        if (tokens.join('') !== text.replace(/\s+/g, '')) throw new Error(`unsupported expression: ${source}`);
        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];
        const binary = (operand, operators) => () => {
            let node = operand();
            while (operators[peek()]) {
                const apply = operators[next()], left = node, right = operand();
                node = scope => apply(left(scope), right(scope));
            }
            return node;
        };
        const unary = () => {
            if (peek() === '-') { next(); const inner = unary(); return scope => -inner(scope); }
            if (peek() === '+') { next(); return unary(); }
            return power();
        };
        const term = binary(unary, { '*': (a, b) => a * b, '/': (a, b) => a / b });
        const expression = binary(term, { '+': (a, b) => a + b, '-': (a, b) => a - b });
        function power() {
            const base = primary();
            if (peek() !== '^' && peek() !== '**') return base;
            next();
            const exponent = unary();
            return scope => Math.pow(base(scope), exponent(scope));
        }
        function primary() {
            const token = next();
            if (token === undefined) throw new Error(`incomplete expression: ${source}`);
            if (token === '(') {
                const inner = expression();
                if (next() !== ')') throw new Error(`missing ")": ${source}`);
                return inner;
            }
            if (/^[\d.]/.test(token)) { const value = Number(token); return () => value; }
            const name = token.toLowerCase();
            if (FUNCTIONS[name] && peek() === '(') {
                next();
                const args = [];
                if (peek() !== ')') do args.push(expression()); while (peek() === ',' && next());
                if (next() !== ')') throw new Error(`missing ")": ${source}`);
                return scope => FUNCTIONS[name](...args.map(arg => arg(scope)));
            }
            if (name in CONSTANTS) return () => CONSTANTS[name];
            return scope => { if (name in scope) return scope[name]; throw new Error(`unknown name "${token}" in ${source}`); };
        }
        const root = expression();
        if (pos < tokens.length) throw new Error(`unexpected "${peek()}" in ${source}`);
        return root;
    }

    // Series of a plot spec as point lists: "points" [[x, y], …], "expr" over [from, to], or "segments" (piecewise,
    // e.g. a switching system: [{"from", "to", "expr"}], each expression in absolute time).
    function seriesPoints(series, xRange) {
        const sample = (expr, from, to, count) => {
            const f = compile(expr);
            const out = [];
            for (let k = 0; k <= count; k++) {
                const x = from + (to - from) * k / count;
                out.push([x, f({ t: x, x })]);
            }
            return out;
        };
        if (Array.isArray(series.points)) return series.points.map(p => [Number(p[0]), Number(p[1])]);
        if (Array.isArray(series.segments)) return series.segments.flatMap(seg => sample(seg.expr, Number(seg.from), Number(seg.to), 120));
        if (series.expr) return sample(series.expr, Number(series.from ?? xRange[0]), Number(series.to ?? xRange[1]), 400);
        return [];
    }

    function niceTicks(min, max, count = 6) {
        const span = max - min || 1;
        const raw = span / count, magnitude = 10 ** Math.floor(Math.log10(raw));
        const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) || magnitude * 10;
        const ticks = [];
        for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        return ticks;
    }
    const tickText = v => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(6))));

    const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf'];

    // A line chart (title, axes, grid, legend, dashed reference lines) as PNG or JPEG bytes.
    async function renderPlot(spec, type = 'image/png') {
        const W = 960, H = 560, L = 90, R = 30, T = 56, B = 76;
        const xRange = Array.isArray(spec.xRange) ? spec.xRange.map(Number) : [0, 10];
        const series = (spec.series || []).map((s, i) => ({ label: String(s.label || ''), color: COLORS[i % COLORS.length], points: seriesPoints(s, xRange).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])) }))
            .filter(s => s.points.length > 1);
        if (!series.length) throw new Error('the plot has no data');
        const lines = (spec.hlines || []).map(line => (typeof line === 'number' ? { y: line } : { y: Number(line.y), label: line.label })).filter(line => Number.isFinite(line.y));
        const xs = series.flatMap(s => s.points.map(p => p[0]));
        const ys = [...series.flatMap(s => s.points.map(p => p[1])), ...lines.map(line => line.y)];
        let [x0, x1] = Array.isArray(spec.xRange) ? xRange : [Math.min(...xs), Math.max(...xs)];
        let [y0, y1] = Array.isArray(spec.yRange) ? spec.yRange.map(Number) : [Math.min(...ys), Math.max(...ys)];
        if (x1 === x0) x1 = x0 + 1;
        if (!Array.isArray(spec.yRange)) {
            const pad = (y1 - y0) * 0.06 || Math.abs(y0) * 0.1 || 1;
            y0 -= pad; y1 += pad;
        }
        const canvas = new OffscreenCanvas(W, H);
        const g = canvas.getContext('2d');
        const px = x => L + (x - x0) / (x1 - x0) * (W - L - R);
        const py = y => H - B - (y - y0) / (y1 - y0) * (H - T - B);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, W, H);
        g.font = '15px Arial, sans-serif';
        g.strokeStyle = '#e3e3e3';
        g.fillStyle = '#333';
        g.lineWidth = 1;
        g.textAlign = 'center';
        for (const v of niceTicks(x0, x1)) {
            g.beginPath(); g.moveTo(px(v), T); g.lineTo(px(v), H - B); g.stroke();
            g.fillText(tickText(v), px(v), H - B + 22);
        }
        g.textAlign = 'right';
        for (const v of niceTicks(y0, y1)) {
            g.beginPath(); g.moveTo(L, py(v)); g.lineTo(W - R, py(v)); g.stroke();
            g.fillText(tickText(v), L - 10, py(v) + 5);
        }
        g.strokeStyle = '#333';
        g.strokeRect(L, T, W - L - R, H - T - B);
        g.textAlign = 'center';
        g.fillText(String(spec.xLabel || 't'), L + (W - L - R) / 2, H - 24);
        g.save(); g.translate(24, T + (H - T - B) / 2); g.rotate(-Math.PI / 2); g.fillText(String(spec.yLabel || ''), 0, 0); g.restore();
        g.font = 'bold 18px Arial, sans-serif';
        g.fillText(String(spec.title || ''), W / 2, 32);
        g.save();
        g.beginPath(); g.rect(L, T, W - L - R, H - T - B); g.clip();
        g.setLineDash([8, 6]); g.strokeStyle = '#777'; g.lineWidth = 1.5;
        g.font = '14px Arial, sans-serif'; g.fillStyle = '#555'; g.textAlign = 'left';
        for (const line of lines) {
            g.beginPath(); g.moveTo(L, py(line.y)); g.lineTo(W - R, py(line.y)); g.stroke();
            if (line.label) g.fillText(line.label, L + 8, py(line.y) - 6);
        }
        g.setLineDash([]); g.lineWidth = 2.5;
        for (const s of series) {
            g.strokeStyle = s.color;
            g.beginPath();
            s.points.forEach(([x, y], k) => (k ? g.lineTo(px(x), py(y)) : g.moveTo(px(x), py(y))));
            g.stroke();
        }
        g.restore();
        const labelled = series.filter(s => s.label);
        if (labelled.length) {
            g.font = '14px Arial, sans-serif';
            const boxW = Math.max(...labelled.map(s => g.measureText(s.label).width)) + 46, boxH = labelled.length * 22 + 10;
            // The corner the curves cross least.
            const corners = [[W - R - boxW - 10, T + 10], [L + 10, T + 10], [W - R - boxW - 10, H - B - boxH - 10], [L + 10, H - B - boxH - 10]];
            const covered = ([x, y]) => series.reduce((sum, s) => sum + s.points.filter(([px0, py0]) => {
                const cx = px(px0), cy = py(py0);
                return cx >= x - 4 && cx <= x + boxW + 4 && cy >= y - 4 && cy <= y + boxH + 4;
            }).length, 0) + lines.filter(line => py(line.y) >= y - 8 && py(line.y) <= y + boxH + 8).length * 20;
            const [bx, by] = corners.reduce((best, corner) => (covered(corner) < covered(best) ? corner : best));
            g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(bx, by, boxW, boxH);
            g.strokeStyle = '#bbb'; g.lineWidth = 1; g.strokeRect(bx, by, boxW, boxH);
            labelled.forEach((s, k) => {
                g.strokeStyle = s.color; g.lineWidth = 3;
                g.beginPath(); g.moveTo(bx + 8, by + 20 + k * 22); g.lineTo(bx + 32, by + 20 + k * 22); g.stroke();
                g.fillStyle = '#222'; g.textAlign = 'left'; g.fillText(s.label, bx + 38, by + 25 + k * 22);
            });
        }
        const blob = await canvas.convertToBlob({ type, quality: 0.92 });
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: W, height: H };
    }

    // Blocks with the plots rendered ({ image } or { failed }).
    async function renderBlocks(blocks, type) {
        const out = [];
        for (const block of blocks) {
            if (block.type !== 'plot') { out.push(block); continue; }
            try {
                out.push({ ...block, image: await renderPlot(block.spec, type) });
            } catch (error) {
                console.warn('[Naki] Plot not drawn:', error.message);
                out.push({ type: 'para', text: `[${block.spec.title || 'Plot'}]` });
            }
        }
        return out;
    }

    async function makePdf(title, blocks) {
        const W = 595, H = 842, M = 56, width = W - 2 * M;
        const items = [];
        for (const line of wrap(title, 16, true, width)) items.push({ text: line, size: 16, bold: true, gap: 22 });
        items.push({ text: '', size: 11, gap: 10 });
        for (const block of await renderBlocks(blocks, 'image/jpeg')) {
            if (block.image) {
                const h = width * block.image.height / block.image.width;
                items.push({ image: block.image, h, gap: h + 10 });
                if (block.spec.title) items.push({ text: '', size: 11, gap: 6 });
            } else if (block.type === 'table') {
                const columns = Math.max(...block.rows.map(row => row.length));
                const colWidth = width / columns;
                block.rows.forEach((row, r) => items.push({ cells: row.map(cell => wrap(cell, 9.5, r === 0, colWidth - 6)[0]), colWidth, size: 9.5, bold: r === 0, gap: 14 }));
                items.push({ text: '', size: 11, gap: 6 });
            } else {
                const heading = block.type === 'heading';
                const size = heading ? 12.5 : 11;
                for (const line of wrap(block.text.replace(/\t/g, '    '), size, heading, width)) items.push({ text: line, size, bold: heading, gap: heading ? 18 : 15 });
            }
        }
        const pages = [[]];
        let y = H - M;
        for (const item of items) {
            if (y - item.gap < M) { pages.push([]); y = H - M; }
            y -= item.gap;
            pages[pages.length - 1].push({ ...item, y });
        }
        const escape = s => [...s].map(c => {
            const code = winAnsiCode(c);
            const ch = code < 0 ? '?' : String.fromCharCode(code);
            return ch === '\\' || ch === '(' || ch === ')' ? '\\' + ch : ch;
        }).join('');
        const objects = [];
        const add = body => { objects.push(body); return objects.length; };
        const catalog = add(null), pagesId = add(null);
        const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        const images = [];
        for (const page of pages) for (const item of page) if (item.image) {
            item.name = `Im${images.length + 1}`;
            images.push([item.name, add(`<< /Type /XObject /Subtype /Image /Width ${item.image.width} /Height ${item.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${item.image.bytes.length} >>\nstream\n${latin1(item.image.bytes)}\nendstream`)]);
        }
        const xobjects = images.length ? ` /XObject << ${images.map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >>` : '';
        const text = (s, x, y, size, isBold) => `BT /${isBold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${escape(s)}) Tj ET`;
        const kids = [];
        for (const page of pages) {
            const content = page.map(item => {
                if (item.image) return `q ${width} 0 0 ${item.h.toFixed(1)} ${M} ${item.y.toFixed(1)} cm /${item.name} Do Q`;
                if (item.cells) return item.cells.map((cell, c) => text(cell, M + c * item.colWidth, item.y, item.size, item.bold)).join('\n');
                return item.text ? text(item.text, M, item.y, item.size, item.bold) : '';
            }).filter(Boolean).join('\n');
            const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
            kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>${xobjects} >> /Contents ${contentId} 0 R >>`));
        }
        objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
        objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
        let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
        const offsets = [];
        objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
        const xref = out.length;
        out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
        out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        return Uint8Array.from(out, c => c.charCodeAt(0));
    }

    const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc32 = bytes => {
        let c = 0xffffffff;
        for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };

    // A stored (uncompressed) zip archive; contents are strings (UTF-8) or bytes.
    function makeZip(files) {
        const encoder = new TextEncoder();
        const chunks = [], central = [];
        let offset = 0;
        for (const [name, content] of files) {
            const nameBytes = encoder.encode(name), data = typeof content === 'string' ? encoder.encode(content) : content, crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            [[0, 0x04034b50, 4], [4, 20, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2]]
                .forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
            const entry = new DataView(new ArrayBuffer(46));
            [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [42, offset, 4]]
                .forEach(([at, value, size]) => size === 4 ? entry.setUint32(at, value, true) : entry.setUint16(at, value, true));
            chunks.push(new Uint8Array(local.buffer), nameBytes, data);
            central.push(new Uint8Array(entry.buffer), nameBytes);
            offset += 30 + nameBytes.length + data.length;
        }
        const size = central.reduce((sum, chunk) => sum + chunk.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        [[0, 0x06054b50, 4], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4]]
            .forEach(([at, value, bytes]) => bytes === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true));
        return new Blob([...chunks, ...central, new Uint8Array(end.buffer)]);
    }

    async function makeDocx(title, blocks) {
        const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const run = (s, bold, size, italic) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escape(s)}</w:t></w:r>`;
        const paragraph = (s, bold, size, { italic = false, center = false } = {}) =>
            `<w:p>${center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : ''}${run(s, bold, size, italic)}</w:p>`;
        const border = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
        const table = rows => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>` +
            `<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
            rows.map((row, r) => `<w:tr>${row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(cell, r === 0, 20)}</w:tc>`).join('')}</w:tr>`).join('') + '</w:tbl><w:p/>';
        const images = [];
        const picture = image => {
            images.push(image.bytes);
            const n = images.length, cx = 5486400, cy = Math.round(cx * image.height / image.width);
            return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Plot ${n}"/>` +
                `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
                `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="plot${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
                `<pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
                `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
        };
        const body = [paragraph(title, true, 32)];
        for (const block of await renderBlocks(blocks, 'image/png')) {
            if (block.image) {
                body.push(picture(block.image));
                if (block.spec.caption) body.push(paragraph(String(block.spec.caption), false, 20, { italic: true, center: true }));
            } else if (block.type === 'table') body.push(table(block.rows));
            else if (block.type === 'heading') body.push(paragraph(block.text, true, 26));
            else body.push(paragraph(block.text, false, 22));
        }
        const rels = images.map((_, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/plot${i + 1}.png"/>`).join('');
        return makeZip([
            ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
            ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
            ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`],
            ['word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
                `<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`],
            ...images.map((bytes, i) => [`word/media/plot${i + 1}.png`, bytes])
        ]);
    }

    const plainText = blocks => blocks.map(block => block.type === 'table' ? block.rows.map(row => row.join('\t')).join('\n')
        : block.type === 'plot' ? `[${block.spec.title || 'Plot'}]` : block.text).join('\n');

    // The answer as a file Coursera accepts for the part. Plots and tables → DOCX (real tables, PNG charts); otherwise
    // PDF when the text fits a standard PDF font, else DOCX, else TXT. allowed: the part's allowedFiles (["ALL"],
    // ["PDF", "DOCX"], …), an empty list allows anything. name: the file name without extension (title by default).
    async function makeFile(title, text, allowed = [], name = title) {
        const kinds = allowed.map(kind => String(kind).toUpperCase());
        const any = !kinds.length || kinds.some(kind => /ALL|ANY/.test(kind));
        const ok = pattern => any || kinds.some(kind => pattern.test(kind));
        const base = String(name).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'submission';
        const blocks = parseBlocks(text);
        const rich = blocks.some(block => block.type === 'plot' || block.type === 'table');
        const fits = fitsPdf(`${title}\n${plainText(blocks)}`);
        const docx = async () => new File([await makeDocx(title, blocks)], `${base}.docx`, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const pdf = async () => new File([await makePdf(title, blocks)], `${base}.pdf`, { type: 'application/pdf' });
        if (ok(/DOC|WORD|OFFICE/) && (rich || !fits)) return docx();
        if (ok(/PDF/) && fits) return pdf();
        if (ok(/DOC|WORD|OFFICE/)) return docx();
        if (ok(/TXT|TEXT|PLAIN/)) return new File([`${title}\n\n${plainText(blocks)}`], `${base}.txt`, { type: 'text/plain' });
        if (ok(/PDF/)) return pdf(); // unsupported characters become "?"
        return null;
    }

    return { textOf, pdfText, officeText, makeFile, makePdf, makeDocx, parseBlocks, renderPlot, compile };
})();
