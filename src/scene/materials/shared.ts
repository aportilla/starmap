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
export const snappedMaterials: ShaderMaterial[] = [];

export function setSnappedLineViewport(w: number, h: number): void {
  for (const m of snappedMaterials) m.uniforms.uViewport.value.set(w, h);
}

// JS number → glsl float literal. Always emits a decimal point so 50
// becomes "50.0", not the bare "50" that glsl rejects as an int literal.
export const glsl = (n: number): string => Number.isInteger(n) ? n.toFixed(1) : n.toString();

// Rasterizer padding around the integer-pixel disc, shared by both the
// perspective and flat stars shaders. Adding +2 (preserving parity)
// keeps every fragment we care about safely inside the rasterized
// square so the rasterizer never has to make a tie-breaking call at the
// bounding-box edges that would drop a row/column on one side. Cost: a
// few extra discarded fragments per disc.
export const RASTER_PAD = 2;
