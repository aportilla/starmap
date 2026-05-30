// Shared infrastructure for the galaxy + system material modules:
// - The snapped-material registry that lets resize() push the new
//   buffer dims into every pixel-snapped shader in one call.
// - The glsl() helper that emits valid GLSL float literals from JS
//   numbers (always with a decimal point so 50 becomes "50.0", not the
//   bare "50" that glsl rejects as an int literal).
// - RASTER_PAD, the +2 rasterizer padding shared by all the
//   procedural-disc materials.
//
// Nothing in this file is view-specific. Galaxy materials live in
// ./galaxy.ts, the system-view planet material in ./planet.ts, and the
// smaller system-view materials in ./system-decor.ts; the snap-aware
// ones push into the registry below at construction time.

import type { ShaderMaterial } from 'three';

// Module-private list of every material that carries a uViewport
// uniform. The resize handler walks it and writes new buffer dims into
// each material — far simpler than threading a callback through every
// scene that owns one of these materials.
//
// Exported so galaxy.ts + planet.ts can push into it, but treat it as
// internal — outside consumers should call setSnappedLineViewport()
// rather than pushing directly.
//
// INVARIANT: exactly one scene is live at a time. This list and the
// viewport it carries are module-global, so whichever scene's
// ViewportSizer.apply ran last owns the dims written into every snapped
// material. That's correct only because the galaxy and system views are
// never on screen simultaneously — if both were live at once they'd fight
// over a single shared viewport and snap against the wrong buffer size.
export const snappedMaterials: ShaderMaterial[] = [];

// Push the current drawing-buffer dims into every snapped material. Called
// by the live scene's ViewportSizer; see the one-live-scene invariant on
// snappedMaterials above — there is no per-scene partitioning here.
export function setSnappedLineViewport(w: number, h: number): void {
  for (const m of snappedMaterials) m.uniforms.uViewport.value.set(w, h);
}

// JS number → glsl float literal. Always emits a decimal point so 50
// becomes "50.0", not the bare "50" that glsl rejects as an int literal.
export const glsl = (n: number): string => Number.isInteger(n) ? n.toFixed(1) : n.toString();

// Rasterizer padding around the integer-pixel disc, shared by the
// perspective stars shader and the planet disc. Adding +2 (preserving parity)
// keeps every fragment we care about safely inside the rasterized
// square so the rasterizer never has to make a tie-breaking call at the
// bounding-box edges that would drop a row/column on one side. Cost: a
// few extra discarded fragments per disc.
export const RASTER_PAD = 2;

// Parity-aware pixel-grid snap — the single GLSL source for every snapped
// vertex shader (perspective stars, planet/moon disc, snapped lines +
// dots). Maps a projected NDC position to the buffer-pixel grid:
//   oddOff 0   → integer pixel BOUNDARY (even-diameter discs, lines)
//   oddOff 0.5 → pixel CENTER (odd-diameter discs, 1-px dots)
// so each disc rasterizes symmetrically under the gl_FragCoord − center
// offset path and thin geometry stops shimmering. This crisp-pixel snap
// is load-bearing for the committed aesthetic, so it lives once here — a
// fix can't land in one shader and silently rot the others. Interpolate
// at pre-main scope, then call snapToPixelGrid(ndc, uViewport, oddOff).
export const PIXEL_SNAP_GLSL = /* glsl */ `
      vec2 snapToPixelGrid(vec2 ndc, vec2 viewport, float oddOff) {
        vec2 fp = (ndc * 0.5 + 0.5) * viewport;
        return floor(fp - oddOff + 0.5) + oddOff;
      }`;

// Shared snap→clip vertex epilogue: snap an NDC seed to the pixel grid,
// rebuild NDC from the snapped buffer-pixel coords, and re-apply the
// clip-space w/z so gl_Position lands at the snapped position while
// keeping the original depth + perspective divide intact. Centralizes the
// three-line tail every snapped vertex shader wrote by hand so the snap
// invariant lives in one place.
//
// Each call site declares its own `vec4 clip = projection * modelView *
// vec4(position, 1.0)` first (the .zw it carries differ per shader, and
// the stars shader also reads clip.xy/clip.w inside its seed), then passes:
//   ndcSeed  — the snap input. Usually `clip.xy / clip.w`; the stars
//              shader substitutes a focus-seed expression that short-
//              circuits to vec2(0.0) for the orbit-target vertex.
//   oddOff   — parity offset (0.0 lines / boundary, 0.5 dots / odd discs,
//              or a `mod(sz,2.0)*0.5` expression for the disc shaders).
// The snapped center is left in `vec2 px` in the caller's scope so sites
// that carry it to the fragment shader can `vCenter = px;` after.
export const snapClipToGlPosition = (ndcSeed: string, oddOff: string): string => /* glsl */ `
        vec2 px = snapToPixelGrid(${ndcSeed}, uViewport, ${oddOff});
        vec2 ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);`;
