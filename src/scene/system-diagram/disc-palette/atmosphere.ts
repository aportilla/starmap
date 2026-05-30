// Atmosphere model for the disc palette: the haze contributor blend, the
// unified haze color/opacity, the per-gas limb Rayleigh scatter, the deep
// atm-column color, and the outward rim-width buckets. All of it reads the
// body's atm1/2/3 + pressure/gravity + class and folds into the scalars the
// shader's haze pass and outward halo consume.

import { Color } from 'three';
import { AtmGas, Body } from '../../../data/stars';
import {
  deckGasesFor, GAS_COLOR, GAS_POTENCY,
  HAZE_AEROSOL_SCALE, HAZE_BULK_GAS_SCALE, HAZE_DUST_SCALE, HAZE_RAYLEIGH_SCALE,
  RENDERER_SKIP_AEROSOLS, SCATTERING_COLOR, SCATTERING_POTENCY,
  stratosphericHazeStrengthFor,
} from '../color-science';
import { atmGasPairs, dustColorFor, weightedColorBlend } from './shared';

// Outward rim width buckets for surface bodies — integer pixels of
// atmospheric halo extending INTO SPACE beyond the disc edge. Driven
// by a visual-extent scalar combining pressure with the body's
// scale-height proxy H ∝ T/g (see `scaleHeightFactor` below). The
// extent crosses these thresholds to step from 0 → N px. Anchors with
// the curated Sol bodies: Mars 0, Earth 2, Titan 3 (low g + bearable
// pressure puffs it past Earth despite ~⅔ Earth's surface pressure),
// Venus 3 (caps out — high P × hot dominates the high-g penalty).
// Capped at 3 px so the halo stays a glance-read of "this body has
// air" rather than a dominant visual element.
const RIM_EXTENT_THRESHOLDS = [0.02, 0.15, 0.7] as const;

// Outward rim width buckets for no-surface bodies (gas / ice giants /
// hycean / helium / gas dwarfs). No surfacePressureBar to anchor — at
// the limb you're looking through a deep continuous H₂/He column whose
// "pressure" is conventional, so width keys off the scale-height
// proxy alone (already includes the per-class µ correction). All
// no-surface bodies carry a visible halo; base = 1 px and each
// threshold adds one. Sol anchors: Jupiter / Neptune → 2 px (compressed
// by gravity), Saturn / Uranus → 3 px (puffier per their real H/R).
const RIM_NO_SURFACE_FACTOR_THRESHOLDS = [1.0, 3.5] as const;
const RIM_NO_SURFACE_BASE_PX = 1;

// Atmosphere-presence floor: any surface body whose color merger
// produced a non-zero signal — cloud coverage, any haze contributor,
// or lifted dust — gets at least this many px of rim. Distinguishes
// "has air" (Mars: thin CO₂ + dust storms + helicopters fly) from
// "airless" (Mercury, Luna). The pressure-driven [2, 3] tiers above
// still mark significant atmospheric depth.
export const RIM_PRESENCE_FLOOR_PX = 1;

// Per-class molecular-weight ratio µ_air / µ_atm. H ∝ T/(µg), so a
// lighter atmosphere produces a taller column. Used inside
// `scaleHeightFactor`. Surface bodies default to 1 (atmospheres
// roughly air-weight — CO₂/N₂/O₂/CH₄ cluster within ~2×, sub-dominant
// to T and g). No-surface bodies are H₂/He-dominated (µ ≈ 2.3, ratio
// ≈ 13); helium worlds sit between at µ ≈ 4. Without this correction
// gas giants would underestimate their halo by ~13× because T/g alone
// puts Jupiter at 0.23 (well below Earth).
const MU_FACTOR_BY_CLASS: Readonly<Record<string, number>> = {
  gas_giant: 13,
  ice_giant: 13,
  gas_dwarf: 13,
  hycean:    13,
  helium:     7,
};

// Unified haze contributor list — one entry per visible atmospheric
// channel for a body. Reused by both `hazeBlendFor` (one tint + opacity
// for the uniform haze pass) and the rim merger (which adds per-deck
// cloud bases on top). Walks four contributor categories: bulk atm
// gases (absorption tint), Rayleigh scattering on the same gases
// (scattering tint), formation-gated aerosol products from procgen
// (`hazeAerosols`), and lifted mineral dust colored by the body's
// resource mineralogy.
//
// Every contributor weight is multiplied by `atmColumnFactor(body)` =
// log10(P/g + 1) — true column-mass-per-unit-area proxy in Earth-
// normalized units. Aerosol formation strength and dust suspension
// strength are "per-unit-column" signals from the procgen gates;
// multiplying by column thickness gives visible opacity. The 1/g
// factor (over plain log10(P+1)) is the puffy-column effect: low-
// gravity bodies pile more atmospheric mass per unit surface pressure,
// so Titan-class (g=0.135) sits ~2.75× more opaque than its surface
// pressure alone would suggest, matching the IRL observation that
// Titan's surface is invisible from orbit. Surface bodies with no
// atmosphere (P null/0) contribute nothing here — they're handled by
// the no-surface stratospheric path in `hazeBlendFor`.
//
// Aerosol species that already paint as a cloud deck on this body are
// skipped — they shouldn't double-count as stratospheric haze. Species
// in RENDERER_SKIP_AEROSOLS (CHROMOPHORE today) are also skipped while
// their proper home — a thin sparse-coverage top deck — remains a TODO.
export function surfaceHazeContributors(body: Body): Array<{ color: Color; weight: number }> {
  const out: Array<{ color: Color; weight: number }> = [];
  const P = body.surfacePressureBar;
  if (P === null || P <= 0) return out;
  const colFactor = atmColumnFactor(body);
  for (const [gas, frac] of atmGasPairs(body)) {
    const col = GAS_COLOR[gas];
    const potency = GAS_POTENCY[gas] ?? 0;
    if (col && potency > 0) {
      out.push({ color: col, weight: frac * potency * colFactor * HAZE_BULK_GAS_SCALE });
    }
    const sCol = SCATTERING_COLOR[gas];
    const sPotency = SCATTERING_POTENCY[gas] ?? 0;
    if (sCol && sPotency > 0) {
      out.push({ color: sCol, weight: frac * sPotency * colFactor * HAZE_RAYLEIGH_SCALE });
    }
  }
  if (body.hazeAerosols !== null) {
    const deckGases = deckGasesFor(body);
    for (const [species, strength] of Object.entries(body.hazeAerosols)) {
      if (strength <= 0) continue;
      const gas = species as AtmGas;
      if (deckGases.has(gas)) continue;
      if (RENDERER_SKIP_AEROSOLS.has(gas)) continue;
      const col = GAS_COLOR[gas];
      const potency = GAS_POTENCY[gas] ?? 0;
      if (!col || potency <= 0) continue;
      out.push({ color: col, weight: strength * potency * colFactor * HAZE_AEROSOL_SCALE });
    }
  }
  if (body.dustStrength !== null && body.dustStrength > 0) {
    const potency = GAS_POTENCY.DUST ?? 0;
    if (potency > 0) {
      out.push({ color: dustColorFor(body), weight: body.dustStrength * potency * colFactor * HAZE_DUST_SCALE });
    }
  }
  return out;
}

// Per-body limb Rayleigh scattering — drives the rim halo's depth-graded
// hue shift (see makePlanetMaterial's Rayleigh constant block). Returns
// the per-gas scattering hue + a strength scalar:
//
//   color    — the frac × SCATTERING_POTENCY weighted blend of the body's
//              atm gases' SCATTERING_COLOR. SCATTERING_COLOR already
//              encodes each gas's wavelength-selective scatter/absorb hue
//              (N2/O2 blue, CO2 warmer cool-grey, CH4 cyan, SO2 yellow),
//              so this is the gas-specific limb color the starlight then
//              re-illuminates in the shader.
//   strength — the Rayleigh FRACTION of the co-located clear-air signal:
//              rayleigh ÷ (rayleigh + bulk-gas absorption), using the same
//              HAZE_*_SCALE weights the rim merger uses. Aerosols/dust are
//              deliberately NOT in the denominator: at the limb the thin
//              Rayleigh gas sits ABOVE the aerosol haze (the outer loft
//              layers are clear gas), and the shader's depth gradient
//              already models "haze is lower." Bulk-gas absorption IS
//              co-located in the same column, so it competes. The column
//              factor cancels in the ratio, leaving a pressure-independent
//              hue-fraction (the rim's width + alpha already carry "how
//              much atmosphere"). Earth → ~0.76 (clean blue), Titan → ~0.8
//              (N2 blue fringe over the orange Mie haze), Venus → ~0.39
//              (CO2's pale cool-grey, muted) — the three read distinctly.
//
// No-surface giants (null surface pressure) return strength 0: their limb
// hue already comes from the cloud/atm-column signal in rimColor, and the
// clear-air Rayleigh model doesn't apply.
export function scatteringRimFor(body: Body): { color: readonly [number, number, number]; strength: number } {
  const P = body.surfacePressureBar;
  if (P === null || P <= 0) return { color: [0, 0, 0], strength: 0 };
  // Rayleigh contributors feed the color blend; bulk-gas weight accrues over
  // every gas (not just the scattering ones) so it stays a separate tail.
  let bulkW = 0;
  const scatter: Array<{ color: { r: number; g: number; b: number }; weight: number }> = [];
  for (const [gas, frac] of atmGasPairs(body)) {
    const sCol = SCATTERING_COLOR[gas];
    const sPotency = SCATTERING_POTENCY[gas] ?? 0;
    if (sCol && sPotency > 0) scatter.push({ color: sCol, weight: frac * sPotency });
    bulkW += frac * (GAS_POTENCY[gas] ?? 0);
  }
  const { r, g, b, totalWeight: rayW } = weightedColorBlend(scatter);
  if (rayW <= 0) return { color: [0, 0, 0], strength: 0 };
  const rs = rayW * HAZE_RAYLEIGH_SCALE;
  const bs = bulkW * HAZE_BULK_GAS_SCALE;
  return { color: [r, g, b], strength: rs / (rs + bs) };
}

// Multiplier applied to stratosphericHazeStrengthFor when folding the
// atm column into the no-surface haze contributor list. Tuned so the
// exp soft-cap on opacity lands at:
//   Jupiter (s ≈ 0.15) → opacity ≈ 0.20
//   Saturn  (s ≈ 0.55) → opacity ≈ 0.55
//   Uranus  (s ≈ 0.85) → opacity ≈ 0.71
const NO_SURFACE_HAZE_GAIN = 1.5;

// Unified haze color + opacity — weighted average across all
// surfaceHazeContributors plus (for no-surface bodies) the atm column
// itself as a stratospheric-haze contributor. Opacity is the soft cap
// 1 - exp(-Σw) so many thin contributions saturate smoothly.
export function hazeBlendFor(body: Body): { color: Color; opacity: number } {
  const contribs = surfaceHazeContributors(body);
  // Stratospheric atm-column haze on gas / ice giants. Drives the
  // per-deck haze pre-tint in the cloud loop (deeper decks get more
  // cream tint on Saturn) and supplies vHazeColor for the same.
  // Surface bodies stay on the contributor list alone — their column
  // absorption + Rayleigh already feed it via bulk-gas terms.
  if (body.surfaceOpacity < 1) {
    const atmCol = atmColumnColor(body);
    if (atmCol) {
      const w = stratosphericHazeStrengthFor(body.avgSurfaceTempK) * NO_SURFACE_HAZE_GAIN;
      if (w > 0) contribs.push({ color: atmCol, weight: w });
    }
  }
  const { r, g, b, totalWeight } = weightedColorBlend(contribs);
  if (totalWeight <= 0) return { color: new Color(0, 0, 0), opacity: 0 };
  return {
    color: new Color(r, g, b),
    opacity: 1 - Math.exp(-totalWeight),
  };
}

// Atm-only column color — weighted blend across atm1/2/3 by
// `frac × GAS_POTENCY`. No worldClass filter, no cloud-deck
// substitution: this is what the gas column looks like through any
// cloud rents on a no-surface body. Jupiter is fully cloud-covered
// at every altitude, so its atm column never renders in practice (no
// rent for it to show through). Uranus / Neptune surface the visible
// CH4 cyan through the same blend.
//
// GAS_COLOR entries are already chosen pale enough that the result
// reads as a natural "lighter at the limb" effect.
export function atmColumnColor(body: Body): Color | null {
  let r = 0, g = 0, b = 0, totalW = 0;
  for (const [gas, frac] of atmGasPairs(body)) {
    const col = GAS_COLOR[gas];
    if (!col) continue;
    const w = frac * (GAS_POTENCY[gas] ?? 1);
    if (w <= 0) continue;
    r += col.r * w;
    g += col.g * w;
    b += col.b * w;
    totalW += w;
  }
  if (totalW <= 0) return null;
  return new Color(r / totalW, g / totalW, b / totalW);
}

// Earth-normalized atmospheric column-mass proxy for vertical viewing
// (orbit straight down). Hydrostatic equilibrium gives column mass per
// unit area = P/g, so a low-gravity body with the same surface pressure
// as Earth has more atmospheric mass — and therefore more aerosol
// particles — in the line of sight. Titan at 1.45 bar / 0.135 g_earth
// returns log10(10.7 + 1) ≈ 1.07 vs the surface-pressure-only
// log10(2.45) ≈ 0.39 — the "puffy column" effect that makes Titan's
// haze read as opaque from orbit even though its surface pressure is
// only ~1.5× Earth's. Sibling to scaleHeightFactor (slant-path proxy
// for the rim); both are Earth-normalized atmospheric measures, but
// column mass density (this one) is the right physics for vertical
// optical depth through aerosols and bulk gas absorption. Nulls or
// unphysical inputs fall back to plain log10(P+1).
function atmColumnFactor(body: Body): number {
  const p = body.surfacePressureBar;
  if (p === null || p <= 0) return 0;
  const m = body.massEarth;
  const r = body.radiusEarth;
  if (m === null || r === null || r <= 0) return Math.log10(p + 1);
  const gRel = m / (r * r);
  if (gRel <= 0) return Math.log10(p + 1);
  return Math.log10(p / gRel + 1);
}

// Earth-relative atmospheric scale-height proxy. H = kT/(μg);
// normalized so an air-weight Earth = 1.0. Surface bodies vary mostly
// through T and g (their atmospheres cluster around µ_air). No-surface
// bodies pick up a per-class µ multiplier so H₂/He giants reflect
// their ~13× lighter column — without it Jupiter's T/g lands at 0.23
// (smaller than Earth) and gas giants under-halo dramatically. Nulls
// or unphysical inputs fall back to Earth-like.
function scaleHeightFactor(body: Body): number {
  const t = body.avgSurfaceTempK;
  const m = body.massEarth;
  const r = body.radiusEarth;
  if (t === null || m === null || r === null || r <= 0) return 1;
  const gRel = m / (r * r);
  if (gRel <= 0) return 1;
  const muMul = body.worldClass !== null ? (MU_FACTOR_BY_CLASS[body.worldClass] ?? 1) : 1;
  return (t / 288) / gRel * muMul;
}

export function rimWidthForSurfaceAtmosphere(body: Body): number {
  const p = body.surfacePressureBar;
  if (p === null || p <= 0) return 0;
  const extent = Math.log10(p + 1) * scaleHeightFactor(body);
  let width = 0;
  for (const t of RIM_EXTENT_THRESHOLDS) {
    if (extent >= t) width++;
  }
  return width;
}

export function rimWidthForNoSurfaceAtmosphere(body: Body): number {
  const factor = scaleHeightFactor(body);
  let width = RIM_NO_SURFACE_BASE_PX;
  for (const t of RIM_NO_SURFACE_FACTOR_THRESHOLDS) {
    if (factor >= t) width++;
  }
  return width;
}
