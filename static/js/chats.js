// static/js/chats.js
// Список чатов персонажа + создание нового чата (выбор персоны).
// Новый файл — этой сущности не было в старой архитектуре (один чат на
// персонажа, без промежуточного экрана).

let _chatListCharacterId = null;

async function fetchCharacterChats(characterId) {
    const r = await fetch(`${BASE_URL}/character/${characterId}/chats`);
    return r.json();
}

// Вызывается вместо прямого loadCharacter() при клике на карточку
// персонажа в списке — теперь ведёт на список чатов, не сразу в чат.
async function openChatList(characterId) {
    _chatListCharacterId = characterId;

    const characters = await fetchCharacters();
    const character = characters.find(c => c.id === characterId);
    const titleEl = document.getElementById('chatListTitle');
    if (titleEl) titleEl.textContent = character ? `${character.name} — chats` : 'Chats';

    switchView('chatList');
    await renderChatList();
}

async function renderChatList() {
    const container = document.getElementById('chatListContainer');
    if (!container || !_chatListCharacterId) return;

    container.innerHTML = '<div class="grid-full-center"><div class="loader-spinner"></div></div>';
    try {
        const chats = await fetchCharacterChats(_chatListCharacterId);
        if (!chats.length) {
            container.innerHTML = '<div class="empty-state">No chats yet — start one</div>';
            return;
        }
        container.innerHTML = chats.map(chat => `
            <div class="chat-list-item" onclick="loadCharacter(${_chatListCharacterId}, 'chat', ${chat.id})">
                <div class="chat-list-item-main">
                    <div class="chat-list-item-title">${chat.title || 'Untitled chat'}</div>
                    <div class="chat-list-item-sub">with ${chat.persona_name}</div>
                </div>
                <button class="action-btn delete-btn" onclick="event.stopPropagation(); deleteChat(${chat.id})">
                    <img src="/static/icons/trash.svg" alt="delete">
                </button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Error loading chat list:', e);
        container.innerHTML = '<div class="empty-state">Failed to load chats</div>';
    }
}

function deleteChat(chatId) {
    showConfirm('Delete this chat and its entire history?', () => {
        fetch(`${BASE_URL}/delete_chat/${chatId}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    if (currentChatId === chatId) {
                        currentChatId = null;
                        chatHistory = [];
                    }
                    renderChatList();
                } else {
                    showCustomAlert('Delete error');
                }
            }).catch(e => showCustomAlert('Error: ' + e));
    });
}

// ── New chat: persona picker modal ──────────────────────────────────
// Показывает персон, УЖЕ подключённых к этому персонажу (create_chat на
// бэке требует persona_id из тех, что реально связаны — см.
// routes/chats.py comment: "выбор идёт из уже отфильтрованного списка").
// Если подключённых персон нет — прямым текстом просит подключить хотя
// бы одну через форму персонажа, вместо создания пустого списка выбора.

async function openNewChatPicker() {
    if (!_chatListCharacterId) return;
    const modal = document.getElementById('newChatPersonaModal');
    const list = document.getElementById('newChatPersonaList');
    if (!modal || !list) return;

    list.innerHTML = '<div class="loader-spinner"></div>';
    modal.classList.add('active');

    try {
        const personas = await fetchCharacterPersonas(_chatListCharacterId);
        if (!personas.length) {
            list.innerHTML = '<div class="empty-state-small">No personas connected to this character yet. Connect one from the character\'s edit form first.</div>';
            return;
        }
        list.innerHTML = personas.map(p => `
            <div class="persona-pick-item" onclick="createChatWithPersona(${p.id})">
                <span>${p.name}</span>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = '<div class="empty-state-small">Failed to load personas</div>';
    }
}

function closeNewChatPicker() {
    _closeModalAnimated(document.getElementById('newChatPersonaModal'));
}

function createChatWithPersona(personaId) {
    if (!_chatListCharacterId) return;
    fetch(`${BASE_URL}/create_chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: _chatListCharacterId, persona_id: personaId, title: 'New chat' })
    }).then(r => r.json()).then(data => {
        closeNewChatPicker();
        if (data.success) {
            loadCharacter(_chatListCharacterId, 'chat', data.chat_id);
        } else {
            showCustomAlert('Could not create chat: ' + (data.error || 'unknown error'));
        }
    }).catch(e => showCustomAlert('Error: ' + e));
}
