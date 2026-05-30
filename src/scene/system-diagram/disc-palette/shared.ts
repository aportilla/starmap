// Cross-model helpers shared by the disc-palette sub-models (ocean,
// atmosphere, lava) and the buildDiscPalette orchestrator. Everything here
// is a small stateless primitive: identity colors, the atmosphere gas walk,
// and the body's mineralogy-blended dust color. Keeping them in one leaf
// module lets the sub-models depend on them without cycling through index.ts.

import { Color } from 'three';
import { AtmGas, Body } from '../../../data/stars';
import { dominantResources } from '../color-science';

// Identity colors reused as lerp targets / no-tint sentinels across the
// palette code. Treated as read-only — callers pass them to lerpColor (which
// allocates a fresh Color) and never mutate them in place.
export const WHITE_COLOR = new Color(1, 1, 1);
export const BLACK_COLOR = new Color(0, 0, 0);

// Clamp to [0, 1] — the GLSL `clamp(x, 0.0, 1.0)` the shader applies to every
// normalized signal, mirrored CPU-side so palette scalars derived here land in
// the same range the disc shader expects.
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// GLSL-style smoothstep clamped to [0, 1] — 0 at/below e0, 1 at/above e1,
// Hermite ease between. Mirrors the shader's built-in so CPU-derived ramps
// match the curve the disc sub-passes (lava melt gates, ice globalness)
// expect. Degenerate e0 === e1 acts as a hard step at e0.
export function smoothstep01(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// Weighted RGB blend. Sums color × weight across entries (skipping
// non-positive weights), returns the hue normalized by the total weight
// plus that total. Normalization is folded in because every consumer wants
// the averaged color, but the total weight is handed back because each uses
// it differently downstream — the haze pass soft-caps it as 1 − exp(−w),
// the rim merger treats it as a presence floor, the Rayleigh rim feeds it a
// strength ratio. totalWeight 0 (channels zeroed) means nothing contributed,
// so callers branch on totalWeight rather than re-checking emptiness.
export interface ColorBlend { r: number; g: number; b: number; totalWeight: number; }
export function weightedColorBlend(
  entries: Iterable<{ color: { r: number; g: number; b: number }; weight: number }>,
): ColorBlend {
  let r = 0, g = 0, b = 0, totalWeight = 0;
  for (const { color, weight } of entries) {
    if (weight <= 0) continue;
    r += color.r * weight; g += color.g * weight; b += color.b * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return { r: 0, g: 0, b: 0, totalWeight: 0 };
  return { r: r / totalWeight, g: g / totalWeight, b: b / totalWeight, totalWeight };
}

// All present atmospheric gases as [species, fraction] pairs, filtered to
// positive fractions. The single walk over atm1/atm2/atm3 that every
// atmosphere consumer shares (column color, haze contributors, Rayleigh
// rim, solvent pick, lava sulfur) — the null/≤0 guards live here rather
// than being re-derived at each call site.
export function atmGasPairs(body: Body): Array<[AtmGas, number]> {
  const out: Array<[AtmGas, number]> = [];
  if (body.atm1 !== null && (body.atm1Frac ?? 0) > 0) out.push([body.atm1 as AtmGas, body.atm1Frac as number]);
  if (body.atm2 !== null && (body.atm2Frac ?? 0) > 0) out.push([body.atm2 as AtmGas, body.atm2Frac as number]);
  if (body.atm3 !== null && (body.atm3Frac ?? 0) > 0) out.push([body.atm3 as AtmGas, body.atm3Frac as number]);
  return out;
}

export function atmFracOf(body: Body, gas: AtmGas): number {
  for (const [g, frac] of atmGasPairs(body)) {
    if (g === gas) return frac;
  }
  return 0;
}

// Per-body dust color. Lifted surface dust reflects the body's surface
// mineralogy: Mars's ferric-oxide rust is one possibility, but alien
// Mars-class bodies with different resource mixes lift different-colored
// dust (iron-grey on metal-dominant, tan on silicate-dominant, rose on
// rare-earth-rich). Weighted blend across the body's top-2 resource
// colors — same source the surface texturing uses, so dust matches the
// body's apparent surface. Shared by the ocean sediment pathway and the
// atmosphere haze contributors so the turbid-shoreline tint matches the
// dust-storm haze tint drifting over the same coastlines.
//
// Fallback rust color when dust is present but the body has no resource
// signal (procgen drift / missing data). Matches the canonical Mars-rust
// hue so a data-thin body still reads as "dusty world."
const DUST_FALLBACK_COLOR = new Color(0xa86040);

export function dustColorFor(body: Body): Color {
  const resources = dominantResources(body, 2);
  if (resources.length === 0) return DUST_FALLBACK_COLOR;
  // Renormalize: dustColorFor is a hue blend across the body's
  // mineralogy, so we want the relative ratio between the top resources,
  // not their absolute abundance. A barren world still lifts dust that
  // reflects its (sparse) surface composition; richness shows up in the
  // surface palette grey-lerp, not here.
  const total = resources.reduce((s, e) => s + e.abundance, 0);
  if (total <= 0) return DUST_FALLBACK_COLOR;
  let r = 0, g = 0, b = 0;
  for (const { color, abundance } of resources) {
    const w = abundance / total;
    r += color.r * w;
    g += color.g * w;
    b += color.b * w;
  }
  return new Color(r, g, b);
}
