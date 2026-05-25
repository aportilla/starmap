// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// consumed by makePlanetMaterial.
//
// The shader composes a layered stack per fragment, bottom to top:
//   - **surface**  — worley/voronoi cell texture painted with the body's
//                    top 3 resource colors. World-class color only
//                    surfaces as a flat-fill fallback when a body has
//                    no resource signal. Skipped entirely when the body
//                    has no accessible surface (gas / ice giants).
//   - **cloud**    — coverage + structure scalars drive a worley patchy
//                    pattern (cloudStructure < 0.5, like Earth) or a
//                    latitude-banded pattern (cloudStructure ≥ 0.5, like
//                    Jupiter / Venus). Cloud palette is gas-mix derived
//                    when banded (top-3 gases including the condensate
//                    tint) and a single condensate color when patchy.
//   - **haze**     — uniform per-fragment lerp toward the haze color by
//                    hazeOpacity. Aerosol species (CH4 tholin, SO2
//                    sulfate, DUST, SILICATE) live here.
//   - **rim**      — concentric 1..N px halo OUTSIDE the disc + inward
//                    fade INSIDE, driven by total atmospheric column.
//
// Each layer's alpha is data-driven; total opacity is a continuum
// rather than a mode flip. A body with cloudCoverage = 0.4 and
// hazeOpacity = 0 renders as patchy clouds over a visible surface
// (Earth); cloudCoverage = 1.0 + hazeOpacity = 0.85 renders as full
// banded cloud cover with a tholin tint over it (Titan, with visible
// methane cloud structure beneath the haze).

import { Color } from 'three';
import {
  AtmGas, Body, CONDENSATE_COLOR, GAS_COLOR, GAS_POTENCY,
  GAS_VISIBILITY_FILTER, HAZE_AEROSOL_SCALE, HAZE_BULK_GAS_SCALE,
  HAZE_DUST_SCALE, HAZE_RAYLEIGH_SCALE, NO_SURFACE_WORLD_CLASSES,
  SCATTERING_COLOR, SCATTERING_POTENCY,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT,
  WORLD_CLASS_UNKNOWN_COLOR, biomePaintFor, cloudBandPalette,
  dominantResources,
} from '../../data/stars';
import { hash32 } from './geom/prng';
import { bodyVisualTiltRad } from './geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from './layout/constants';


// (Cloud condensate colors live in CONDENSATE_COLOR in stars.ts — a
// shared table used by both cloudBandPalette and the patchy-cloud path here.)

// (NO_SURFACE_WORLD_CLASSES lives in stars.ts — shared with
// cloudBandPalette which needs it to apply the temperature-driven
// base-blend weight on these classes.)

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
  // 4 RGB entries × 3 floats — the CLOUD layer palette. For banded
  // clouds (cloudStructure ≥ 0.5), slot 0 carries the perceptual
  // base blend (atm + cloud + haze) at fixed BASE_BLEND_WEIGHT and
  // slots 1-3 carry the top accent species sharing the remaining
  // weight (see cloudBandPalette in stars.ts). For patchy clouds
  // (cloudStructure < 0.5), slot 0 carries the single condensate
  // color and weights collapse to [1, 0, 0, 0]. Zeros throughout
  // when the body has no cloud layer.
  readonly cloudPalette: readonly [number, number, number,
                                   number, number, number,
                                   number, number, number,
                                   number, number, number];
  readonly cloudWeights: readonly [number, number, number, number];
  // True when the body has a paintable surface (terrestrial bracket
  // classes). False for gas/ice giants, gas dwarfs, hycean, helium —
  // the shader short-circuits the surface block and the cloud layer
  // is their canvas.
  readonly hasSurface: boolean;
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
  // Cloud layer coverage [0..1]. 0 = no clouds. Earth-class ≈ 0.4;
  // gas giants and Venus = 1.0 (full deck). Patchy structure: per-cell
  // hash < coverage paints cloud. Banded structure: full latitude
  // strips at this alpha.
  readonly cloudCoverage: number;
  // Cloud structure scalar. 0 = patchy cellular (Earth, Mars). 1 =
  // banded zonal (Venus, gas giants). The shader snaps at 0.5 in v1;
  // intermediate values mostly come from procgen jitter.
  readonly cloudStructure: number;
  // Haze layer uniform opacity [0..1]. The shader runs a per-fragment
  // mix(col, hazeColor, hazeOpacity) over EVERY paint underneath
  // (surface + cloud). Derived from the unified contributor blend
  // (bulk atm gases × pressure × potency, formation-gated aerosol
  // products, lifted dust from body mineralogy, Rayleigh scattering)
  // soft-capped via 1 - exp(-Σ). Titan ≈ 0.85, Venus ≈ 0.7, Mars ≈
  // 0.25, Earth ≈ 0.15. Zero on bodies with no atmosphere data.
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
// for the uniform haze pass) and the rim merger (which adds cloud slot 0
// on top). Walks four contributor categories: bulk atm gases × pressure
// (absorption tint), Rayleigh scattering on the same gases (scattering
// tint), formation-gated aerosol products from procgen (`hazeAerosols`),
// and lifted mineral dust colored by the body's resource mineralogy.
// Empty on bodies with no atmosphere data.
function surfaceHazeContributors(body: Body): Array<{ color: Color; weight: number }> {
  const out: Array<{ color: Color; weight: number }> = [];
  const P = body.surfacePressureBar;
  if (P !== null && P > 0) {
    const logP = Math.log10(P + 1);
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
        out.push({ color: col, weight: frac * potency * logP * HAZE_BULK_GAS_SCALE });
      }
      const sCol = SCATTERING_COLOR[gas];
      const sPotency = SCATTERING_POTENCY[gas] ?? 0;
      if (sCol && sPotency > 0) {
        out.push({ color: sCol, weight: frac * sPotency * logP * HAZE_RAYLEIGH_SCALE });
      }
    }
  }
  if (body.hazeAerosols !== null) {
    for (const [species, strength] of Object.entries(body.hazeAerosols)) {
      if (strength <= 0) continue;
      const gas = species as AtmGas;
      const col = GAS_COLOR[gas];
      const potency = GAS_POTENCY[gas] ?? 0;
      if (!col || potency <= 0) continue;
      out.push({ color: col, weight: strength * potency * HAZE_AEROSOL_SCALE });
    }
  }
  if (body.dustStrength !== null && body.dustStrength > 0) {
    const potency = GAS_POTENCY.DUST ?? 0;
    if (potency > 0) {
      out.push({ color: dustColorFor(body), weight: body.dustStrength * potency * HAZE_DUST_SCALE });
    }
  }
  return out;
}

// Unified haze color + opacity — weighted average across all
// surfaceHazeContributors; opacity is the soft cap 1 - exp(-Σw) so
// many thin contributions saturate smoothly rather than clipping.
function hazeBlendFor(body: Body): { color: Color; opacity: number } {
  const contribs = surfaceHazeContributors(body);
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

// Cloud condensate color — what cloud particles of the given species
// look like. Most cloud species are condensable gases whose ice/frost
// form differs visibly from their gas-phase color (CH4 ice frost vs
// CH4 gas cyan); CONDENSATE_COLOR carries those. Species that ARE
// already aerosols (H2SO4 droplets, SILICATE) fall back to GAS_COLOR
// since their "gas" color is their visible appearance.
function cloudCondensateColor(gas: AtmGas): Color {
  return CONDENSATE_COLOR[gas] ?? GAS_COLOR[gas] ?? new Color(0xffffff);
}

// Atm-only column color — weighted blend across atm1/2/3 by
// `frac × GAS_POTENCY`, with no contribution from cloud or haze
// species.
//
// Models the limb's physical regime on no-surface bodies (gas/ice
// giants, hycean, helium): at the limb the line of sight passes
// through a long glancing-angle gas column where forward-scattering
// accumulates. The visible color is the column tint of the gas
// species (H2/He cream for Jupiter; CH4 cyan-leaning for Uranus) —
// NOT the cloud-deck chemistry, which is altitude-localized and
// doesn't appear at the limb.
//
// GAS_COLOR entries are already chosen pale enough that the result
// reads as a natural "lighter at the limb" effect without an extra
// brighten-toward-white step. The visibility filter is honored so
// gas-giant CH4 (buried under the NH3 deck) doesn't paint the rim.
function atmColumnColor(body: Body): Color | null {
  const filtered: ReadonlySet<AtmGas> | undefined =
    body.worldClass !== null ? GAS_VISIBILITY_FILTER[body.worldClass] : undefined;
  const candidates: Array<[AtmGas | null, number | null]> = [
    [body.atm1 as AtmGas | null, body.atm1Frac],
    [body.atm2 as AtmGas | null, body.atm2Frac],
    [body.atm3 as AtmGas | null, body.atm3Frac],
  ];
  let r = 0, g = 0, b = 0, totalW = 0;
  for (const [gas, frac] of candidates) {
    if (gas === null || frac === null) continue;
    if (filtered?.has(gas)) continue;
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
  const hasSurface = body.worldClass === null ||
    !NO_SURFACE_WORLD_CLASSES.has(body.worldClass);
  const tinyDisc = discPx < PROCEDURAL_TEXTURE_MIN_PX;

  // ── SURFACE PALETTE — resource-driven, always computed ──
  // World-class color only re-enters as a flat-fill fallback when a
  // body carries no resource signal at all (procgen edge).
  const res = dominantResources(body, 3);
  let sC0: Color, sC1: Color, sC2: Color;
  let sW0: number, sW1: number, sW2: number;
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

  // ── CLOUD PALETTE — base+accent for banded, single condensate for patchy ──
  // For now (Phase B of the layered cloud rollout) the shader still
  // takes a single deck. Pick the top layer (highest altitudeNorm —
  // last in the procgen-sorted array) as the representative deck;
  // Phase D will dispatch all layers to the shader through a per-body
  // data texture.
  const topLayer = body.cloudLayers.length > 0
    ? body.cloudLayers[body.cloudLayers.length - 1]
    : null;
  const cloudGas = topLayer ? (topLayer.gas as AtmGas) : null;
  const rawCloudCoverage  = topLayer?.coverage ?? 0;
  const rawCloudStructure = topLayer?.bandness ?? 0;
  let cC0 = new Color(0, 0, 0);
  let cC1 = new Color(0, 0, 0);
  let cC2 = new Color(0, 0, 0);
  let cC3 = new Color(0, 0, 0);
  let cW0 = 0, cW1 = 0, cW2 = 0, cW3 = 0;
  if (cloudGas !== null && rawCloudCoverage > 0) {
    if (rawCloudStructure >= 0.5) {
      // Banded — 4-slot base+accent palette stochastically picked per
      // cell. Slot 0 = perceptual blend across atm + cloud + haze at
      // ~50% picker weight; slots 1-3 = accent species at their
      // natural saturation sharing the remaining weight. See
      // cloudBandPalette in stars.ts for the model.
      const cbp = cloudBandPalette(body);
      cC0 = cbp.palette[0];
      cC1 = cbp.palette[1];
      cC2 = cbp.palette[2];
      cC3 = cbp.palette[3];
      cW0 = cbp.weights[0];
      cW1 = cbp.weights[1];
      cW2 = cbp.weights[2];
      cW3 = cbp.weights[3];
    } else {
      // Patchy — single condensate color in slot 0. The shader paints
      // pCloudPalette0 on cells where the per-cell hash < cloudCoverage.
      const c = cloudCondensateColor(cloudGas);
      cC0 = c; cC1 = c; cC2 = c; cC3 = c;
      cW0 = 1; cW1 = 0; cW2 = 0; cW3 = 0;
    }
  }

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

  // Cloud + haze scalars — tinyDisc suppresses both since the shader's
  // per-fragment work would resolve as noise.
  const cloudCoverage  = tinyDisc ? 0 : rawCloudCoverage;
  const cloudStructure = tinyDisc ? 0 : rawCloudStructure;

  // Unified haze blend — one color + one opacity per body, derived
  // from the atmospheric contributor list (bulk gases × pressure ×
  // potency, Rayleigh scattering, formation-gated aerosol products,
  // lifted dust). Surface bodies paint this as the interior overlay.
  const hazeRaw = (tinyDisc || !hasSurface)
    ? { color: new Color(0, 0, 0), opacity: 0 }
    : hazeBlendFor(body);
  const hazeOpacity = hazeRaw.opacity;
  const hazeColorRgb: readonly [number, number, number] = [hazeRaw.color.r, hazeRaw.color.g, hazeRaw.color.b];

  // Rim color — cloud slot 0 + the same contributor list (surface
  // bodies) or cloud + atm column tint (no-surface bodies). Every
  // contributor with weight > 0 participates; result normalizes.
  let rimColorRgb: readonly [number, number, number] = [0, 0, 0];
  let rimWidthPx = 0;

  if (!tinyDisc) {
    let mr = 0, mg = 0, mb = 0, mw = 0;
    const add = (c: { r: number; g: number; b: number }, w: number) => {
      if (w <= 0) return;
      mr += c.r * w; mg += c.g * w; mb += c.b * w; mw += w;
    };

    // Cloud slot 0 — chromophore-muted base blend for banded clouds,
    // single condensate for patchy. Safe on no-surface bodies too.
    if (rawCloudCoverage > 0 && (cC0.r + cC0.g + cC0.b) > 0) {
      add(cC0, rawCloudCoverage);
    }
    if (hasSurface) {
      // Same contributor list that feeds hazeColor — bulk gas
      // absorption, Rayleigh, aerosol products, dust. Each at its
      // physics-derived weight; no special-casing per channel.
      for (const { color, weight } of surfaceHazeContributors(body)) {
        add(color, weight);
      }
    } else {
      // Forward-scatter gas-column tint with chromophore filter
      // (atmColumnColor strips cloud-deck species). Aerosols are
      // altitude-localized chromophores on gas giants — they feed
      // the cloud band palette, not the limb.
      const c = atmColumnColor(body);
      if (c !== null) add(c, 1);
    }

    if (mw > 0) {
      rimColorRgb = [mr / mw, mg / mw, mb / mw];
      rimWidthPx = hasSurface
        ? rimWidthForSurfaceAtmosphere(body)
        : rimWidthForNoSurfaceAtmosphere(body);
      // Presence floor — any contributor that made it into the merger
      // counts as "has atmosphere," so any surface body that fell
      // through the pressure tiers still gets a visible rim. Catches
      // Mars (P=0.006 bar too thin for the Rayleigh tier, but dust +
      // thin cirrus dominate the visible signal from orbit) and data-
      // thin bodies whose only signal is haze.
      if (hasSurface && rimWidthPx === 0) {
        rimWidthPx = RIM_PRESENCE_FLOOR_PX;
      }
    }
  }

  // Per-class hue tint applies to surface palette entries; cloud
  // palette comes from gas-mix (already physically derived) and skips
  // the tint to keep cloud colors aligned with their gas species.
  const tint = body.worldClass !== null ? WORLD_CLASS_TINT[body.worldClass] : undefined;
  const t0 = applyTint(sC0, tint);
  const t1 = applyTint(sC1, tint);
  const t2 = applyTint(sC2, tint);
  const ct0 = cC0;
  const ct1 = cC1;
  const ct2 = cC2;
  const ct3 = cC3;

  return {
    palette: [
      t0.r, t0.g, t0.b,
      t1.r, t1.g, t1.b,
      t2.r, t2.g, t2.b,
    ] as const,
    weights: [sW0, sW1, sW2] as const,
    cloudPalette: [
      ct0.r, ct0.g, ct0.b,
      ct1.r, ct1.g, ct1.b,
      ct2.r, ct2.g, ct2.b,
      ct3.r, ct3.g, ct3.b,
    ] as const,
    cloudWeights: [cW0, cW1, cW2, cW3] as const,
    hasSurface,
    seed,
    tilt: bodyVisualTiltRad(body),
    waterFrac,
    iceFrac,
    biomeColor,
    biomeCoverage,
    cloudCoverage,
    cloudStructure,
    hazeOpacity,
    hazeColor: hazeColorRgb,
    rimColor: rimColorRgb,
    rimWidthPx,
    surfaceAge,
    globalness,
  };
}
