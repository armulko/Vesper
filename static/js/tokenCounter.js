// js/tokenCounter.js
// Character-form token counting: debounced exact counts via /count_field_tokens,
// falls back to length/4 approximation when the LLM backend is unavailable.

// ── Character form: token counters ──────────────────────────────
//
// Token counts come from /count_field_tokens, which runs the text through
// the actually-loaded model's tokenizer (llama-server /tokenize). Debounced
// per-field (350ms) so typing doesn't spam the backend with a request per
// keystroke.
//
// No approximate/instant number is shown anymore — a counter just keeps
// displaying its last known exact value until the new exact value comes
// back and replaces it. Less "live" than a flickering estimate, but never
// shows a number that's actually wrong.
//
// Known compromise (see backend note in count_field_tokens): each field is
// tokenized in isolation, so the total ignores chat-template wrapper tokens
// (role headers, BOS/EOS, etc.) added at actual prompt-assembly time. Good
// enough to gauge "am I anywhere close to context limit", not an exact
// prompt simulator. If the LLM isn't currently loaded (e.g. app is in Image
// mode), the backend falls back to the old length/4 estimate rather than
// erroring — the counter should never block typing, it'll just be less
// exact for that one request.

const _TOKEN_DEBOUNCE_MS = 350;
const _fieldTokenDebounce = {};    // tokenKey -> timeout handle
const _fieldTokenCache = {};       // tokenKey -> last known token count
const _fieldTokenApprox = {};      // tokenKey -> true if that count is the len/4 fallback, not the real tokenizer

// Backend returns {tokens, approximate: true} when llama-server is down/not
// loaded and it falls back to a length/4 guess instead of the real tokenizer
// count. Previously that flag was read from the response and then dropped on
// the floor — the UI showed the guess as if it were exact, so "am I near the
// context limit" could be quietly wrong with no indication why.
async function _fetchTokenCount(text) {
    if (!text) return { tokens: 0, approximate: false };
    try {
        const r = await fetch(`${BASE_URL}/count_field_tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await r.json();
        return { tokens: data.tokens ?? 0, approximate: !!data.approximate };
    } catch {
        return null; // network hiccup — caller keeps the last known value
    }
}

function _resetTokenCache() {
    Object.keys(_fieldTokenCache).forEach(k => delete _fieldTokenCache[k]);
    Object.keys(_fieldTokenApprox).forEach(k => delete _fieldTokenApprox[k]);
}

// Debounced exact-count fetch for one field. tokenKey is whatever the
// caller wants to key the cache by — static fields use their fixed
// data-target id ('desc-tok' etc), dynamic greeting/char-book fields use a
// per-textarea key (see _bindTokenCounter in characters.js) so each entry
// tracks its own count independently of its position in the list.
function _updateFieldTokenCount(text, tokenKey, onUpdate) {
    clearTimeout(_fieldTokenDebounce[tokenKey]);
    _fieldTokenDebounce[tokenKey] = setTimeout(async () => {
        const result = await _fetchTokenCount(text);
        if (result === null) return; // request failed — leave cache/display untouched
        _fieldTokenCache[tokenKey] = result.tokens;
        _fieldTokenApprox[tokenKey] = result.approximate;
        onUpdate(result.tokens, result.approximate);
        _updateTotalTokens();
    }, _TOKEN_DEBOUNCE_MS);
}

function _onFieldInput(textarea, tokenTargetId) {
    const counter = document.querySelector(`.field-token-count[data-target="${tokenTargetId}"]`);
    _updateFieldTokenCount(textarea.value, tokenTargetId, (count, approximate) => {
        if (counter) counter.textContent = approximate ? `~${count} tok` : `${count} tok`;
    });
    _validateSaveBtn();
}

// characterName has no visible per-field counter, but its tokens still
// count toward the total — tracked under a fixed cache key like the others.
function _onNameInput(input) {
    _updateFieldTokenCount(input.value, 'name-tok', () => {});
    _validateSaveBtn();
    _updateTotalTokens();
}

// Sums every cached field count that currently applies to the form: the
// fixed fields (name + the 8 static textareas) plus every dynamically
// rendered greeting/char-book textarea present right now. Previously the
// "exact" total silently ignored name/greetings/char-book and bailed out
// to the approximate total the moment any one field was still pending —
// this version just adds up whatever's in cache and updates as each field
// resolves, so it converges to the real total instead of flashing between
// two different numbers.
//
// If ANY field's count came from the length/4 fallback, the whole total is
// only as good as its worst input — flagging one field as approximate and
// not the total would misleadingly imply the sum is still exact.
function _updateTotalTokens() {
    const staticKeys = [
        'name-tok', 'desc-tok', 'firstmes-tok', 'personality-tok', 'scenario-tok',
        'mesexample-tok', 'sysprompt-tok', 'posthist-tok', 'creatornotes-tok'
    ];
    let total = 0;
    let anyApprox = false;
    staticKeys.forEach(key => {
        total += _fieldTokenCache[key] || 0;
        if (_fieldTokenApprox[key]) anyApprox = true;
    });

    document.querySelectorAll('.alt-greeting-textarea, .charbook-content').forEach(ta => {
        const key = ta.dataset.tokenId;
        if (key) {
            total += _fieldTokenCache[key] || 0;
            if (_fieldTokenApprox[key]) anyApprox = true;
        }
    });

    const container = document.getElementById('charTotalTokens');
    if (container) {
        const valueEl = container.querySelector('.char-total-tokens-value');
        const labelEl = container.querySelector('.char-total-tokens-label');
        if (valueEl) valueEl.textContent = anyApprox ? `~${total}` : `${total}`;
        if (labelEl) labelEl.textContent = anyApprox ? 'tokens (estimated)' : 'tokens total';
        container.classList.toggle('char-total-tokens-approx', anyApprox);
    }
}

function _validateSaveBtn() {
    const name    = (document.getElementById('characterName')?.value || '').trim();
    const desc    = (document.getElementById('characterDescription')?.value || '').trim();
    const firstMes = (document.getElementById('characterFirstMes')?.value || '').trim();
    const btn = document.getElementById('saveCharacterBtn');
    if (btn) btn.disabled = !(name && desc && firstMes);
}

document.addEventListener('DOMContentLoaded', () => {
    ['characterName', 'characterDescription', 'characterFirstMes'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', _validateSaveBtn);
    });
    document.getElementById('characterName')?.addEventListener('input', function() { _onNameInput(this); });
});
