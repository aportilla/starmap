// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// + per-body data-texture row consumed by makePlanetMaterial.
//
// The shader composes a layered stack per fragment, bottom to top:
//   - **surface**  — worley/voronoi cell texture painted with the body's
//                    top 2 resource archetypes. World-class color only
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
//
// ─── Surface palette: three resource-archetype slots ───────────────
//
// `buildDiscPalette` derives the surface palette from each body's
// dominant resources via `dominantResources(body, 2)`:
//   slot 0  — single-archetype color for the top resource (ROCK_ARCHETYPE_SINGLE)
//   slot 1  — pair archetype for top-1+top-2 (ROCK_ARCHETYPE_PAIR —
//             basalt for metals+silicates, iron oxide for metals+
//             rare-earths, sulfur deposits for silicates+radioactives,
//             permafrost for silicates+volatiles, etc.)
//   slot 2  — body-tinted barren regolith via `barrenTintFor(k0, k1)`
//             — ordered lookup (different colors per ordering so
//             dominance shows in the regolith) with formula fallback
//             that mixes BARREN_ROCK_COLOR + RESOURCE_COLOR[k0/k1]
//
// Each archetype slot lerps toward BARREN_ROCK_COLOR by `1 − abundance`
// (with ABUNDANCE_VISUAL_FLOOR so trace-resource slots still hint at
// their archetype), and picks up a deterministic brightness offset +
// temperature tint per body. The barren slot is NOT abundance-lerped —
// it always paints at full strength as the body's regolith. World-
// class color appears only as a flat-fill fallback when a body has no
// resource signal at all.
//
// Gas / ice giants skip the surface entirely and paint `atmColumnColor`
// — a frac × GAS_POTENCY weighted blend of the body's atm slots that
// resolves to whichever absorbing species dominates the column. A
// synthetic "base" cloud deck (prepended at altitudeNorm 0.0 with deck
// color = atmColumnColor lifted slightly toward white) provides the
// foundation banding through the same worley + lat-keyed lj machinery
// the chemistry decks use, so gas giants read as gently banded rather
// than a flat fill. The chemistry decks then composite above.
//
// ─── Haze contributor model ────────────────────────────────────────
//
// `hazeBlendFor` returns (color, opacity) from four weighted contributor
// categories, each gated by `log10(P+1)` (column-mass proxy) so a
// thin-atm body can't paint full haze regardless of formation strength:
//
//   bulk gases    — frac × GAS_POTENCY[gas]            × HAZE_BULK_GAS_SCALE
//   Rayleigh      — frac × SCATTERING_POTENCY[gas]     × HAZE_RAYLEIGH_SCALE
//   aerosols      — body.hazeAerosols[gas] × POTENCY   × HAZE_AEROSOL_SCALE
//                   (skipped when species matches a cloud deck on this
//                    body — `deckGasesFor` — so we don't double-count)
//   lifted dust   — body.dustStrength × POTENCY[DUST]  × HAZE_DUST_SCALE
//                   (color from `dominantResources` so dust matches the
//                    body's mineralogy: iron-grey, rust, tan)
//
// No-surface bodies fold `atmColumnColor` in as a stratospheric-haze
// contributor so Saturn picks up a non-zero opacity (cream H2/He tint)
// for the per-deck haze pre-tint. Opacity is soft-capped via
// `1 − exp(−Σ)` so many thin contributions saturate smoothly. CHROMOPHORE
// sits in RENDERER_SKIP_AEROSOLS — its visible signal is too localized
// (Jupiter's GRS, Saturn's polar hexagon) for a uniform haze tint.
//
// The rim halo uses the same weighted-average merger plus each cloud
// deck's base color folded in by deck coverage — this is the loft's
// base (Mie) hue, which the shader lights per-star. `scatteringRimFor`
// additionally derives the per-gas limb Rayleigh scatter color (the
// frac × SCATTERING_POTENCY blend of SCATTERING_COLOR) and a Rayleigh-
// fraction strength; the shader rotates the lit rim toward that hue with
// loft-column depth (hue only — see makePlanetMaterial's Rayleigh block).
//
// ─── Where chemistry lives ─────────────────────────────────────────
//
// Procgen owns the chemistry: `procgen.mjs:hazeFor` emits per-species
// formation strengths (THOLIN / NH4SH / CHROMOPHORE / SALT / H2SO4 /
// SULFUR / SILICATE) and `dustStrength` from peaked T+atm gates;
// `procgen.mjs:cloudDecksFor` emits cloud decks from per-species
// condensation gates in `CONDENSABLES`. The renderer paints exactly
// what procgen emits — no silent substitution. See the chemistry-gate
// comments in `procgen.mjs:hazeContribution` and the `CONDENSABLES`
// table in `procgen-priors.mjs` for per-species rationale.
//
// Color tables (two layers) live in `../color-science`:
//   GAS_COLOR        — visible hue when the species is gas-phase or
//                      photochemistry aerosol (CH4 cyan, H2/He cream,
//                      THOLIN orange, NH4SH brown, H2SO4 sulfate, etc.)
//   CONDENSATE_COLOR — sparse table of ice/frost appearances for
//                      condensable gases (CH4 frost, NH3 ice, N2 frost,
//                      H2O ice). Falls back to GAS_COLOR when the
//                      species isn't a condensable.
//
// `WORLD_CLASS_TINT` applies a small warm/cool shift to surface palette
// entries — `gas_giant` lerps toward amber so Jupiter reads ruddier
// than Saturn. Cloud palette entries skip the tint so cloud colors
// stay aligned with their gas species.

import { Color } from 'three';
import { Body } from '../../../data/stars';
import {
  BARREN_ROCK_COLOR, barrenTintFor,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT, WORLD_CLASS_UNKNOWN_COLOR,
  biomePaintFor, cloudDeckPalette, dominantResources, lerpColor,
  rockArchetypeFor,
} from '../color-science';
import { hash32 } from '../geom/prng';
import { bodyVisualTiltRad } from '../geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from '../layout/constants';
import {
  atmColumnColor, hazeBlendFor, rimWidthForNoSurfaceAtmosphere,
  rimWidthForSurfaceAtmosphere, RIM_PRESENCE_FLOOR_PX, scatteringRimFor,
  surfaceHazeContributors,
} from './atmosphere';
import { lavaDrivesFor } from './lava';
import { oceanColorFor, OCEAN_FALLBACK_COLOR } from './ocean';
import { BLACK_COLOR, smoothstep01, weightedColorBlend, WHITE_COLOR } from './shared';

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

// Per-body brightness shift — deterministic ±RANGE in [0..1] applied
// uniformly across both archetype palette slots so the body's internal
// contrast is preserved but two bodies sharing an archetype stack
// (e.g. a system full of M+R rusty worlds) read as visibly different
// shades. Positive seed → lerp toward white; negative → lerp toward
// black. Magnitude tuned so adjacent bodies look like siblings rather
// than the same body twice.
const PER_BODY_BRIGHTNESS_RANGE = 0.18;

// Per-body temperature tint — hot bodies lerp toward a warm orange,
// cold bodies toward a cool blue, by `amount × hueShiftMagnitude`. Real
// planetary surfaces lean this way (more iron oxide & sulfur on hot
// dry, more ice & frost on cold), and the shift gives a 5-body system
// orbiting one star a temperature gradient readable at a glance. Tints
// are deliberately soft hues, not saturated — they nudge, they don't
// dominate.
const TEMP_TINT_WARM = new Color(1.0, 0.55, 0.25);
const TEMP_TINT_COOL = new Color(0.55, 0.78, 1.0);
const TEMP_TINT_AMOUNT = 0.12;
const TEMP_NEUTRAL_K = 280;
const TEMP_COLD_K    = 100;
const TEMP_HOT_K     = 700;

// Two consumers share BARREN_ROCK_COLOR (imported from data/stars). The
// archetype slots lerp toward it by (1 − abundance) so a trace-silicates
// region collapses ~90% to neutral regolith. The third slot — the body-
// tinted barren paint — uses it as the base for a (k0, k1)-flavored
// mineralogy hint via `barrenTintFor`, so the disc's regolith varies
// per body instead of every world wearing the same grey.
// ABUNDANCE_VISUAL_FLOOR keeps any present-but-trace resource from
// collapsing all the way to grey (~10% archetype always survives, so
// the disc still hints at the underlying mineralogy rather than reading
// as pure noise).
const ABUNDANCE_VISUAL_FLOOR = 0.1;

// Synthetic base deck params for no-surface bodies. The deck color is
// the atm column lifted slightly toward white so deck cells fire at a
// just-perceptibly-brighter shade than the rented atm column — gentle
// wispy variety where the deck doesn't fully cover. Coverage 0.95
// leaves ~5% rents to pure atm column. BAND_LIGHTNESS_JITTER in the
// shader (±6%) provides the lat-band tone variation on top.
const BASE_DECK_LIGHTNESS_LIFT = 0.05;
const BASE_DECK_COVERAGE = 0.95;
const BASE_DECK_WIND_DEFAULT = 200;

// Apply two per-body shifts to an archetype color: a deterministic
// brightness offset (from the body's hash seed) and a temperature-driven
// warm/cool tint (from `avgSurfaceTempK`). Both are soft — they vary the
// body within a recognizable archetype, not across archetypes.
//
// seed ∈ [0, 1) — same hash used elsewhere in disc-palette so both
// palette slots on one body share the same brightness shift.
function applyPerBodyTints(c: Color, body: Body, seed: number): Color {
  // Brightness — map seed [0, 1) to [-RANGE, +RANGE], lerp toward black
  // or white. Uniform across the body's slots so internal contrast
  // is preserved.
  const brightDelta = (seed - 0.5) * 2 * PER_BODY_BRIGHTNESS_RANGE;
  let shifted = brightDelta > 0
    ? lerpColor(c, WHITE_COLOR, brightDelta)
    : brightDelta < 0
      ? lerpColor(c, BLACK_COLOR, -brightDelta)
      : c;
  // Temperature — split-piecewise around TEMP_NEUTRAL_K. Hot → warm
  // tint; cold → cool tint. Amount scales linearly to TEMP_HOT_K /
  // TEMP_COLD_K then clamps at TEMP_TINT_AMOUNT. Null tempK = no shift.
  const tempK = body.avgSurfaceTempK;
  if (tempK !== null) {
    if (tempK > TEMP_NEUTRAL_K) {
      const a = Math.min(1, (tempK - TEMP_NEUTRAL_K) / (TEMP_HOT_K - TEMP_NEUTRAL_K));
      shifted = lerpColor(shifted, TEMP_TINT_WARM, a * TEMP_TINT_AMOUNT);
    } else if (tempK < TEMP_NEUTRAL_K) {
      const a = Math.min(1, (TEMP_NEUTRAL_K - tempK) / (TEMP_NEUTRAL_K - TEMP_COLD_K));
      shifted = lerpColor(shifted, TEMP_TINT_COOL, a * TEMP_TINT_AMOUNT);
    }
  }
  return shifted;
}

// Compute globalness from avgSurfaceTempK via a smoothstep curve.
// Null temperature falls back to 0 (cap pattern — safest default for
// a body with missing thermal data; the iceFrac value still gates
// whether any ice renders at all).
function globalnessForTemp(avgT: number | null): number {
  if (avgT == null) return 0;
  // Inverted ramp — full global ice at/below the cold threshold, none at/above
  // the cap. ICE_TEMP_GLOBAL_K < ICE_TEMP_CAP_K, so smoothstep01 climbs 0→1 with
  // temperature and the 1 − … flip turns it into the ice-melts-as-it-warms curve.
  return 1 - smoothstep01(ICE_TEMP_GLOBAL_K, ICE_TEMP_CAP_K, avgT);
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
  // Per-body ocean color [0..1]^3 — replaces the shader's hard-coded
  // OCEAN_COLOR constant for surface-liquid cells. Derived through five
  // physical pathways (stellar SED × sky reflection + solvent base ×
  // CDOM × pigment × sediment) so close-analog bodies get distinguishable
  // hues. See `oceanColorFor` above for the full stack. Painted only
  // where the shader's existing `liquidOceanHere` predicate fires; cold
  // bodies (globalness > 0.5) still fall back to ice/resource paths.
  readonly oceanColor: readonly [number, number, number];
  // Surface ice cover [0..1]. Drives cap-latitude paint on warm bodies
  // (Earth's poles) and bulk cryosphere on cold ones (Europa). Same
  // suppression gates as waterFrac.
  readonly iceFrac: number;
  // Biome stipple — pigment color (archetype × stellar shift; see
  // biomePaintFor in color-science.ts) packed as [r,g,b], and coverage density
  // [0..1] scaled off biosphereSurfaceImpact. Suppressed on no-surface
  // bodies, tiny discs, and bodies with no surface signature.
  readonly biomeColor: readonly [number, number, number];
  readonly biomeCoverage: number;
  // Cloud layers — up to MAX_CLOUD_LAYERS stratified decks, sorted
  // ascending by altitudeNorm. Each entry carries one condensate color
  // (no in-deck mixing). The shader composites layers above the
  // surface + haze, each pre-tinted by the haze opacity sitting above
  // it. Empty slots have coverage = 0 and get a no-op composite.
  // Banded character emerges from coverage rents revealing the deck
  // below (or the surface / atm-column beneath the stack). No-surface
  // bodies get a synthetic base deck prepended at altitudeNorm 0.0
  // (atm column lifted toward white) so the bulk gas-giant fill reads
  // as gently banded foundation under any chemistry decks above.
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
  // Per-body limb Rayleigh scattering (see scatteringRimFor). scatterColor
  // is the gas-specific scatter hue the rim shifts toward (re-illuminated
  // by starlight in the shader); scatterStrength [0..1] scales the maximum
  // depth-graded hue shift so a clear-air body (Earth) shifts strongly
  // while an absorption-dominated one (Venus) barely moves. Black /
  // strength 0 on bodies with no clear-air signal — the shader then leaves
  // the rim at its Mie color.
  readonly scatterColor: readonly [number, number, number];
  readonly scatterStrength: number;
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
  // Lava / molten-surface emission. `moltenCoverage` [0..1] = how much of
  // the disc is molten — the max of an insolation-driven global-melt ramp
  // (avgSurfaceTempK across the silicate solidus) and a capped tidal/
  // radiogenic vent drive (sparse calderas on an actively-repaved dry
  // surface, e.g. Io). `emissionTempNorm` [0..1] keys the shader's
  // blackbody emberRamp (0 ≈ Draper-point dull red, 1 ≈ white-hot) — the
  // heat path emits at the surface temperature, the vent path at intrinsic
  // silicate-lava temperature regardless of a cold crust. Both 0 on
  // suppressed surfaces and non-incandescent bodies, so the shader's
  // molten sub-pass early-outs. See the LAVA_* constants above and the
  // molten sub-pass in makePlanetMaterial.
  readonly moltenCoverage: number;
  readonly emissionTempNorm: number;
  // Composition hue nudge [0..1] — abiotic surface sulfur fraction (SO2 /
  // sulfate / elemental-sulfur species). The shader lifts the ember's
  // green channel by this so sulfurous volcanism (Io) reads yellower than
  // pure silicate lava. 0 leaves the blackbody ember untouched.
  readonly lavaSulfurFrac: number;
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
  return lerpColor(c, tint.color, tint.amount);
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

  // ── SURFACE PALETTE — three paint slots for terrestrials, bulk-atm
  // column tint for gas/ice giants. World-class color re-enters as a
  // flat-fill fallback when a body carries no resource signal at all.
  //
  // Slot mapping (terrestrials with N>=1 nonzero resources):
  //   slot 0 = top-1 single archetype           (Mercury → iron grey)
  //   slot 1 = (top-1 + top-2) pair archetype   (M+S    → basalt)
  //   slot 2 = body-tinted barren regolith      (M+S    → rust-stained
  //                                              iron-grey dust)
  //
  // With N=1 → slot 1 = slot 0. The shader's per-region subset hash
  // picks one of 7 non-empty subsets of {p0, p1, p2} so a region paints
  // as pure-archetype-A, pure-archetype-B, body-tinted barren regolith,
  // or any mix — coherent mineralogy rather than a blend of raw
  // saturated resource colors.
  //
  // The two archetype slots are lerped toward BARREN_ROCK_COLOR by
  // (1 − abundance) so resource-poor worlds fade toward neutral; the
  // barren slot is independent of abundance — it's always the body's
  // own tinted regolith and provides the visual variety that
  // distinguishes a metal-rich world's barren patches from a volatile-
  // rich one's. Net visual: a resource-poor moon and a resource-rich
  // planet read visually distinct (the rich planet shows vibrant
  // archetype regions next to body-tinted barren; the poor moon shows
  // muted archetype regions next to body-tinted barren) instead of
  // both saturating the same archetype palette.
  let sC0: Color, sC1: Color, sC2: Color;
  let sW0: number, sW1: number, sW2: number;
  if (!hasSurface) {
    const colColor = atmColumnColor(body) ?? worldClassColor(body);
    sC0 = colColor; sC1 = colColor; sC2 = colColor;
    sW0 = 1; sW1 = 0; sW2 = 0;
  } else {
    const res = dominantResources(body, 2);
    if (res.length === 0) {
      // No resource signal at all — fall back to the world-class color
      // rather than barren grey so an "atm-only" classification still
      // reads as something distinct. (Procgen virtually always populates
      // at least one res scalar for terrestrials, so this branch is
      // defensive against curated rows with the entire grid empty.)
      const base = worldClassColor(body);
      sC0 = base; sC1 = base; sC2 = base;
      sW0 = 1; sW1 = 0; sW2 = 0;
    } else {
      const k0 = res[0].key;
      const k1 = res[1]?.key ?? null;
      const a0 = res[0].abundance;
      const a1 = res[1]?.abundance ?? 0;
      const arch0 = applyPerBodyTints(rockArchetypeFor(k0, null, 1), body, seed);
      // a0 / (a0 + a1) needs no zero guard: dominantResources filters to
      // value > 0, so res[0] (and thus a0) is always strictly positive when
      // res.length > 0 — the denominator can't vanish.
      const arch1 = applyPerBodyTints(
        k1 !== null ? rockArchetypeFor(k0, k1, a0 / (a0 + a1)) : arch0,
        body, seed,
      );
      // Per-slot grey lerp keyed off absolute abundance. Floor keeps a
      // present-but-trace resource from collapsing fully to grey so the
      // disc still hints at composition.
      const t0 = Math.max(ABUNDANCE_VISUAL_FLOOR, a0);
      const t1 = Math.max(ABUNDANCE_VISUAL_FLOOR, a1);
      sC0 = lerpColor(BARREN_ROCK_COLOR, arch0, t0);
      sC1 = lerpColor(BARREN_ROCK_COLOR, arch1, t1);
      // Slot 2: body-tinted barren regolith. Ordered (k0, k1) so a
      // metals-dominant world's barren differs from a silicates-
      // dominant one's. Runs through applyPerBodyTints for the same
      // sibling-distinguishing brightness/temp shifts the archetype
      // slots use. NOT abundance-lerped — the barren patches are the
      // body's actual regolith, present at full strength regardless of
      // how rich the rest is.
      sC2 = applyPerBodyTints(barrenTintFor(k0, k1), body, seed);
      // Equal weights across all three slots so the region hash gets
      // an even shot at each. Abundance shows through the per-slot
      // color lerp above, not as area share.
      sW0 = 1; sW1 = 1; sW2 = 1;
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

  // Unified haze blend — one color + one opacity per body, derived
  // from the atmospheric contributor list (bulk gases × pressure ×
  // potency, Rayleigh scattering, formation-gated aerosol products,
  // lifted dust). Runs for every body now that the surface gate is
  // gone; gas giants typically land at low hazeOpacity from bulk
  // atm contributions alone (no surfacePressureBar → 0 for those
  // contributors, only aerosol formation gates fire). Computed once
  // here and threaded into oceanColorFor (its Fresnel sky-reflect
  // pathway needs the same blend) so the contributor walk runs once.
  const hazeRaw = tinyDisc
    ? { color: new Color(0, 0, 0), opacity: 0 }
    : hazeBlendFor(body);
  const oceanColor = surfaceSuppressed ? OCEAN_FALLBACK_COLOR : oceanColorFor(body, hazeRaw);

  // ── LAVA / MOLTEN-SURFACE EMISSION — three continuous melt drives folded
  // to (coverage, emission temp, sulfur hue). See lavaDrivesFor in ./lava.
  // Suppressed surfaces (no-surface / tiny disc) emit nothing, so the
  // shader's molten sub-pass early-outs.
  const { moltenCoverage, emissionTempNorm, lavaSulfurFrac } = surfaceSuppressed
    ? { moltenCoverage: 0, emissionTempNorm: 0, lavaSulfurFrac: 0 }
    : lavaDrivesFor(body, surfaceAge);

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
  //
  // No-surface bodies get a synthetic "base" deck prepended at altitude
  // 0.0 — the bulk atm column rendered through the same worley + lat-
  // keyed brightness-jitter machinery as real cloud decks, with the
  // deck color lerped slightly toward white so it reads as "the body's
  // bulk color, gently banded" rather than a flat fill. Coverage 0.95
  // leaves occasional rents that reveal the pure atm column beneath
  // for subtle wispy variety. Wind matches the topmost real deck so
  // the base deck's bands share geometry with the chemistry decks
  // above it (no-deck bodies fall back to BASE_DECK_WIND_DEFAULT).
  const cloudLayers = tinyDisc
    ? []
    : (() => {
        const decks: Array<{
          coverage: number;
          windSpeedMS: number;
          altitudeNorm: number;
          color: readonly [number, number, number];
        }> = body.cloudLayers.map((l) => {
          const dp = cloudDeckPalette(body, l.gas);
          return {
            coverage: l.coverage,
            windSpeedMS: l.windSpeedMS,
            altitudeNorm: l.altitudeNorm,
            color: [dp.color.r, dp.color.g, dp.color.b] as const,
          };
        });
        if (!hasSurface && atmColC !== null) {
          const topWind = decks.reduce(
            (max, d) => (d.windSpeedMS > max ? d.windSpeedMS : max),
            BASE_DECK_WIND_DEFAULT,
          );
          const baseColor = lerpColor(atmColC, WHITE_COLOR, BASE_DECK_LIGHTNESS_LIFT);
          decks.unshift({
            coverage: BASE_DECK_COVERAGE,
            windSpeedMS: topWind,
            altitudeNorm: 0.0,
            color: [baseColor.r, baseColor.g, baseColor.b] as const,
          });
        }
        return decks;
      })();

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
    const entries: Array<{ color: { r: number; g: number; b: number }; weight: number }> = [];

    // Per-deck cloud bases weighted by that deck's coverage. Higher
    // decks aren't preferred over lower decks at the limb — the rim
    // sees the sum of cloud chemistry.
    for (const dl of cloudLayers) {
      const cr = dl.color[0], cg = dl.color[1], cb = dl.color[2];
      // Channel-sum > 0 is a proxy for "real condensate" — it drops the
      // BLACK_COLOR fallback cloudDeckPalette emits for a gas with no
      // CONDENSATE_COLOR/GAS_COLOR entry. Safe only because every curated
      // condensate/gas color is non-black; a legitimately near-black deck
      // would be silently skipped here.
      if ((cr + cg + cb) > 0) entries.push({ color: { r: cr, g: cg, b: cb }, weight: dl.coverage });
    }
    if (hasSurface) {
      for (const c of surfaceHazeContributors(body)) entries.push(c);
    } else if (atmColC !== null) {
      entries.push({ color: atmColC, weight: 1 });
    }

    const { r, g, b, totalWeight } = weightedColorBlend(entries);
    if (totalWeight > 0) {
      rimColorRgb = [r, g, b];
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

  // Per-body limb Rayleigh scatter color + strength for the rim hue shift.
  // Suppressed on tiny discs alongside the rest of the atmosphere paint.
  const scatter = tinyDisc
    ? { color: [0, 0, 0] as readonly [number, number, number], strength: 0 }
    : scatteringRimFor(body);

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
    oceanColor,
    iceFrac,
    biomeColor,
    biomeCoverage,
    cloudLayers,
    hazeOpacity,
    hazeColor: hazeColorRgb,
    rimColor: rimColorRgb,
    rimWidthPx,
    scatterColor: scatter.color,
    scatterStrength: scatter.strength,
    surfaceAge,
    globalness,
    moltenCoverage,
    emissionTempNorm,
    lavaSulfurFrac,
  };
}
