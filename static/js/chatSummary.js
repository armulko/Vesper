// chatSummary.js
// Conversation summarization: per-message summarize, meta-summarize,
// summary browser modal, unarchive.
// Split out of chat.js (2nd great refactoring).

async function summarizeHistory(index, btn) {
    const messagesToSum = chatHistory.slice(0, index + 1)
        .filter(m => !m.isArchived && !m.isSummary)
        .map(msg => `${msg.isUser ? 'User' : 'AI'}: ${msg.text}`);

    if (messagesToSum.length === 0) return showCustomAlert('Nothing to compress here');

    const modal = document.getElementById('summarizeModal');
    const body = document.getElementById('summarizeBody');
    const buttons = document.getElementById('summarizeButtons');
    const cancelOnly = document.getElementById('summarizeCancelOnly');
    const applyBtn = document.getElementById('summarizeApplyBtn');
    const cancelOnlyBtn = document.getElementById('summarizeCancelOnlyBtn');
    const cancelBtn = document.getElementById('summarizeCancelBtn');

    showSummarizeModal();

    let aborted = false;
    let summaryText = '';

    cancelOnlyBtn.onclick = () => { aborted = true; closeSummarizeModal(); };

    try {
        const previousSummaries = chatHistory
            .slice(0, index + 1)
            .filter(m => m.isSummary)
            .map(m => m.text.replace(/^📜 \[CONTEXT OF THE PAST\]:\n/, ''));

        const response = await fetch(`${BASE_URL}/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: messagesToSum, previousSummaries })
        });

        if (!response.ok) throw new Error('Server error');

        body.textContent = '';
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
                        if (aborted) return;
                        summaryText += data.token;
                        body.textContent = summaryText;
                    }
                } catch(e) { console.error(e); }
            }
        }

        if (aborted) return;

        cancelOnly.style.display = 'none';
        buttons.style.display = 'flex';

        applyBtn.onclick = () => {
            closeSummarizeModal();
            for (let i = 0; i <= index; i++) {
                if (!chatHistory[i].isSummary) chatHistory[i].isArchived = true;
            }
            chatHistory.splice(index + 1, 0, {
                text: `📜 [CONTEXT OF THE PAST]:\n${summaryText}`,
                isUser: false,
                isSummary: true
            });
            saveChatHistory();
            updateTokenCount();
            reloadChat();
        };

        cancelBtn.onclick = () => closeSummarizeModal();

    } catch (e) {
        if (!aborted) {
            closeSummarizeModal();
            showCustomAlert('Error: ' + e.message);
        }
    }
}

function unarchiveFrom(index) {
    showConfirm('Return archived messages to the AI context?', () => {
        let start = 0;
        for (let i = index - 1; i >= 0; i--) {
            if (chatHistory[i].isSummary) {
                start = i + 1;
                break;
            }
        }
        for (let i = start; i < index; i++) {
            chatHistory[i].isArchived = false;
        }
        chatHistory.splice(index, 1);
        saveChatHistory();
        reloadChat();
    });
}

document.getElementById('clearChatBtn')?.addEventListener('click', () => {
    showConfirm('Clear the entire chat history?', () => {
        chatHistory = [];
        saveChatHistory();
        reloadChat();
        updateTokenCount();
    });
});


function renderStreamChunk(container, fullText) {
    const prevLen = parseInt(container.dataset.prevLen || '0');
    if (fullText.length <= prevLen) return;

    const newChunk = fullText.slice(prevLen);
    container.dataset.prevLen = fullText.length;

    const inItalic = container.dataset.inItalic === 'true';
    const nextInItalic = parseAndAppend(container, newChunk, inItalic);
    container.dataset.inItalic = nextInItalic;
}

function parseAndAppend(container, chunk, inItalic) {
    const rawParts = chunk.split('*');
    let currentItalic = inItalic;

    rawParts.forEach((part, i) => {
        if (part.length > 0) {
            appendTextNode(container, part, currentItalic);
        }
        if (i < rawParts.length - 1) {
            currentItalic = !currentItalic;
        }
    });

    return currentItalic;
}

function appendTextNode(container, text, italic) {
    const lines = text.split('\n');
    // lastWasBr tracks whether the last node appended to this container was
    // a line break with no text after it yet — lets us collapse runs of
    // blank lines live, as tokens arrive, instead of only fixing it up in
    // the final parseMarkdown() pass after the stream ends.
    let lastWasBr = container.dataset.lastWasBr === 'true';

    lines.forEach((line, i) => {
        if (line.length > 0) {
            const span = document.createElement('span');
            span.textContent = line;
            if (italic) span.className = 'markdown-italic';
            span.classList.add('token-appear');
            container.appendChild(span);
            lastWasBr = false;
        }
        if (i < lines.length - 1) {
            if (!lastWasBr) {
                container.appendChild(document.createElement('br'));
                lastWasBr = true;
            }
            // else: this \n would produce a second consecutive <br> — drop it
        }
    });

    container.dataset.lastWasBr = lastWasBr;
}

function openSummaryBrowser() {
  const summaries = chatHistory
    .map((m, i) => ({ msg: m, index: i }))
    .filter(({ msg }) => msg.isSummary);

  const list = document.getElementById('summaryBrowserList');
  list.innerHTML = '';

  summaries.forEach(({ msg, index }, n) => {
    const item = document.createElement('div');
    item.className = 'summary-browser-item';

    const num = document.createElement('div');
    num.className = 'summary-browser-num';
    num.textContent = `#${n + 1}`;

    const preview = document.createElement('div');
    preview.className = 'summary-browser-preview';
    preview.textContent = msg.text.replace(/^📜 \[CONTEXT OF THE PAST\]:\n/, '');

    item.appendChild(num);
    item.appendChild(preview);
    item.onclick = () => {
      closeSummaryBrowser();
      const el = chatMessages.querySelector(`[data-message-index="${index}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    list.appendChild(item);
  });

  document.getElementById('summaryBrowserModal').classList.add('active');
}

function closeSummaryBrowser() {
  _closeModalAnimated(document.getElementById('summaryBrowserModal'));
}

async function metaSummarize() {
  const summaryBlocks = chatHistory
    .map((m, i) => ({ msg: m, index: i }))
    .filter(({ msg }) => msg.isSummary);

  if (summaryBlocks.length < 2) return showCustomAlert('Need at least 2 summaries to merge');

  closeSummaryBrowser();

  const summaries = summaryBlocks.map(({ msg }) =>
    msg.text.replace(/^📜 \[CONTEXT OF THE PAST\]:\n/, '')
  );

  const modal = document.getElementById('summarizeModal');
  const body = document.getElementById('summarizeBody');
  const buttons = document.getElementById('summarizeButtons');
  const cancelOnly = document.getElementById('summarizeCancelOnly');
  const applyBtn = document.getElementById('summarizeApplyBtn');
  const cancelOnlyBtn = document.getElementById('summarizeCancelOnlyBtn');
  const cancelBtn = document.getElementById('summarizeCancelBtn');

  showSummarizeModal();

  let aborted = false;
  let summaryText = '';

  cancelOnlyBtn.onclick = () => { aborted = true; closeSummarizeModal(); };

  try {
    const response = await fetch(`${BASE_URL}/meta_summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summaries })
    });

    if (!response.ok) throw new Error('Server error');

    body.textContent = '';
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
            if (aborted) return;
            summaryText += data.token;
            body.textContent = summaryText;
          }
        } catch(e) { console.error(e); }
      }
    }

    if (aborted) return;

    cancelOnly.style.display = 'none';
    buttons.style.display = 'flex';

    applyBtn.onclick = () => {
      closeSummarizeModal();
      const lastSummaryIndex = summaryBlocks[summaryBlocks.length - 1].index;
      summaryBlocks.forEach(({ index }) => {
        chatHistory[index].isArchived = true;
        chatHistory[index].isSummary = false;
    });
      chatHistory.splice(lastSummaryIndex + 1, 0, {
        text: `📜 [CONTEXT OF THE PAST]:\n${summaryText}`,
        isUser: false,
        isSummary: true
      });
      saveChatHistory();
      updateTokenCount();
      reloadChat();
    };

    cancelBtn.onclick = () => closeSummarizeModal();

  } catch(e) {
    if (!aborted) {
      closeSummarizeModal();
      showCustomAlert('Error: ' + e.message);
    }
  }
}

function updateSummaryBrowserBtn() {
  const count = chatHistory.filter(m => m.isSummary).length;
  const btn = document.getElementById('summaryBrowserBtn');
  const badge = document.getElementById('summaryBrowserBadge');
  const metaWrap = document.getElementById('metaSummaryBtnWrap');
  if (count > 0) {
    btn.classList.remove('hidden');
    badge.textContent = count;
    if (metaWrap) metaWrap.style.display = count > 1 ? 'flex' : 'none';
  } else {
    btn.classList.add('hidden');
    badge.textContent = '';
    if (metaWrap) metaWrap.style.display = 'none';
  }
}


