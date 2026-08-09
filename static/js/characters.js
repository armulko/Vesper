// static/js/characters.js

let _charactersCache = [];

function defaultAvatarUrl(filename) {
    return `${BASE_URL}/default_avatar/${filename}`;
}

let _pendingDefaultAvatar = null;

async function _pickAndPreviewDefaultAvatar() {
    _pendingDefaultAvatar = null;
    const preview = document.getElementById('imagePreview');
    try {
        const r = await fetch(`${BASE_URL}/list_default_avatars`);
        const files = await r.json();
        if (!files || files.length === 0) return;
        const chosen = files[Math.floor(Math.random() * files.length)];
        _pendingDefaultAvatar = chosen;
        if (preview) preview.innerHTML = `<img src="${defaultAvatarUrl(chosen)}" alt="Character">`;
    } catch (e) {
        console.error('Error fetching default avatars:', e);
    }
}

async function fetchCharacters() {
    const r = await fetch(`${BASE_URL}/get_characters`);
    return r.json();
}

async function fetchCharacterHistory(id) {
    const r = await fetch(`${BASE_URL}/get_chat_history/${id}`);
    return r.json();
}

function avatarUrl(id) {
    const char = _charactersCache.find(c => c.vesper?.id === id) || currentCharacter;
    const bust = char?.vesper?._avatarBust ? `?t=${char.vesper._avatarBust}` : '';
    return `${BASE_URL}/character_avatar/${id}${bust}`;
}

function characterAvatarImg(char) {
    const src = char.vesper?.has_avatar
        ? avatarUrl(char.vesper.id)
        : defaultAvatarUrl(char.vesper?.default_avatar);
    return `<img src="${src}" alt="${char.data.name}">`;
}

function loadCharacterList() {
    const targets = ['sidebarList', 'characterGrid'].map(id => document.getElementById(id)).filter(Boolean);
    targets.forEach(t => t.innerHTML = `<div class="grid-full-center"><div class="loader-spinner"></div></div>`);
    fetchCharacters().then(characters => {
        _charactersCache = characters;
        targets.forEach(t => t.innerHTML = '');
        if (characters.length > 0) renderCharacterCards(_pinSelectedCharacter(characters));
    });
}

function _pinSelectedCharacter(characters) {
    if (!currentCharacter) return characters;
    const selId = currentCharacter.vesper?.id;
    const idx = characters.findIndex(c => c.vesper?.id === selId);
    if (idx <= 0) return characters;
    const copy = characters.slice();
    const [selected] = copy.splice(idx, 1);
    copy.unshift(selected);
    return copy;
}

function _buildGreetingMessage(character, persona) {
    const rawVersions = [
        character.data.first_mes,
        ...(character.data.alternate_greetings || [])
    ].filter(t => t && t.trim());

    if (rawVersions.length === 0) return null;

    const personaName = persona ? persona.name : 'User';
    const fillPlaceholders = (t) => t
        .replace(/\{\{char\}\}/g, character.data.name)
        .replace(/\{\{user\}\}/g, personaName)
        .replace(/{char}/g, character.data.name)
        .replace(/{user}/g, personaName);

    const versions = rawVersions.map(fillPlaceholders);

    return {
        text: versions[0],
        isUser: false,
        versions,
        rawVersions,
        activeVersion: 0
    };
}

function loadCharacter(id, restoreView = 'chat') {
    const emptyState = document.getElementById('chatEmptyState');
    if (emptyState) emptyState.innerHTML = '';
    if (typeof _flushDraft === 'function') _flushDraft();
    Promise.all([fetchCharacters(), fetchCharacterHistory(id)]).then(([characters, history]) => {
        const character = characters.find(c => c.vesper?.id === id);
        if (!character) return;

        currentCharacter = character;
        chatHistory = history || [];
        if (typeof loadDraftIntoInput === 'function') loadDraftIntoInput();

        const chatCharAvatar = document.getElementById('chatCharAvatar');
        const chatCharName = document.getElementById('chatCharName');
        if (chatCharName) chatCharName.textContent = character.data.name;
        if (userInput) userInput.placeholder = `Write to ${character.data.name}…`;
        if (chatCharAvatar) {
            const src = character.has_avatar
                ? avatarUrl(character.vesper.id)
                : defaultAvatarUrl(character.vesper?.default_avatar);
            chatCharAvatar.innerHTML = `<img src="${src}" alt="${character.data.name}">`;
            chatCharAvatar.onclick = () => openAvatarModal(src);
        }

        const clearBtn = document.getElementById('clearHistoryBtn');
        if (clearBtn){ 
            clearBtn.classList.remove('hidden');
            clearBtn.classList.add('flex');
        }

        const chatMessages = document.getElementById('chatMessagesInner');
        chatMessages.innerHTML = '';

        if (chatHistory.length > 0) {
            const firstMsg = chatHistory[0];
            if (firstMsg && !firstMsg.isUser) {
                const personaName = currentPersona ? currentPersona.name : 'User';
                const fillPlaceholders = (t) => t
                    .replace(/\{\{char\}\}/g, character.data.name)
                    .replace(/\{\{user\}\}/g, personaName)
                    .replace(/{char}/g, character.data.name)
                    .replace(/{user}/g, personaName);

                if (firstMsg.versions?.length) {
                    firstMsg.versions = firstMsg.rawVersions.map(fillPlaceholders);
                    firstMsg.text = firstMsg.versions[firstMsg.activeVersion] ?? firstMsg.versions[0];
                } else if (chatHistory.length === 1 && (character.data.alternate_greetings || []).length > 0) {
                    const rawVersions = [
                        character.data.first_mes,
                        ...(character.data.alternate_greetings || [])
                    ].filter(t => t && t.trim());
                    const versions = rawVersions.map(fillPlaceholders);
                    const matchedIndex = versions.indexOf(firstMsg.text);
                    firstMsg.versions = versions;
                    firstMsg.rawVersions = rawVersions;
                    firstMsg.activeVersion = matchedIndex >= 0 ? matchedIndex : 0;
                    firstMsg.text = versions[firstMsg.activeVersion];
                } else if (character.data.first_mes) {
                    firstMsg.text = fillPlaceholders(character.data.first_mes);
                }
                saveChatHistory();
            }
            chatHistory.forEach((msg, index) => {
                addMessage(msg.text, msg.isUser, index);
            });
        } else {
            const greetingMsg = _buildGreetingMessage(character, currentPersona);
            if (greetingMsg) {
                addMessage(greetingMsg.text, false, 0);
                chatHistory.push(greetingMsg);
                saveChatHistory();
            }
        }

        loadCharacterList();
        updateSummaryBrowserBtn();
        loadCharacterNotes(id);
        switchView(restoreView);
        updateTokenCount();
        saveAppState();

    }).catch(error => {
        console.error('Error loading character:', error);
        showCustomAlert('Load error: ' + error);
    });
}

function _openEditorAvatarModal(containerId) {
    const container = document.getElementById(containerId);
    const img = container?.querySelector('img');
    if (!img) return;
    openAvatarModal(img.src);
}

function handleDirectAvatarUpload(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        characterImage = e.target.result;
        const preview = document.getElementById('imagePreview');
        if (preview) preview.innerHTML = `<img src="${characterImage}" alt="Character">`;
        if (typeof _validateSaveBtn === 'function') _validateSaveBtn();
    };
    reader.readAsDataURL(file);
}

function saveCharacter() {
    const name = document.getElementById('characterName').value.trim();
    const description = document.getElementById('characterDescription').value.trim();
    const first_mes = document.getElementById('characterFirstMes').value.trim();

    if (!name) { showCustomAlert('Enter the character name'); return; }
    if (!description) { showCustomAlert('Enter the character description'); return; }
    if (!first_mes) { showCustomAlert('Enter the first message'); return; }

    const charId = editingCharacterId || Date.now();
    const character = {
        vesper: {
            id: charId,
            has_avatar: !!(editingCharacterId ? (currentCharacter?.vesper?.has_avatar || characterImage) : characterImage),
            ...(editingCharacterId ? {} : (_pendingDefaultAvatar ? { default_avatar: _pendingDefaultAvatar } : {}))
        },
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality:              document.getElementById('characterPersonality')?.value.trim() || '',
            scenario:                 document.getElementById('characterScenario')?.value.trim() || '',
            first_mes,
            mes_example:              document.getElementById('characterMesExample')?.value.trim() || '',
            creator_notes:            document.getElementById('characterCreatorNotes')?.value.trim() || '',
            system_prompt:            document.getElementById('characterSystemPrompt')?.value.trim() || '',
            post_history_instructions: document.getElementById('characterPostHistory')?.value.trim() || '',
            alternate_greetings:      _collectAlternateGreetings(),
            character_book:           _collectCharacterBook(),
            tags:                     (document.getElementById('characterTags')?.value || '').split(',').map(t => t.trim()).filter(Boolean),
            creator:                  document.getElementById('characterCreator')?.value.trim() || '',
            character_version:        document.getElementById('characterVersion')?.value.trim() || '',
            extensions:               _collectExtensions()
        },
        image: characterImage,
        id: charId,
    };

    const url = editingCharacterId
        ? `${BASE_URL}/update_character/${editingCharacterId}`
        : `${BASE_URL}/save_character`;
    const method = editingCharacterId ? 'PUT' : 'POST';

    fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(character)
    }).then(r => r.json()).then(data => {
        if (data.success) {
            if (editingCharacterId && currentCharacter?.id === editingCharacterId) {
                currentCharacter = { ...currentCharacter };
                currentCharacter.data.name = name;
                currentCharacter.data.description = description;
                currentCharacter.data.first_mes = first_mes;
                if (characterImage) {
                    currentCharacter.vesper.has_avatar = true;
                    currentCharacter.vesper._avatarBust = Date.now();
                }
                const chatCharNameEl = document.getElementById('chatCharName');
                if (chatCharNameEl) chatCharNameEl.textContent = name;
            }
            document.getElementById('characterName').value = '';
            document.getElementById('characterDescription').value = '';
            document.getElementById('characterFirstMes').value = '';
            const optFields = ['characterPersonality','characterScenario','characterMesExample','characterCreatorNotes','characterSystemPrompt','characterPostHistory','characterTags','characterCreator','characterVersion','characterExtensions'];
            optFields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            _renderAlternateGreetings([]);
            _renderCharacterBook({ entries: [] });
            _collapseAllAccordions();
            document.getElementById('imagePreview').innerHTML = '<div class="image-preview-placeholder">Choose a photo</div>';
            characterImage = null;
            editingCharacterId = null;
            _pickAndPreviewDefaultAvatar();
            document.querySelector('.save-btn').textContent = 'Save character';
            showCustomAlert(method === 'PUT' ? 'Character updated!' : 'Character saved!');

            const isDesktop = window.matchMedia('(min-width: 768px)').matches;
            if (isDesktop) {
                loadCharacter(charId, 'chat');
            } else {
                switchView('load');
            }
        }
    }).catch(error => showCustomAlert('Save error: ' + error));
}

async function _importCharacterFromPng(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    let result;
    try {
        const r = await fetch(`${BASE_URL}/import_character_png`, { method: 'POST', body: formData });
        result = await r.json();
    } catch (e) {
        showCustomAlert('Import failed: ' + e);
        return;
    }
    if (!result.success) {
        showCustomAlert('Import failed: ' + (result.error || 'unknown error'));
        return;
    }

    const data = result.data;
    editingCharacterId = null;
    if (typeof _resetTokenCache === 'function') _resetTokenCache();

    document.getElementById('characterName').value = data.name || '';
    document.getElementById('characterDescription').value = data.description || '';
    document.getElementById('characterFirstMes').value = data.first_mes || '';
    document.getElementById('characterPersonality').value = data.personality || '';
    document.getElementById('characterScenario').value = data.scenario || '';
    document.getElementById('characterMesExample').value = data.mes_example || '';
    document.getElementById('characterCreatorNotes').value = data.creator_notes || '';
    document.getElementById('characterSystemPrompt').value = data.system_prompt || '';
    document.getElementById('characterPostHistory').value = data.post_history_instructions || '';
    ['characterDescription', 'characterFirstMes']
        .forEach(id => _autoResizeTextarea(document.getElementById(id)));
    document.getElementById('characterTags').value = (data.tags || []).join(', ');
    document.getElementById('characterCreator').value = data.creator || '';
    document.getElementById('characterVersion').value = data.character_version || '';
    _renderAlternateGreetings(data.alternate_greetings || []);
    _renderCharacterBook(data.character_book || { entries: [] });
    _renderExtensions(data.extensions || {});
    _autoExpandFilledAccordions(data);
    ['characterPersonality', 'characterScenario', 'characterMesExample',
     'characterSystemPrompt', 'characterPostHistory', 'characterCreatorNotes']
        .forEach(id => _autoResizeTextarea(document.getElementById(id)));
    if (typeof _updateTotalTokens === 'function') _updateTotalTokens();
    Object.entries({
        characterDescription: 'desc-tok', characterFirstMes: 'firstmes-tok',
        characterPersonality: 'personality-tok', characterScenario: 'scenario-tok',
        characterMesExample: 'mesexample-tok', characterSystemPrompt: 'sysprompt-tok',
        characterPostHistory: 'posthist-tok', characterCreatorNotes: 'creatornotes-tok'
    }).forEach(([fieldId, tokTarget]) => {
        const el = document.getElementById(fieldId);
        if (el && el.value && typeof _onFieldInput === 'function') _onFieldInput(el, tokTarget);
    });

    characterImage = result.image || null;
    const preview = document.getElementById('imagePreview');
    if (preview) {
        preview.innerHTML = characterImage
            ? `<img src="${characterImage}" alt="Character">`
            : '<div class="image-preview-placeholder">Choose a photo</div>';
    }

    if (typeof _validateSaveBtn === 'function') _validateSaveBtn();
    const saveBtn = document.querySelector('.save-btn');
    if (saveBtn) saveBtn.textContent = 'Save character';
}

function editCharacter(id, event) {
    event.stopPropagation();
    fetchCharacters().then(characters => {
        const character = characters.find(c => c.vesper?.id === id);
        if (!character) return;

        editingCharacterId = id;
        if (typeof _resetTokenCache === 'function') _resetTokenCache();
        document.getElementById('characterName').value = character.data.name;
        document.getElementById('characterDescription').value = character.data.description || '';
        document.getElementById('characterFirstMes').value = character.data.first_mes || '';
        document.getElementById('characterPersonality').value = character.data.personality || '';
        document.getElementById('characterScenario').value = character.data.scenario || '';
        document.getElementById('characterMesExample').value = character.data.mes_example || '';
        document.getElementById('characterCreatorNotes').value = character.data.creator_notes || '';
        document.getElementById('characterSystemPrompt').value = character.data.system_prompt || '';
        document.getElementById('characterPostHistory').value = character.data.post_history_instructions || '';
        document.getElementById('characterTags').value = (character.data.tags || []).join(', ');
        document.getElementById('characterCreator').value = character.data.creator || '';
        document.getElementById('characterVersion').value = character.data.character_version || '';
        _renderAlternateGreetings(character.data.alternate_greetings || []);
        _renderCharacterBook(character.data.character_book || { entries: [] });
        _renderExtensions(character.data.extensions || {});
        _autoExpandFilledAccordions(character.data);
        if (typeof _updateTotalTokens === 'function') _updateTotalTokens();
        
        Object.entries({
            characterDescription: 'desc-tok', characterFirstMes: 'firstmes-tok',
            characterPersonality: 'personality-tok', characterScenario: 'scenario-tok',
            characterMesExample: 'mesexample-tok', characterSystemPrompt: 'sysprompt-tok',
            characterPostHistory: 'posthist-tok', characterCreatorNotes: 'creatornotes-tok'
        }).forEach(([fieldId, tokTarget]) => {
            const el = document.getElementById(fieldId);
            if (el && el.value && typeof _onFieldInput === 'function') _onFieldInput(el, tokTarget);
        });

        if (character.vesper?.has_avatar) {
            characterImage = null; 
            document.getElementById('imagePreview').innerHTML = `<img src="${avatarUrl(id)}?t=${Date.now()}" alt="Character">`;
        } else {
            characterImage = null;
            document.getElementById('imagePreview').innerHTML = character.vesper?.default_avatar
                ? `<img src="${defaultAvatarUrl(character.vesper.default_avatar)}" alt="Character">`
                : '<div class="image-preview-placeholder">Choose a photo</div>';
        }

        document.querySelector('.save-btn').textContent = 'Save changes';
        switchView('create');

        ['characterDescription', 'characterFirstMes',
         'characterPersonality', 'characterScenario', 'characterMesExample',
         'characterSystemPrompt', 'characterPostHistory', 'characterCreatorNotes']
            .forEach(id => _autoResizeTextarea(document.getElementById(id)));
    }).catch(error => console.error('Error loading character:', error));
}

const ACCORDION_FIELD_MAP = {
    'acc-personality':    d => d.personality,
    'acc-scenario':       d => d.scenario,
    'acc-mes-example':    d => d.mes_example,
    'acc-system-prompt':  d => d.system_prompt,
    'acc-post-history':   d => d.post_history_instructions,
    'acc-creator-notes':  d => d.creator_notes,
    'acc-alt-greetings':  d => (d.alternate_greetings || []).length > 0,
    'acc-char-book':      d => (d.character_book?.entries || []).length > 0,
    'acc-tags':           d => (d.tags || []).length > 0,
    'acc-meta':           d => d.creator || d.character_version,
};

function _autoExpandFilledAccordions(data) {
    Object.entries(ACCORDION_FIELD_MAP).forEach(([accId, getter]) => {
        const el = document.getElementById(accId);
        if (!el) return;
        el.classList.toggle('open', !!getter(data));
    });
}

function _collapseAllAccordions() {
    Object.keys(ACCORDION_FIELD_MAP).forEach(accId => {
        document.getElementById(accId)?.classList.remove('open');
    });
}

function _resetCharacterForm() {
    editingCharacterId = null;
    characterImage = null;
    if (typeof _resetTokenCache === 'function') _resetTokenCache();
    document.getElementById('characterName').value = '';
    document.getElementById('characterDescription').value = '';
    document.getElementById('characterFirstMes').value = '';
    const optFields = ['characterPersonality','characterScenario','characterMesExample','characterCreatorNotes','characterSystemPrompt','characterPostHistory','characterTags','characterCreator','characterVersion','characterExtensions'];
    optFields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

    ['characterDescription','characterFirstMes','characterPersonality','characterScenario',
     'characterMesExample','characterCreatorNotes','characterSystemPrompt','characterPostHistory']
        .forEach(id => { const el = document.getElementById(id); if (el) el.style.height = ''; });
    _renderAlternateGreetings([]);
    _renderCharacterBook({ entries: [] });
    _collapseAllAccordions();
    const preview = document.getElementById('imagePreview');
    if (preview) preview.innerHTML = '<div class="image-preview-placeholder">Choose a photo</div>';
    _pickAndPreviewDefaultAvatar();
    const saveBtn = document.querySelector('.save-btn');
    if (saveBtn) saveBtn.textContent = 'Save character';
    _updateTotalTokens();
    _validateSaveBtn();
}

function showDeleteConfirm(id, event) {
    event.stopPropagation();
    deleteCharacterId = id;
    document.getElementById('confirmModal').classList.add('active');
}

function confirmDelete() {
    if (deleteCharacterId === null) return;

    fetch(`${BASE_URL}/delete_character/${deleteCharacterId}`, {
        method: 'DELETE'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            if (currentCharacter && currentCharacter.vesper.id === deleteCharacterId) {
                currentCharacter = null;
                chatHistory = [];
                _characterNotes = '';
                const notesPanel = document.getElementById('notesPanel');
                if (notesPanel) notesPanel.classList.add('hidden');
                const notesInput = document.getElementById('characterNotesInput');
                if (notesInput) notesInput.value = '';
                const chatCharName = document.getElementById('chatCharName');
                const chatCharAvatar = document.getElementById('chatCharAvatar');
                if (chatCharName) chatCharName.textContent = 'Select a character';
                if (chatCharAvatar) { chatCharAvatar.innerHTML = ''; chatCharAvatar.onclick = null; }
                document.getElementById('chatMessagesInner').innerHTML = '';
                const btn = document.getElementById('clearHistoryBtn');
                btn.classList.add('hidden');
                btn.classList.remove('flex');
            }
            closeConfirm();
            loadCharacterList();
        } else {
            showCustomAlert('Delete error');
        }
    }).catch(error => showCustomAlert('Error: ' + error));
}

function clearChatHistory() {
    if (!currentCharacter) return;
    showConfirm('Clear the entire chat history?', () => {
        fetch(`${BASE_URL}/clear_chat_history/${currentCharacter.vesper.id}`, {
            method: 'POST'
        }).then(r => r.json()).then(data => {
            if (data.success) {
                chatHistory = [];
                document.getElementById('chatMessagesInner').innerHTML = '';
                const greetingMsg = _buildGreetingMessage(currentCharacter, currentPersona);
                if (greetingMsg) {
                    chatHistory.push(greetingMsg);
                    saveChatHistory();
                }
                reloadChat();
                showCustomAlert('History cleared');
            }
        }).catch(e => showCustomAlert('Clear error: ' + e));
    });
}

function _fuzzyScore(str, query) {
    str = str.toLowerCase();
    query = query.toLowerCase().trim();
    if (!query) return 1;

    if (str.includes(query)) return 1;

    const tokens = query.split(/\s+/);
    let total = 0;

    for (const token of tokens) {
        let best = 0;
        if (str.includes(token)) {
            best = Math.max(best, 0.85);
        }

        const words = str.split(/\s+/);
        for (const word of words) {
            const maxLen = Math.max(word.length, token.length);
            if (maxLen === 0) continue;
            const dist = _levenshtein(word, token);
            const sim = 1 - dist / maxLen;
            best = Math.max(best, sim * 0.75);
        }
        let si = 0;
        for (let ci = 0; ci < str.length && si < token.length; ci++) {
            if (str[ci] === token[si]) si++;
        }
        if (si === token.length) {
            best = Math.max(best, 0.4 + 0.3 * (token.length / str.length));
        }

        total += best;
    }

    return total / tokens.length;
}

function _fuzzyScoreLayoutAware(str, query) {
    const variants = typeof _getLayoutVariants === 'function'
        ? _getLayoutVariants(query)
        : [query];
    let best = 0;
    for (const v of variants) {
        best = Math.max(best, _fuzzyScore(str, v));
        if (best === 1) break;
    }
    return best;
}

function _levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i-1] === b[j-1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i-1][j] + 1,
                dp[i][j-1] + 1,
                dp[i-1][j-1] + cost
            );
            if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) {
                dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
            }
        }
    }
    return dp[a.length][b.length];
}

function renderCharacterCards(characters) {
    const targets = ['sidebarList', 'characterGrid'].map(id => document.getElementById(id)).filter(Boolean);
    if (characters.length === 0) {
        targets.forEach(t => t.innerHTML = '<div class="empty-state">Nothing found</div>');
        return;
    }
    const html = characters.map(char => `
        <div class="character-card compact ${currentCharacter && currentCharacter.vesper?.id === char.vesper?.id ? 'selected-persona' : ''}" data-character-id="${char.vesper.id}">
            <div class="character-card-clickable" onclick="loadCharacter(${char.vesper.id}); switchView('chat')">
                <div class="character-card-avatar">
                    ${characterAvatarImg(char)}
                </div>
                <div class="character-card-name">${char.data.name}</div>
                <div class="character-card-desc">
                    ${(char.data.description || '').slice(0, 60)}
                </div>
            </div>
            <div class="character-actions">
                <button class="action-btn edit-btn" onclick="editCharacter(${char.vesper.id}, event)">
                    <img src="/static/icons/edit.svg" alt="edit">
                </button>
                <button class="action-btn delete-btn" onclick="showDeleteConfirm(${char.vesper.id}, event)">
                    <img src="/static/icons/trash.svg" alt="delete">
                </button>
            </div>
        </div>
    `).join('');
    targets.forEach(t => t.innerHTML = html);
    if (typeof _staggerCardReveal === 'function') targets.forEach(_staggerCardReveal);
}

// Внутренняя функция непосредственного расчета фильтрации
function _execFilterCharacters(query) {
    const clearBtn = document.getElementById('characterSearchClear');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !query);
        clearBtn.classList.toggle('block', !!query);
    }
    if (!query.trim()) {
        renderCharacterCards(_charactersCache);
        return;
    }
    const THRESHOLD = 0.35;
    const scored = _charactersCache.map(char => {
        const nameScore  = _fuzzyScoreLayoutAware(char.data?.name || '', query) * 0.7;
        const instrScore = _fuzzyScoreLayoutAware(char.data?.description || '', query) * 0.3;
        return { char, score: nameScore + instrScore };
    })
    .filter(x => x.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score);

    renderCharacterCards(scored.map(x => x.char));
}

// Debounce для безопасного вызова
let _charSearchTimeout = null;
function filterCharacters(query) {
    clearTimeout(_charSearchTimeout);
    _charSearchTimeout = setTimeout(() => {
        _execFilterCharacters(query);
    }, 120);
}

function clearCharacterSearch() {
    const input = document.getElementById('characterSearch');
    const clearBtn = document.getElementById('characterSearchClear');
    if (input) input.value = '';
    if (clearBtn) {
        clearBtn.classList.add('hidden');
        clearBtn.classList.remove('flex', 'block');
    }
    renderCharacterCards(_pinSelectedCharacter(_charactersCache));
}

// ── V2 helpers ────────────────────────────────────────────────────

function _collectAlternateGreetings() {
    const container = document.getElementById('alternateGreetingsList');
    if (!container) return [];
    return Array.from(container.querySelectorAll('.alt-greeting-textarea'))
        .map(ta => ta.value.trim())
        .filter(Boolean);
}

function _renderAlternateGreetings(greetings) {
    const container = document.getElementById('alternateGreetingsList');
    if (!container) return;
    container.innerHTML = '';
    greetings.forEach((text, i) => _addAlternateGreetingItem(container, text, i));
    _updateAltGreetingsHeader();
}

function _addAlternateGreetingItem(container, text = '', index = null) {
    const idx = index ?? container.querySelectorAll('.alt-greeting-item').length;
    const tokenKey = `alt-greeting-${idx}-${Date.now()}`;
    const item = document.createElement('div');
    item.className = 'alt-greeting-item field-accordion';
    item.innerHTML = `
        <div class="field-accordion-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="field-accordion-title">Greeting #${idx + 1}</span>
            <span class="field-token-count" data-target="${tokenKey}">0 tok</span>
            <button class="field-remove-btn" onclick="event.stopPropagation(); this.closest('.alt-greeting-item').remove(); _updateAltGreetingsHeader(); _updateTotalTokens()">×</button>
        </div>
        <div class="field-accordion-body">
            <div class="field-accordion-body-inner">
                <textarea class="alt-greeting-textarea field-textarea" data-token-id="${tokenKey}" rows="4">${text}</textarea>
            </div>
        </div>`;
    container.appendChild(item);
    _bindTokenCounter(item.querySelector('.alt-greeting-textarea'));
}

function _updateAltGreetingsHeader() {
    const count = document.querySelectorAll('.alt-greeting-item').length;
    const label = document.getElementById('altGreetingsLabel');
    if (label) label.textContent = `Alternate Greetings (${count})`;
}

function _collectCharacterBook() {
    const container = document.getElementById('charBookEntries');
    if (!container) return { entries: [] };
    const entries = Array.from(container.querySelectorAll('.charbook-entry')).map(el => ({
        keys: (el.querySelector('.charbook-keys')?.value || '').split(',').map(k => k.trim()).filter(Boolean),
        content: el.querySelector('.charbook-content')?.value.trim() || '',
        enabled: el.querySelector('.charbook-enabled')?.checked ?? true,
        priority: parseInt(el.querySelector('.charbook-priority')?.value || '100', 10)
    })).filter(e => e.content);
    return { entries };
}

function _collectExtensions() {
    const raw = document.getElementById('characterExtensions')?.value.trim();
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
        showCustomAlert('Extensions field is not valid JSON — saved as empty object instead');
        return {};
    }
}

function _renderExtensions(extensions) {
    const el = document.getElementById('characterExtensions');
    if (!el) return;
    const hasContent = extensions && typeof extensions === 'object' && Object.keys(extensions).length > 0;
    el.value = hasContent ? JSON.stringify(extensions, null, 2) : '';
}

function _renderCharacterBook(book) {
    const container = document.getElementById('charBookEntries');
    if (!container) return;
    container.innerHTML = '';
    (book.entries || []).forEach((entry, i) => _addCharBookEntry(container, entry, i));
    _updateCharBookHeader();
}

function _addCharBookEntry(container, entry = {}, index = null) {
    const idx = index ?? container.querySelectorAll('.charbook-entry').length;
    const tokenKey = `charbook-${idx}-${Date.now()}`;
    const item = document.createElement('div');
    item.className = 'charbook-entry';
    item.innerHTML = `
        <div class="charbook-entry-header">
            <span>Entry #${idx + 1}</span>
            <span class="field-token-count" data-target="${tokenKey}">0 tok</span>
            <button class="field-remove-btn" onclick="this.closest('.charbook-entry').remove(); _updateCharBookHeader(); _updateTotalTokens()">×</button>
        </div>
        <input class="charbook-keys field-input" type="text" placeholder="keywords, comma separated" value="${(entry.keys || []).join(', ')}">
        <textarea class="charbook-content field-textarea" data-token-id="${tokenKey}" rows="3" placeholder="Content...">${entry.content || ''}</textarea>
        <div class="charbook-entry-meta">
            <label><input class="charbook-enabled" type="checkbox" ${entry.enabled !== false ? 'checked' : ''}> Enabled</label>
            <label>Priority <input class="charbook-priority field-input-sm" type="number" value="${entry.priority ?? 100}"></label>
        </div>`;
    container.appendChild(item);
    _bindTokenCounter(item.querySelector('.charbook-content'));
}

function _updateCharBookHeader() {
    const count = document.querySelectorAll('.charbook-entry').length;
    const label = document.getElementById('charBookLabel');
    if (label) label.textContent = `Character Book (${count} entries)`;
}

function _autoResizeTextarea(textarea) {
    if (!textarea) return;
    if (textarea.dataset.manuallyResized === '1') return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

function _bindMobileResizeHandle(textarea) {
    if (!textarea || textarea.dataset.mobileResizeBound) return;
    textarea.dataset.mobileResizeBound = '1';

    const handle = document.createElement('div');
    handle.className = 'textarea-resize-handle';
    handle.setAttribute('aria-hidden', 'true');

    const wrapper = document.createElement('div');
    wrapper.className = 'textarea-resize-wrapper';
    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);
    wrapper.appendChild(handle);

    let startY = 0;
    let startHeight = 0;

    const onMove = (clientY) => {
        const delta = clientY - startY;
        const newHeight = Math.max(60, startHeight + delta);
        textarea.style.height = newHeight + 'px';
    };

    const onTouchMove = (e) => {
        onMove(e.touches[0].clientY);
        e.preventDefault();
    };

    const onTouchEnd = () => {
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    };

    handle.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        startHeight = textarea.offsetHeight;
        textarea.dataset.manuallyResized = '1';
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    }, { passive: true });
}

function _bindTokenCounter(textarea) {
    if (!textarea) return;
    const tokenKey = textarea.dataset.tokenId;
    const counter = tokenKey ? document.querySelector(`.field-token-count[data-target="${tokenKey}"]`) : null;
    const updateCount = () => {
        if (!tokenKey || typeof _updateFieldTokenCount !== 'function') return;
        _updateFieldTokenCount(textarea.value, tokenKey, (count, approximate) => {
            if (counter) counter.textContent = approximate ? `~${count} tok` : `${count} tok`;
        });
    };
    textarea.addEventListener('input', updateCount);
    updateCount();
    textarea.addEventListener('input', () => _autoResizeTextarea(textarea));
    _autoResizeTextarea(textarea);
    if (window.matchMedia('(max-width: 767px)').matches) {
        _bindMobileResizeHandle(textarea);
    }
}

function _bindStaticCharacterTextareas() {
    const ids = [
        'characterDescription', 'characterFirstMes', 'characterPersonality',
        'characterScenario', 'characterMesExample', 'characterSystemPrompt',
        'characterPostHistory', 'characterCreatorNotes'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.autoResizeBound) return;
        el.dataset.autoResizeBound = '1';
        el.addEventListener('input', () => _autoResizeTextarea(el));
        if (window.matchMedia('(max-width: 767px)').matches) {
            _bindMobileResizeHandle(el);
        }
    });
}

document.addEventListener('DOMContentLoaded', _bindStaticCharacterTextareas);