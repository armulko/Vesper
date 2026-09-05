// static/js/personas.js

function _bindPersonaDescriptionTextarea() {
    const el = document.getElementById('personaDescription');
    if (!el || el.dataset.autoResizeBound) return;
    el.dataset.autoResizeBound = '1';
    el.addEventListener('input', () => _autoResizeTextarea(el));
    if (window.matchMedia('(max-width: 767px)').matches) {
        _bindMobileResizeHandle(el);
    }
}

document.addEventListener('DOMContentLoaded', _bindPersonaDescriptionTextarea);

let _personasCache = [];

function personaAvatarUrl(id) {
    return `/persona_avatar/${id}`;
}

function personaDefaultAvatarUrl(filename) {
    return `${BASE_URL}/default_avatar/${filename}`;
}

function personaAvatarImg(persona) {
    const src = persona.has_avatar
        ? personaAvatarUrl(persona.id)
        : personaDefaultAvatarUrl(persona.default_avatar);
    return `<img src="${src}" alt="${persona.name}">`;
}

let _pendingPersonaDefaultAvatar = null;

async function _pickAndPreviewPersonaDefaultAvatar() {
    _pendingPersonaDefaultAvatar = null;
    const preview = document.getElementById('personaImagePreview');
    try {
        const r = await fetch(`${BASE_URL}/list_default_avatars`);
        const files = await r.json();
        if (!files || files.length === 0) return;
        const chosen = files[Math.floor(Math.random() * files.length)];
        _pendingPersonaDefaultAvatar = chosen;
        if (preview) preview.innerHTML = `<img src="${personaDefaultAvatarUrl(chosen)}" alt="Persona">`;
    } catch (e) {
        console.error('Error fetching default avatars:', e);
    }
}

function handleDirectPersonaAvatarUpload(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        personaImage = e.target.result;
        const preview = document.getElementById('personaImagePreview');
        if (preview) preview.innerHTML = `<img src="${personaImage}" alt="Persona">`;
    };
    reader.readAsDataURL(file);
}

function _resetPersonaForm() {
    editingPersonaId = null;
    personaImage = null;
    document.getElementById('personaName').value = '';
    document.getElementById('personaDescription').value = '';
    document.getElementById('personaDescription').style.height = '';
    const preview = document.getElementById('personaImagePreview');
    if (preview) preview.innerHTML = '<div class="image-preview-placeholder">Choose a photo</div>';
    _pickAndPreviewPersonaDefaultAvatar();
    const saveBtn = document.querySelectorAll('.save-btn')[1];
    if (saveBtn) saveBtn.textContent = 'Save persona';
    renderPersonaConnectedCharacters(null);
}

async function fetchPersonas() {
    const r = await fetch(`${BASE_URL}/get_personas`);
    return r.json();
}

function loadPersonaList() {
    const targets = ['sidebarList', 'personaGrid'].map(id => document.getElementById(id)).filter(Boolean);
    targets.forEach(t => t.innerHTML = `<div class="grid-full-center"><div class="loader-spinner"></div></div>`);
    fetchPersonas().then(personas => {
        _personasCache = personas;
        if (personas.length === 0) {
            targets.forEach(t => t.innerHTML = '');
            return;
        }
        renderPersonaCards(_pinSelectedPersona(personas));
    }).catch(error => console.error('Error loading personas:', error));
}

function _pinSelectedPersona(personas) {
    if (!currentPersona) return personas;
    const idx = personas.findIndex(p => p.id === currentPersona.id);
    if (idx <= 0) return personas;
    const copy = personas.slice();
    const [selected] = copy.splice(idx, 1);
    copy.unshift(selected);
    return copy;
}

function selectPersona(id) {
    fetchPersonas().then(personas => {
        const persona = personas.find(p => p.id === id);
        if (!persona) return;
        currentPersona = persona;
        loadPersonaList();
        saveAppState();
        reloadChat();
    }).catch(error => console.error('Error selecting persona:', error));
}

function savePersona() {
    const name = document.getElementById('personaName').value.trim();
    const description = document.getElementById('personaDescription').value.trim();

    if (!name) { showCustomAlert('Enter the persona name'); return; }

    const persona = {
        name,
        description,
        id: editingPersonaId || Date.now()
    };

    if (personaImage && personaImage.startsWith('data:')) {
        persona.image = personaImage;
    }

    if (!editingPersonaId && _pendingPersonaDefaultAvatar) {
        persona.default_avatar = _pendingPersonaDefaultAvatar;
    }

    const url = editingPersonaId
        ? `${BASE_URL}/update_persona/${editingPersonaId}`
        : `${BASE_URL}/save_persona`;
    const method = editingPersonaId ? 'PUT' : 'POST';

    fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(persona)
    }).then(r => r.json()).then(data => {
        if (data.success) {
            document.getElementById('personaName').value = '';
            document.getElementById('personaDescription').value = '';
            document.getElementById('personaDescription').style.height = '';
            document.getElementById('personaImagePreview').innerHTML = '<div class="image-preview-placeholder">Choose a photo</div>';
            personaImage = null;
            editingPersonaId = null;
            _pickAndPreviewPersonaDefaultAvatar();

            const saveBtn = document.querySelectorAll('.save-btn')[1];
            if (saveBtn) saveBtn.textContent = 'Save persona';

            showCustomAlert(method === 'PUT' ? 'Persona updated!' : 'Persona saved!');
            switchView('loadPersona');
        }
    }).catch(error => showCustomAlert('Save error: ' + error));
}

function editPersona(id, event) {
    event.stopPropagation();
    fetchPersonas().then(personas => {
        const persona = personas.find(p => p.id === id);
        if (!persona) return;

        editingPersonaId = id;
        document.getElementById('personaName').value = persona.name;
        document.getElementById('personaDescription').value = persona.description || '';

        if (persona.has_avatar) {
            const url = personaAvatarUrl(persona.id);
            personaImage = url;
            document.getElementById('personaImagePreview').innerHTML = `<img src="${url}" alt="Persona">`;
        } else {
            personaImage = null;
            document.getElementById('personaImagePreview').innerHTML = persona.default_avatar
                ? `<img src="${personaDefaultAvatarUrl(persona.default_avatar)}" alt="Persona">`
                : '<div class="image-preview-placeholder">Choose a photo</div>';
        }

        const saveBtn = document.querySelectorAll('.save-btn')[1];
        if (saveBtn) saveBtn.textContent = 'Save changes';

        renderPersonaConnectedCharacters(id);

        switchView('createPersona');
        _autoResizeTextarea(document.getElementById('personaDescription'));
    }).catch(error => console.error('Error loading persona:', error));
}

function deletePersona(id, event) {
    event.stopPropagation();
    showConfirm('Delete this persona?', () => {
        fetch(`${BASE_URL}/delete_persona/${id}`, { method: 'DELETE' })
        .then(r => r.json()).then(data => {
            if (data.success) {
                if (currentPersona && currentPersona.id === id) currentPersona = null;
                loadPersonaList();
            } else if (data.needs_confirmation) {
                // Персона фигурирует в data.affected_chats чатах — бэкенд
                // отказался удалять без явного подтверждения (см.
                // routes/personas.py: delete_persona, ON DELETE CASCADE на
                // chats.persona_id). Второй showConfirm — явное двойное
                // подтверждение для деструктивного действия, которое унесёт
                // с собой историю переписки, не только саму персону.
                showConfirm(
                    `This persona is used in ${data.affected_chats} chat(s). Deleting it will delete those chats too. Continue?`,
                    () => {
                        fetch(`${BASE_URL}/delete_persona/${id}?force=true`, { method: 'DELETE' })
                        .then(r => r.json()).then(forced => {
                            if (forced.success) {
                                if (currentPersona && currentPersona.id === id) currentPersona = null;
                                loadPersonaList();
                            } else {
                                showCustomAlert('Delete error');
                            }
                        }).catch(e => showCustomAlert('Error: ' + e));
                    }
                );
            } else {
                showCustomAlert('Delete error');
            }
        }).catch(e => showCustomAlert('Error: ' + e));
    });
}

// ── Подключение персон к персонажам (N:N) ──────────────────────────
// Грубая первая версия: список подключённых персонажей рендерится прямо
// в форме редактирования персоны (под описанием), с кнопкой отключить.
// Подключение новой персоны к персонажу происходит из формы персонажа
// (характерс-сторона), не отсюда — см. соответствующий блок в
// characters.js/HTML, когда он появится. Здесь — только просмотр +
// отключение с текущей стороны, раз юзер уже открыл конкретную персону.

async function fetchPersonaCharacters(personaId) {
    const r = await fetch(`${BASE_URL}/persona/${personaId}/characters`);
    return r.json();
}

async function renderPersonaConnectedCharacters(personaId) {
    const container = document.getElementById('personaConnectedCharacters');
    if (!container) return; // разметки может ещё не быть в HTML — не падаем

    if (!personaId) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = '<div class="loader-spinner"></div>';
    try {
        const characters = await fetchPersonaCharacters(personaId);
        if (!characters.length) {
            container.innerHTML = '<div class="empty-state-small">Not connected to any character yet</div>';
            return;
        }
        container.innerHTML = characters.map(c => `
            <div class="connected-chip" data-character-id="${c.id}">
                <span>${c.name}</span>
                <button class="chip-remove-btn" onclick="disconnectPersonaFromCharacter(${personaId}, ${c.id})">×</button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Error loading connected characters:', e);
        container.innerHTML = '';
    }
}

function disconnectPersonaFromCharacter(personaId, characterId) {
    fetch(`${BASE_URL}/disconnect_persona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId, persona_id: personaId })
    }).then(r => r.json()).then(data => {
        if (data.success) {
            renderPersonaConnectedCharacters(personaId);
        } else {
            showCustomAlert('Disconnect error');
        }
    }).catch(e => showCustomAlert('Error: ' + e));
}

function connectPersonaToCharacter(personaId, characterId) {
    return fetch(`${BASE_URL}/connect_persona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: characterId, persona_id: personaId })
    }).then(r => r.json());
}

function renderPersonaCards(personas) {
    const targets = ['sidebarList', 'personaGrid'].map(id => document.getElementById(id)).filter(Boolean);
    if (personas.length === 0) {
        targets.forEach(t => t.innerHTML = '<div class="empty-state">Nothing found</div>');
        return;
    }
    const html = personas.map(persona => `
        <div class="character-card compact ${currentPersona && currentPersona.id === persona.id ? 'selected-persona' : ''}" data-persona-id="${persona.id}">
            <div class="character-card-clickable" onclick="selectPersona(${persona.id})">
                <div class="character-card-avatar">
                    ${personaAvatarImg(persona)}
                </div>
                <div class="character-card-name">${persona.name}</div>
                <div class="character-card-desc">
                    ${(persona.description || '').slice(0, 60)}
                </div>
            </div>
            <div class="character-actions">
                <button class="action-btn edit-btn" onclick="editPersona(${persona.id}, event)">
                    <img src="/static/icons/edit.svg" alt="edit">
                </button>
                <button class="action-btn delete-btn" onclick="deletePersona(${persona.id}, event)">
                    <img src="/static/icons/trash.svg" alt="delete">
                </button>
            </div>
        </div>
    `).join('');
    targets.forEach(t => t.innerHTML = html);
    if (typeof _staggerCardReveal === 'function') targets.forEach(_staggerCardReveal);
}

// Внутренняя функция фильтрации
function _execFilterPersonas(query) {
    const clearBtn = document.getElementById('personaSearchClear');
    if (clearBtn){ 
        clearBtn.classList.toggle('hidden', !query);
        clearBtn.classList.toggle('block', !!query);
    }
    if (!query.trim()) {
        renderPersonaCards(_personasCache);
        return;
    }
    const THRESHOLD = 0.35;
    const scored = _personasCache.map(persona => {
        const nameScore = _fuzzyScoreLayoutAware(persona.name || '', query) * 0.7;
        const descScore = _fuzzyScoreLayoutAware(persona.description || '', query) * 0.3;
        return { persona, score: nameScore + descScore };
    })
    .filter(x => x.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score);

    renderPersonaCards(scored.map(x => x.persona));
}

// Debounce для безопасного вызова
let _personaSearchTimeout = null;
function filterPersonas(query) {
    clearTimeout(_personaSearchTimeout);
    _personaSearchTimeout = setTimeout(() => {
        _execFilterPersonas(query);
    }, 120);
}

function clearPersonaSearch() {
    const input = document.getElementById('personaSearch');
    const clearBtn = document.getElementById('personaSearchClear');
    if (input) input.value = '';
    if (clearBtn) {
        clearBtn.classList.add('hidden');
        clearBtn.classList.remove('flex', 'block');
    }
    renderPersonaCards(_pinSelectedPersona(_personasCache));
}