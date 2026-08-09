// modelManager.js
// Model loading, switching, and per-model config modal.
// Split out of main.js (2nd great refactoring).

function showModelLoader(show) {
    let loader = document.getElementById('modelSwitchLoader');
    if (show && !loader) {
        loader = document.createElement('div');
        loader.id = 'modelSwitchLoader';
        loader.className = 'model-switch-loader';
        loader.innerHTML = `
            <div class="loader-content">
                <div class="loader-spinner"></div>
                <div class="loader-text">PLEASE WAIT</div>
            </div>
        `;
        document.body.appendChild(loader);
    } else if (!show && loader) {
        loader.remove();
    }
}

function updateModelUI() {
    const sendBtn = document.getElementById('sendBtn');
    const userInput = document.getElementById('userInput');
    if (!sendBtn || !userInput) return;
    const isLlm = isLlmLoaded === true;
    sendBtn.disabled = !isLlm;
    userInput.disabled = !isLlm;
    userInput.placeholder = isLlm
        ? (currentCharacter ? `Write to ${currentCharacter.data.name}…` : 'Write a message…')
        : 'LLM not loaded — select a model in settings';
}

async function loadCurrentModel() {
    try {
        const res = await fetch(`${BASE_URL}/get_model_type`);
        const data = await res.json();
        isLlmLoaded = data.llm_loaded;
        isSdLoaded = data.sd_loaded;
        updateModelUI();
    } catch {}
}

async function loadModelManager() {
    try {
        const res = await fetch(`${BASE_URL}/get_models`);
        const data = await res.json();
        renderModelCards('llmCards', data.models.filter(m => m.type === 'llm'), data.selected_llm, 'llm');
        renderModelCards('sdCards', data.models.filter(m => m.type === 'sd'), data.selected_sd, 'sd');
    } catch (e) {
        console.error('loadModelManager error', e);
    }
}

function renderModelCards(containerId, models, selectedFilename, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const noneCard = document.createElement('div');
    noneCard.className = 'model-card model-card-none' + (!selectedFilename ? ' selected' : '');
    noneCard.innerHTML = `
        <div class="model-card-icon"><svg width="12" height="12" viewBox="0 0 14 14"><use href="#icon-close"/></svg></div>
        <div class="model-card-body">
            <div class="model-card-name">None</div>
            <div class="model-card-meta">Unload model</div>
        </div>
    `;
    noneCard.onclick = () => confirmSelectModel(null, type);
    container.appendChild(noneCard);

    const iconSrc = type === 'llm' ? '/static/icons/chat.svg' : '/static/icons/image.svg';

    models.forEach(m => {
        const isSelected = m.filename === selectedFilename;
        const card = document.createElement('div');
        // "loaded" no longer drives its own border/glow (see components.css) —
        // still tracked as a class in case future logic needs to key off it,
        // but "selected" is now the only badge/visual state shown.
        card.className = 'model-card' + (isSelected ? ' selected' : '') + (m.loaded ? ' loaded' : '');
        card.innerHTML = `
            <div class="model-card-icon"><img src="${iconSrc}" alt=""></div>
            <div class="model-card-body">
                <div class="model-card-name">${m.filename}</div>
                <div class="model-card-meta">${m.size_gb} GB${isSelected ? '<span class="model-card-badge badge-selected">selected</span>' : ''}</div>
            </div>
            <button class="model-card-cfg-btn" title="Settings" onclick="event.stopPropagation(); openModelConfig('${m.filename}', '${type}')">
                <img src="/static/icons/settings.svg" alt="">
            </button>
        `;
        card.onclick = () => confirmSelectModel(m.filename, type);
        container.appendChild(card);
    });
}

async function confirmSelectModel(filename, type) {
    if (!filename) {
        showConfirm(`Switch ${type.toUpperCase()} to: None?`, async () => {
            await _doSelectModel(filename, type, false);
        });
        return;
    }

    showModelLoader(true);
    let checkData;
    try {
        const res = await fetch(`${BASE_URL}/check_model_cfg/${encodeURIComponent(filename)}?type=${type}`);
        checkData = await res.json();
    } catch (e) {
        showModelLoader(false);
        showCustomAlert('Error checking config: ' + e);
        return;
    }
    showModelLoader(false);

    if (checkData.valid) {
        showConfirm(`Switch ${type.toUpperCase()} to: ${filename}?`, async () => {
            await _doSelectModel(filename, type, false);
        });
        return;
    }
    openModelConfigWithAutodetect(filename, type, checkData);
}

function openModelConfigWithAutodetect(filename, type, checkData) {
    _modelConfigFilename = filename;
    _modelConfigPendingSwitch = { filename, type }; 

    document.getElementById('modelConfigTitle').textContent = filename;

    const warnIcon = '<img src="/static/icons/warning.svg" alt="warning" class="btn-icon">';
    const reasonText = checkData.reason === 'missing_config'
        ? `${warnIcon} There is no config for this model yet. Settings were picked automatically — check before loading.`
        : `${warnIcon} Model config is corrupted or incomplete. Settings were restored automatically — check before loading.`;

    let warningsHtml = '';
    if (checkData.warnings && checkData.warnings.length) {
        warningsHtml = `<div style="margin-top:6px; font-size:0.75rem; opacity:0.8">${checkData.warnings.join('<br>')}</div>`;
    }

    document.getElementById('modelConfigFields').innerHTML = `
        <div class="model-config-warning" style="padding:8px; margin-bottom:10px; border:1px solid rgba(255,180,0,0.4); border-radius:6px; background:rgba(255,180,0,0.08)">
            ${reasonText}${warningsHtml}
        </div>
    `;
    document.getElementById('modelConfigModal').classList.add('active');

    const suggested = checkData.suggested_cfg || (type === 'llm' ? _LLM_DEFAULTS : _SD_DEFAULTS);
    console.log(JSON.stringify(checkData.suggested_cfg.chat_template.system_start));
    renderModelConfigFields(suggested, type);

    const btn = document.getElementById('modelConfigSaveBtn');
    if (btn) btn.textContent = 'Save & Load';
}

async function _doSelectModel(filename, type, force) {
    if (isModelSwitching) return;
    isModelSwitching = true;
    showModelLoader(true);
    try {
        const body = filename
            ? { filename, force }
            : { filename: type === 'llm' ? 'none_llm' : 'none_sd', force };

        const res = await fetch(`${BASE_URL}/select_model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (data.vram_warning) {
            isModelSwitching = false;
            showModelLoader(false);
            showConfirm(
                `<img src="/static/icons/warning.svg" alt="warning" class="btn-icon"> Not enough VRAM: need ${data.required_gb} GB, ${data.free_gb} GB free. Load anyway?`,
                async () => { await _doSelectModel(filename, type, true); }
            );
            return;
        }

        if (!data.success) {
            showCustomAlert('Error: ' + (data.error || 'unknown'));
            return;
        }

        await loadCurrentModel();
        await loadModelManager();
    } catch (e) {
        showCustomAlert('Error: ' + e);
    } finally {
        isModelSwitching = false;
        showModelLoader(false);
    }
}


async function openModelConfig(filename, type) {
    _modelConfigFilename = filename;
    _modelConfigPendingSwitch = null; // regular open via the gear icon — no need to switch
    document.getElementById('modelConfigTitle').textContent = filename;
    document.getElementById('modelConfigFields').innerHTML = '<div style="opacity:0.5">Loading…</div>';
    document.getElementById('modelConfigModal').classList.add('active');

    const btn = document.getElementById('modelConfigSaveBtn');
    if (btn) btn.textContent = 'Save';

    try {
        const res = await fetch(`${BASE_URL}/get_model_config/${encodeURIComponent(filename)}`);
        const cfg = await res.json();
        renderModelConfigFields(cfg, type);
    } catch (e) {
        document.getElementById('modelConfigFields').innerHTML = '<div>Loading error</div>';
    }
}

function closeModelConfig() {
    document.getElementById('modelConfigModal').classList.remove('active');
    _modelConfigFilename = null;
    _modelConfigPendingSwitch = null;
}

const _LLM_FIELDS = [
    { key: 'context_size',           label: 'Context size',           type: 'number' },
    { key: 'max_answer_tokens',      label: 'Max answer tokens',      type: 'number' },
    { key: 'gpu_layers',             label: 'GPU layers (-1 = all)',   type: 'number' },
    { key: 'cpu_threads',            label: 'CPU threads',             type: 'number' },
    { key: 'batch_size',             label: 'Batch size',              type: 'number' },
    { key: 'generation_timeout',     label: 'Generation timeout (s)',  type: 'number' },
    { key: 'lock_acquire_timeout',   label: 'Lock acquire timeout (s)',type: 'number' },
    { key: 'tokenize_timeout',       label: 'Tokenize timeout (s)',    type: 'number' },
    { key: 'summarize_n_predict',    label: 'Summarize n_predict',     type: 'number' },
    { key: 'summarize_temperature',  label: 'Summarize temperature',   type: 'number', step: '0.01' },
];

const _LLM_TEMPLATE_FIELDS = [
    { key: 'prompt_template', label: 'Prompt template', type: 'textarea' },
    { key: 'system_start',    label: 'System start',    type: 'textarea' },
    { key: 'system_end',      label: 'System end',      type: 'textarea' },
    { key: 'inst_start',      label: 'Inst start',      type: 'textarea' },
    { key: 'inst_end',        label: 'Inst end',         type: 'textarea' },
    { key: 'stop_tokens',     label: 'Stop tokens (JSON array)', type: 'text' },
];

const _SD_FIELDS = [
    { key: 'image_height',          label: 'Height',                type: 'number' },
    { key: 'image_width',           label: 'Width',                 type: 'number' },
    { key: 'guidance_scale',        label: 'Guidance scale',        type: 'number', step: '0.1' },
    { key: 'avatar_steps',          label: 'Avatar steps',          type: 'number' },
    { key: 'avatar_base_prompt',    label: 'Base prompt',           type: 'textarea' },
    { key: 'avatar_portrait_prompt',label: 'Portrait prompt',       type: 'textarea' },
    { key: 'avatar_fullbody_prompt',label: 'Fullbody prompt',       type: 'textarea' },
];

function renderModelConfigFields(cfg, type) {
    const container = document.getElementById('modelConfigFields');
    container.innerHTML = '';

    const fields = type === 'llm' ? _LLM_FIELDS : _SD_FIELDS;

    fields.forEach(f => {
        const val = cfg[f.key] ?? '';
        container.insertAdjacentHTML('beforeend', `
            <div style="margin-bottom:6px">
                <label style="font-size:0.78rem; opacity:0.6; display:block; margin-bottom:2px">${f.label}</label>
                ${f.type === 'textarea'
                    ? `<textarea class="form-textarea" data-cfg-key="${f.key}" style="min-height:60px">${val}</textarea>`
                    : `<input class="form-input" type="${f.type === 'number' ? 'number' : 'text'}"
                        ${f.step ? `step="${f.step}"` : ''}
                        data-cfg-key="${f.key}" value="${val}">`
                }
            </div>
        `);
        const el = container.querySelector(`[data-cfg-key="${f.key}"]`);
        if (el) el.addEventListener('input', () => el.classList.remove('cfg-field-error'));
    });

    // chat_template for LLM — as a separate block
    if (type === 'llm' && cfg.chat_template) {
        container.insertAdjacentHTML('beforeend', `
            <div class="cfg-section-heading">Chat template</div>
        `);
        const tmpl = cfg.chat_template;
        _LLM_TEMPLATE_FIELDS.forEach(f => {
            let raw = tmpl[f.key] ?? [];
            if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = []; } }
            let val = f.key === 'stop_tokens' ? JSON.stringify(raw) : (tmpl[f.key] ?? '');
            container.insertAdjacentHTML('beforeend', `
                <div style="margin-bottom:6px">
                    <label style="font-size:0.78rem; opacity:0.6; display:block; margin-bottom:2px">${f.label}</label>
                    ${f.type === 'textarea'
                        ? `<textarea class="form-textarea" data-cfg-tmpl-key="${f.key}" style="min-height:24px; overflow:hidden; resize:none"></textarea>`
                        : `<input class="form-input" type="text" data-cfg-tmpl-key="${f.key}">`
                    }
                </div>
            `);
            const inserted = container.querySelector(`[data-cfg-tmpl-key="${f.key}"]`);
            if (inserted) {
                inserted.value = val;
                inserted.addEventListener('input', () => inserted.classList.remove('cfg-field-error'));
                if (f.type === 'textarea') {
                    const resize = () => {
                        inserted.style.height = 'auto';
                        inserted.style.height = inserted.scrollHeight + 'px';
                    };
                    // wait for an actual layout pass, otherwise scrollHeight on a just-inserted
                    // element can be computed before styles/min-height apply and clip the trailing \n
                    requestAnimationFrame(() => requestAnimationFrame(resize));
                    inserted.addEventListener('input', resize);
                }
            }
        });
    }
}

async function saveModelConfig() {
    if (!_modelConfigFilename) return;
    const container = document.getElementById('modelConfigFields');
    const cfg = {};

    _clearFieldErrors(container);

    container.querySelectorAll('[data-cfg-key]').forEach(el => {
        const key = el.dataset.cfgKey;
        const raw = el.value;
        cfg[key] = el.type === 'number' ? Number(raw) : raw;
    });

    // chat_template
    const tmplFields = container.querySelectorAll('[data-cfg-tmpl-key]');
    if (tmplFields.length) {
        cfg.chat_template = {};
        tmplFields.forEach(el => {
            const key = el.dataset.cfgTmplKey;
            if (key === 'stop_tokens') {
                try { cfg.chat_template[key] = JSON.parse(el.value); }
                catch { cfg.chat_template[key] = []; }
            } else {
                cfg.chat_template[key] = el.value;
            }
        });
    }

    const btn = document.getElementById('modelConfigSaveBtn');
    const pending = _modelConfigPendingSwitch; // keep it until closeModelConfig() resets it
    const cfgType = pending ? pending.type : 'llm';
    btn.textContent = 'Saving…';
    try {
        const res = await fetch(`${BASE_URL}/save_model_config/${encodeURIComponent(_modelConfigFilename)}?type=${cfgType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const data = await res.json();
        if (!data.success) {
            btn.textContent = 'Save';
            const count = _highlightInvalidFields(container, data.problems || []);
            if (count === 0) {
                showCustomAlert('Invalid config: ' + (data.error || 'unknown'));
            }
            return;
        }
        if (data.success) {
            btn.innerHTML = 'Saved <svg width="11" height="11" viewBox="0 0 14 14"><use href="#icon-check"/></svg>';
            setTimeout(async () => {
                btn.textContent = 'Save';
                closeModelConfig();
                if (pending) {
                    // config confirmed by the user — now the model can be loaded
                    await _doSelectModel(pending.filename, pending.type, false);
                }
            }, 800);
        } else {
            showCustomAlert('Save error');
            btn.textContent = 'Save';
        }
    } catch (e) {
        showCustomAlert('Error: ' + e);
        btn.textContent = 'Save';
    }
}

// clears the error highlight on all config fields (call when opening the modal and before a new save)
function _clearFieldErrors(container) {
    container.querySelectorAll('.cfg-field-error').forEach(el => el.classList.remove('cfg-field-error'));
    container.querySelectorAll('.cfg-field-hint').forEach(el => el.remove());
}

// human-readable description of the problem by code ("out_of_range", "missing", "empty_string", ...)
function _problemHint(code, key) {
    const map = {
        missing: 'This field is required',
        bad_type: 'Wrong value type — make sure you enter a number where a number is expected',
        out_of_range: 'Value is out of the allowed range',
        not_finite: 'Invalid number (NaN/Infinity) — enter a proper value',
        empty_string: 'Field cannot be empty',
        empty_list: 'List is empty — add at least one value',
        bad_list_items: 'The list contains empty or invalid items',
        empty_config: 'Config is empty',
    };
    return map[code] || `Invalid value (${code})`;
}

// parses problems like "out_of_range:batch_size" / "chat_template.empty_string:system_start" /
// "missing:context_size" / "chat_template.missing:stop_tokens", highlights the corresponding inputs,
// adds an error text below them and scrolls to the first invalid field.
// Returns the number of fields actually found and highlighted.
function _highlightInvalidFields(container, problems) {
    let highlighted = 0;
    let firstEl = null;

    problems.forEach(p => {
        const isTmpl = p.startsWith('chat_template.');
        const body = isTmpl ? p.slice('chat_template.'.length) : p;
        const [code, key] = body.includes(':') ? body.split(':') : [body, null];
        if (!key) return;

        const selector = isTmpl ? `[data-cfg-tmpl-key="${key}"]` : `[data-cfg-key="${key}"]`;
        const el = container.querySelector(selector);
        if (!el) return;

        if (!el.classList.contains('cfg-field-error')) {
            el.classList.add('cfg-field-error');
            highlighted++;
        }

        const hint = document.createElement('div');
        hint.className = 'cfg-field-hint';
        hint.textContent = _problemHint(code, key);
        el.insertAdjacentElement('afterend', hint);

        if (!firstEl) firstEl = el;
    });

    if (firstEl) {
        firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstEl.focus({ preventScroll: true });
    }

    return highlighted;
}