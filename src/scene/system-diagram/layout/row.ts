// Row layout — planets + belts share one dome-arc row, sorted by
// semi-major axis. This module owns the RowSlot datatype, the
// dome-arc math, and a handful of small utilities (bigMiddleOrder,
// sumOf, discPxFromRadius/planetDiscPx) that the row build needs.

import { BODIES, STARS, type StarCluster } from '../../../data/stars';
import { sizes } from '../../../ui/theme';
import {
  BELT_SLOT_WIDTH,
  DOME_AREA_MAX, DOME_AREA_MIN, DOME_PEAK_MAX_PX, DOME_PEAK_MIN_PX,
  PLANET_DISC_ASYMPTOTE, PLANET_DISC_BASE,
  PLANET_DISC_BLEND_HI, PLANET_DISC_BLEND_LO,
  PLANET_DISC_FLOOR_KNEE, PLANET_DISC_GIANT_OFFSET,
  PLANET_DISC_GIANT_SLOPE, PLANET_DISC_MIN, PLANET_DISC_TOP_KNEE,
  PLANET_PEAK_FROM_TOP,
} from './constants';

// One slot in the planet+belt row. Built once at construction (sorted
// by semi-major axis); cx/cy are filled in by layoutRow(). Planets
// carry a disc size, belts a fixed slot width (BELT_SLOT_WIDTH).
// rowIdx is the 0-based position in the sorted row; layout code threads
// it into every element's vertex z via Z_STRIDE so each row item's
// stack renders as one z-layer above its left-of-here neighbors and
// below its right-of-here neighbors.
export interface RowSlot {
  kind: 'planet' | 'belt';
  bodyIdx: number;
  widthPx: number;
  cx: number;
  cy: number;
  rowIdx: number;
}

// Disc diameter (px) from a body's radiusEarth, cube-root-compressed and
// hard-clamped. Moon-only: moon radii are all sub-Earth, so the simple
// compression never needs the giant-band handling the planet curve has.
// The caller supplies base / clamp / null-fallback (the moon cap exceeds
// the planet floor on purpose — see MOON_DISC_* in constants.ts).
export function discPxFromRadius(
  radiusEarth: number | null,
  opts: { base: number; min: number; max: number; fallback: number },
): number {
  const r = radiusEarth ?? opts.fallback;
  const px = Math.cbrt(Math.max(r, 0.0001)) * opts.base;
  return Math.max(opts.min, Math.min(opts.max, Math.round(px)));
}

// Smooth ceiling/floor: log-sum-exp soft-min / soft-max so px approaches the
// bound asymptotically instead of clipping to it (knee = how wide the bend).
// softplus is the stable building block (≈ z for large z, so no overflow).
const softplus = (z: number): number => (z > 30 ? z : Math.log(1 + Math.exp(z)));
const softMin = (x: number, max: number, knee: number): number =>
  max - knee * softplus((max - x) / knee);
const softMax = (x: number, min: number, knee: number): number =>
  min + knee * softplus((x - min) / knee);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// Per-planet disc diameter — two radius→size mappings blended into one
// monotonic curve. The low-end cube-root mapping pins Earth to
// PLANET_DISC_BASE and spreads the rocky worlds; the high-end linear
// mapping gives the degeneracy-clustered giant band real px-separation
// instead of a flat plateau. smoothstep hands low→high across the blend
// band, a soft-min asymptotes the top toward PLANET_DISC_ASYMPTOTE (no
// hard clip), and a soft-max eases the smallest bodies onto
// PLANET_DISC_MIN. Read here by row construction (widthPx) and, via
// RowSlot.widthPx, by PlanetsLayer (shader aSize).
export function planetDiscPx(radiusEarth: number | null): number {
  const r = Math.max(radiusEarth ?? 1.0, 0.0001);
  const lo = Math.cbrt(r) * PLANET_DISC_BASE;
  const hi = PLANET_DISC_GIANT_SLOPE * r + PLANET_DISC_GIANT_OFFSET;
  const w = smoothstep(PLANET_DISC_BLEND_LO, PLANET_DISC_BLEND_HI, r);
  let px = lo * (1 - w) + hi * w;
  px = softMin(px, PLANET_DISC_ASYMPTOTE, PLANET_DISC_TOP_KNEE);
  px = softMax(px, PLANET_DISC_MIN, PLANET_DISC_FLOOR_KNEE);
  return Math.round(px);
}

// Gather every planet + belt across a cluster's member stars, tag each
// with its slot width, and sort by semi-major axis. rowIdx is assigned
// after the sort so it's stable across the rest of the construction
// pipeline.
export function buildRowSlots(cluster: StarCluster): RowSlot[] {
  const items: RowSlot[] = [];
  for (const starIdx of cluster.members) {
    for (const pIdx of STARS[starIdx].planets) {
      items.push({
        kind: 'planet', bodyIdx: pIdx,
        widthPx: planetDiscPx(BODIES[pIdx].radiusEarth),
        cx: 0, cy: 0, rowIdx: 0,
      });
    }
    for (const bIdx of STARS[starIdx].belts) {
      items.push({
        kind: 'belt', bodyIdx: bIdx,
        widthPx: BELT_SLOT_WIDTH,
        cx: 0, cy: 0, rowIdx: 0,
      });
    }
  }
  items.sort((a, b) => {
    const aa = BODIES[a.bodyIdx].semiMajorAu ?? Infinity;
    const bb = BODIES[b.bodyIdx].semiMajorAu ?? Infinity;
    return aa - bb;
  });
  items.forEach((r, i) => { r.rowIdx = i; });
  return items;
}

// Compute cx/cy for every rowItem (planets + belts share the row).
// Edge-to-edge spacing: free space split into N+1 equal gaps — one
// between each adjacent pair plus one as a margin on each end — so a
// gas giant next to a rocky world (or a belt next to either) preserves
// the same edge-to-edge gap. Goes negative when sum(width) > availW;
// slots then overlap evenly (deck-of-cards). Not shrinking widths in
// that case because the cbrt size curve is what keeps Mercury legible
// next to Jupiter — uniform shrinkage would flatten the ratio.
//
// Dome Y is keyed to each slot's actual x rather than its ordinal
// index, so the peak stays at availW/2 regardless of within-row size
// variation — the arc is a geometric shape every slot rides on, not a
// function of slot index.
export function layoutRow(items: RowSlot[], bufferW: number, bufferH: number): void {
  const N = items.length;
  if (N === 0) return;

  const availW = bufferW - 2 * sizes.edgePad;
  const xLeft = sizes.edgePad;

  const sumD = items.reduce((s, r) => s + r.widthPx, 0);
  const gap = (availW - sumD) / (N + 1);

  // Lerp the dome's height over viewport area, then derive the baseline
  // from the (fixed) peak position. Peak anchored = top of the arc
  // stays the same distance from the stars; edges drop as the screen
  // grows.
  const area = bufferW * bufferH;
  const areaT = Math.max(0, Math.min(1,
    (area - DOME_AREA_MIN) / (DOME_AREA_MAX - DOME_AREA_MIN)));
  const peakHeight = DOME_PEAK_MIN_PX + areaT * (DOME_PEAK_MAX_PX - DOME_PEAK_MIN_PX);
  const peakY = bufferH - PLANET_PEAK_FROM_TOP;
  const baselineY = peakY - peakHeight;

  let cursor = xLeft + gap;
  for (let i = 0; i < N; i++) {
    const item = items[i];
    const r = item.widthPx / 2;
    const cx = cursor + r;
    // sin(π·t) peaks at t = 0.5 and is 0 at t = 0 / t = 1.
    const t = (cx - xLeft) / availW;
    const yOffset = peakHeight * Math.sin(Math.PI * t);
    item.cx = Math.round(cx);
    item.cy = Math.round(baselineY + yOffset);
    cursor += item.widthPx + gap;
  }
}

// Permutation that walks slots outward from the center. Caller passes a
// disc-size array already sorted descending; out[finalSlot] = source
// index. Biggest item lands at floor(N/2); subsequent items alternate
// right-then-left as we walk outward, falling back to the unfilled side
// when one runs out (handles asymmetric N gracefully).
export function bigMiddleOrder(sortedDescCount: number): number[] {
  const N = sortedDescCount;
  const out: number[] = new Array(N).fill(-1);
  if (N === 0) return out;
  const mid = Math.floor(N / 2);
  out[mid] = 0;
  for (let i = 1; i < N; i++) {
    const step = Math.ceil(i / 2);
    let slot = (i % 2 === 1) ? mid + step : mid - step;
    if (slot < 0 || slot >= N || out[slot] !== -1) {
      slot = slot >= N ? mid - step : mid + step;
    }
    out[slot] = i;
  }
  return out;
}

export function sumOf(arr: readonly number[]): number {
  let s = 0;
  for (const n of arr) s += n;
  return s;
}
