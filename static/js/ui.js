//ui.js

// Staggered up+fade reveal for a batch of grid cards (character/persona
// lists) — same restart-reliability pattern as the chat message reveal in
// chat.js (see _staggerMessageRows there for the full rationale): re-adding
// an already-present class is a no-op to the browser, so a container
// re-rendered repeatedly (typing in the search box, switching tabs back and
// forth) needs an explicit remove → reflow → re-add cycle to actually
// replay the animation each time rather than only on the very first render.
// Caps how many cards stagger individually so a long list doesn't drag the
// tail out — same 8-card cap and 18ms step as the chat message reveal, for
// a consistent feel across the app.
const CARD_STAGGER_CAP = 8;
const CARD_STAGGER_STEP_MS = 18;

function _staggerCardReveal(container) {
    if (!container) return;
    const cards = container.querySelectorAll('.character-card');
    if (!cards.length) return;

    container.classList.remove('stagger-play');
    cards.forEach(card => card.classList.remove('card-stagger-in'));
    void container.offsetHeight;

    cards.forEach((card, i) => {
        card.classList.add('card-stagger-in');
        card.style.setProperty('--stagger-i', Math.min(i, CARD_STAGGER_CAP));
    });

    requestAnimationFrame(() => {
        container.classList.add('stagger-play');
    });
}

// display:none kills an element instantly, so a modal's *Out keyframes
// (see modals.css) only get a chance to run if .active removal is
// delayed until the animation actually finishes. This adds .closing
// (which keeps display:flex and plays the reverse animation), waits for
// animationend on the backdrop itself, then swaps to .active removed —
// with a timeout fallback in case animationend never fires (e.g. the
// element was already hidden some other way).
//
// _pendingClose tracks, per modal, the in-flight close's cancel function.
// Needed because showConfirm can legitimately be called again for the
// same modal before a prior close has actually finished animating (e.g.
// confirm "Switch model?" -> Yes -> backend reports vram_warning ->
// confirmSelectModel immediately calls showConfirm again for the same
// #confirmModal). Without this, the *old* close's animationend/timeout
// fires after the *new* open already set .active, and strips it back off
// — the modal flashes open for a frame then vanishes. Opening cancels
// any pending close for that modal before proceeding.
const _pendingClose = new WeakMap();

function _cancelPendingClose(modal) {
    const cancel = _pendingClose.get(modal);
    if (cancel) {
        cancel();
        _pendingClose.delete(modal);
    }
}

function _closeModalAnimated(modal, extraCleanup) {
    if (!modal || !modal.classList.contains('active')) {
        if (extraCleanup) extraCleanup();
        return;
    }
    modal.classList.add('closing');
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        _pendingClose.delete(modal);
        modal.classList.remove('active', 'closing');
        if (extraCleanup) extraCleanup();
    };
    modal.addEventListener('animationend', finish, { once: true });
    // var(--dur) is 180ms — 400ms is a generous ceiling above that so a
    // missed animationend (rather than a legitimately slower animation)
    // can't leave the modal stuck in .closing forever.
    const timeoutId = setTimeout(finish, 400);

    // Registers a way to cancel this close outright (used when the same
    // modal is reopened before this close finished) — marks done so the
    // in-flight animationend/timeout become no-ops, and drops .closing
    // immediately so the next .active add isn't fighting leftover state.
    _pendingClose.set(modal, () => {
        done = true;
        clearTimeout(timeoutId);
        modal.classList.remove('closing');
    });
}

function showConfirm(text, onYes) {
    const confirmModal = document.getElementById('confirmModal');
    _cancelPendingClose(confirmModal);
    const confirmText = confirmModal.querySelector('.confirm-text');
    const originalText = confirmText.innerHTML;

    confirmText.innerHTML = text;
    confirmModal.classList.add('active');

    const yesBtn = confirmModal.querySelector('.confirm-yes');
    const noBtn = confirmModal.querySelector('.confirm-no');

    const originalYesText = yesBtn.textContent;
    yesBtn.textContent = 'Yes';

    const cleanup = () => {
        _closeModalAnimated(confirmModal, () => {
            confirmText.innerHTML = originalText;
            yesBtn.textContent = originalYesText;
        });
        yesBtn.removeEventListener('click', handleYes);
        noBtn.removeEventListener('click', handleNo);
    };

    const handleYes = () => { cleanup(); onYes(); };
    const handleNo = () => { cleanup(); };

    yesBtn.addEventListener('click', handleYes);
    noBtn.addEventListener('click', handleNo);
}

function showCustomAlert(message) {
    const alertModal = document.getElementById('customAlert');
    _cancelPendingClose(alertModal);
    document.getElementById('customAlertText').innerHTML = message;
    alertModal.classList.add('active');
}

function closeCustomAlert() {
    _closeModalAnimated(document.getElementById('customAlert'));
}

function closeConfirm() {
    _closeModalAnimated(document.getElementById('confirmModal'), () => {
        deleteCharacterId = null;
    });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('visible');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('visible');
}

function openAvatarModal(imageSrc) {
    const modal = document.getElementById('avatarModal');
    _cancelPendingClose(modal);
    document.getElementById('avatarModalImage').src = imageSrc;
    modal.classList.add('active');
}

function closeAvatarModal() {
    _closeModalAnimated(document.getElementById('avatarModal'));
}

// Actually flips a view to visible. Split out of switchView so the
// same "make it appear" step can either run immediately (nothing was
// showing before) or be deferred until an outgoing view has finished
// leaving (see the sequential handoff in switchView).
function _showView(nextEl) {
    // Forcing a reflow matters here: nextEl starts from opacity:0 /
    // visibility:hidden. Adding .active on the very next line without
    // ever reading a layout property in between lets the browser
    // coalesce the "before" and "after" style into a single frame — no
    // transition plays, the view just snaps straight to its end state.
    // Reading offsetHeight forces the browser to compute/paint the
    // pre-.active layout first, giving the following change a real
    // starting frame to transition away from.
    void nextEl.offsetHeight;
    nextEl.classList.add('active');

    if (nextEl.id === 'chatView') {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const chatMessages = document.getElementById('chatMessages');
                if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
            });
        });
        // Re-runs the side-entry message animation every time the chat tab
        // becomes active — not just on first load/character switch (those
        // already trigger it themselves via reloadChat/loadCharacter, before
        // this view-level hook even runs). Guarded because chat.js may not
        // be loaded yet in edge cases (script order), though in practice it
        // always is by the time a view switch can happen.
        if (typeof replayMessageStagger === 'function') replayMessageStagger();
    } else if (nextEl.id === 'modelSwitchView') {
        _staggerSettingsReveal();
    } else if (nextEl.id === 'loadView' || nextEl.id === 'loadPersonaView') {
        // Mirrors the chat/settings hooks above: switchView kicks off the
        // character/persona list fetch+render in parallel with this view
        // transition (see the comment in renderCharacterCards), so the
        // render can finish before or after the view is actually visible.
        // Firing here too — in addition to the one at the end of
        // renderCharacterCards — covers the "render finished first, view
        // became visible second" ordering; the other one covers the
        // reverse. Whichever fires later is the one that actually plays
        // visibly; the earlier one animates inside a still-hidden
        // container and is effectively wasted but harmless.
        const grid = nextEl.querySelector('.character-grid');
        if (grid && typeof _staggerCardReveal === 'function') _staggerCardReveal(grid);
    }
}

// Alternating left/right stagger-reveal for the Settings view's stacked
// blocks — same restart-reliability pattern as _staggerCardReveal above
// (remove → reflow → re-add, paused → running via a container class), but
// simpler geometry: no grid to derive left/right from, just alternation by
// each direct child's position in the stack. Only the *direct children* of
// .view-body get the class — nested content inside a settings-section
// (labels, sliders, the accordion's own inner rows) shouldn't each fly in
// separately, only the section as a whole.
const SETTINGS_STAGGER_STEP_MS = 60;

function _staggerSettingsReveal() {
    const view = document.getElementById('modelSwitchView');
    if (!view) return;
    const body = view.querySelector('.view-body');
    if (!body) return;
    const blocks = Array.from(body.children);
    if (!blocks.length) return;

    body.classList.remove('stagger-play');
    blocks.forEach(b => b.classList.remove('settings-stagger-in'));
    void body.offsetHeight;

    blocks.forEach((block, i) => {
        block.classList.add('settings-stagger-in');
        block.style.setProperty('--stagger-i', i);
    });

    requestAnimationFrame(() => {
        body.classList.add('stagger-play');
    });
}

function switchView(view) {
    closeSidebar();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const views = {
        'chat':          { id: 'chatView',           tab: 0 },
        'create':        { id: 'createView',         tab: 1 },
        'load':          { id: 'loadView',           tab: 2 },
        'chatList':      { id: 'chatListView',        tab: -1 },
        'createPersona': { id: 'createPersonaView',  tab: 3 },
        'loadPersona':   { id: 'loadPersonaView',    tab: 4 },
        'modelSwitch':   { id: 'modelSwitchView',    tab: 5 },
        'lorebooks':     { id: 'lorebooksView',      tab: 6 },
        'textReplace':   { id: 'textReplaceView',    tab: 7 },
    };

    const target = views[view];
    if (!target) return;

    const nextEl = document.getElementById(target.id);
    if (!nextEl) return;

    // Sequential handoff, not a cross-fade: the outgoing view fully
    // finishes leaving (opacity+transform out) before the incoming one
    // starts appearing. A cross-fade had both views' geometry live at
    // once — on mobile especially, the still-departing view's content
    // visibly collided with the arriving one instead of a clean swap.
    // _showView (below) is what actually flips .active on nextEl; it's
    // either called right away (nothing was showing) or deferred until
    // the outgoing view's transitionend fires.
    const prevEl = document.querySelector('.view.active');

    if (prevEl && prevEl !== nextEl) {
        prevEl.classList.remove('active');
        prevEl.classList.add('view-leaving');
        let started = false;
        const startNext = () => {
            if (started) return;
            started = true;
            prevEl.classList.remove('view-leaving');
            _showView(nextEl);
        };
        prevEl.addEventListener('transitionend', startNext, { once: true });
        // var(--dur) is 180ms — 300ms is a ceiling above that so a missed
        // transitionend (e.g. the tab was backgrounded mid-animation)
        // can't leave the app stuck with no view visible at all.
        setTimeout(startNext, 300);
    } else {
        _showView(nextEl);
    }

    // Everything below is app *state*, not visual presentation — which
    // tab is logically active, what data a view needs loaded. This runs
    // immediately regardless of the animation above, so e.g. the
    // character list is already fetched and ready by the time the view
    // actually becomes visible, instead of the view arriving empty and
    // populating a beat later.
    currentView = view;
    saveAppState();

    const tabs = document.querySelectorAll('.tab-btn');
    if (tabs[target.tab]) {
        tabs[target.tab].classList.add('active');
    }

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (navBtn) navBtn.classList.add('active');

    if (view === 'load') {
        loadCharacterList();
        editingCharacterId = null;
    } else if (view === 'loadPersona') {
        loadPersonaList();
        editingPersonaId = null;
    } else if (view === 'lorebooks') {
        if (typeof loadLorebookList === 'function') loadLorebookList();
        editingLorebookId = null;
    } else if (view === 'modelSwitch') {
        updateModelUI();
    } else if (view === 'create' && !editingCharacterId) {
        document.querySelector('.save-btn').textContent = 'Save character';
        // Covers entering 'create' via any path other than the + button
        // (e.g. a nav-btn with data-view="create") — makes sure the preview
        // always shows a freshly-picked default rather than whatever was
        // left over from a previous visit.
        if (typeof _pickAndPreviewDefaultAvatar === 'function') _pickAndPreviewDefaultAvatar();
    } else if (view === 'createPersona' && !editingPersonaId) {
        const saveBtn = document.querySelectorAll('.save-btn')[1];
        if (saveBtn) saveBtn.textContent = 'Save persona';
        if (typeof _pickAndPreviewPersonaDefaultAvatar === 'function') _pickAndPreviewPersonaDefaultAvatar();
    }
    saveAppState();
}

function showSummarizeModal() {
    const modal = document.getElementById('summarizeModal');
    _cancelPendingClose(modal);
    const body = document.getElementById('summarizeBody');
    const buttons = document.getElementById('summarizeButtons');
    const cancelOnly = document.getElementById('summarizeCancelOnly');

    body.innerHTML = '<div class="loading"><span></span><span></span><span></span></div>';
    buttons.style.display = 'none';
    cancelOnly.style.display = 'flex';
    modal.classList.add('active');
}

function closeSummarizeModal() {
    _closeModalAnimated(document.getElementById('summarizeModal'));
}

document.addEventListener('DOMContentLoaded', () => {

    const searchInput = document.getElementById('sidebarSearch');

    searchInput.addEventListener('input', () => {
        const activeTab = document.querySelector('.sidebar-tab.active')?.dataset.tab;

        if (activeTab === 'characters') {
            filterCharacters(searchInput.value);
        } else if (activeTab === 'personas') {
            filterPersonas(searchInput.value);
        }
    });

    const tabs = document.querySelectorAll('.sidebar-tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const type = tab.dataset.tab;

            if (type === 'characters') {
                loadCharacterList();
            } else if (type === 'personas') {
                loadPersonaList();
            }
        });
    });

    const createBtn = document.getElementById('createEntityBtn');

    createBtn.addEventListener('click', () => {
        const activeTab = document.querySelector('.sidebar-tab.active')?.dataset.tab;

        if (activeTab === 'characters') {
            if (typeof _resetCharacterForm === 'function') _resetCharacterForm();
            switchView('create');
        } else if (activeTab === 'personas') {
            if (typeof _resetPersonaForm === 'function') _resetPersonaForm();
            switchView('createPersona');
        }
    });

    // default
    loadCharacterList();
});