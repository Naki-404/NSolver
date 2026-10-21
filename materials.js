// Materials base: the course materials NSolver gives the model with Coursera and NetAcad questions, viewable and editable by hand.
// Records live in chrome.storage.local under "nakiMaterials:<course id>" = { savedAt, name, site, docs, edited } (materials-core.js).
// NSolver, made by Naki — https://github.com/Naki-404/NSolver
(function () {
    const PREFIX = 'nakiMaterials:';
    const INDEX_KEY = 'nakiMaterialsIndex';
    const $ = id => document.getElementById(id);

    let lang = 'ru';
    const tr = (key, vars) => Naki.t(lang, key, vars);
    let courses = {};      // slug → record
    let selected = null;   // slug
    let query = '';
    let openDoc = null;    // position of the expanded material in the selected course
    let noticeTimer = null;

    // DOM helper: el('div', { className, textContent, onclick, ... }, children)
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key in node) node[key] = value;
            else node.setAttribute(key, value);
        }
        for (const child of [].concat(children)) if (child) node.append(child);
        return node;
    }

    const sizeOf = record => new Blob([JSON.stringify(record)]).size;
    function formatSize(bytes) {
        if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }
    const formatDate = time => new Date(time).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
    const typeLabel = type => tr({ lecture: 'mbLecture', supplement: 'mbReading', page: 'mbPage', note: 'mbNote' }[type] || 'mbNote');

    function notice(text, kind = 'success') {
        $('notice').textContent = text;
        $('notice').className = `message ${kind}`;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 5000);
    }

    // ------------------------------------------------------------------ storage

    async function load() {
        const all = await chrome.storage.local.get(null);
        courses = Object.fromEntries(Object.entries(all)
            .filter(([key, value]) => key.startsWith(PREFIX) && value && Array.isArray(value.docs))
            .map(([key, value]) => [key.slice(PREFIX.length), value]));
        if (selected && !courses[selected]) selected = null;
        if (!selected) selected = Object.keys(courses).sort((a, b) => (courses[b].savedAt || 0) - (courses[a].savedAt || 0))[0] || null;
        render();
    }

    // Saving by hand marks the course as edited: NSolver then never replaces or evicts it on its own.
    async function saveCourse(slug, record) {
        const next = { ...record, edited: true };
        courses[slug] = next;
        const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
        await chrome.storage.local.set({ [PREFIX + slug]: next, [INDEX_KEY]: index.includes(slug) ? index : [slug, ...index] });
    }

    async function deleteCourse(slug) {
        const { [INDEX_KEY]: index = [] } = await chrome.storage.local.get(INDEX_KEY);
        await chrome.storage.local.remove(PREFIX + slug);
        await chrome.storage.local.set({ [INDEX_KEY]: index.filter(other => other !== slug) });
        delete courses[slug];
        selected = null;
        openDoc = null;
    }

    // ------------------------------------------------------------------ rendering

    function render() {
        document.documentElement.lang = lang;
        $('heading').textContent = tr('materialsTitle');
        $('hint').textContent = tr('mbHint');
        $('importLabel').textContent = tr('mbImport');
        $('coursesTitle').textContent = tr('mbCourses');
        const slugs = Object.keys(courses).sort((a, b) => (courses[a].name || a).localeCompare(courses[b].name || b));
        const total = slugs.reduce((sum, slug) => sum + sizeOf(courses[slug]), 0);
        $('coursesSummary').textContent = slugs.length ? tr('materialsSummary', { courses: slugs.length, size: formatSize(total) }) : '';
        renderCourseList(slugs);
        renderDetail();
    }

    function renderCourseList(slugs) {
        const list = $('courseList');
        list.replaceChildren();
        if (!slugs.length) {
            list.append(el('p', { className: 'mb-empty', textContent: tr('mbNoCourses') }));
            return;
        }
        for (const slug of slugs) {
            const record = courses[slug];
            const on = record.docs.filter(doc => !doc.disabled).length;
            list.append(el('button', {
                type: 'button',
                className: `mb-course${slug === selected ? ' active' : ''}`,
                onclick: () => { selected = slug; openDoc = null; query = ''; render(); }
            }, [
                el('b', { textContent: record.name || slug }),
                el('small', { textContent: `${tr('mbDocs', { n: record.docs.length, on })} · ${formatSize(sizeOf(record))}` }),
                el('small', { textContent: record.edited ? `${slug} · ${tr('mbEdited')}` : slug })
            ]));
        }
    }

    function renderDetail() {
        const detail = $('detail');
        detail.replaceChildren();
        const record = selected && courses[selected];
        if (!record) {
            detail.append(el('p', { className: 'mb-empty', textContent: Object.keys(courses).length ? tr('mbSelect') : tr('materialsEmpty') }));
            return;
        }
        const on = record.docs.filter(doc => !doc.disabled).length;
        detail.append(el('div', { className: 'mb-detail-head' }, [
            el('div', {}, [
                el('h2', { textContent: record.name || selected }),
                el('p', { textContent: [tr('mbDocs', { n: record.docs.length, on }), record.savedAt ? tr('mbSaved', { date: formatDate(record.savedAt) }) : '', record.edited ? tr('mbEdited') : ''].filter(Boolean).join(' · ') })
            ]),
            el('div', { className: 'mb-actions' }, [
                el('button', { type: 'button', className: 'btn secondary small', textContent: tr('mbExport'), onclick: () => exportCourse(selected) }),
                el('button', { type: 'button', className: 'btn small danger', textContent: tr('mbDeleteCourse'), onclick: async () => {
                    if (!confirm(tr('mbConfirmDelete', { name: record.name || selected }))) return;
                    await deleteCourse(selected);
                    render();
                } })
            ])
        ]));

        // own material
        const title = el('input', { type: 'text', placeholder: tr('mbNoteTitle'), maxLength: 200 });
        const text = el('textarea', { placeholder: tr('mbNoteText') });
        detail.append(el('details', { className: 'mb-add' }, [
            el('summary', { textContent: tr('mbAddNote') }),
            el('form', { onsubmit: async event => {
                event.preventDefault();
                const body = text.value.replace(/\s+\n/g, '\n').trim();
                if (!body) return;
                const docs = [...record.docs, { type: 'note', title: title.value.trim() || tr('mbNote'), module: null, order: 1e6 + record.docs.length, text: body, edited: true }];
                await saveCourse(selected, { ...record, docs });
                notice(tr('mbSavedOk'));
                render();
            } }, [title, text, el('div', { className: 'mb-actions' }, el('button', { type: 'submit', className: 'btn small', textContent: tr('mbAdd') }))])
        ]));

        const search = el('input', { type: 'text', placeholder: tr('mbSearch'), value: query });
        search.addEventListener('input', () => { query = search.value; renderDocs(record, docsBox); });
        detail.append(search);
        const docsBox = el('div', { className: 'mb-docs' });
        detail.append(docsBox);
        renderDocs(record, docsBox);
    }

    function renderDocs(record, box) {
        box.replaceChildren();
        const needle = query.trim().toLowerCase();
        const shown = record.docs
            .map((doc, position) => ({ doc, position }))
            .filter(({ doc }) => !needle || `${doc.title} ${doc.text}`.toLowerCase().includes(needle));
        if (!shown.length) {
            box.append(el('p', { className: 'mb-empty', textContent: tr('mbNothingFound') }));
            return;
        }
        for (const { doc, position } of shown) box.append(renderDoc(record, doc, position));
    }

    function renderDoc(record, doc, position) {
        const use = el('input', { type: 'checkbox', checked: !doc.disabled, title: tr('mbUse') });
        use.addEventListener('change', async () => {
            const docs = record.docs.map((item, i) => (i === position ? { ...item, disabled: !use.checked } : item));
            await saveCourse(selected, { ...record, docs });
            render();
        });
        const meta = [doc.module !== null && doc.module !== undefined ? tr('mbModule', { n: doc.module + 1 }) : '', tr('mbChars', { n: doc.text.length.toLocaleString() })].filter(Boolean).join(' · ');
        const row = el('div', { className: 'mb-doc-row' }, [
            el('label', { className: 'switch', title: tr('mbUse') }, [use, el('span', { className: 'track' })]),
            el('span', { className: `mb-badge ${doc.type}`, textContent: typeLabel(doc.type) }),
            el('button', { type: 'button', className: 'mb-doc-title', textContent: doc.title, title: doc.title, onclick: () => { openDoc = openDoc === position ? null : position; render(); } }),
            el('span', { className: 'mb-meta', textContent: meta })
        ]);
        const item = el('div', { className: `mb-doc${doc.disabled ? ' off' : ''}` }, row);
        if (openDoc === position) {
            const title = el('input', { type: 'text', value: doc.title, maxLength: 200 });
            const text = el('textarea', { value: doc.text });
            item.append(el('div', { className: 'mb-doc-body' }, [
                title,
                text,
                el('div', { className: 'mb-actions' }, [
                    el('button', { type: 'button', className: 'btn small danger', textContent: tr('mbDelete'), onclick: async () => {
                        if (!confirm(tr('mbConfirmDeleteDoc', { name: doc.title }))) return;
                        await saveCourse(selected, { ...record, docs: record.docs.filter((_, i) => i !== position) });
                        openDoc = null;
                        render();
                    } }),
                    el('button', { type: 'button', className: 'btn secondary small', textContent: tr('mbCancel'), onclick: () => { openDoc = null; render(); } }),
                    el('button', { type: 'button', className: 'btn small', textContent: tr('mbSave'), onclick: async () => {
                        const docs = record.docs.map((current, i) => (i === position ? { ...current, title: title.value.trim() || current.title, text: text.value.trim(), edited: true } : current));
                        await saveCourse(selected, { ...record, docs });
                        notice(tr('mbSavedOk'));
                        render();
                    } })
                ])
            ]));
        }
        return item;
    }

    // ------------------------------------------------------------------ export / import

    function exportCourse(slug) {
        const blob = new Blob([JSON.stringify({ nsolverMaterials: 1, slug, ...courses[slug] }, null, 2)], { type: 'application/json' });
        const link = el('a', { href: URL.createObjectURL(blob), download: `nsolver-materials-${slug}.json` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    $('importFile').addEventListener('change', async event => {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!data || typeof data.slug !== 'string' || !/^[\w-]+$/.test(data.slug) || !Array.isArray(data.docs)) throw new Error('not an NSolver materials file');
            const docs = data.docs
                .filter(doc => doc && typeof doc.text === 'string' && doc.text.trim())
                .map((doc, i) => ({
                    type: ['lecture', 'supplement', 'page', 'note'].includes(doc.type) ? doc.type : 'note',
                    title: String(doc.title || `${i + 1}`).slice(0, 200),
                    module: Number.isInteger(doc.module) ? doc.module : null,
                    order: Number.isFinite(doc.order) ? doc.order : i,
                    text: doc.text,
                    ...(doc.disabled ? { disabled: true } : {}),
                    ...(doc.edited ? { edited: true } : {})
                }));
            await saveCourse(data.slug, { savedAt: Number(data.savedAt) || Date.now(), name: String(data.name || data.slug), ...(data.site === 'netacad' ? { site: 'netacad' } : {}), docs });
            selected = data.slug;
            openDoc = null;
            notice(tr('mbImported', { name: data.name || data.slug }));
            render();
        } catch (error) {
            notice(tr('mbImportFailed', { error: error.message }), 'error');
        }
    });

    // ------------------------------------------------------------------ init

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.lang) lang = changes.lang.newValue === 'en' ? 'en' : 'ru';
        // Changes made elsewhere (a new course downloaded by the solver) show up here; an expanded editor stays open.
        if (Object.keys(changes).some(key => key.startsWith(PREFIX) || key === 'lang')) load();
    });

    Naki.loadSettings().then(settings => {
        lang = settings.lang;
        load();
    });
})();
