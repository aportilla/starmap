// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// + per-body data-texture row consumed by makePlanetMaterial.
//
// The shader composes a layered stack per fragment, bottom to top:
//   - **surface**  — worley/voronoi cell texture painted with the body's
//                    top 3 resource colors. World-class color only
//                    surfaces as a flat-fill fallback when a body has
//                    no resource signal. Substituted with `atmColumnColor`
//                    when the body has no accessible surface (gas / ice
//                    giants) — the void between cloud cells shows the
//                    deep atm column tint there.
//   - **haze**     — uniform per-fragment lerp toward the haze color by
//                    hazeOpacity. Aerosol species not claimed by a
//                    cloud deck (DUST, SILICATE, SALT, H2SO4, ...)
//                    live here alongside bulk gas absorption and
//                    Rayleigh scattering.
//   - **cloud**    — up to MAX_CLOUD_LAYERS stratified decks composited
//                    back-to-front by altitudeNorm. Each deck is ONE
//                    condensate color (CONDENSATE_COLOR[gas] with
//                    GAS_COLOR fallback) plus small per-cell brightness
//                    jitter. Multi-color character on banded bodies
//                    emerges from coverage rents in upper decks
//                    revealing the next-deeper deck (or the surface /
//                    atm-column beneath the stack), not from in-deck
//                    palette mixing.
//   - **rim**      — outward halo into space, no inward fade. Width
//                    bucketed off pressure (surface) or scale-height
//                    proxy (no-surface). Color = same contributor blend
//                    as haze, with each deck's base color folded in by
//                    coverage.
//
// Each layer's alpha is data-driven; total opacity emerges from
// composition rather than a mode flip. Earth's H2O deck at coverage
// 0.4 covers 40% of the disc in white worley cells; Venus's H2SO4
// deck at 1.0 covers everything; Saturn's three full-coverage decks
// stack such that the upper NH3 hides everything below it, while
// Jupiter's lower NH3 coverage rents zonally to reveal NH4SH bands.

import { Color } from 'three';
import {
  AtmGas, Body, GAS_COLOR, GAS_POTENCY,
  HAZE_AEROSOL_SCALE, HAZE_BULK_GAS_SCALE,
  HAZE_DUST_SCALE, HAZE_RAYLEIGH_SCALE,
  SCATTERING_COLOR, SCATTERING_POTENCY,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT,
  WORLD_CLASS_UNKNOWN_COLOR, biomePaintFor, deckGasesFor, RENDERER_SKIP_AEROSOLS,
  cloudDeckPalette, dominantResources, stratosphericHazeStrengthFor,
} from '../../data/stars';
import { hash32 } from './geom/prng';
import { bodyVisualTiltRad } from './geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from './layout/constants';

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
const RIM_PRESENCE_FLOOR_PX = 1;

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

// Phase 1.6 ice-geometry temperature thresholds. globalness lerps from
// 0 (cap-latitude pattern) at ICE_TEMP_CAP_K down to 1 (global pattern)
// at ICE_TEMP_GLOBAL_K. Smoothstep curve between the two. Anchors:
// Earth (288 K) lands at 0; Mars (210 K) at ~0.74 (mostly global but
// iceFrac so small the visual is still cap-like); Europa (102 K)
// saturates at 1; an ice-age Earth at ~240 K transitions through the
// midpoint smoothly. The cap-vs-global signal comes from temperature
// rather than insolation because the temperature is the actual driver
// of where ice can exist on a body — insolation determines temperature
// but greenhouse, albedo, and tidal heating all confound the direct
// mapping.
const ICE_TEMP_GLOBAL_K = 180;
const ICE_TEMP_CAP_K    = 270;

// Compute globalness from avgSurfaceTempK via a smoothstep curve.
// Null temperature falls back to 0 (cap pattern — safest default for
// a body with missing thermal data; the iceFrac value still gates
// whether any ice renders at all).
function globalnessForTemp(avgT: number | null): number {
  if (avgT == null) return 0;
  if (avgT <= ICE_TEMP_GLOBAL_K) return 1;
  if (avgT >= ICE_TEMP_CAP_K)    return 0;
  const t = (avgT - ICE_TEMP_GLOBAL_K) / (ICE_TEMP_CAP_K - ICE_TEMP_GLOBAL_K);
  const sm = t * t * (3 - 2 * t);
  return 1 - sm;
}

export interface DiscPalette {
  // 3 RGB entries × 3 floats — the SURFACE resource palette. Worley
  // cells in the surface block pick from this. Always derived from
  // `dominantResources(body)`; empty bodies fall back to a flat
  // world-class color in slot 0.
  readonly palette: readonly [number, number, number,
                              number, number, number,
                              number, number, number];
  readonly weights: readonly [number, number, number];
  // Atmospheric column color — weighted blend across the body's atm
  // gases by `frac × GAS_POTENCY`. Painted as the disc base when
  // `surfaceOpacity == 0` (gas / ice giants) so cloud rents reveal the
  // physically-honest deep-column tint. Black when the body has no
  // atmosphere data.
  readonly atmColumnColor: readonly [number, number, number];
  // Surface opacity [0..1]. 1 = paintable surface visible (terrestrials).
  // 0 = surface contribution is suppressed; the shader paints
  // atmColumnColor as base instead. Composition stays unconditional;
  // this scalar gates contribution rather than branching the codepath.
  readonly surfaceOpacity: number;
  readonly seed: number;  // [0..1)
  // Render tilt in radians — rotates the banded-mode strip axis so
  // bands run parallel to the planet's equator (and, for ringed giants,
  // to the ring plane via the shared bodyVisualTiltRad helper). Used
  // by both the cloud-banded and surface sphere-projection paths.
  readonly tilt: number;
  // Surface water cover [0..1]. Surface block splits the disc into
  // coarse continent cells; a per-cell hash < waterFrac flips that
  // cell from resource patch to flat ocean color. Earth at 0.71 reads
  // as ~71% ocean; Mars at 0 stays all-land. Forced to 0 on no-surface
  // bodies and on tiny discs (PROCEDURAL_TEXTURE_MIN_PX gate).
  readonly waterFrac: number;
  // Surface ice cover [0..1]. Drives cap-latitude paint on warm bodies
  // (Earth's poles) and bulk cryosphere on cold ones (Europa). Same
  // suppression gates as waterFrac.
  readonly iceFrac: number;
  // Biome stipple — pigment color (archetype × stellar shift; see
  // biomePaintFor in stars.ts) packed as [r,g,b], and coverage density
  // [0..1] keyed to biosphereTier. Suppressed on no-surface bodies,
  // tiny discs, and bodies with no biosphere.
  readonly biomeColor: readonly [number, number, number];
  readonly biomeCoverage: number;
  // Cloud layers — up to MAX_CLOUD_LAYERS stratified decks, sorted
  // ascending by altitudeNorm. Each entry carries one condensate color
  // (no in-deck mixing). The shader composites layers above the
  // surface + haze, each pre-tinted by the haze opacity sitting above
  // it. Empty slots have coverage = 0 and get a no-op composite.
  // Banded character emerges from coverage rents revealing the deck
  // below (or the surface / atm-column beneath the stack).
  readonly cloudLayers: ReadonlyArray<{
    readonly coverage: number;
    readonly windSpeedMS: number;
    readonly altitudeNorm: number;
    // Condensate RGB — CONDENSATE_COLOR[gas] with GAS_COLOR fallback.
    readonly color: readonly [number, number, number];
  }>;
  // Haze layer uniform opacity [0..1]. The shader runs a per-fragment
  // mix(col, hazeColor, hazeOpacity) over EVERY paint underneath
  // (surface + cloud). Derived from the unified contributor blend
  // (bulk atm gases × pressure × potency, formation-gated aerosol
  // products, lifted dust from body mineralogy, Rayleigh scattering)
  // soft-capped via 1 - exp(-Σ). Titan ≈ 0.92 (puffy-column-anchored —
  // low gravity piles ~10× Earth-equivalent atmospheric mass per unit
  // surface pressure, matching real Titan's orbit-invisible surface),
  // Venus ≈ 0.7, Mars ≈ 0.30 (dust storms now visible from orbit),
  // Earth ≈ 0.15. Zero on bodies with no atmosphere data.
  readonly hazeOpacity: number;
  // Unified haze blend color — weighted average across every
  // atmospheric contributor (bulk gases, Rayleigh, aerosol products,
  // dust). One color per body; the shader's surface haze pass paints
  // it uniformly across the disc face. Same color also feeds the
  // outward rim merger.
  readonly hazeColor: readonly [number, number, number];
  // Merged rim color — weighted-average blend across cloud slot 0 +
  // every haze contributor for surface bodies, or cloud + atm column
  // tint for no-surface bodies. Used by the outward halo. Dominated by
  // whatever signal has the highest weight (tholin on Titan,
  // chromophore-filtered H2/He column on Jupiter, cyan Rayleigh on
  // Earth, mineralogy-rust on Mars).
  readonly rimColor: readonly [number, number, number];
  readonly rimWidthPx: number;
  // Phase 1.4 surface age [0..1]. 1 = perpetually refreshed (Io's lava,
  // Enceladus's plumes); 0 = ancient unmodified (Mercury, Luna,
  // Callisto). Drives crater density and the ice-on-top-vs-buried mix.
  // Forced to 0.5 on no-surface bodies and tiny discs (the surface
  // block is unreachable there) so the attribute schema stays uniform.
  readonly surfaceAge: number;
  // Phase 1.6 globalness [0..1]. Smoothstep on avgSurfaceTempK between
  // ICE_TEMP_GLOBAL_K and ICE_TEMP_CAP_K. Selects between the cap-
  // latitude ice pattern (warm) and the global-scatter pattern (cold).
  readonly globalness: number;
}

// Per-body dust color. Lifted surface dust reflects the body's surface
// mineralogy: Mars's ferric-oxide rust is one possibility, but alien
// Mars-class bodies with different resource mixes lift different-colored
// dust (iron-grey on metal-dominant, tan on silicate-dominant, rose on
// rare-earth-rich). Weighted blend across the body's top-3 resource
// colors — same source the surface texturing uses, so dust matches the
// body's apparent surface.
//
// Fallback rust color when dust is present but the body has no resource
// signal (procgen drift / missing data). Matches the canonical Mars-rust
// hue so a data-thin body still reads as "dusty world."
const DUST_FALLBACK_COLOR = new Color(0xa86040);

function dustColorFor(body: Body): Color {
  const resources = dominantResources(body, 3);
  if (resources.length === 0) return DUST_FALLBACK_COLOR;
  let r = 0, g = 0, b = 0;
  for (const { color, weight } of resources) {
    r += color.r * weight;
    g += color.g * weight;
    b += color.b * weight;
  }
  return new Color(r, g, b);
}

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
function surfaceHazeContributors(body: Body): Array<{ color: Color; weight: number }> {
  const out: Array<{ color: Color; weight: number }> = [];
  const P = body.surfacePressureBar;
  if (P === null || P <= 0) return out;
  const colFactor = atmColumnFactor(body);
  const atmPairs: Array<[AtmGas | null, number | null]> = [
    [body.atm1 as AtmGas | null, body.atm1Frac],
    [body.atm2 as AtmGas | null, body.atm2Frac],
    [body.atm3 as AtmGas | null, body.atm3Frac],
  ];
  for (const [gas, frac] of atmPairs) {
    if (gas === null || frac === null || frac <= 0) continue;
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
function hazeBlendFor(body: Body): { color: Color; opacity: number } {
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
  let mr = 0, mg = 0, mb = 0, mw = 0;
  for (const { color, weight } of contribs) {
    if (weight <= 0) continue;
    mr += color.r * weight; mg += color.g * weight; mb += color.b * weight;
    mw += weight;
  }
  if (mw <= 0) return { color: new Color(0, 0, 0), opacity: 0 };
  return {
    color: new Color(mr / mw, mg / mw, mb / mw),
    opacity: 1 - Math.exp(-mw),
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
function atmColumnColor(body: Body): Color | null {
  const candidates: Array<[AtmGas | null, number | null]> = [
    [body.atm1 as AtmGas | null, body.atm1Frac],
    [body.atm2 as AtmGas | null, body.atm2Frac],
    [body.atm3 as AtmGas | null, body.atm3Frac],
  ];
  let r = 0, g = 0, b = 0, totalW = 0;
  for (const [gas, frac] of candidates) {
    if (gas === null || frac === null) continue;
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

function rimWidthForSurfaceAtmosphere(body: Body): number {
  const p = body.surfacePressureBar;
  if (p === null || p <= 0) return 0;
  const extent = Math.log10(p + 1) * scaleHeightFactor(body);
  let width = 0;
  for (const t of RIM_EXTENT_THRESHOLDS) {
    if (extent >= t) width++;
  }
  return width;
}

function rimWidthForNoSurfaceAtmosphere(body: Body): number {
  const factor = scaleHeightFactor(body);
  let width = RIM_NO_SURFACE_BASE_PX;
  for (const t of RIM_NO_SURFACE_FACTOR_THRESHOLDS) {
    if (factor >= t) width++;
  }
  return width;
}

// World-class color or unknown-grey fallback. Same precedence as the
// legacy flat-color renderer so a worldClass=null body stays
// recognizable as "TBD" rather than slotting into an arbitrary class.
function worldClassColor(body: Body): Color {
  if (body.worldClass === null) return WORLD_CLASS_UNKNOWN_COLOR;
  return WORLD_CLASS_COLOR[body.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR;
}

// Lerp `c` toward `tint.color` by `tint.amount`. Returns `c` unchanged
// when `tint` is undefined. Applied to surface palette entries to fold
// in the per-class hue tint (gas-giant warm shift, etc.).
function applyTint(c: Color, tint: { color: Color; amount: number } | undefined): Color {
  if (!tint) return c;
  return new Color(
    c.r + (tint.color.r - c.r) * tint.amount,
    c.g + (tint.color.g - c.g) * tint.amount,
    c.b + (tint.color.b - c.b) * tint.amount,
  );
}

// Build the per-body palette + scalars for one disc. discPx is the
// final rendered diameter — sub-PROCEDURAL_TEXTURE_MIN_PX bodies force
// flat fill (palette weights = [1, 0, 0]) so tiny moons don't render
// as noise.
export function buildDiscPalette(
  body: Body,
  discPx: number,
): DiscPalette {
  const seed = hash32(`disc:${body.id}`) / 0x100000000;
  const surfaceOpacity = body.surfaceOpacity;
  const hasSurface = surfaceOpacity > 0;
  const tinyDisc = discPx < PROCEDURAL_TEXTURE_MIN_PX;

  // ── SURFACE PALETTE — resource-driven for terrestrials, bulk-atm
  // column tint for gas/ice giants (so a cloud rent reveals the
  // physically-honest deep-column color). World-class color only
  // re-enters as a flat-fill fallback when a body carries no resource
  // signal at all (procgen edge).
  let sC0: Color, sC1: Color, sC2: Color;
  let sW0: number, sW1: number, sW2: number;
  if (!hasSurface) {
    const colColor = atmColumnColor(body) ?? worldClassColor(body);
    sC0 = colColor; sC1 = colColor; sC2 = colColor;
    sW0 = 1; sW1 = 0; sW2 = 0;
  } else {
    const res = dominantResources(body, 3);
    if (res.length === 0) {
      const base = worldClassColor(body);
      sC0 = base; sC1 = base; sC2 = base;
      sW0 = 1; sW1 = 0; sW2 = 0;
    } else {
      sC0 = res[0].color;
      sC1 = res[1]?.color ?? res[0].color;
      sC2 = res[2]?.color ?? res[0].color;
      sW0 = res[0].weight;
      sW1 = res[1]?.weight ?? 0;
      sW2 = res[2]?.weight ?? 0;
    }
  }

  // ── ATM COLUMN COLOR — what fills the void on a no-surface body.
  // Pure atm blend; no cloud / haze contribution. Black on bodies
  // with no atmosphere data (always overwritten by surface where
  // surface paints).
  const atmColC = atmColumnColor(body);
  const atmColumnRgb: readonly [number, number, number] = atmColC
    ? [atmColC.r, atmColC.g, atmColC.b]
    : [0, 0, 0];

  // Force flat fill on very small discs — the per-pixel hash texture
  // and the band strips both degrade to noise below ~16 px.
  if (tinyDisc) {
    sW0 = 1; sW1 = 0; sW2 = 0;
  }

  // Surface scalars — suppressed on no-surface bodies (the surface
  // block is unreachable there) and on tiny discs.
  const surfaceSuppressed = !hasSurface || tinyDisc;
  const waterFrac  = surfaceSuppressed ? 0   : (body.waterFraction ?? 0);
  const iceFrac    = surfaceSuppressed ? 0   : (body.iceFraction   ?? 0);
  const surfaceAge = surfaceSuppressed ? 0.5 : (body.surfaceAge ?? 0.5);
  const globalness = surfaceSuppressed ? 0   : globalnessForTemp(body.avgSurfaceTempK);

  // Biome stipple — same suppression as terrain scalars.
  const biomePaint = surfaceSuppressed ? null : biomePaintFor(body);
  const biomeColor: readonly [number, number, number] = biomePaint
    ? [biomePaint.color.r, biomePaint.color.g, biomePaint.color.b]
    : [0, 0, 0];
  const biomeCoverage = biomePaint ? biomePaint.coverage : 0;

  // Cloud layer scalars + per-deck color. One condensate per deck;
  // banded character emerges from coverage rents revealing the deck
  // below, not from in-deck mixing. tinyDisc suppresses all decks
  // since per-fragment worley would resolve as noise on a small disc.
  const cloudLayers = tinyDisc
    ? []
    : body.cloudLayers.map((l) => {
        const dp = cloudDeckPalette(body, l.gas);
        return {
          coverage: l.coverage,
          windSpeedMS: l.windSpeedMS,
          altitudeNorm: l.altitudeNorm,
          color: [dp.color.r, dp.color.g, dp.color.b] as const,
        };
      });

  // Unified haze blend — one color + one opacity per body, derived
  // from the atmospheric contributor list (bulk gases × pressure ×
  // potency, Rayleigh scattering, formation-gated aerosol products,
  // lifted dust). Runs for every body now that the surface gate is
  // gone; gas giants typically land at low hazeOpacity from bulk
  // atm contributions alone (no surfacePressureBar → 0 for those
  // contributors, only aerosol formation gates fire).
  const hazeRaw = tinyDisc
    ? { color: new Color(0, 0, 0), opacity: 0 }
    : hazeBlendFor(body);
  const hazeOpacity = hazeRaw.opacity;
  const hazeColorRgb: readonly [number, number, number] = [hazeRaw.color.r, hazeRaw.color.g, hazeRaw.color.b];

  // Rim color — every visible channel folded into one weighted blend.
  // Per-deck cloud bases enter weighted by their own coverage; haze
  // contributors enter at their physics-derived weights. No-surface
  // bodies add the atm column tint as the deep-column signal that
  // dominates at the limb when clouds don't fully occlude.
  let rimColorRgb: readonly [number, number, number] = [0, 0, 0];
  let rimWidthPx = 0;

  if (!tinyDisc) {
    let mr = 0, mg = 0, mb = 0, mw = 0;
    const add = (c: { r: number; g: number; b: number }, w: number) => {
      if (w <= 0) return;
      mr += c.r * w; mg += c.g * w; mb += c.b * w; mw += w;
    };

    // Per-deck cloud bases weighted by that deck's coverage. Higher
    // decks aren't preferred over lower decks at the limb — the rim
    // sees the sum of cloud chemistry.
    for (const dl of cloudLayers) {
      const cr = dl.color[0], cg = dl.color[1], cb = dl.color[2];
      if ((cr + cg + cb) > 0) add({ r: cr, g: cg, b: cb }, dl.coverage);
    }
    if (hasSurface) {
      for (const { color, weight } of surfaceHazeContributors(body)) {
        add(color, weight);
      }
    } else if (atmColC !== null) {
      add(atmColC, 1);
    }

    if (mw > 0) {
      rimColorRgb = [mr / mw, mg / mw, mb / mw];
      rimWidthPx = hasSurface
        ? rimWidthForSurfaceAtmosphere(body)
        : rimWidthForNoSurfaceAtmosphere(body);
      // Presence floor — Mars-class thin-air bodies that fall through
      // the pressure tiers still get a visible rim if the merger
      // produced any signal, distinguishing "has air" from "airless".
      if (hasSurface && rimWidthPx === 0) {
        rimWidthPx = RIM_PRESENCE_FLOOR_PX;
      }
    }
  }

  // Per-class hue tint applies to surface palette entries only. Cloud
  // palettes already derive from physically-anchored gas species and
  // skip the tint so cloud colors stay aligned with their condensates.
  const tint = body.worldClass !== null ? WORLD_CLASS_TINT[body.worldClass] : undefined;
  const t0 = applyTint(sC0, tint);
  const t1 = applyTint(sC1, tint);
  const t2 = applyTint(sC2, tint);

  return {
    palette: [
      t0.r, t0.g, t0.b,
      t1.r, t1.g, t1.b,
      t2.r, t2.g, t2.b,
    ] as const,
    weights: [sW0, sW1, sW2] as const,
    atmColumnColor: atmColumnRgb,
    surfaceOpacity,
    seed,
    tilt: bodyVisualTiltRad(body),
    waterFrac,
    iceFrac,
    biomeColor,
    biomeCoverage,
    cloudLayers,
    hazeOpacity,
    hazeColor: hazeColorRgb,
    rimColor: rimColorRgb,
    rimWidthPx,
    surfaceAge,
    globalness,
  };
}
