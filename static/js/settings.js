const RESTART_REQUIRED_FIELDS = {
    system: ['LLAMA_SERVER_URL']
};

// Тег пишем в двойных скобках — {{tag}} — одинарный вариант {tag}
// достраивается автоматом в _expandTags(), т.к. по требованиям они
// полностью равноценны (оба матчатся, оба подсвечиваются, один hint
// на оба варианта). Раньше это было fallbackPlaceholder только для одного
// обязательного тега; теперь так для любого числа необязательных.
function _expandTags(tags) {
    return (tags || []).map(t => {
        const double = t.tag;
        const single = double.startsWith('{{') && double.endsWith('}}')
            ? '{' + double.slice(2, -2) + '}'
            : null;
        return { ...t, variants: single ? [double, single] : [double] };
    });
}

const SETTINGS_SCHEMA = [
    {
    key: "system",
    label: "System",
    fields: [
        { key: "INACTIVITY_TIMEOUT_HOURS", label: "Inactivity Timeout (hours, 0 — disabled)", type: "number" },
        { key: "LLAMA_SERVER_URL", label: "Llama Server URL (requires restart)", type: "text" }
        ]
    },
    {
    key: "generation",
    label: "Text Generation",
    fields: [
        { key: "DEFAULT_CONTEXT_SIZE", label: "Default Context Size (for auto-config)", type: "number" },
        { key: "TEMPERATURE", label: "Temperature", type: "number", step: "0.01" },
        { key: "TOP_P", label: "Top P", type: "number", step: "0.01" },
        { key: "TOP_K", label: "Top K", type: "number" },
        { key: "REPEAT_PENALTY", label: "Repeat Penalty", type: "number", step: "0.01" },
        { key: "FREQUENCY_PENALTY", label: "Frequency Penalty", type: "number", step: "0.01" },
        { key: "PRESENCE_PENALTY", label: "Presence Penalty", type: "number", step: "0.01" }
        ]
    },
    {
        key: "prompts",
        label: "Prompts",
        fields: [
            { key: "DEFAULT_SYSTEM_RULES", label: "System Rules", type: "textarea", tags: _expandTags([
                { tag: "{{char}}", hint: "Replaced with the character's name." },
                { tag: "{{user}}", hint: "Replaced with your persona's name." }
            ]) },
            { key: "SUMMARIZE_PROMPT", label: "Summarize Prompt", type: "textarea" },
            { key: "META_SUMMARIZE_PROMPT", label: "Meta-Summarize Prompt", type: "textarea" },
            { key: "SUGGEST_SYSTEM_PROMPT", label: "Suggest Prompt", type: "textarea", tags: _expandTags([
                { tag: "{{user_name}}", hint: "Replaced with your persona's name." },
                { tag: "{{user_description}}", hint: "Replaced with your persona's description." },
                { tag: "{{char_name}}", hint: "Replaced with the character's name." },
                { tag: "{{char_instructions}}", hint: "Replaced with the character's system rules/instructions." }
            ]) },
            { key: "NOTES_TEMPLATE", label: "Notes OOC Template", type: "textarea", tags: _expandTags([
                { tag: "{{content}}", hint: "Replaced with the character's notes text. Required — without it, the notes text never actually reaches the model.", required: true }
            ]) },
            { key: "OOC_TEMPLATE", label: "Command OOC Template", type: "textarea", tags: _expandTags([
                { tag: "{{content}}", hint: "Replaced with your /cmd text. Required — without it, your command text never actually reaches the model.", required: true }
            ]) }
        ]
    }
];

let _settingsData = null;

let _saveInProgress = false;

// Невидимый клон textarea, того же шрифта/паддингов/переносов, только
// чтобы измерить реальные пиксельные координаты тегов внутри текста —
// textarea сама этого не даёт (нет API "дай мне позицию символа N").
// Реальная textarea не трогается (текст, курсор, выделение — всё родное),
// клон существует только для измерения и для рисования фоновой подсветки
// позади реального (непрозрачного) текста textarea.
//
// В отличие от старой single-tag версии, тут сканируется ВЕСЬ текст на
// вхождения ЛЮБОГО из tags[].variants (двойные и одинарные скобки —
// равноценные варианты одного тега, оба матчатся). Каждое найденное
// вхождение — отдельный <mark> с одной общей подсветкой (без разделения
// по тегу) и своим data-hint для тултипа конкретно этого куска текста.
// Теги по умолчанию опциональны (чисто справочная подсветка), но
// отдельный тег может быть помечен required: true в схеме (см.
// {{content}} у NOTES_TEMPLATE/OOC_TEMPLATE — это не украшение, а
// единственное место, куда бэкенд реально подставляет текст заметок/
// команды; без него они физически не долетают до модели). Required
// проверяется отдельной функцией _checkRequiredTags ниже — это чистая
// строковая проверка, без пересчёта пиксельных координат.
function _rebuildTagMarks(textarea, tags) {
    if (!tags || !tags.length) {
        if (textarea._placeholderClone) textarea._placeholderClone.innerHTML = '';
        textarea._marks = null;
        _hideTooltip();
        return;
    }

    let clone = textarea._placeholderClone;
    if (!clone) {
        clone = document.createElement('div');
        clone.className = 'settings-textarea-clone';
        textarea.parentElement.appendChild(clone);
        textarea._placeholderClone = clone;
    }

    // Explicitly pin the clone directly on top of the textarea every time —
    // CSS's static top:0/left:0 only matches the textarea's position when
    // the textarea happens to sit at .form-group's own top-left corner,
    // which it never does here (the <label> sits above it). Anchoring via
    // JS against the textarea's own position removes that assumption.
    clone.style.top = textarea.offsetTop + 'px';
    clone.style.left = textarea.offsetLeft + 'px';

    const cs = getComputedStyle(textarea);
    ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
     'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
     'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
     'boxSizing', 'whiteSpace', 'wordWrap'].forEach(p => {
        clone.style[p] = cs[p];
    });
    // clientWidth excludes border, but boxSizing:border-box (copied above)
    // treats `width` as the full border-inclusive box — so pairing
    // clientWidth with border-box shrinks the content area vs the real
    // textarea and throws line-wrapping out of sync. offsetWidth includes
    // border, matching what border-box expects.
    clone.style.width = textarea.offsetWidth + 'px';
    clone.style.whiteSpace = 'pre-wrap';
    clone.style.wordBreak = 'break-word';
    // The clone's own text stays fully invisible — it only exists to
    // measure where tags land and to host the highlight's background
    // fill. Real textarea text renders normally on top of it, uncolored.
    clone.style.color = 'transparent';

    // Найти ВСЕ непересекающиеся вхождения ВСЕХ вариантов ВСЕХ тегов,
    // отсортированные по позиции в тексте — нужно для одного прохода
    // "текст между тегами / тег" при сборке DOM клона.
    const value = textarea.value;
    const found = [];
    tags.forEach(t => {
        t.variants.forEach(variant => {
            let from = 0;
            let idx;
            while ((idx = value.indexOf(variant, from)) !== -1) {
                found.push({ start: idx, end: idx + variant.length, hint: t.hint, text: variant });
                from = idx + variant.length;
            }
        });
    });
    found.sort((a, b) => a.start - b.start);
    // Двойной {{tag}} естественно поглощает совпадение одинарного {tag}
    // на той же позиции (оба матчатся у {{content}}, т.к. "{content}" —
    // подстрока "{{content}}") — отбрасываем вложенные/перекрывающиеся
    // совпадения, оставляя первое (более раннее/длинное) из каждой группы.
    const marks = [];
    let lastEnd = -1;
    for (const m of found) {
        if (m.start < lastEnd) continue;
        marks.push(m);
        lastEnd = m.end;
    }

    clone.innerHTML = '';
    let cursor = 0;
    const markEls = [];
    marks.forEach(m => {
        clone.append(document.createTextNode(value.slice(cursor, m.start)));
        const el = document.createElement('span');
        el.className = 'settings-placeholder-highlight';
        el.textContent = m.text;
        clone.appendChild(el);
        markEls.push({ el, hint: m.hint });
        cursor = m.end;
    });
    clone.append(document.createTextNode(value.slice(cursor)));

    // Store each mark's rect relative to the textarea's own box (not raw
    // viewport coordinates — a raw getBoundingClientRect() snapshot goes
    // stale the instant the page scrolls). mousemove re-derives the live
    // viewport rect from this offset + the textarea's current position
    // every time instead of trusting a cached absolute rect.
    const taRectNow = textarea.getBoundingClientRect();
    textarea._marks = markEls.map(({ el, hint }) => {
        const r = el.getBoundingClientRect();
        return {
            top: r.top - taRectNow.top,
            left: r.left - taRectNow.left,
            width: r.width,
            height: r.height,
            hint
        };
    });
}

// Поле валидно, если у него либо нет required-тегов, либо КАЖДЫЙ
// required-тег присутствует хотя бы одним из своих вариантов ({{x}}
// или {x}) где-то в тексте. Чисто строковая проверка — никакого
// пересчёта координат, дёшево дёргать на каждый keystroke.
function _missingRequiredTags(value, tags) {
    return (tags || [])
        .filter(t => t.required)
        .filter(t => !t.variants.some(v => value.includes(v)));
}

// Ловит юзера, который случайно сожрал обязательный {{content}} —
// показывает warn-плашку под полем и блокирует Save, пока тег не
// вернётся. Непохоже на остальную (чисто справочную) подсветку тегов —
// это единственное место, где отсутствие тега реально ломает
// функциональность (см. required: true в схеме и комментарий выше).
function _checkRequiredTags(input, field) {
    const missing = _missingRequiredTags(input.value, field.tags);
    const group = input.closest('.form-group');
    const existingWarn = group?.querySelector('.settings-placeholder-warn');

    input.classList.toggle('settings-field-invalid', missing.length > 0);

    if (missing.length) {
        const label = missing.map(t => t.tag).join(', ');
        if (existingWarn) {
            existingWarn.textContent = `Missing required ${label} — can't save without it.`;
        } else if (group) {
            const warn = document.createElement('div');
            warn.className = 'settings-placeholder-warn';
            warn.textContent = `Missing required ${label} — can't save without it.`;
            group.appendChild(warn);
        }
    } else {
        existingWarn?.remove();
    }

    // The accordion caps this section's height via max-height, set once
    // when the section is opened (see header click handler). Adding or
    // removing the warning div changes content height without touching
    // that cap, so the browser just clips it — recompute here or the
    // warning silently exists in the DOM but never becomes visible.
    const body = group?.closest('.settings-section-body');
    const openSection = body?.closest('.settings-section.open');
    if (body && openSection) {
        body.style.maxHeight = body.querySelector('.settings-section-inner').scrollHeight + 'px';
    }

    _updateSaveBtnState();
    return missing.length === 0;
}

// Scans every field that has at least one required tag currently on the
// page — if any is missing, the Save button goes disabled and dimmed so
// the user can't even click into the alert-and-reject flow; if all are
// fine, it's re-enabled. Runs after every _checkRequiredTags call
// (typing, initial render, accordion open) rather than only at Save
// time. Skipped while a save is actually in flight (_saveInProgress) —
// typing in a field during that brief async window shouldn't fight with
// the Saving…/Restarting… button state.
function _updateSaveBtnState() {
    if (_saveInProgress) return;
    const btn = document.getElementById('settingsSaveBtn');
    if (!btn) return;

    let allOk = true;
    document.querySelectorAll('#settingsAccordion [data-section]').forEach(input => {
        const sec = input.dataset.section;
        const field = input.dataset.field;
        const schema = SETTINGS_SCHEMA.find(s => s.key === sec)?.fields.find(f => f.key === field);
        if (!schema?.tags?.some(t => t.required)) return;
        if (_missingRequiredTags(input.value, schema.tags).length) allOk = false;
    });

    btn.disabled = !allOk;
    btn.classList.toggle('save-btn-blocked', !allOk);
}

// Single shared opaque tooltip element, reused across every highlighted
// tag on the page rather than creating one per field — matches the
// native title-tooltip behavior of "one bubble visible at a time" and
// avoids leaving orphaned popups behind when a field gets re-rendered.
let _tooltipEl = null;
function _getTooltipEl() {
    if (!_tooltipEl) {
        _tooltipEl = document.createElement('div');
        _tooltipEl.className = 'settings-tooltip';
        document.body.appendChild(_tooltipEl);
    }
    return _tooltipEl;
}

function _showTooltip(rect, text) {
    const tip = _getTooltipEl();
    tip.textContent = text;
    tip.classList.add('is-visible');

    // Positioned in viewport coordinates (fixed), so no dependency on
    // .form-group's own offset math — measure directly from the given
    // rect and place the bubble just above it, centered horizontally.
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    tip.style.left = left + 'px';
    tip.style.top = (rect.top - tipRect.height - 8) + 'px';
}

function _hideTooltip() {
    _tooltipEl?.classList.remove('is-visible');
}

// Detects hover over any highlighted tag purely by comparing mousemove
// coordinates against each mark's stored position — marks stay
// pointer-events:none (they live in the invisible clone, not the real
// textarea) so clicks/caret placement in the real textarea are untouched.
// Bound once per textarea, not re-bound on every re-render. Each mark
// carries its own hint text, so hovering different tags in the same
// field shows different tooltips.
function _bindTextHoverTooltip(textarea) {
    if (textarea._textHoverBound) return;
    textarea._textHoverBound = true;
    let hoveredMark = null;
    textarea.addEventListener('mousemove', (e) => {
        const marks = textarea._marks;
        if (!marks || !marks.length) return;

        const taRect = textarea.getBoundingClientRect();
        const localX = e.clientX - taRect.left + textarea.scrollLeft;
        const localY = e.clientY - taRect.top + textarea.scrollTop;

        const hit = marks.find(m =>
            localX >= m.left && localX <= m.left + m.width &&
            localY >= m.top && localY <= m.top + m.height
        );

        if (hit && hit !== hoveredMark) {
            hoveredMark = hit;
            _showTooltip({
                left: taRect.left + hit.left - textarea.scrollLeft,
                top: taRect.top + hit.top - textarea.scrollTop,
                width: hit.width
            }, hit.hint);
        } else if (!hit && hoveredMark) {
            hoveredMark = null;
            _hideTooltip();
        }
    });
    textarea.addEventListener('mouseleave', () => {
        if (hoveredMark) _hideTooltip();
        hoveredMark = null;
    });
}

// Sets the button's icon + label together. The checkmark icon now stays
// visible in every state (idle, and the green "Saved" success state) —
// only genuinely different actions (Saving…/Restarting…) swap it out,
// since a spinner state showing a static checkmark would be misleading.
function _setSaveBtnLabel(btn, text) {
    btn.innerHTML = `<img class="save-btn-icon" src="/static/icons/check.svg" alt="">${text}`;
}
function _setSaveBtnIdle(btn) {
    _setSaveBtnLabel(btn, 'Save Settings');
}

async function loadSettings() {
    const res = await fetch('/get_settings');
    _settingsData = await res.json();
    renderAccordion(_settingsData);
}

function renderAccordion(data) {
    const container = document.getElementById('settingsAccordion');
    if (!container) return;
    container.innerHTML = '';

    SETTINGS_SCHEMA.forEach(section => {
        const block = document.createElement('div');
        block.className = 'settings-section';

        const header = document.createElement('div');
        header.className = 'settings-section-header';
        header.innerHTML = `<span>${section.label}</span><span class="settings-arrow">▶</span>`;
        header.addEventListener('click', () => {
            const isOpen = block.classList.toggle('open');
            if (isOpen) {
                body.style.maxHeight = inner.scrollHeight + 'px';
                block.querySelectorAll('.settings-textarea').forEach(ta => {
                    ta.style.height = 'auto';
                    ta.style.height = ta.scrollHeight + 'px';
                    body.style.maxHeight = inner.scrollHeight + 'px';

                    // Section was display:collapsed via max-height:0 until
                    // now, so any earlier getBoundingClientRect() call for
                    // this textarea's marks happened against a zero-size
                    // box — recompute now that it's actually laid out.
                    const sec = SETTINGS_SCHEMA.find(s => s.key === ta.dataset.section);
                    const field = sec?.fields.find(f => f.key === ta.dataset.field);
                    if (field?.tags?.length) {
                        requestAnimationFrame(() => _rebuildTagMarks(ta, field.tags));
                    }
                });
            } else {
                body.style.maxHeight = '0';
            }
        });

        const body = document.createElement('div');
        body.className = 'settings-section-body';

        const inner = document.createElement('div');
        inner.className = 'settings-section-inner';

        const numberFields = section.fields.filter(f => f.type === 'number');
        const otherFields = section.fields.filter(f => f.type !== 'number');

        if (numberFields.length) {
            const grid = document.createElement('div');
            grid.className = 'settings-number-grid';
            numberFields.forEach(field => {
                const group = document.createElement('div');
                group.className = 'settings-number-row';

                const label = document.createElement('label');
                label.className = 'form-label';
                label.textContent = field.label;

                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'form-input settings-number-input';
                if (field.step) input.step = field.step;
                input.value = data[section.key][field.key];
                input.dataset.section = section.key;
                input.dataset.field = field.key;

                group.appendChild(label);
                group.appendChild(input);
                grid.appendChild(group);
            });
            inner.appendChild(grid);
        }

        otherFields.forEach(field => {
            if (field.divider) {
                const divider = document.createElement('div');
                divider.className = 'settings-divider';
                inner.appendChild(divider);
            }
            const group = document.createElement('div');
            group.className = 'form-group';

            const label = document.createElement('label');
            label.className = 'form-label';
            label.textContent = field.label;

            let input;
            const rawValue = data[section.key][field.key];

            if (field.type === 'textarea') {
                input = document.createElement('textarea');
                input.className = 'form-textarea settings-textarea';
                input.value = rawValue;
                input.addEventListener('input', () => {
                    input.style.height = 'auto';
                    input.style.height = input.scrollHeight + 'px';
                    if (field.tags?.length) _rebuildTagMarks(input, field.tags);
                    if (field.tags?.some(t => t.required)) _checkRequiredTags(input, field);
                });
                // Textarea auto-grows to scrollHeight above, so it rarely
                // scrolls internally — but if some CSS caps its height
                // anyway, the marks need to track that too, not just typing.
                input.addEventListener('scroll', () => {
                    if (field.tags?.length) _rebuildTagMarks(input, field.tags);
                });
                if (field.tags?.length) _bindTextHoverTooltip(input);
            } else {
                input = document.createElement('input');
                input.type = 'text';
                input.className = 'form-input';
                input.value = field.serialize === 'array' ? rawValue.join(', ') : rawValue;
            }

            input.dataset.section = section.key;
            input.dataset.field = field.key;
            if (field.serialize) input.dataset.serialize = field.serialize;

            group.appendChild(label);
            group.appendChild(input);
            inner.appendChild(group);

            if (field.type === 'textarea' && field.tags?.length) {
                _rebuildTagMarks(input, field.tags);
                if (field.tags.some(t => t.required)) _checkRequiredTags(input, field);
            }
        });

        body.appendChild(inner);
        block.appendChild(header);
        block.appendChild(body);
        container.appendChild(block);
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn settings-save-btn';
    saveBtn.id = 'settingsSaveBtn';
    _setSaveBtnIdle(saveBtn);
    saveBtn.addEventListener('click', saveSettings);

    // Lives in #settingsFooterRow next to the shutdown icon-button (see
    // index.html) rather than appended to the accordion itself — keeps the
    // two full-width stacked blocks from previous layout as one row instead.
    // Re-rendering the accordion (loadSettings called again) would otherwise
    // duplicate the button on repeat calls, so remove any stale one first.
    const footerRow = document.getElementById('settingsFooterRow');
    if (footerRow) {
        footerRow.querySelector('#settingsSaveBtn')?.remove();
        footerRow.prepend(saveBtn);
    } else {
        container.appendChild(saveBtn); // fallback if footer row markup is missing
    }

    // Fields with a required tag ran their validity check earlier in this
    // same render pass, before the Save button existed yet — that early
    // _updateSaveBtnState() call found no button and no-opped, so the
    // button needs one explicit pass now that it's actually in the DOM.
    _updateSaveBtnState();
}

async function saveSettings() {
    const inputs = document.querySelectorAll('#settingsAccordion [data-section]');
    const fullResult = {};
    const safeResult = {};
    let emptyFieldLabel = null;
    let brokenTagLabels = [];

    inputs.forEach(input => {
        const sec = input.dataset.section;
        const field = input.dataset.field;
        if (!fullResult[sec]) { fullResult[sec] = {}; safeResult[sec] = {}; }

        let value = input.value;
        const schema = SETTINGS_SCHEMA.find(s => s.key === sec).fields.find(f => f.key === field);

        if (schema.tags?.some(t => t.required) && !_checkRequiredTags(input, schema)) {
            brokenTagLabels.push(schema.label);
        }

        if (input.dataset.serialize === 'array') {
            value = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (schema.type === 'number') {
            if (value.trim() === '' && emptyFieldLabel === null) {
                emptyFieldLabel = schema.label;
            }
            value = Number(value);
        }

        fullResult[sec][field] = value;

        const isRestartField = RESTART_REQUIRED_FIELDS[sec]?.includes(field);
        if (!isRestartField) {
            safeResult[sec][field] = value;
        } else {
            safeResult[sec][field] = _settingsData[sec][field]; // old value
        }
    });

    if (brokenTagLabels.length) {
        showCustomAlert(`Missing a required tag in: ${brokenTagLabels.join(', ')}. Fix before saving.`);
        return;
    }

    if (emptyFieldLabel !== null) {
        showCustomAlert(`Field "${emptyFieldLabel}" is empty — fill it in or revert to the previous value.`);
        return;
    }

    // Same 5-minute floor the backend watchdog enforces (routes/system.py) —
    // catch it here too so the user finds out before saving, not after
    // their PC shuts down on them a minute after stepping away.
    const timeoutHours = fullResult.system?.INACTIVITY_TIMEOUT_HOURS;
    if (typeof timeoutHours === 'number' && timeoutHours > 0 && timeoutHours < (5 / 60)) {
        showCustomAlert('Inactivity timeout is set dangerously low (under 5 minutes) — your PC would shut down almost immediately after you stop using it. Set it to 0 to disable, or use a larger value.');
        return;
    }

    let restartNeeded = false;
    for (const [sec, fields] of Object.entries(RESTART_REQUIRED_FIELDS)) {
        for (const field of fields) {
            if (_settingsData[sec]?.[field] !== fullResult[sec]?.[field]) {
                restartNeeded = true;
                break;
            }
        }
        if (restartNeeded) break;
    }

    const btn = document.getElementById('settingsSaveBtn');
    _saveInProgress = true;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    if (!restartNeeded) {
        await _doSave(fullResult, btn);
        _saveInProgress = false;
        return;
    }

    await fetch('/save_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(safeResult)
    });

    _saveInProgress = false;
    btn.disabled = false;
    _setSaveBtnIdle(btn);

    showConfirm(
        'Settings that require a server restart were changed. Restart now?',
        async () => {
            _saveInProgress = true;
            btn.disabled = true;
            btn.textContent = 'Restarting...';
            await fetch('/save_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fullResult)
            });
            _waitForServer();
            fetch('/restart_server', { method: 'POST' }).catch(() => {});
        }
    );
}

async function _doSave(data, btn) {
    const res = await fetch('/save_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    const json = await res.json();
    if (json.success) {
        _setSaveBtnLabel(btn, 'Saved');
        btn.classList.add('save-btn-success');
        setTimeout(() => {
            _setSaveBtnIdle(btn);
            btn.classList.remove('save-btn-success');
            btn.disabled = false;
        }, 2000);
    } else {
        _setSaveBtnIdle(btn);
        btn.disabled = false;
        const problems = (json.problems || []).join(', ') || json.error || 'unknown';
        showCustomAlert('Not saved, check the values: ' + problems);
    }
}

function _waitForServer() {
    setTimeout(() => {
        const interval = setInterval(async () => {
            try {
                const res = await fetch('/ready', { cache: 'no-store' });
                if (res.ok) {
                    clearInterval(interval);
                    setTimeout(() => location.reload(), 500);
                }
            } catch {
            }
        }, 1000);
    }, 5000); 
}

// ─── Shutdown (moved from main.js — 2nd great refactoring) ────
async function shutdownPC() {
    showConfirm('<img src="/static/icons/warning.svg" alt="warning" class="btn-icon"> Shut down the PC?', async () => {
        try {
            const r = await fetch(`${BASE_URL}/shutdown_pc`, { method: 'POST' });
            const data = await r.json();
            showCustomAlert(data.success ? '<img src="/static/icons/moon.svg" alt="" class="btn-icon">Good night!' : 'Error: ' + data.error);
        } catch (e) {
            showCustomAlert('Error: ' + e);
        }
    });
}