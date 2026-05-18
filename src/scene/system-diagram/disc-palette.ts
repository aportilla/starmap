// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// consumed by makePlanetMaterial.
//
// Two render modes emerge from the body's world class + atmosphere:
//   - **surface**  — worley/voronoi cell texture painted with the body's
//                    top 3 resource colors. The world-class base color
//                    is intentionally absent — the disc reads as
//                    gameplay-resource composition rather than rocky/
//                    ice/desert taxonomy. World-class color only
//                    surfaces as a flat-fill fallback when a body has
//                    no resource signal at all. The chromophore signal
//                    is rendered separately via the 1.3a haze pass
//                    (uniform tint + rim stroke) rather than occupying
//                    a palette slot.
//   - **banded**   — quantize latitude into strips, each picking from
//                    the body's top 3 atmospheric gas colors. Used for
//                    gas/ice giants and Venus-class rocky worlds.
//
// The palette is always 3 RGB entries + 3 weights so the shader has
// fixed-size inputs regardless of how many resources/gases the body
// actually carries. Empty slots get zero weight and the picker skips
// them.

import { Color } from 'three';
import {
  AtmGas, Body, CHROMOPHORE_COLOR, CHROMOPHORE_VISUAL_BOOST, GAS_COLOR,
  GAS_MOLECULAR_WEIGHT, WORLD_CLASS_COLOR, WORLD_CLASS_TINT,
  WORLD_CLASS_UNKNOWN_COLOR, biomePaintFor, dominantResources,
  isBandedAtmosphere, topGases,
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

// Phase 1.3a atmospheric haze — well-mixed photochemical or mineral
// aerosols paint a uniform per-fragment tint over the surface plus a
// discrete-width solid stroke at the disc rim. Mutually exclusive
// with cloud patches (1.3c, H2O-only) since chromophoreGas is single-
// valued. The shader stays simple: one mix + one rim test.

// Surface chromophores that route to the uniform-haze pass. H2O is
// intentionally absent — water clouds form discrete patches via
// localized convection and route to a separate pass when 1.3c lands.
// SILICATE + DUST are aerosol-only species — they only ever enter via
// the chromophore path.
const HAZE_CHROMOPHORES: ReadonlySet<AtmGas> = new Set(['CH4', 'SO2', 'DUST', 'SILICATE']);

// Three discrete tint levels — lerp the underlying surface color toward
// hazeColor by this fraction. Driven by chromophoreFrac × visual boost.
// Bucket boundaries land on visual breaks so procgen jitter doesn't
// flicker a body between adjacent levels.
const HAZE_TINT_LIGHT_INPUT  = 0.05;
const HAZE_TINT_MEDIUM_INPUT = 0.25;
const HAZE_TINT_HEAVY_INPUT  = 0.55;
const HAZE_TINT_LIGHT_AMOUNT  = 0.18;
const HAZE_TINT_MEDIUM_AMOUNT = 0.38;
const HAZE_TINT_HEAVY_AMOUNT  = 0.65;

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
const HAZE_RIM_LOG10_THRESHOLDS = [0.005, 0.17, 0.78] as const;

// Cap the rim width to this fraction of disc radius so a tiny moon
// doesn't get visually swamped by its own halo. 0.15 → a 40-px disc
// caps at 3 px, a 20-px disc caps at 1 px.
const HAZE_RIM_MAX_RADIUS_FRACTION = 0.15;

// Default outward halo width for banded gas/ice giants. These have no
// surfacePressureBar to drive the pressure mapping, but they always
// carry a thick atmospheric column. 2 px gives a visible halo without
// dominating the disc — matches Titan's pressure-derived width so a
// gas giant doesn't read as more atmosphere-haloed than Titan.
const GIANT_RIM_WIDTH_PX = 2;

// Phase 1.3b Rayleigh limb — a 1-px sky-cyan rim for surface-mode
// bodies whose atmosphere is clear (no haze chromophore) but thick
// enough to scatter visibly. Earth is the canonical case: H2O routes
// to 1.3c patches, no haze pass fires, so without Rayleigh Earth would
// land with no atmospheric signal at all. The rim communicates "this
// planet has clear-air pressure" as a categorical glance-read. Reuses
// the existing rim shader path (vHazeColor + vRimWidthPx) with the
// hazeTint left at 0 so no uniform tint is applied — only the rim.

// Pressure threshold for the Rayleigh rim to activate. Earth (1.013
// bar) qualifies; Mars (0.006 bar) doesn't; Mercury/Moon (0) don't.
const RAYLEIGH_PRESSURE_THRESHOLD = 0.1;

// Fixed sky-cyan rim color. Not gas-derived — Rayleigh on N2/O2/CO2
// all reads blue at our pixel resolution and the symbol "blue limb =
// breathable-ish air" is worth more than gas-specific hue matching.
const THEME_RAYLEIGH_COLOR: readonly [number, number, number] = [0.55, 0.75, 0.95];

// Phase 1.3c H2O cloud patches — discrete coarse-cell paint over land
// + ocean, suppressed in the polar cap region. Only fires when the
// body's chromophore is H2O (everything else routes to 1.3a uniform
// haze). Cloud density derives from chromophoreFrac × visual boost
// capped so an Earth-class body doesn't go fully overcast.
const CLOUD_MAX_COVERAGE = 0.35;

export type DiscMode = 0 | 1;  // 0 = surface, 1 = banded

export interface DiscPalette {
  // Three RGB entries packed in row order: [r0,g0,b0, r1,g1,b1, r2,g2,b2].
  readonly palette: readonly [number, number, number,
                              number, number, number,
                              number, number, number];
  readonly weights: readonly [number, number, number];
  readonly mode: DiscMode;
  readonly seed: number;  // [0..1)
  // Render tilt in radians — rotates the banded-mode strip axis so
  // bands run parallel to the planet's equator (and, for ringed giants,
  // to the ring plane via the shared bodyVisualTiltRad helper). Unused
  // by surface mode but plumbed uniformly so per-vertex attributes
  // stay schema-stable.
  readonly tilt: number;
  // Surface water cover in [0..1]. Surface-mode shader splits the disc
  // into coarse continent cells; a per-cell hash < waterFrac flips that
  // cell from resource patch to flat ocean color. Earth at 0.71 reads
  // as ~71% ocean; Mars at 0 stays all-land. Forced to 0 on banded
  // bodies and on tiny discs (PROCEDURAL_TEXTURE_MIN_PX gate).
  readonly waterFrac: number;
  // Surface ice cover in [0..1]. Surface-mode shader paints any latitude
  // band with |sin(lat)| > 1 - iceFrac as polar cap. Europa at 1.0 reads
  // as fully white; Earth at 0.1 reads as small caps; Venus at 0 has
  // none. Uses the same sphere-projection foreshortening as banded mode
  // so caps curve as latitude lines.
  readonly iceFrac: number;
  // Biome stipple — pigment color (archetype × stellar shift; see
  // biomePaintFor in stars.ts) packed as [r,g,b], and coverage density
  // [0..1] keyed to biosphereTier. The shader's surface branch runs a
  // per-pixel hash over the land cells: when hash < biomeCoverage * lat
  // taper, the fragment flips from the resource pick to biomeColor. Zero
  // coverage means "no stipple" — saves a hash test in the shader.
  // Suppressed on banded bodies, tiny discs, and bodies with no
  // biosphere or hosted by a class that can't support one.
  readonly biomeColor: readonly [number, number, number];
  readonly biomeCoverage: number;
  // Phase 1.3a haze layer — uniform tint + rim stroke for bodies with a
  // well-mixed aerosol chromophore (CH4 tholin, SO2 sulfuric, DUST,
  // SILICATE). The shader's surface branch lerps every fragment color
  // toward hazeColor by hazeTint, then stamps the outermost rimWidthPx
  // ring solid as hazeColor. All three are zero when no haze applies
  // (no chromophore, H2O chromophore, banded body, or tiny disc) so
  // the shader's mix and rim test are fast no-ops.
  readonly hazeColor: readonly [number, number, number];
  readonly hazeTint: number;
  readonly rimWidthPx: number;
  // Phase 1.3c — coverage density [0..1] for H2O cloud patches.
  // Shader's land + ocean branches run a coarse-cell hash: when
  // hash < cloudDensity, the fragment flips to CLOUD_COLOR. Zero when
  // the body's chromophore isn't H2O, or on banded / tiny / no-atm
  // bodies — the shader uses that as the early-out.
  readonly cloudDensity: number;
}

function hazeChromophoreColor(gas: AtmGas): Color | null {
  return CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas] ?? null;
}

// Chromophores that form aerosol/haze layers at high altitude — what's
// visible at the limb of banded bodies. NH3 is intentionally excluded:
// on gas giants NH3 condenses into NH4SH brown clouds DEEP in the
// atmosphere, but the limb is dominated by the H2/He scattering layer
// above. H2O is also excluded (routes to 1.3c cloud patches on surface
// bodies, doesn't form a limb haze).
const HIGH_ALTITUDE_CHROMOPHORES: ReadonlySet<AtmGas> = new Set(['CH4', 'SO2', 'SILICATE']);

// Pick the lightest atmospheric gas from atm1/2/3 by molecular weight.
// Used by bandedRimColor for gas giants whose chromophore is non-haze
// (deep cloud chemistry) — the limb shows the lightest top-of-column
// gas (H2 for Jupiter/Saturn), not the cloud chemistry beneath it.
function pickLightestAtmGas(body: Body): AtmGas | null {
  let lightest: AtmGas | null = null;
  let minW = Infinity;
  for (const slot of [body.atm1, body.atm2, body.atm3]) {
    if (slot === null) continue;
    const gas = slot as AtmGas;
    const w = GAS_MOLECULAR_WEIGHT[gas];
    if (w !== undefined && w < minW) {
      minW = w;
      lightest = gas;
    }
  }
  return lightest;
}

// Atmospheric rim color for banded bodies. The limb is dominated by
// one of three physical regimes:
//
//   1. **High-altitude aerosol layer** (Titan CH4 tholin, Venus SO2
//      sulfuric, hot sub-Neptune SILICATE fog) — the chromophore IS
//      visible at the limb. Use its condensed-phase color directly.
//
//   2. **Strong absorber mixed throughout** (Uranus/Neptune CH4) —
//      H2/He dominate by mass but CH4 absorbs red light strongly, so
//      the limb appears cyan-blue. topGases ranks by frac × potency,
//      putting CH4 first → cyan-blue color.
//
//   3. **Forward scattering from a transparent gas column** (Jupiter
//      and Saturn — NH3 chromophore is deep cloud chemistry, not at
//      the limb). The lightest gas (typically H2) sits at the top of
//      the column and dominates scattering at the limb → its clear-
//      gas color (cream).
function bandedRimColor(body: Body): Color | null {
  if (body.chromophoreGas !== null) {
    const gas = body.chromophoreGas as AtmGas;
    if (HIGH_ALTITUDE_CHROMOPHORES.has(gas)) {
      const c = CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas];
      if (c) return c;
    }
    // Fall through — chromophore is deep cloud chemistry, not at the limb.
  }
  if (body.worldClass === 'ice_giant') {
    const gases = topGases(body);
    if (gases.length > 0) return gases[0].color;
  }
  const lightest = pickLightestAtmGas(body);
  if (lightest !== null) {
    const c = GAS_COLOR[lightest];
    if (c) return c;
  }
  // Final defensive fallback — top gas pick (rarely reached).
  const gases = topGases(body);
  return gases.length > 0 ? gases[0].color : null;
}

function hazeTintAmount(chromophoreFrac: number | null): number {
  if (chromophoreFrac === null || chromophoreFrac <= 0) return 0;
  const v = Math.min(1, chromophoreFrac * CHROMOPHORE_VISUAL_BOOST);
  if (v >= HAZE_TINT_HEAVY_INPUT)  return HAZE_TINT_HEAVY_AMOUNT;
  if (v >= HAZE_TINT_MEDIUM_INPUT) return HAZE_TINT_MEDIUM_AMOUNT;
  if (v >= HAZE_TINT_LIGHT_INPUT)  return HAZE_TINT_LIGHT_AMOUNT;
  return 0;
}

function hazeRimWidthPx(pressureBar: number | null, discPx: number): number {
  if (pressureBar === null || pressureBar <= 0) return 0;
  const logP = Math.log10(pressureBar + 1);
  let width = 0;
  for (const t of HAZE_RIM_LOG10_THRESHOLDS) {
    if (logP >= t) width++;
  }
  if (width === 0) return 0;
  const maxWidth = Math.max(1, Math.floor((discPx / 2) * HAZE_RIM_MAX_RADIUS_FRACTION));
  return Math.min(width, maxWidth);
}

// Pull the world-class color or unknown-grey fallback. Same precedence
// as the legacy flat-color renderer so a worldClass=null body stays
// recognizable as "TBD" rather than slotting into an arbitrary class.
function worldClassColor(body: Body): Color {
  if (body.worldClass === null) return WORLD_CLASS_UNKNOWN_COLOR;
  return WORLD_CLASS_COLOR[body.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR;
}

// Lerp `c` toward `tint.color` by `tint.amount`. Returns `c` unchanged
// when `tint` is undefined. Used by buildDiscPalette to apply the
// world-class warm/cool tint to every palette entry.
function applyTint(c: Color, tint: { color: Color; amount: number } | undefined): Color {
  if (!tint) return c;
  return new Color(
    c.r + (tint.color.r - c.r) * tint.amount,
    c.g + (tint.color.g - c.g) * tint.amount,
    c.b + (tint.color.b - c.b) * tint.amount,
  );
}

// Collapse three palette entries toward their weight-proportional mean
// by `blend`. Returns the entries lerped from their original color
// toward the mean of all three — visually, this turns a high-contrast
// palette (e.g. 3 blue + 1 white) into close tonal variations of the
// dominant tone (light blue, slightly lighter blue, slightly darker
// blue). Pass-through when weights sum to zero (defensive).
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

// Build the per-body palette + mode + seed for one disc. discPx is the
// final rendered diameter — sub-PROCEDURAL_TEXTURE_MIN_PX bodies force
// flat fill (weights = [1, 0, 0]) so tiny moons don't render as noise.
//
// transformColor lets the caller post-process every palette entry
// before packing (moons brighten toward white so their rims don't merge
// into a same-class parent — see MOON_BRIGHTEN).
export function buildDiscPalette(
  body: Body,
  discPx: number,
  transformColor: (c: Color) => Color = c => c,
): DiscPalette {
  const seed = hash32(`disc:${body.id}`) / 0x100000000;
  const banded = isBandedAtmosphere(body);

  // Slot 0 carries the body's dominant signal — top resource in surface
  // mode, top gas in banded mode — so the shader's defensive fallback
  // (weights summing to 0) renders palette[0] solid as a reasonable
  // single-color representation of the body.
  let c0: Color;
  let c1: Color;
  let c2: Color;
  let w0: number;
  let w1: number;
  let w2: number;

  if (banded) {
    const gases = topGases(body);
    const base = worldClassColor(body);
    if (gases.length === 0) {
      // No atmosphere data on a gas/ice giant — render flat world-class
      // color. Shouldn't happen after procgen but handle defensively.
      c0 = base; c1 = base; c2 = base;
      w0 = 1; w1 = 0; w2 = 0;
    } else {
      const g0 = gases[0].color;
      const g1 = gases[1]?.color ?? gases[0].color;
      const g2 = gases[2]?.color ?? gases[0].color;
      w0 = gases[0].weight;
      w1 = gases[1]?.weight ?? 0;
      w2 = gases[2]?.weight ?? 0;
      // Pull each gas color toward the visually-weighted mean so bands
      // share a dominant tone with small per-band variation rather than
      // alternating full-contrast (e.g. blue/white → three light-blue
      // shades). The picker downstream still selects by weight, so
      // higher-weight gases still dominate the band count.
      [c0, c1, c2] = blendTowardMean(g0, g1, g2, w0, w1, w2, BAND_BLEND_TOWARD_MEAN);
    }
  } else {
    // Surface mode is resource-driven: the disc paints from the body's
    // resource grid so colors correlate directly to mining value. World-
    // class color only re-enters as a flat-fill fallback when a body
    // carries no resource signal at all. The chromophore signal renders
    // separately via the 1.3a haze pass below.
    const res = dominantResources(body, 3);
    if (res.length === 0) {
      const base = worldClassColor(body);
      c0 = base; c1 = base; c2 = base;
      w0 = 1; w1 = 0; w2 = 0;
    } else {
      c0 = res[0].color;
      c1 = res[1]?.color ?? res[0].color;
      c2 = res[2]?.color ?? res[0].color;
      w0 = res[0].weight;
      w1 = res[1]?.weight ?? 0;
      w2 = res[2]?.weight ?? 0;
    }
  }

  // Force flat fill on very small discs — the per-pixel hash texture
  // and the band strips both degrade to noise below ~16 px.
  const tinyDisc = discPx < PROCEDURAL_TEXTURE_MIN_PX;
  if (tinyDisc) {
    w0 = 1; w1 = 0; w2 = 0;
  }

  // Surface terrain scalars. Suppressed on banded bodies (the shader's
  // surface block is unreachable there) and on tiny discs (would resolve
  // to single-pixel polar slivers / one-cell oceans). Null treated as 0
  // so a procgen body that didn't fill the slot just renders without
  // oceans or caps rather than throwing.
  const waterFrac = banded || tinyDisc ? 0 : (body.waterFraction ?? 0);
  const iceFrac   = banded || tinyDisc ? 0 : (body.iceFraction   ?? 0);

  // Biome stipple paint — null on banded mode + tiny discs (same reason
  // as terrain scalars: stipple resolves as noise at sub-threshold disc
  // sizes). The transformColor pass below applies to the resource
  // palette entries but intentionally NOT to the biome color: the moon
  // brighten lift is calibrated to keep the moon's *rim* readable against
  // its parent, and washing biome pigments toward white at the same
  // amount would turn an alien-purple gaian moon (rare but possible)
  // into a pale lavender that no longer reads as "alive."
  const biomePaint = banded || tinyDisc ? null : biomePaintFor(body);
  const biomeColor: readonly [number, number, number] = biomePaint
    ? [biomePaint.color.r, biomePaint.color.g, biomePaint.color.b]
    : [0, 0, 0];
  const biomeCoverage = biomePaint ? biomePaint.coverage : 0;

  // Atmospheric rim (1.3a haze rim, 1.3b Rayleigh limb, banded body
  // rim) — color + width packed for the shader. Mutually exclusive
  // assignment: a body gets at most one rim source. The shader can't
  // tell which pass set the color (a colored rim of width N renders
  // identically regardless of source), so the CPU just picks the right
  // color/width and ships them as varyings.
  //
  // Tint (uniform per-fragment lerp toward hazeColor) is a separate
  // signal that ONLY applies to surface-mode bodies — banded bodies
  // have no surface to tint. Cloud density likewise (H2O patches paint
  // over surface cells; banded bodies have no land/ocean cells).
  let hazeColorRgb: readonly [number, number, number] = [0, 0, 0];
  let hazeTint = 0;
  let rimWidthPx = 0;
  let cloudDensity = 0;

  if (banded && !tinyDisc) {
    // Banded body — Venus, Titan, gas giants, ice giants. The disc IS
    // the atmosphere's visible upper layer; the rim represents the
    // tangential column above it, fading off into space. Color comes
    // from the chromophore (Titan CH4 → tholin orange, Jupiter/Saturn
    // NH3 → NH4SH brown, Venus SO2 → yellow) or the dominant atm gas
    // when no chromophore is set (Uranus/Neptune → CH4 cyan-blue).
    const c = bandedRimColor(body);
    if (c !== null) {
      hazeColorRgb = [c.r, c.g, c.b];
      if (body.surfacePressureBar !== null) {
        // Surface-pressure-bearing banded body (Venus 92 bar → 3 px,
        // Titan 1.45 bar → 2 px). Same mapping as surface-mode haze.
        rimWidthPx = hazeRimWidthPx(body.surfacePressureBar, discPx);
      } else {
        // Gas/ice giant — no surfacePressureBar. Fixed default width,
        // capped at the same radius fraction as the pressure-driven
        // path so tiny banded bodies don't get swamped.
        const maxByRadius = Math.max(1, Math.floor((discPx / 2) * HAZE_RIM_MAX_RADIUS_FRACTION));
        rimWidthPx = Math.min(GIANT_RIM_WIDTH_PX, maxByRadius);
      }
    }
  } else if (!banded && !tinyDisc && body.chromophoreGas !== null) {
    const gas = body.chromophoreGas as AtmGas;
    if (HAZE_CHROMOPHORES.has(gas)) {
      // 1.3a haze layer — surface-mode body with a well-mixed aerosol
      // (CH4 tholin, SO2 sulfuric, DUST, SILICATE). Tint AND rim.
      const c = hazeChromophoreColor(gas);
      if (c !== null) {
        hazeColorRgb = [c.r, c.g, c.b];
        hazeTint = hazeTintAmount(body.chromophoreFrac);
        rimWidthPx = hazeRimWidthPx(body.surfacePressureBar, discPx);
      }
    } else if (gas === 'H2O') {
      // 1.3c H2O cloud patches — discrete cells, no uniform tint or rim.
      // The Rayleigh limb below will add a cyan rim if pressure passes.
      const frac = body.chromophoreFrac ?? 0;
      cloudDensity = Math.min(CLOUD_MAX_COVERAGE, Math.max(0, frac * CHROMOPHORE_VISUAL_BOOST));
    }
  }

  // 1.3b Rayleigh limb — surface-mode bodies with clear thick air get
  // a 1-px sky-cyan rim. Fires only when no other rim has been set
  // (haze rim and Rayleigh limb are mutually exclusive). Earth qualifies
  // because its H2O chromophore goes to clouds, leaving rimWidthPx = 0.
  if (!banded && !tinyDisc && rimWidthPx === 0
      && body.surfacePressureBar !== null
      && body.surfacePressureBar >= RAYLEIGH_PRESSURE_THRESHOLD) {
    hazeColorRgb = THEME_RAYLEIGH_COLOR;
    rimWidthPx = 1;
  }

  // Per-class hue tint (gas-giant warm shift, etc.) runs first so the
  // caller-supplied transform (moon brighten) lerps from the tinted
  // color toward white rather than starting from the untinted base.
  const tint = body.worldClass !== null ? WORLD_CLASS_TINT[body.worldClass] : undefined;
  const t0 = transformColor(applyTint(c0, tint));
  const t1 = transformColor(applyTint(c1, tint));
  const t2 = transformColor(applyTint(c2, tint));

  return {
    palette: [
      t0.r, t0.g, t0.b,
      t1.r, t1.g, t1.b,
      t2.r, t2.g, t2.b,
    ] as const,
    weights: [w0, w1, w2] as const,
    mode: banded ? 1 : 0,
    seed,
    tilt: bodyVisualTiltRad(body),
    waterFrac,
    iceFrac,
    biomeColor,
    biomeCoverage,
    hazeColor: hazeColorRgb,
    hazeTint,
    rimWidthPx,
    cloudDensity,
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
