// chat.js

function characterAvatarUrl(id) {
    return `/character_avatar/${id}`;
}

function personaAvatarUrl(id) {
    return `/persona_avatar/${id}`;
}

let _characterNotes = '';

function parseMarkdown(text) {
    return text
        .replace(/\n{2,}/g, '\n')
        .replace(/\/cmd\s+(.+)/g, '<span class="ooc-cmd">$1</span>')
        .replace(/^>\s?(.+)$\n?/gm, '<span class="markdown-quote">$1</span>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em class="markdown-bold-italic">$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/~~(.+?)~~/g, '<del class="markdown-strike">$1</del>')
        .replace(/\*(.+?)\*/g, '<em class="markdown-italic">$1</em>')
        .replace(/\n/g, '<br>')
}

// Same blank-line collapsing rule as parseMarkdown, applied to the raw text
// before it's pushed into chatHistory/saved — so what's stored on disk is
// already clean and parseMarkdown's \n{2,} replace becomes a no-op on
// reload instead of doing real work every render.
function normalizeStreamedText(text) {
    return text.trim().replace(/\n{2,}/g, '\n');
}

function isScrolledToBottom() {
    const threshold = 50;
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < threshold;
}

function addMessage(text, isUser = false, messageIndex = null) {

    const msg = messageIndex !== null ? chatHistory[messageIndex] : null;
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isUser ? 'user' : 'bot'}`;
    if (msg?.isArchived) messageDiv.classList.add('message-archived');
    if (msg?.isSummary) messageDiv.classList.add('message-is-summary');
    
    if (messageIndex !== null) messageDiv.dataset.messageIndex = messageIndex;

    const contentWrapper = document.createElement('div');
    const msgHeader = document.createElement('div');
    msgHeader.className = 'message-header';

    let imgSrc;

    if (isUser) {
        imgSrc = currentPersona?.has_avatar
            ? personaAvatarUrl(currentPersona.id)
            : defaultAvatarUrl(currentPersona?.default_avatar);
    } else {
        imgSrc = currentCharacter?.has_avatar
            ? characterAvatarUrl(currentCharacter.vesper.id)
            : defaultAvatarUrl(currentCharacter?.vesper?.default_avatar);
    }

    msgHeader.innerHTML = `
        <div class="message-avatar-small">
            <img src="${imgSrc}" loading="lazy">
        </div>
        <span class="message-sender-name">
            ${isUser
                ? (currentPersona?.name || 'User')
                : (currentCharacter?.name || 'AI')
            }
        </span>
    `;

    const avatarSmall = msgHeader.querySelector('.message-avatar-small');

    if (imgSrc) {
        avatarSmall.classList.add('clickable');
        avatarSmall.onclick = (e) => {
            e.stopPropagation();
            openAvatarModal(imgSrc);
        };
    }

    if (isUser) msgHeader.classList.add('user');

    contentWrapper.className = 'content-wrapper';
    if (isUser) contentWrapper.classList.add('user');

    const content = document.createElement('div');
    content.className = 'message-content';
    
    const msgBodyContainer = document.createElement('div');
    msgBodyContainer.className = 'message-body-container';

    if (!isUser) {
        content.appendChild(msgHeader);
        
        const divider = document.createElement('div');
        divider.className = 'message-header-divider';
        content.appendChild(divider);

        msgBodyContainer.innerHTML = `<div class="msg-body">${parseMarkdown(text)}</div>`;
    } else {
        content.insertBefore(msgHeader, content.firstChild);
        msgBodyContainer.innerHTML = parseMarkdown(text);
    }

    content.appendChild(msgBodyContainer);
    contentWrapper.appendChild(content);

    if (isUser && messageIndex !== null && !msg?.isArchived) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'message-action-btn edit-msg-btn';
        editBtn.innerHTML = '<img src="/static/icons/edit.svg" alt="edit"> <span>Edit</span>';
        editBtn.onclick = () => editMessage(messageIndex);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'message-action-btn delete-msg-btn';
        deleteBtn.innerHTML = '<img src="/static/icons/trash.svg" alt="delete"> <span>Delete</span>';
        deleteBtn.onclick = () => deleteMessageFrom(messageIndex);

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);

        
        if (messageIndex > 0) {
            const sumBtn = document.createElement('button');
            sumBtn.className = 'message-action-btn summarize-msg-btn';
            sumBtn.innerHTML = '<img src="/static/icons/summarize.svg" alt="sum"> <span>Summarize</span>';
            sumBtn.onclick = (e) => summarizeHistory(messageIndex, e.currentTarget);
            actions.appendChild(sumBtn);
        }
        
        contentWrapper.appendChild(actions);
    }

    if (!isUser && messageIndex !== null && !msg?.isArchived){
        const actions = document.createElement('div');
        actions.className = 'message-actions bot-actions';

        // Greeting (index 0, no reply yet) gets rebuilt from the card's
        // first_mes/alternate_greetings every time loadCharacter runs, so
        // any manual edit here is silently discarded on next visit — no
        // point offering a button that lies about persisting.
        const isGreeting = messageIndex === 0 && chatHistory.length === 1;

        if (!isGreeting) {
            const editBtn = document.createElement('button');
            editBtn.className = 'message-action-btn edit-msg-btn';
            editBtn.innerHTML = '<img src="/static/icons/edit.svg" alt="edit"> <span>Edit</span>';
            editBtn.onclick = () => editMessage(messageIndex);
            actions.appendChild(editBtn);
        }

        if (messageIndex > 0) {
            const sumBtn = document.createElement('button');
            sumBtn.className = 'message-action-btn';
            sumBtn.innerHTML = '<img src="/static/icons/summarize.svg" alt="sum"> <span>Summarize</span>';
            sumBtn.onclick = (e) => summarizeHistory(messageIndex, e.target);
            actions.appendChild(sumBtn);
        }

        if (messageIndex === chatHistory.length - 1 && !isGreeting) {
            const regenBtn = document.createElement('button');
            regenBtn.className = 'message-action-btn regen-msg-btn';
            regenBtn.innerHTML = '<img src="/static/icons/refresh.svg" alt="regen"> <span>Regenerate</span>';
            regenBtn.onclick = () => regenerateMessage(messageIndex);
            actions.appendChild(regenBtn);
        }

        contentWrapper.appendChild(actions);

        const msgData = chatHistory[messageIndex];
        // Greeting swipe stays available only while it's still the sole
        // message (index 0 AND last) — once the user replies, the opening
        // line is "locked in" as actual conversation history and shouldn't
        // retroactively change under it.
        const canSwipe = msgData?.versions?.length > 1
            && (isGreeting ? chatHistory.length === 1 : messageIndex === chatHistory.length - 1);
        if (canSwipe) {
            const versionNav = document.createElement('div');
            versionNav.className = 'version-nav';

            const prevBtn = document.createElement('button');
            prevBtn.className = 'version-btn';
            prevBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 14 14"><use href="#icon-chevron-left"/></svg>';
            prevBtn.onclick = () => switchVersion(messageIndex, -1);

            const versionLabel = document.createElement('span');
            versionLabel.className = 'version-label';
            versionLabel.textContent = `${msgData.activeVersion + 1}/${msgData.versions.length}`;

            const nextBtn = document.createElement('button');
            nextBtn.className = 'version-btn';
            nextBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 14 14"><use href="#icon-chevron-right"/></svg>';
            nextBtn.onclick = () => switchVersion(messageIndex, 1);

            versionNav.appendChild(prevBtn);
            versionNav.appendChild(versionLabel);
            versionNav.appendChild(nextBtn);
            contentWrapper.appendChild(versionNav);
        }
    }

    if (msg?.isSummary) {
        const summaryBlock = document.createElement('div');
        summaryBlock.className = 'summary-block';

        const icon = document.createElement('div');
        icon.className = 'summary-block-icon';
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><use href="#icon-scroll"/></svg>';

        const blockBody = document.createElement('div');
        blockBody.className = 'summary-block-body';

        const label = document.createElement('div');
        label.className = 'summary-block-label';
        label.textContent = 'Context of the past';

        const bodyText = document.createElement('div');
        bodyText.className = 'summary-block-text';
        bodyText.textContent = text.replace(/^📜 \[CONTEXT OF THE PAST\]:\n/, '');

        blockBody.appendChild(label);
        blockBody.appendChild(bodyText);
        summaryBlock.appendChild(icon);
        summaryBlock.appendChild(blockBody);

        if (messageIndex !== null) {
            const unarchiveBtn = document.createElement('button');
            unarchiveBtn.className = 'message-action-btn';
            unarchiveBtn.classList.add('mt-sm');
            unarchiveBtn.innerHTML = '<img src="/static/icons/refresh.svg" alt="unarchive"> <span>Restore context</span>';
            unarchiveBtn.onclick = () => unarchiveFrom(messageIndex);
            blockBody.appendChild(unarchiveBtn);
        }

        messageDiv.appendChild(summaryBlock);
    } else {
        messageDiv.appendChild(contentWrapper);
    }
    document.getElementById('chatMessagesInner').appendChild(messageDiv);

    if (isScrolledToBottom()) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    return msgBodyContainer;
}

function addLoadingIndicator() {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.id = 'loading-indicator';

    const content = document.createElement('div');
    content.className = 'message-content loading';
    content.innerHTML = '<span></span><span></span><span></span>';

    messageDiv.appendChild(content);
    document.getElementById('chatMessagesInner').appendChild(messageDiv);
    if (isScrolledToBottom()) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeLoadingIndicator() {
    const indicator = document.getElementById('loading-indicator');
    if (indicator) indicator.remove();
}

// Marks a freshly-inserted (or re-targeted) batch of .message rows for a
// staggered side-entry reveal (bot from the left, user from the right —
// see chat.css), then plays it. Shared between reloadChat, loadCharacter
// (characters.js), and replayMessageStagger (view-switch replay) below.
function _staggerMessageRows(rows) {
    const inner = document.getElementById('chatMessagesInner');
    // Full reset before re-arming: .stagger-play might already be set on
    // the container from a previous reveal, and rows re-targeted by
    // replayMessageStagger might already carry .message-stagger-in from
    // last time. Re-adding a class that's already present is a no-op to
    // the browser — the animation just keeps its old finished/running
    // state, nothing replays. Clearing both, forcing a reflow, then
    // re-applying is what makes the browser treat this as a genuinely new
    // animation instance instead of continuing (or ignoring) the old one.
    inner.classList.remove('stagger-play');
    rows.forEach(row => row.classList.remove('message-stagger-in'));
    void inner.offsetHeight;

    rows.forEach((row, i) => {
        row.classList.add('message-stagger-in');
        row.style.setProperty('--stagger-i', Math.min(i, 8));
        // Start fully hidden via inline style (not the animation's own
        // `from` keyframe) — a paused animation's rendered state before
        // it's ever set running isn't reliable across browsers, plain
        // opacity is.
        row.style.opacity = '0';
    });
}

function _playStaggerReveal(rows) {
    const inner = document.getElementById('chatMessagesInner');
    // One rAF is enough to let the browser paint the opacity:0 state as a
    // real frame before we clear it and flip animation-play-state to
    // running — a second nested rAF was extra latency without adding
    // reliability, and was part of what made the reveal feel delayed.
    requestAnimationFrame(() => {
        rows.forEach(row => row.style.removeProperty('opacity'));
        inner.classList.add('stagger-play');
    });
}

// Replays the side-entry reveal on rows that are *already* in the DOM,
// without touching content — used when the user just switches back to the
// chat tab (nav bar / sidebar tab) rather than loading a new character or
// history. _showView (ui.js) calls this every time chatView becomes active.
// Only the last MAX_REPLAY_ROWS messages animate: replaying hundreds of old
// rows on every tab visit would be both pointless (most are already off
// the bottom of the scroll position) and slow on a long history.
const MAX_REPLAY_ROWS = 20;

function replayMessageStagger() {
    const inner = document.getElementById('chatMessagesInner');
    if (!inner) return;
    const all = inner.querySelectorAll('.message');
    if (!all.length) return;
    const rows = Array.from(all).slice(-MAX_REPLAY_ROWS);
    _staggerMessageRows(rows);
    _playStaggerReveal(rows);
}

function reloadChat() {
    const wasAtBottom = isScrolledToBottom();
    const scrollPos = chatMessages.scrollTop;

    const inner = document.getElementById('chatMessagesInner');
    inner.innerHTML = '';

    const rows = [];
    chatHistory.forEach((msg, index) => {
        const bodyEl = addMessage(msg.text, msg.isUser, index);
        const row = bodyEl ? bodyEl.closest('.message') : null;
        if (row) rows.push(row);
    });
    _staggerMessageRows(rows);

    chatMessages.scrollTop = wasAtBottom ? chatMessages.scrollHeight : scrollPos;
    requestAnimationFrame(() => {
        chatMessages.scrollTop = wasAtBottom ? chatMessages.scrollHeight : scrollPos;
    });
    _playStaggerReveal(rows);

    updateTokenCount();
    updateSummaryBrowserBtn();
}

function editMessage(index) {
    const messageDiv = document.querySelector(`[data-message-index="${index}"]`);
    const content = messageDiv.querySelector('.message-content');

    if (content.contentEditable === 'true') return;

    const originalText = content.textContent;
    const msgData = chatHistory[index];
    content.contentEditable = 'true';
    content.classList.add('editing');
    content.focus();

    const rawText = chatHistory[index].text;
    content.innerHTML = '';
    content.textContent = rawText.replace(/\n{2,}/g, '\n');
    content.classList.add('pre-wrap');

    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(content);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    const saveEdit = () => {
        const newText = content.innerText.trim();
        if (newText && newText !== originalText) {
            chatHistory[index].text = newText;
            if (msgData.versions) msgData.versions[msgData.activeVersion] = newText;
            saveChatHistory();
            reloadChat();
        } else {
            content.textContent = originalText;
        }
        content.contentEditable = 'false';
        content.classList.remove('editing');
        content.classList.remove('pre-wrap');
    };

    content.addEventListener('blur', saveEdit, { once: true });
    content.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
            e.preventDefault();
            content.blur();
        }
        if (e.key === 'Escape') {
            content.textContent = originalText;
            content.blur();
        }
    });
}

function deleteMessageFrom(index) {
    showConfirm('Delete the entire history starting from this message?', () => {
        chatHistory = chatHistory.slice(0, index);
        saveChatHistory();
        reloadChat();
    });
}

function switchVersion(index, dir) {
    const msg = chatHistory[index];
    if (!msg?.versions) return;
    const newIndex = msg.activeVersion + dir;
    if (newIndex < 0 || newIndex >= msg.versions.length) return;
    msg.activeVersion = newIndex;
    msg.text = msg.versions[newIndex];
    saveChatHistory();
    _updateMessageTextInPlace(index);
}

// Swaps just the text (and version label) inside the EXISTING .message
// node, instead of tearing it down and rebuilding via reloadChat or the
// replaceWith approach tried before this. This turned out to be the actual
// fix for version-nav buttons "running away" from the cursor on fast
// clicks — a height-freeze attempt before this didn't touch the real
// cause: .message has `animation: msgIn` (a translateY(10px)->0 slide,
// 280ms, see chat.css) that fires on any FRESH element. reloadChat() and
// the replaceWith-based approach both created a new .message node on every
// click, so every version swap replayed that slide-in — the whole row
// (buttons included) physically moved for 280ms after each click, no
// matter what height-related fix sat on top of it. Reusing the same node
// sidesteps the animation entirely; any remaining shift is just the
// ordinary, instant reflow from the new text's height, which no longer
// fights a moving target underneath an unrelated slide animation.
function _updateMessageTextInPlace(index) {
    const inner = document.getElementById('chatMessagesInner');
    const row = inner.querySelector(`.message[data-message-index="${index}"]`);
    const msg = chatHistory[index];
    if (!row || !msg) { reloadChat(); return; } // fallback if something's out of sync

    // Non-user bodies wrap rendered text in an inner .msg-body (see
    // addMessage); user bodies write straight into .message-body-container.
    // Greeting swaps are always non-user, but this covers both shapes.
    const bodyEl = row.querySelector('.msg-body') || row.querySelector('.message-body-container');
    if (!bodyEl) { reloadChat(); return; }

    // FLIP-style height transition: CSS can't animate `height: auto` to
    // another `auto` directly, so measure before/after in pixels and
    // animate between those. Only worth doing above a small threshold —
    // a 2px wobble from near-identical version lengths doesn't need a
    // transition, and skipping it there avoids paying a layout read/write
    // round-trip on every swap for no visible benefit.
    const oldHeight = row.offsetHeight;
    bodyEl.innerHTML = parseMarkdown(msg.text);

    const versionLabel = row.querySelector('.version-label');
    if (versionLabel) versionLabel.textContent = `${msg.activeVersion + 1}/${msg.versions.length}`;

    const newHeight = row.offsetHeight;
    const diff = Math.abs(newHeight - oldHeight);

    if (diff > 8) {
        row.style.height = `${oldHeight}px`;
        row.style.overflow = 'hidden';
        // Force layout to commit the starting height before flipping to
        // the target — otherwise the browser coalesces both style writes
        // into one frame and there's nothing to transition from.
        row.offsetHeight; // eslint-disable-line no-unused-expressions
        row.style.transition = `height ${180}ms var(--ease, ease)`;
        row.style.height = `${newHeight}px`;

        const cleanup = () => {
            row.style.height = '';
            row.style.overflow = '';
            row.style.transition = '';
            row.removeEventListener('transitionend', cleanup);
        };
        row.addEventListener('transitionend', cleanup);
    }
}

function saveChatHistory() {
    if (!currentCharacter) return;
    fetch(`${BASE_URL}/save_chat_history/${currentCharacter.vesper.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: chatHistory })
    }).catch(error => console.error('Error saving history:', error));
}

// Assembles the chara_card_v2 fields into a SillyTavern-style labeled block.
// Models fine-tuned on RP data have seen this exact layout (Description/
// Personality/Scenario/Example Dialogue headers) thousands of times — a
// blob of unlabeled prose is technically the same information but the
// model has to guess at structure it was never trained to expect.
// post_history_instructions is deliberately NOT folded in here — see the
// fetch body below for why it's sent as a separate field instead.
function buildCharacterCardBlock(charData) {
    if (!charData) return '';
    const d = charData;
    let block = `You are ${d.name}.`;

    if (d.personality && d.personality.trim()) {
        block += `\n\nPersonality: ${d.personality.trim()}`;
    }
    if (d.description && d.description.trim()) {
        block += `\n\nDescription: ${d.description.trim()}`;
    }
    if (d.scenario && d.scenario.trim()) {
        block += `\n\nScenario: ${d.scenario.trim()}`;
    }
    if (d.mes_example && d.mes_example.trim()) {
        block += `\n\nExample dialogue:\n${d.mes_example.trim()}`;
    }
    return block;
}

async function streamChatResponse(botMsgIndex, existingContent = null) {
    let systemPrompt = '';
    if (currentCharacter) {
        // Card's own custom system_prompt (if the creator wrote one) leads —
        // it's meant to set tone/rules before anything else in the card.
        if (currentCharacter.data.system_prompt && currentCharacter.data.system_prompt.trim()) {
            systemPrompt += currentCharacter.data.system_prompt.trim() + '\n\n';
        }
        systemPrompt += buildCharacterCardBlock(currentCharacter.data);
    }
    if (currentPersona) {
        const personaName = currentPersona.name || 'User';
        systemPrompt += `\n\nYou are talking with ${personaName}.`;
        if (currentPersona.description) systemPrompt += ` ${currentPersona.description}`;
    }

    const characterName = currentCharacter ? currentCharacter.data.name : 'AI';
    const personaName = currentPersona ? currentPersona.name : 'User';
    const cmdRegex = /\/cmd\s+(.+)/;
    let oocCommand = null;

    const historyCopy = chatHistory
    .filter(msg => !msg.isArchived)
    .map(msg => {
        const text = (msg.versions && msg.activeVersion !== undefined)
            ? msg.versions[msg.activeVersion]
            : msg.text;
        return { ...msg, text };
    });

    for (let i = historyCopy.length - 1; i >= 0; i--) {
        if (historyCopy[i].isUser) {
            const match = historyCopy[i].text.match(cmdRegex);
            if (match && match[1].trim()) oocCommand = match[1].trim();
            break;
        }
    }

    historyCopy.forEach(msg => {
        if (msg.isUser) msg.text = msg.text.replace(cmdRegex, '').trim();
    });

    let conversationHistory = '';
    historyCopy.forEach(msg => {
        conversationHistory += `${msg.isUser ? personaName : characterName}: ${msg.text}\n`;
    });

    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');

    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    
    let fullText = '';
    let botMessageContent = null;

    if (!existingContent) {
        botMessageContent = addMessage('', false, botMsgIndex);
        botMessageContent.innerHTML = '<span></span><span></span><span></span>';
        botMessageContent.classList.add('loading');
    } else {
        botMessageContent = existingContent;
    }
    
    abortController = new AbortController();

    try {
        const postHistoryInstructions = currentCharacter?.data?.post_history_instructions?.trim() || '';

        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt, conversationHistory, personaName, characterName, oocCommand, characterNotes: _characterNotes, postHistoryInstructions }),
            signal: abortController.signal
        });

        if (!response.ok) throw new Error('Server error');

        botMessageContent.classList.remove('loading');
        botMessageContent.innerHTML = '';

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.error) throw new Error(data.error);
                    if (data.done) break;
                    if (data.token) {
                        fullText += data.token;

                        let msgBody = botMessageContent.querySelector('.msg-body-stream');
                            if (!msgBody) {
                                msgBody = document.createElement('div');
                                msgBody.className = 'msg-body msg-body-stream';
                                botMessageContent.appendChild(msgBody);
                            }
                        renderStreamChunk(msgBody, fullText);
                    }
                } catch(e) { console.error('Parse error:', line, e); }
            }
        }
    } catch (error) {
        if (!fullText.trim() && botMessageContent) {
            const msgElement = botMessageContent.closest('.message');
            if (msgElement) msgElement.remove();
        }
        if (error.name === 'AbortError') {
            if (fullText.trim()) {
                const normalized = normalizeStreamedText(fullText);
                const lastMsg = chatHistory[chatHistory.length - 1];
                if (!lastMsg.isUser && lastMsg.versions) {
                    lastMsg.versions[lastMsg.activeVersion] = normalized;
                    lastMsg.text = normalized;
                } else {
                    chatHistory.push({ text: normalized, isUser: false });
                }
                saveChatHistory();
                reloadChat();
            } else {
                // Not a single token arrived before the abort. If the last
                // thing sitting in history is now a dangling user message
                // with no reply, treat the whole send as cancelled: pull it
                // back out of history and hand the text back to the input
                // instead of leaving an orphaned message the user has to
                // manually delete and retype.
                const last = chatHistory[chatHistory.length - 1];
                if (last && last.isUser) {
                    chatHistory.pop();
                    saveChatHistory();
                    reloadChat();
                    const userInput = document.getElementById('userInput');
                    if (userInput) {
                        userInput.value = last.text;
                        userInput.style.height = 'auto';
                        const maxHeight = parseFloat(getComputedStyle(userInput).maxHeight);
                        const newHeight = Math.min(userInput.scrollHeight, maxHeight);
                        userInput.style.height = newHeight + 'px';
                        userInput.focus();
                        _scheduleDraftSave();
                    }
                }
            }
        } else {
            if (botMessageContent) {
                botMessageContent.classList.remove('loading');
                botMessageContent.innerHTML = `<div class="error-text">ERR: Connection interrupted or server error</div>`;
                botMessageContent.closest('.message').classList.add('error');
            } else {
                const errorBody = addMessage('ERR: Connection to server interrupted...', false);
                errorBody.closest('.message').classList.add('error');
            }
        }
        sendBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        abortController = null;
        return;
    }

    if (fullText.trim()) {
        const normalized = normalizeStreamedText(fullText);
        const lastMsg = chatHistory[chatHistory.length - 1];
        if (!lastMsg.isUser && lastMsg.versions) {
            lastMsg.versions[lastMsg.activeVersion] = normalized;
            lastMsg.text = normalized;
        } else {
            chatHistory.push({ text: normalized, isUser: false });
        }
        saveChatHistory();
        reloadChat();
    }

    updateTokenCount();
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    abortController = null;
}

async function sendMessage() {
    const userInput = document.getElementById('userInput');
    const message = userInput.value.trim();
    if (!message) return;

    const lastMsg = chatHistory[chatHistory.length - 1];
    if (lastMsg && !lastMsg.isUser && lastMsg.versions) {
        lastMsg.text = lastMsg.versions[lastMsg.activeVersion];
        delete lastMsg.versions;
        delete lastMsg.activeVersion;
        reloadChat();
    }

    chatHistory.push({ text: message, isUser: true });
    const userMsgIndex = chatHistory.length - 1;
    addMessage(message, true, userMsgIndex);
    userInput.value = '';
    userInput.style.height = 'auto';
    userInput.blur();
    _clearDraft();

    const botIndex = chatHistory.length;
    await streamChatResponse(botIndex);
}

async function regenerateMessage(index) {
    if (index === 0) return;

    const userMessage = chatHistory[index - 1];
    if (!userMessage?.isUser) return;

    const botMsg = chatHistory[index];
    if (!botMsg.versions) {
        botMsg.versions = [botMsg.text];
        botMsg.activeVersion = 0;
    }

    botMsg.versions.push('');
    botMsg.activeVersion = botMsg.versions.length - 1;
    botMsg.text = '';

    const existingDiv = document.querySelector(`[data-message-index="${index}"]`);
    let bodyContainer = null;
    
    if (existingDiv) {
        bodyContainer = existingDiv.querySelector('.message-body-container');
        if (bodyContainer) {
            bodyContainer.innerHTML = '<span></span><span></span><span></span>';
            bodyContainer.classList.add('loading');
        }
    }

    await streamChatResponse(index, bodyContainer);
}

function buildSuggestSystemPrompt() {
    const personaName = currentPersona ? currentPersona.name : 'User';
    const characterName = currentCharacter.data.name;

    let prompt = `You are ${personaName}.`;
    if (currentPersona?.description) prompt += ` ${currentPersona.description}`;
    prompt += `\n\nYou are talking with ${characterName}.`;
    if (currentCharacter.data.description) prompt += ` ${currentCharacter.data.description}`;
    prompt += `\n\nWrite a single short in-character reply as ${personaName}. Do not write for ${characterName}.`;

    return { prompt, personaName, characterName };
}

async function suggestUserMessage() {
    if (userInput.value.trim()) {
        userInput.value = '';
        userInput.style.height = 'auto';
        return;
    }

    if (!currentCharacter) { showCustomAlert('Select a character first'); return; }

    const personaName = currentPersona ? currentPersona.name : 'User';
    const characterName = currentCharacter.data.name;

    let systemPrompt = `You are ${personaName}.`;
    if (currentPersona?.description) systemPrompt += ` ${currentPersona.description}`;
    systemPrompt += `\n\nYou are talking with ${characterName}.`;
    if (currentCharacter.data.description) systemPrompt += ` ${currentCharacter.data.description}`;

    let conversationHistory = '';
    chatHistory.forEach(msg => {
        conversationHistory += `${msg.isUser ? personaName : characterName}: ${msg.text}\n`;
    });

    const suggestBtn = document.getElementById('suggestBtn');
    suggestBtn.disabled = true;
    userInput.disabled = true;
    userInput.placeholder = 'Generating response...';

    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemPrompt,
                conversationHistory,
                personaName: characterName,
                characterName: personaName,
            })
        });

        if (!response.ok) throw new Error('Server error');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        userInput.disabled = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.done || data.error) break;
                    if (data.token) {
                        fullText += data.token;
                        userInput.value = fullText;
                        userInput.style.height = 'auto';
                        const maxHeight = parseFloat(getComputedStyle(userInput).maxHeight);
                        const newHeight = Math.min(userInput.scrollHeight, maxHeight);
                        userInput.style.height = newHeight + 'px';
                        userInput.style.overflowY = newHeight >= maxHeight ? 'auto' : 'hidden';
                    }
                } catch(e) { console.error(e); }
            }
        }
    } catch(e) {
        showCustomAlert('Error: ' + e);
    } finally {
        suggestBtn.disabled = false;
        userInput.disabled = false;
        userInput.placeholder = currentCharacter ? `Write to ${currentCharacter.data.name}…` : 'Write a message…';
    }
}


// ─── Paste / suggest listeners (moved from main.js — 2nd great refactoring) ────
document.addEventListener('paste', (e) => {
    const avatarModal = document.getElementById('avatarGeneratorModal');
    if (avatarModal && avatarModal.classList.contains('active')) {
        handleAvatarPaste(e);
    }
});

document.getElementById('suggestBtn').addEventListener('click', suggestUserMessage);