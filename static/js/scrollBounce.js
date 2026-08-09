// ── Rubber-band bounce on scroll overscroll ──
// Purely cosmetic: when the user keeps scrolling/swiping past the top or
// bottom edge of .chat-messages, nudge the content with a short spring
// snap-back instead of doing nothing.
//
// IMPORTANT: we never transform #chatMessages itself (that's the scroll
// container — moving it takes it out of flow and it visually overlaps
// neighbours like the sidebar header / input bar, since transform doesn't
// participate in layout). Instead #chatMessagesInner (declared in index.html,
// and the element chat.js appends/clears messages into) is what gets
// transformed, while #chatMessages keeps clipping via its own overflow.

(function () {
  const OVERSCROLL_PX = 40;      // max visual pull distance
  const RAW_PULL_CAP = OVERSCROLL_PX * 1.6; // hard stop on input — can't crank forever
  const WHEEL_TO_PX = 0.6;       // how much of a wheel delta counts as "pull"
  const BOUNCE_MS = 380;         // matches the CSS transition below
  const WHEEL_IDLE_MS = 70;      // no wheel event within this window = gesture over

  function initScrollBounce() {
    const el = document.getElementById('chatMessages');
    const inner = document.getElementById('chatMessagesInner');
    if (!el || !inner || el.dataset.bounceInit) return;
    el.dataset.bounceInit = 'true';

    let pull = 0;                // current visual offset, px (+down / -up)
    let raf = null;
    let activePointer = false;   // true while a wheel/touch drag is live
    let touchStartY = null;
    let touchStartRawPull = 0;
    let wheelIdleTimer = null;   // wheel events have no natural "gesture end"

    function atTop() { return el.scrollTop <= 0; }
    function atBottom() { return el.scrollTop + el.clientHeight >= el.scrollHeight - 1; }

    function render() {
      inner.style.transform = pull ? `translateY(${pull}px)` : '';
    }

    // Rubber-band resistance: raw pull grows linearly with input, but the
    // visual result compresses as it approaches the max — same curve iOS
    // uses for overscroll, so it reads as "pushing against something" and
    // not just a capped linear drag. Resistance ramps up fast near the edge.
    // rawPull itself is hard-capped (RAW_PULL_CAP) — past that point extra
    // input does nothing at all, so holding the wheel down can't hold the
    // pull up forever; it genuinely maxes out like hitting a wall.
    function rubberBand(raw) {
      const max = OVERSCROLL_PX;
      const sign = raw < 0 ? -1 : 1;
      const abs = Math.min(Math.abs(raw), RAW_PULL_CAP);
      return sign * (max * (1 - Math.exp(-abs / max)));
    }

    let rawPull = 0; // accumulated input, hard-capped, feeds rubberBand()

    function applyPull(rawPx) {
      rawPull = Math.max(-RAW_PULL_CAP, Math.min(RAW_PULL_CAP, rawPx));
      pull = rubberBand(rawPull);
      inner.style.transition = 'none';
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    }

    function snapBack() {
      activePointer = false;
      touchStartY = null;
      rawPull = 0;
      if (wheelIdleTimer) { clearTimeout(wheelIdleTimer); wheelIdleTimer = null; }
      if (pull === 0) return;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      inner.style.transition = `transform ${BOUNCE_MS}ms var(--ease-spring)`;
      inner.style.transform = '';
      pull = 0;
    }

    // Desktop / trackpad — like touchend for touch, debounce treats a gap
    // between wheel events (WHEEL_IDLE_MS) as the gesture ending, and snaps.
    // Also snaps immediately if the next tick reverses direction (user
    // pulled off the wheel / scrolled the other way) instead of waiting
    // out the idle window — matches how a finger lifting off feels instant.
    el.addEventListener('wheel', (e) => {
      const tryingUp = e.deltaY < 0 && atTop();
      const tryingDown = e.deltaY > 0 && atBottom();
      if (!tryingUp && !tryingDown) {
        if (pull !== 0) snapBack();
        return;
      }
      e.preventDefault();

      const delta = -e.deltaY * WHEEL_TO_PX;
      if (pull !== 0 && Math.sign(delta) !== Math.sign(pull)) {
        snapBack();
        return;
      }

      activePointer = true;
      applyPull(rawPull + delta);

      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(snapBack, WHEEL_IDLE_MS);
    }, { passive: false });

    el.addEventListener('mouseleave', snapBack);
    window.addEventListener('mouseup', () => { if (activePointer) snapBack(); });
    window.addEventListener('blur', snapBack);

    // Touch
    el.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
      touchStartRawPull = rawPull;
      activePointer = true;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (touchStartY === null) return;
      const dy = e.touches[0].clientY - touchStartY;
      const tryingDown = dy > 0 && atTop();   // finger drags down while at top
      const tryingUp = dy < 0 && atBottom();  // finger drags up while at bottom
      if (!tryingDown && !tryingUp) {
        // left the overscroll zone (e.g. content scrolled back into view) —
        // release instead of holding a stale pull
        if (pull !== 0) snapBack();
        return;
      }
      e.preventDefault();
      applyPull(touchStartRawPull + dy * 0.5);
    }, { passive: false });

    // touchend AND touchcancel both must release — a cancelled gesture
    // (e.g. the OS/browser reclaims it for its own scroll/nav gesture)
    // never fires touchend, which was leaving `pull` stuck.
    el.addEventListener('touchend', snapBack);
    el.addEventListener('touchcancel', snapBack);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollBounce);
  } else {
    initScrollBounce();
  }
})();