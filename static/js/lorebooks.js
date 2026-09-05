// static/js/lorebooks.js
// Список лорбуков + редактор (модалка) с entries. Новый файл — заменяет
// собой то, что раньше было character_book внутри карточки персонажа.

let _lorebooksCache = [];
let editingLorebookId = null;
let _lorebookEntryCounter = 0;

async function fetchLorebooks() {
    const r = await fetch(`${BASE_URL}/get_lorebooks`);
    return r.json();
}

async function fetchLorebook(id) {
    const r = await fetch(`${BASE_URL}/lorebook/${id}`);
    return r.json();
}

function loadLorebookList() {
    const container = document.getElementById('lorebookGrid');
    if (!container) return;
    container.innerHTML = '<div class="grid-full-center"><div class="loader-spinner"></div></div>';
    fetchLorebooks().then(lorebooks => {
        _lorebooksCache = lorebooks;
        renderLorebookCards(lorebooks);
    }).catch(e => {
        console.error('Error loading lorebooks:', e);
        container.innerHTML = '<div class="empty-state">Failed to load</div>';
    });
}

function renderLorebookCards(lorebooks) {
    const container = document.getElementById('lorebookGrid');
    if (!container) return;
    if (!lorebooks.length) {
        container.innerHTML = '<div class="empty-state">No lorebooks yet</div>';
        return;
    }
    container.innerHTML = lorebooks.map(lb => `
        <div class="character-card compact" data-lorebook-id="${lb.id}">
            <div class="character-card-clickable" onclick="openLorebookEditor(${lb.id})">
                <div class="character-card-name">
                    ${lb.name}
                    ${lb.is_shared ? '<span class="field-tag-muted">shared</span>' : ''}
                </div>
                <div class="character-card-desc">
                    ${lb.auto_created_for_character_id ? 'Auto-created from a character card' : 'Manually created'}
                </div>
            </div>
            <div class="character-actions">
                <button class="action-btn delete-btn" onclick="deleteLorebook(${lb.id}, event)">
                    <img src="/static/icons/trash.svg" alt="delete">
                </button>
            </div>
        </div>
    `).join('');
    if (typeof _staggerCardReveal === 'function') _staggerCardReveal(container);
}

function resetLorebookEditor() {
    editingLorebookId = null;
    document.getElementById('lorebookEditorTitle').textContent = 'New lorebook';
    document.getElementById('lorebookName').value = '';
    document.getElementById('lorebookShared').checked = false;
    document.getElementById('lorebookScanDepth').value = 4;
    document.getElementById('lorebookEntriesList').innerHTML = '';
    _updateLorebookEntriesHeader();
}

async function openLorebookEditor(id = null) {
    const modal = document.getElementById('lorebookEditorModal');
    if (!modal) return;

    if (id) {
        editingLorebookId = id;
        document.getElementById('lorebookEditorTitle').textContent = 'Edit lorebook';
        try {
            const lb = await fetchLorebook(id);
            document.getElementById('lorebookName').value = lb.name || '';
            document.getElementById('lorebookShared').checked = !!lb.is_shared;
            document.getElementById('lorebookScanDepth').value = lb.scan_depth || 4;
            const list = document.getElementById('lorebookEntriesList');
            list.innerHTML = '';
            (lb.entries || []).forEach(entry => addLorebookEntryItem(entry));
            _updateLorebookEntriesHeader();
        } catch (e) {
            showCustomAlert('Failed to load lorebook: ' + e);
            return;
        }
    } else {
        resetLorebookEditor();
    }

    modal.classList.add('active');
}

function closeLorebookEditor() {
    _closeModalAnimated(document.getElementById('lorebookEditorModal'));
}

// Каждая entry — свой мини-блок: keys (comma-separated), content, priority,
// enabled. secondary_keys/case_sensitive/position/token_budget не выведены
// в UI этой грубой версии (доступны через API, просто не редактируются
// отсюда) — хранятся as-is при round-trip если были заданы раньше (через
// data-атрибуты, не теряются молча).
function addLorebookEntryItem(entry = {}) {
    const list = document.getElementById('lorebookEntriesList');
    if (!list) return;
    const uid = `lb-entry-${_lorebookEntryCounter++}`;

    const item = document.createElement('div');
    item.className = 'lorebook-entry-item field-accordion open';
    item.dataset.entryUid = uid;
    item.dataset.secondaryKeys = entry.secondary_keys ? JSON.stringify(entry.secondary_keys) : '';
    item.dataset.caseSensitive = entry.case_sensitive ? '1' : '0';
    item.dataset.position = entry.position || 'before_char';
    item.dataset.tokenBudget = entry.token_budget != null ? entry.token_budget : '';

    item.innerHTML = `
        <div class="field-accordion-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="field-accordion-title">${(entry.keys || []).join(', ') || 'New entry'}</span>
            <button class="field-remove-btn" onclick="event.stopPropagation(); this.closest('.lorebook-entry-item').remove(); _updateLorebookEntriesHeader()">×</button>
        </div>
        <div class="field-accordion-body">
            <div class="field-accordion-body-inner">
                <label class="field-label-sm">Keys (comma-separated)</label>
                <input type="text" class="field-input lorebook-entry-keys" value="${(entry.keys || []).join(', ')}" placeholder="dragon, wyrm">
                <label class="field-label-sm">Content</label>
                <textarea class="field-textarea lorebook-entry-content" placeholder="What gets injected when a key matches…">${entry.content || ''}</textarea>
                <label class="field-label-sm">Priority <span class="field-tag-muted">higher wins the token budget first</span></label>
                <input type="number" class="field-input lorebook-entry-priority" value="${entry.priority ?? 100}">
                <label class="field-checkbox-label">
                    <input type="checkbox" class="lorebook-entry-enabled" ${entry.enabled === false ? '' : 'checked'}>
                    <span>Enabled</span>
                </label>
            </div>
        </div>`;
    list.appendChild(item);
    _updateLorebookEntriesHeader();
}

function _updateLorebookEntriesHeader() {
    const count = document.querySelectorAll('#lorebookEntriesList .lorebook-entry-item').length;
    const label = document.getElementById('lorebookEntriesLabel');
    if (label) label.textContent = `Entries (${count})`;
}

function _collectLorebookEntries() {
    return Array.from(document.querySelectorAll('#lorebookEntriesList .lorebook-entry-item')).map(item => {
        const keys = item.querySelector('.lorebook-entry-keys').value
            .split(',').map(k => k.trim()).filter(Boolean);
        const content = item.querySelector('.lorebook-entry-content').value.trim();
        const priority = parseInt(item.querySelector('.lorebook-entry-priority').value, 10) || 100;
        const enabled = item.querySelector('.lorebook-entry-enabled').checked;

        const secondaryKeysRaw = item.dataset.secondaryKeys;
        let secondary_keys = null;
        if (secondaryKeysRaw) {
            try { secondary_keys = JSON.parse(secondaryKeysRaw); } catch (e) { secondary_keys = null; }
        }
        const tokenBudgetRaw = item.dataset.tokenBudget;

        return {
            keys, content, priority, enabled,
            secondary_keys,
            case_sensitive: item.dataset.caseSensitive === '1',
            position: item.dataset.position || 'before_char',
            token_budget: tokenBudgetRaw ? parseInt(tokenBudgetRaw, 10) : null,
        };
    });
}

function saveLorebook() {
    const name = document.getElementById('lorebookName').value.trim();
    if (!name) { showCustomAlert('Enter a lorebook name'); return; }

    const payload = {
        name,
        is_shared: document.getElementById('lorebookShared').checked,
        scan_depth: parseInt(document.getElementById('lorebookScanDepth').value, 10) || 4,
        entries: _collectLorebookEntries(),
    };

    const url = editingLorebookId
        ? `${BASE_URL}/update_lorebook/${editingLorebookId}`
        : `${BASE_URL}/save_lorebook`;
    const method = editingLorebookId ? 'PUT' : 'POST';

    fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(r => r.json()).then(data => {
        if (data.success) {
            closeLorebookEditor();
            loadLorebookList();
        } else {
            showCustomAlert('Save error: ' + (data.error || 'unknown'));
        }
    }).catch(e => showCustomAlert('Error: ' + e));
}

// Удаление: спрашиваем то же "локальный неподключённый лорбук?" на
// фронте, раз бэкенд сознательно не делает эту проверку сам (см.
// routes/lorebooks.py comment — UI-уровня решение). Считаем подключения
// перед удалением и предупреждаем только если лорбук реально к чему-то
// привязан ИЛИ помечен shared — иначе тихое confirm без лишних деталей.
function deleteLorebook(id, event) {
    event.stopPropagation();
    fetch(`${BASE_URL}/lorebook/${id}/characters`).then(r => r.json()).then(characters => {
        const lb = _lorebooksCache.find(l => l.id === id);
        const usedElsewhere = (characters || []).length > 0;
        const isShared = lb?.is_shared;

        let message = 'Delete this lorebook?';
        if (usedElsewhere) {
            message = `This lorebook is connected to ${characters.length} character(s). Deleting it removes it from all of them. Continue?`;
        } else if (isShared) {
            message = 'This lorebook is marked shared but not connected to any character right now. Delete it?';
        }

        showConfirm(message, () => {
            fetch(`${BASE_URL}/delete_lorebook/${id}`, { method: 'DELETE' })
                .then(r => r.json()).then(data => {
                    if (data.success) loadLorebookList();
                    else showCustomAlert('Delete error');
                }).catch(e => showCustomAlert('Error: ' + e));
        });
    }).catch(() => {
        showConfirm('Delete this lorebook?', () => {
            fetch(`${BASE_URL}/delete_lorebook/${id}`, { method: 'DELETE' })
                .then(r => r.json()).then(data => {
                    if (data.success) loadLorebookList();
                    else showCustomAlert('Delete error');
                }).catch(e => showCustomAlert('Error: ' + e));
        });
    });
}

// ── Подключение лорбуков к персонажу ────────────────────────────────
// Симметрично connected-personas на характерс-стороне — рендерится в
// новый аккордеон в форме персонажа (см. _forms.html правку ниже).

async function fetchCharacterLorebooks(characterId) {
    const r = await fetch(`${BASE_URL}/character/${characterId}/lorebooks`);
    return r.json();
}

async function renderCharacterConnectedLorebooks(characterId) {
    const container = document.getElementById('characterConnectedLorebooks');
    const select = document.getElementById('connectLorebookSelect');
    if (!container) return;

    if (!characterId) {
        container.innerHTML = '';
        if (select) select.innerHTML = '';
        return;
    }

    container.innerHTML = '<div class="loader-spinner"></div>';
    try {
        const [connected, allLorebooks] = await Promise.all([
            fetchCharacterLorebooks(characterId),
            fetchLorebooks()
        ]);

        if (!connected.length) {
            container.innerHTML = '<div class="empty-state-small">No lorebooks connected yet</div>';
        } else {
            container.innerHTML = connected.map(lb => `
                <div class="connected-chip" data-lorebook-id="${lb.id}">
                    <span>${lb.name}</span>
                    <button class="chip-remove-btn" onclick="disconnectCharacterFromLorebook(${characterId}, ${lb.id})">×</button>
                </div>
            `).join('');
        }

        if (select) {
            const connectedIds = new Set(connected.map(lb => lb.id));
            const selectable = allLorebooks.filter(lb => !connectedIds.has(lb.id));
            select.innerHTML = selectable.length
                ? selectable.map(lb => `<option value="${lb.id}">${lb.name}${lb.is_shared ? ' (shared)' : ''}</option>`).join('')
                : '<option value="" disabled selected>No more lorebooks to connect</option>';
        }
    } catch (e) {
        console.error('Error loading connected lorebooks:', e);
        container.innerHTML = '';
    }
}

function disconnectCharacterFromLorebook(characterId, lorebookId) {
    fetch(`${BASE_URL}/disconnect_lorebook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId, lorebook_id: lorebookId })
    }).then(r => r.json()).then(data => {
        if (data.success) renderCharacterConnectedLorebooks(characterId);
        else showCustomAlert('Disconnect error');
    }).catch(e => showCustomAlert('Error: ' + e));
}

function connectLorebookToCurrentCharacter() {
    if (!editingCharacterId) {
        showCustomAlert('Save the character first, then connect lorebooks to it.');
        return;
    }
    const select = document.getElementById('connectLorebookSelect');
    const lorebookId = select ? parseInt(select.value, 10) : null;
    if (!lorebookId) return;

    fetch(`${BASE_URL}/connect_lorebook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: editingCharacterId, lorebook_id: lorebookId })
    }).then(r => r.json()).then(data => {
        if (data.success) renderCharacterConnectedLorebooks(editingCharacterId);
        else showCustomAlert('Connect error');
    }).catch(e => showCustomAlert('Error: ' + e));
}
