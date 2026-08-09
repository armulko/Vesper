// bgPattern.js
//
// Generates the decorative background pattern once per page load: a
// single large <svg>, injected behind every .view, with each motif
// placed as its own <g> at a randomized position/rotation/scale. This
// replaces the earlier pure-CSS tiled-background approach — a
// repeating background-image always reads as "the same thing over and
// over" no matter how the tile is designed, because it IS the same
// tile, just repeated. Real irregularity needs actual randomized
// placement, which only JS can do; CSS has no source of randomness to
// draw from.
//
// The pattern is generated ONCE at DOMContentLoaded and never touched
// again — this is deliberately not a per-frame or scroll-driven
// generator. A static field of shapes with a slow CSS transform drift
// on the whole <svg> (see .bg-pattern-svg in layout.css) gives the
// "alive" feel cheaply; regenerating shapes continuously would cost
// real CPU for a background nobody is meant to consciously watch.
//
// Motifs are faceted low-poly "crystals": a flat outline read as too
// plain at this density (earlier versions), so each motif here is
// built from several triangular facets fanning out from an
// off-center apex, each facet filled at a different opacity to fake
// directional lighting. That off-center apex is what actually sells
// the 3D read — a symmetric fan of identically-shaded triangles just
// looks like a decorated circle, not a gem.
//
// Each motif is its own <g> element (not baked into one flat path) so
// a later pass can animate individual motifs independently — e.g.
// slightly different drift phases per shape — without touching this
// generation logic again.

(function () {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    function randRange(min, max) {
        return min + Math.random() * (max - min);
    }

    // Builds one faceted crystal: `sides` outer points around a circle
    // of radius `s`, plus one apex offset from center (toward a fixed
    // "light" direction so the offset is consistent across every
    // crystal — if each one picked a random light direction the field
    // would look like glitter, not a coherent gem field). Each
    // triangular facet (apex -> outer point i -> outer point i+1) gets
    // its own fill-opacity based on the facet's angle relative to the
    // light direction, so facets facing the light read brighter than
    // ones facing away — that gradient across facets is the entire
    // illusion of depth.
    function buildCrystal(g, s, sides) {
        const LIGHT_ANGLE = -Math.PI / 4; // fixed "up-left" light source for every crystal
        const apexOffset = s * 0.35;
        const apexX = Math.cos(LIGHT_ANGLE) * apexOffset;
        const apexY = Math.sin(LIGHT_ANGLE) * apexOffset;

        const outer = [];
        for (let i = 0; i < sides; i++) {
            const angle = (Math.PI * 2 / sides) * i - Math.PI / 2;
            outer.push([s * Math.cos(angle), s * Math.sin(angle)]);
        }

        let markup = '';
        for (let i = 0; i < sides; i++) {
            const [x1, y1] = outer[i];
            const [x2, y2] = outer[(i + 1) % sides];

            // Facet's own facing angle, compared against the light
            // direction — closer alignment (smaller angular
            // difference) means more light hits it, so it gets a
            // higher fill-opacity. cos() maps that difference smoothly
            // to a 0..1 brightness curve instead of a hard step.
            const facetAngle = Math.atan2((y1 + y2) / 2, (x1 + x2) / 2);
            let diff = facetAngle - LIGHT_ANGLE;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const brightness = (Math.cos(diff) + 1) / 2; // 0 (away from light) .. 1 (facing light)
            const fillOpacity = (0.12 + brightness * 0.55).toFixed(2);

            markup += `<polygon points="${apexX.toFixed(1)},${apexY.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="currentColor" fill-opacity="${fillOpacity}" stroke="currentColor" stroke-opacity="0.5" stroke-width="0.5"/>`;
        }

        // Crisp outer silhouette on top of the shaded facets — without
        // this the crystal's edge against the page background is only
        // as sharp as the dimmest facet's stroke, which looks soft/
        // smudged rather than cut.
        const outline = outer.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        markup += `<polygon points="${outline}" fill="none" stroke="currentColor" stroke-opacity="0.7" stroke-width="0.6"/>`;

        g.innerHTML = markup;
    }

    // Facet counts to draw from — kept small (4-7) since more sides
    // at these sizes stop reading as distinct facets and blur back
    // into looking like a shaded circle.
    const SIDE_COUNTS = [4, 5, 6, 7];

    function buildMotif(g, size) {
        const sides = SIDE_COUNTS[Math.floor(Math.random() * SIDE_COUNTS.length)];
        buildCrystal(g, size, sides);
    }

    function generateBackgroundPattern() {
        const host = document.querySelector('.main-content');
        if (!host || host.querySelector('.bg-pattern-svg')) return; // already generated, or nothing to attach to

        // Oversize the generation area beyond the host element (not
        // the window!) so the slow CSS drift (see .bg-pattern-svg in
        // layout.css) never scrolls past the edge of the generated
        // field and exposes bare space.
        //
        // This MUST be measured from `host` itself, not
        // window.innerWidth/innerHeight — .main-content is narrower
        // than the window (the sidebar eats part of it), and the CSS
        // side positions this SVG via `inset: -300px` relative to
        // .main-content's own box. Sizing the SVG's viewBox off the
        // window while CSS sizes its rendered box off .main-content
        // meant the two disagreed by exactly the sidebar's width —
        // enough to shove the entire generated field out past the
        // visible area, which is exactly what "nothing renders at all"
        // looked like. Measuring both from the same element is what
        // actually keeps the viewBox and the rendered box in sync.
        const overscan = 900;
        const hostRect = host.getBoundingClientRect();
        if (hostRect.width < 1 || hostRect.height < 1) return; // host not laid out yet — bail rather than generate a field with a broken viewBox
        const w = hostRect.width + overscan * 2;
        const h = hostRect.height + overscan * 2;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.classList.add('bg-pattern-svg');
        svg.setAttribute('width', w);
        svg.setAttribute('height', h);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('aria-hidden', 'true');

        const group = document.createElementNS(SVG_NS, 'g');
        svg.appendChild(group);

        // Cell-based placement with per-cell jitter: a pure random
        // scatter tends to clump shapes together in some areas and
        // leave others empty (classic Poisson-disc problem), which
        // reads as uneven rather than organic. Dividing the field into
        // a loose grid and jittering each motif within its own cell
        // keeps roughly even coverage while still avoiding any
        // perfectly regular repeat.
        // Cell and inner jitter range widened again for more breathing
        // room between neighbors — each crystal also now wobbles in a
        // small orbit around its placement point (see below), so the
        // gap has to absorb that extra travel too, not just the
        // crystal's own footprint.
        // Cell size scales with the host's own width instead of being a
        // flat constant — a fixed 260px cell means ~5-6 columns on a
        // desktop-width host but only 1-2 on a phone-width one, which is
        // exactly what produced the "a few crystals floating alone"
        // look on mobile. Aiming for a roughly constant column COUNT
        // (~6) instead means the cell just gets smaller/denser on
        // narrow screens rather than the grid collapsing outright.
        const cell = Math.max(120, Math.min(260, w / 6));
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        // Base jitter range — each cell additionally randomizes its own
        // min/max around this per-cell below, so no two cells jitter
        // across an identical range. That per-cell randomization (plus
        // the row/col stagger) is what breaks up the "obviously a grid"
        // read: a fixed 0.3–0.7 range for every single cell means every
        // crystal sits a very similar relative distance from its cell
        // corner, which the eye picks up as alignment across rows/cols
        // even with the position itself randomized.
        const jitterMin = 0.3;
        const jitterMax = 0.7;

        for (let row = 0; row < rows; row++) {
            // Every other row is nudged half a cell sideways — like a
            // brick/hex offset instead of a pure grid. This alone does
            // most of the work of killing the "rows and columns" read,
            // since aligned columns are the strongest visual cue of a
            // grid, stronger than position jitter within a cell.
            const rowOffset = (row % 2 === 0) ? 0 : cell * 0.5;

            for (let col = 0; col < cols; col++) {
                if (Math.random() < 0.2) continue;

                // Per-cell jitter range: instead of every cell drawing
                // from the exact same [0.3, 0.7] window, each cell gets
                // its own slightly shifted window (still bounded so
                // crystals never cross into a neighboring cell's
                // territory). This is on top of the row stagger above —
                // between the two, no two neighboring crystals sit at a
                // visually "matching" offset from their respective cell
                // corners.
                const spread = randRange(0.08, 0.22);
                const center = randRange(0.42, 0.58);
                const cellJitterMin = Math.max(jitterMin, center - spread);
                const cellJitterMax = Math.min(jitterMax, center + spread);

                const size = randRange(40, 62);

                // Two nested <g>s split the motion into independent
                // parts: the outer one holds this crystal's fixed grid
                // position plus a slow orbital wobble (CSS animation,
                // see .bg-crystal in layout.css) that keeps it inside a
                // small radius around that point — it can never drift
                // into a neighboring cell's crystal because the orbit
                // itself is bounded, no collision checking needed. The
                // inner <g> only carries the shape's own spin, so
                // spinning doesn't also drag the crystal off its
                // orbital path (rotating a already-offset element
                // around its own origin would otherwise swing it
                // through a much wider arc than intended).
                const outer = document.createElementNS(SVG_NS, 'g');
                const cx = col * cell + rowOffset + randRange(cell * cellJitterMin, cell * cellJitterMax);
                const cy = row * cell + randRange(cell * cellJitterMin, cell * cellJitterMax);
                // Base position goes through the CSS `translate`
                // property (distinct from `transform`, and composited
                // together with it rather than overwriting it) rather
                // than an SVG transform="" attribute — the inner
                // .bg-crystal-spin group below animates `transform` via
                // CSS keyframes, and CSS transform on an element always
                // overrides an attribute transform outright rather than
                // combining with it, so the base position had to live
                // somewhere that composites with an animated transform
                // instead of getting overwritten by it.
                outer.style.translate = `${cx.toFixed(1)}px ${cy.toFixed(1)}px`;
                outer.classList.add('bg-crystal-orbit');
                // .bg-crystal-orbit no longer carries its own wobble
                // animation — an earlier version had one (a small
                // orbiting drift), but it reliably made the entire
                // field invisible at exactly 100% browser zoom for
                // reasons that resisted direct debugging (see the long
                // comment on .bg-crystal-spin in layout.css). The class
                // stays because bgPattern.js's <g> nesting structure
                // (this element wraps .bg-crystal-spin) is still used
                // for the self-rotation below.

                const spin = document.createElementNS(SVG_NS, 'g');
                spin.classList.add('bg-crystal-spin');
                const baseRotation = randRange(0, 360);
                spin.style.setProperty('--base-rotation', `${baseRotation.toFixed(1)}deg`);
                // Slow, and randomized direction — half spin one way,
                // half the other, so a dense field doesn't read as
                // everything turning in visible lockstep. Direction is
                // set via animation-direction (reverse flips the same
                // 0deg->360deg keyframes the other way); a negative
                // animation-duration is NOT how you reverse a CSS
                // animation — it's simply invalid and the browser
                // would drop it back to its default instead of running
                // it backward.
                spin.style.setProperty('--spin-duration', `${randRange(40, 90).toFixed(1)}s`);
                spin.style.setProperty('--spin-direction', Math.random() < 0.5 ? 'normal' : 'reverse');
                spin.style.setProperty('--spin-delay', `-${randRange(0, 90).toFixed(1)}s`);

                const scale = randRange(0.85, 1.2);
                // Same reasoning as the outer group's translate: scale
                // goes through the CSS `scale` property so it composites
                // with the rotate animation below instead of being
                // overwritten by it.
                spin.style.scale = `${scale.toFixed(2)}`;

                const motif = document.createElementNS(SVG_NS, 'g');
                buildMotif(motif, size);

                spin.appendChild(motif);
                outer.appendChild(spin);
                group.appendChild(outer);
            }
        }

        host.prepend(svg);
    }

    // requestAnimationFrame defers to just before the browser's next
    // paint — by that point layout is guaranteed to be fully computed,
    // which DOMContentLoaded alone doesn't guarantee (it fires once
    // the DOM tree is parsed, not necessarily once layout/reflow has
    // fully settled). This turned out to matter in practice: without
    // it, host.getBoundingClientRect() intermittently returned a
    // pre-final size specifically at 100% browser zoom, which threw
    // off the SVG's viewBox enough that the whole generated field
    // rendered outside the visible area — invisible, but still present
    // and correctly positioned by every other measure (DevTools showed
    // real geometry, real fill colors, real animation). Other zoom
    // levels happened to dodge the race by pure timing luck.
    function generateOnNextFrame() {
        requestAnimationFrame(generateBackgroundPattern);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', generateOnNextFrame);
    } else {
        generateOnNextFrame();
    }
})();