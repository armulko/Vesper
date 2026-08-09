const RESTART_REQUIRED_FIELDS = {
    system: ['LLAMA_SERVER_URL']
};

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
            { key: "DEFAULT_SYSTEM_RULES", label: "System Rules", type: "textarea" },
            { key: "SUMMARIZE_PROMPT", label: "Summarize Prompt", type: "textarea" },
            { key: "META_SUMMARIZE_PROMPT", label: "Meta-Summarize Prompt", type: "textarea" },
            { key: "SUGGEST_SYSTEM_PROMPT", label: "Suggest Prompt", type: "textarea" }
        ]
    }
];

let _settingsData = null;

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
                });
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
}

async function saveSettings() {
    const inputs = document.querySelectorAll('#settingsAccordion [data-section]');
    const fullResult = {};
    const safeResult = {};
    let emptyFieldLabel = null;

    inputs.forEach(input => {
        const sec = input.dataset.section;
        const field = input.dataset.field;
        if (!fullResult[sec]) { fullResult[sec] = {}; safeResult[sec] = {}; }

        let value = input.value;
        const schema = SETTINGS_SCHEMA.find(s => s.key === sec).fields.find(f => f.key === field);

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
    btn.disabled = true;
    btn.textContent = 'Saving...';

    if (!restartNeeded) {
        await _doSave(fullResult, btn);
        return;
    }

    await fetch('/save_settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(safeResult)
    });

    btn.disabled = false;
    _setSaveBtnIdle(btn);

    showConfirm(
        'Settings that require a server restart were changed. Restart now?',
        async () => {
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