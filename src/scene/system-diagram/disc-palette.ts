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
  AtmGas, Body, CHROMOPHORE_COLOR, GAS_COLOR,
  SCATTERING_COLOR, SCATTERING_POTENCY,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT,
  WORLD_CLASS_UNKNOWN_COLOR, biomePaintFor, dominantResources,
  topGases,
} from '../../data/stars';
import { hash32 } from './geom/prng';
import { bodyVisualTiltRad } from './geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from './layout/constants';

// How strongly banded-mode palette entries collapse toward their
// weighted mean. 0 = full-contrast alternation (e.g. 3 blue bands +
// 1 white band reads as alternating blue/white strips); 1 = single
// flat color. 0.85 leans heavily toward a single dominant tone with
// only subtle per-band hue shifts — the shader's many-band non-uniform
// strip layout already produces strong perceived variation through
// band-width jitter and boundary warp, so the palette can stay tight
// without the disc reading as monochrome.
const BAND_BLEND_TOWARD_MEAN = 0.85;

// Condensate-phase color per cloud species. Gas-phase color in
// GAS_COLOR is wrong for condensed clouds — CH4 gas is blue (Uranus/
// Neptune absorption) but CH4 ICE is off-white frost. This lookup
// gives the renderer the right "what does this cloud LOOK like as a
// condensed patch" color. Used only for patchy clouds (single
// condensate species); banded clouds derive their palette from the
// full atm gas mix via topGases.
const CLOUD_COLOR_FOR_GAS: Partial<Record<AtmGas, Color>> = {
  H2O:      new Color(0xe4ecf0),  // white — water ice/droplets
  CH4:      new Color(0xeae8de),  // pale frost — methane ice
  N2:       new Color(0xeceae0),  // pale frost — nitrogen ice (Triton)
  NH3:      new Color(0xeae6dc),  // off-white — ammonia ice
  H2SO4:    new Color(0xd8c474),  // yellow-cream — sulfuric acid (Venus)
  SILICATE: new Color(0x788098),  // refractive grey-blue
  DUST:     new Color(0xa86040),  // ferric rust — dust suspended as cloud
};

// World classes whose body has no accessible surface — gas/ice giants,
// gas dwarfs, hycean (deep ocean under thick H2/He), helium giants.
// hasSurface is plumbed to the shader to short-circuit the surface
// paint pass on these bodies; the cloud layer is their canvas.
const NO_SURFACE_WORLD_CLASSES: ReadonlySet<string> = new Set([
  'gas_giant', 'gas_dwarf', 'ice_giant', 'hycean', 'helium',
]);

// Pressure-driven outward rim width buckets — the number of integer
// pixels the atmospheric halo extends INTO SPACE beyond the disc edge.
// log10(surfacePressureBar + 1) crosses these thresholds to step from
// 0 → N px. Sub-0.01 bar gets no rim (Mercury, Moon, Mars's 0.006 bar);
// 0.01..0.5 bar = 1 px; 0.5..5 bar = 2 px (Earth lands here); ≥ 5 bar
// = 3 px (sub-banded thick atmospheres). Capped at 3 px max so the
// halo stays a glance-read of "this body has air" rather than a
// dominant visual element. The shader pairs this outward halo with an
// INWARD fade whose width is proportional to disc radius — together
// they simulate the limb's atmospheric column thickening at the disc
// edge as seen edge-on.
const RIM_PRESSURE_LOG10_THRESHOLDS = [0.005, 0.17, 0.78] as const;

// Cap the rim width to this fraction of disc radius so a tiny moon
// doesn't get visually swamped by its own halo. 0.15 → a 40-px disc
// caps at 3 px, a 20-px disc caps at 1 px.
const RIM_MAX_RADIUS_FRACTION = 0.15;

// Default outward halo width for no-surface bodies (gas / ice giants).
// These have no surfacePressureBar to drive the pressure mapping, but
// they always carry a thick atmospheric column. 2 px gives a visible
// halo without dominating the disc — matches Titan's pressure-derived
// width so a gas giant doesn't read as more atmosphere-haloed than
// Titan.
const NO_SURFACE_RIM_WIDTH_PX = 2;

// Minimum atmospheric pressure for any rim to render at all. Below
// this the column has too little gas to produce a visible scattering
// signal. Above it, the clear-air rim color comes from a per-gas
// scattering blend (no fixed sky-cyan token) so the rim reflects the
// actual atmospheric composition.
const RIM_MIN_PRESSURE_BAR = 0.1;

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
  // 3 RGB entries × 3 floats — the CLOUD layer palette. For banded
  // clouds (cloudStructure ≥ 0.5), this is the gas-mix from topGases
  // (so Jupiter's bands paint H2/He/NH3 condensate tones). For patchy
  // clouds (cloudStructure < 0.5), slot 0 carries the single condensate
  // color (H2O white, CH4 frost, etc.) and weights collapse to
  // [1, 0, 0]. Zeros throughout when the body has no cloud layer.
  readonly cloudPalette: readonly [number, number, number,
                                   number, number, number,
                                   number, number, number];
  readonly cloudWeights: readonly [number, number, number];
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
  // (surface + cloud). 0 = no haze (Earth, Jupiter, airless). Titan ≈
  // 0.85. Venus ≈ 0.7. Mars dust ≈ 0.15.
  readonly hazeOpacity: number;
  // Color used by both the haze layer (uniform tint) and the disc
  // rim (outward halo + inward fade). Chosen by physical regime: haze
  // species color if a haze layer is present, else Rayleigh sky blue
  // for thick-clear-air surface bodies, else top-of-column gas color
  // for no-surface bodies (lightest gas for gas giants, dominant gas
  // for ice giants).
  readonly hazeColor: readonly [number, number, number];
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

// Per-body dust haze color. Lifted surface dust reflects the body's
// surface mineralogy: Mars's ferric-oxide rust is one possibility, but
// alien Mars-class bodies with different resource mixes lift different-
// colored dust (iron-grey on metal-dominant, tan on silicate-dominant,
// rose on rare-earth-rich, etc.). Weighted blend across the body's
// resource grid via dominantResources — same source the surface
// texturing uses, so the dust matches the body's apparent surface.
//
// Fallback to the fixed CHROMOPHORE_COLOR['DUST'] entry when the body
// has no resource signal (procgen drift / missing data).
function dustHazeColor(body: Body): Color {
  // Top 3 dominant resources — matches the surface texturing's palette
  // depth. Using all six would dilute the body's dominant mineralogy
  // toward a muddy grey on balanced bodies; top-3 preserves the signal.
  const resources = dominantResources(body, 3);
  if (resources.length === 0) {
    return CHROMOPHORE_COLOR.DUST ?? new Color(0xa86040);
  }
  let r = 0, g = 0, b = 0;
  for (const { color, weight } of resources) {
    r += color.r * weight;
    g += color.g * weight;
    b += color.b * weight;
  }
  return new Color(r, g, b);
}

// Chromophore color for a haze species — what the visible aerosol
// layer paints. Most species have a body-independent product color
// (CH4 tholin brown, H2SO4 sulfate yellow, SILICATE grey). DUST is the
// exception: surface-lifted mineral dust reflects the body's actual
// mineralogy, so we route it through dustHazeColor for a per-body mix.
function hazeChromophoreColor(gas: AtmGas, body: Body): Color | null {
  if (gas === 'DUST') return dustHazeColor(body);
  return CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas] ?? null;
}

function cloudCondensateColor(gas: AtmGas): Color {
  return CLOUD_COLOR_FOR_GAS[gas] ?? GAS_COLOR[gas] ?? new Color(0xffffff);
}

// Clear-air rim color for surface bodies with a meaningful atmosphere
// but no haze layer (Earth-class). Weighted blend across atm1/2/3 by
// frac × SCATTERING_POTENCY: bulk N2/O2 produces sky cyan-blue
// (Rayleigh anchor), CH4-rich columns tint deeper cyan, SO2 tints
// yellow, etc. Returns null when the body has no atmosphere data or
// every contributing gas has zero potency (aerosol-only species).
function scatteringRimColor(body: Body): Color | null {
  const candidates: Array<[AtmGas | null, number | null]> = [
    [body.atm1 as AtmGas | null, body.atm1Frac],
    [body.atm2 as AtmGas | null, body.atm2Frac],
    [body.atm3 as AtmGas | null, body.atm3Frac],
  ];
  let r = 0, g = 0, b = 0, totalW = 0;
  for (const [gas, frac] of candidates) {
    if (gas === null || frac === null) continue;
    const potency = SCATTERING_POTENCY[gas] ?? 0;
    const col = SCATTERING_COLOR[gas];
    if (potency <= 0 || !col) continue;
    const w = frac * potency;
    r += col.r * w;
    g += col.g * w;
    b += col.b * w;
    totalW += w;
  }
  if (totalW <= 0) return null;
  return new Color(r / totalW, g / totalW, b / totalW);
}

// Rim color for no-surface bodies (gas giants, ice giants, hycean,
// helium). Returns the body's visually-dominant gas — same source
// the cloud-band palette draws from — so the rim agrees with the
// band color: H2 cream for Jupiter/Saturn (H2 wins by mass × low
// potency), CH4 cyan-blue for Uranus/Neptune and Hycean (CH4 wins
// by frac × potency 6), etc. The earlier lightest-gas heuristic
// broke when a trace high-potency absorber (CH4 on a hydrogen-rich
// world) dominated the visible signal but not the molecular-weight
// stratification.
function noSurfaceRimColor(body: Body): Color | null {
  const gases = topGases(body);
  return gases.length > 0 ? gases[0].color : null;
}

function rimWidthPxForPressure(pressureBar: number | null, discPx: number): number {
  if (pressureBar === null || pressureBar <= 0) return 0;
  const logP = Math.log10(pressureBar + 1);
  let width = 0;
  for (const t of RIM_PRESSURE_LOG10_THRESHOLDS) {
    if (logP >= t) width++;
  }
  if (width === 0) return 0;
  const maxWidth = Math.max(1, Math.floor((discPx / 2) * RIM_MAX_RADIUS_FRACTION));
  return Math.min(width, maxWidth);
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

// Collapse three palette entries toward their weight-proportional mean
// by `blend`. Used by the banded cloud palette so 3 high-contrast
// gases (e.g. blue/white/blue) blend to three close shades of the
// dominant tone (light blue, slightly lighter, slightly darker) —
// readable bands without alternating extreme stripes.
function blendTowardMean(
  c0: Color, c1: Color, c2: Color,
  w0: number, w1: number, w2: number,
  blend: number,
): [Color, Color, Color] {
  const total = w0 + w1 + w2;
  if (total <= 0) return [c0, c1, c2];
  const mr = (c0.r * w0 + c1.r * w1 + c2.r * w2) / total;
  const mg = (c0.g * w0 + c1.g * w1 + c2.g * w2) / total;
  const mb = (c0.b * w0 + c1.b * w1 + c2.b * w2) / total;
  const lerp = (c: Color) => new Color(
    c.r + (mr - c.r) * blend,
    c.g + (mg - c.g) * blend,
    c.b + (mb - c.b) * blend,
  );
  return [lerp(c0), lerp(c1), lerp(c2)];
}

// Build the per-body palette + scalars for one disc. discPx is the
// final rendered diameter — sub-PROCEDURAL_TEXTURE_MIN_PX bodies force
// flat fill (palette weights = [1, 0, 0]) so tiny moons don't render
// as noise.
//
// transformColor lets the caller post-process every palette entry
// before packing (moons brighten toward white so their rims don't merge
// into a same-class parent — see MOON_BRIGHTEN). Applied to surface +
// cloud palettes uniformly so a moon's clouds brighten the same
// amount as its surface.
export function buildDiscPalette(
  body: Body,
  discPx: number,
  transformColor: (c: Color) => Color = c => c,
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

  // ── CLOUD PALETTE — gas-mix for banded, single condensate for patchy ──
  const cloudGas = body.cloudGas as AtmGas | null;
  const rawCloudCoverage  = body.cloudCoverage ?? 0;
  const rawCloudStructure = body.cloudStructure ?? 0;
  let cC0 = new Color(0, 0, 0);
  let cC1 = new Color(0, 0, 0);
  let cC2 = new Color(0, 0, 0);
  let cW0 = 0, cW1 = 0, cW2 = 0;
  if (cloudGas !== null && rawCloudCoverage > 0) {
    if (rawCloudStructure >= 0.5) {
      // Banded — paint from the gas mix. Pulls each gas color toward
      // the visually-weighted mean so bands share a dominant tone with
      // small per-band variation rather than full-contrast alternation.
      const gases = topGases(body);
      if (gases.length === 0) {
        // No atm data — degenerate to the cloud condensate color.
        const c = cloudCondensateColor(cloudGas);
        cC0 = c; cC1 = c; cC2 = c;
        cW0 = 1; cW1 = 0; cW2 = 0;
      } else {
        const g0 = gases[0].color;
        const g1 = gases[1]?.color ?? gases[0].color;
        const g2 = gases[2]?.color ?? gases[0].color;
        cW0 = gases[0].weight;
        cW1 = gases[1]?.weight ?? 0;
        cW2 = gases[2]?.weight ?? 0;
        [cC0, cC1, cC2] = blendTowardMean(g0, g1, g2, cW0, cW1, cW2, BAND_BLEND_TOWARD_MEAN);
      }
    } else {
      // Patchy — single condensate color in slot 0. The shader paints
      // pCloudPalette0 on cells where the per-cell hash < cloudCoverage.
      const c = cloudCondensateColor(cloudGas);
      cC0 = c; cC1 = c; cC2 = c;
      cW0 = 1; cW1 = 0; cW2 = 0;
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

  // Biome stipple — same suppression as terrain scalars. transformColor
  // intentionally not applied: moon-brighten on biome would wash an
  // alien-purple gaian moon into pale lavender that no longer reads as
  // "alive."
  const biomePaint = surfaceSuppressed ? null : biomePaintFor(body);
  const biomeColor: readonly [number, number, number] = biomePaint
    ? [biomePaint.color.r, biomePaint.color.g, biomePaint.color.b]
    : [0, 0, 0];
  const biomeCoverage = biomePaint ? biomePaint.coverage : 0;

  // Cloud + haze scalars — tinyDisc suppresses both since the shader's
  // per-fragment work would resolve as noise.
  const cloudCoverage  = tinyDisc ? 0 : rawCloudCoverage;
  const cloudStructure = tinyDisc ? 0 : rawCloudStructure;
  const hazeOpacity    = tinyDisc ? 0 : (body.hazeOpacity ?? 0);

  // Rim color + width. Four regimes pick one color for both the
  // outward halo and the inward fade:
  //   1. Haze layer present → haze species color (per-body for DUST,
  //      species chromophore for CH4 / H2SO4 / SILICATE).
  //   2. No surface (gas/ice giant) → top-of-column gas color.
  //   3. Surface with thick clear air → scattering blend across atm
  //      gases (pale cyan-blue for N2/O2, deeper cyan for CH4-rich,
  //      yellow for SO2-tinted, etc.).
  //   4. Otherwise → no rim.
  let rimColorRgb: readonly [number, number, number] = [0, 0, 0];
  let rimWidthPx = 0;

  const hazeGas = body.hazeGas as AtmGas | null;
  if (!tinyDisc && hazeGas !== null && hazeOpacity > 0) {
    const c = hazeChromophoreColor(hazeGas, body);
    if (c !== null) {
      rimColorRgb = [c.r, c.g, c.b];
      rimWidthPx = body.surfacePressureBar !== null
        ? rimWidthPxForPressure(body.surfacePressureBar, discPx)
        : Math.min(NO_SURFACE_RIM_WIDTH_PX,
                   Math.max(1, Math.floor((discPx / 2) * RIM_MAX_RADIUS_FRACTION)));
    }
  } else if (!tinyDisc && !hasSurface) {
    const c = noSurfaceRimColor(body);
    if (c !== null) {
      rimColorRgb = [c.r, c.g, c.b];
      const maxByRadius = Math.max(1, Math.floor((discPx / 2) * RIM_MAX_RADIUS_FRACTION));
      rimWidthPx = Math.min(NO_SURFACE_RIM_WIDTH_PX, maxByRadius);
    }
  } else if (!tinyDisc && body.surfacePressureBar !== null
      && body.surfacePressureBar >= RIM_MIN_PRESSURE_BAR) {
    const c = scatteringRimColor(body);
    if (c !== null) {
      rimColorRgb = [c.r, c.g, c.b];
      rimWidthPx = 1;
    }
  }

  // The haze LAYER (uniform per-fragment lerp) needs its own color
  // when present, even if a different rim regime fires (rare — only
  // happens if hazeGas is null but the shader still wants a haze color
  // to use for the layer; in our model hazeOpacity > 0 ↔ hazeGas
  // != null, so this stays consistent).
  let hazeLayerColorRgb: readonly [number, number, number] = rimColorRgb;
  if (hazeGas !== null) {
    const c = hazeChromophoreColor(hazeGas, body);
    if (c !== null) hazeLayerColorRgb = [c.r, c.g, c.b];
  }

  // Per-class hue tint applies to surface palette entries; cloud
  // palette comes from gas-mix (already physically derived) and skips
  // the tint to keep cloud colors aligned with their gas species.
  const tint = body.worldClass !== null ? WORLD_CLASS_TINT[body.worldClass] : undefined;
  const t0 = transformColor(applyTint(sC0, tint));
  const t1 = transformColor(applyTint(sC1, tint));
  const t2 = transformColor(applyTint(sC2, tint));
  const ct0 = transformColor(cC0);
  const ct1 = transformColor(cC1);
  const ct2 = transformColor(cC2);

  // Pick the actual layer color — for the haze tint we want the haze
  // species color (set above); for the rim we want the regime color.
  // The shader receives ONE color attribute that does both jobs; when
  // both fire (e.g. Titan: tholin layer + tholin rim) they agree by
  // construction.
  const sharedColor = hazeGas !== null && hazeOpacity > 0
    ? hazeLayerColorRgb
    : rimColorRgb;

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
    ] as const,
    cloudWeights: [cW0, cW1, cW2] as const,
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
    hazeColor: sharedColor,
    rimWidthPx,
    surfaceAge,
    globalness,
  };
}

// Per-channel lerp toward white. Used by MoonsLayer with MOON_BRIGHTEN
// so all palette entries lift uniformly, not just the world-class base
// — keeping resource accents recognizable while preventing the moon's
// rim from merging into a same-class parent.
export function lerpTowardWhite(c: Color, amount: number): Color {
  return new Color(
    c.r + (1 - c.r) * amount,
    c.g + (1 - c.g) * amount,
    c.b + (1 - c.b) * amount,
  );
}
