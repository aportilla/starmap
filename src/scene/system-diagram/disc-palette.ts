// Per-body palette derivation for the planet + moon disc shader.
// Both PlanetsLayer and MoonsLayer call buildDiscPalette(body, discPx) at
// construction time and pack the result into the per-vertex attributes
// consumed by makePlanetMaterial.
//
// Two render modes emerge from the body's world class + atmosphere:
//   - **surface**  — worley/voronoi cell texture painted with the body's
//                    top 3 resource colors (or top 2 + chromophore when
//                    the body carries a chromophore signal). The
//                    world-class base color is intentionally absent —
//                    the disc reads as gameplay-resource composition
//                    rather than rocky/ice/desert taxonomy. World-class
//                    color only surfaces as a flat-fill fallback when
//                    a body has no resource signal at all.
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
  AtmGas, Body, CHROMOPHORE_COLOR, GAS_COLOR,
  WORLD_CLASS_COLOR, WORLD_CLASS_TINT, WORLD_CLASS_UNKNOWN_COLOR,
  dominantResources, isBandedAtmosphere, topGases,
} from '../../data/stars';
import { hash32 } from './geom/prng';
import { bodyVisualTiltRad } from './geom/ring';
import { PROCEDURAL_TEXTURE_MIN_PX } from './layout/constants';

// Fraction of total surface weight reserved for the chromophore
// (cloud deck / dust haze) when present. Remaining (1 - this) is split
// across the body's top 2 resources by their relative magnitudes. 0.25
// reads as "partly cloudy" rather than "fully banded" — resource
// patches still dominate the disc while the chromophore registers as
// a distinctive accent (Earth's H2O white, Mars's DUST rust).
const SURFACE_CHROMOPHORE_WEIGHT = 0.25;

// How strongly banded-mode palette entries collapse toward their
// weighted mean. 0 = full-contrast alternation (e.g. 3 blue bands +
// 1 white band reads as alternating blue/white strips); 1 = single
// flat color. 0.85 leans heavily toward a single dominant tone with
// only subtle per-band hue shifts — the shader's many-band non-uniform
// strip layout already produces strong perceived variation through
// band-width jitter and boundary warp, so the palette can stay tight
// without the disc reading as monochrome.
const BAND_BLEND_TOWARD_MEAN = 0.85;

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
}

// Pull the world-class color or unknown-grey fallback. Same precedence
// as the legacy flat-color renderer so a worldClass=null body stays
// recognizable as "TBD" rather than slotting into an arbitrary class.
function worldClassColor(body: Body): Color {
  if (body.worldClass === null) return WORLD_CLASS_UNKNOWN_COLOR;
  return WORLD_CLASS_COLOR[body.worldClass] ?? WORLD_CLASS_UNKNOWN_COLOR;
}

// Resolve a body's chromophore to a render color for the surface-mode
// path. Prefers CHROMOPHORE_COLOR (condensed-product hue: NH4SH brown,
// tholin orange, silicate grey-blue, dust rust) and falls back to
// GAS_COLOR (clear-gas hue: H2O white). Returns null when the body
// has no chromophore set OR the gas name isn't in the bounded vocab.
function chromophoreSurfaceColor(body: Body): Color | null {
  if (body.chromophoreGas === null) return null;
  const gas = body.chromophoreGas as AtmGas;
  return CHROMOPHORE_COLOR[gas] ?? GAS_COLOR[gas] ?? null;
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
    // carries no resource signal at all.
    const chromoColor = chromophoreSurfaceColor(body);
    if (chromoColor !== null) {
      // Chromophore overlay (Earth's H2O cloud deck, Mars's DUST haze)
      // takes a fixed share; the body's top 2 resources split the
      // remainder by relative magnitude.
      const res = dominantResources(body, 2);
      if (res.length === 0) {
        const base = worldClassColor(body);
        c0 = base; c1 = base; c2 = base;
        w0 = 1; w1 = 0; w2 = 0;
      } else {
        const resTotal = 1 - SURFACE_CHROMOPHORE_WEIGHT;
        c0 = res[0].color;
        c1 = res[1]?.color ?? res[0].color;
        c2 = chromoColor;
        w0 = resTotal * res[0].weight;
        w1 = resTotal * (res[1]?.weight ?? 0);
        w2 = SURFACE_CHROMOPHORE_WEIGHT;
      }
    } else {
      // Top 3 resources fill all three palette slots. weights from
      // dominantResources are already normalized to sum to 1 across
      // however many nonzero resources the body carries.
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
  }

  // Force flat fill on very small discs — the per-pixel hash texture
  // and the band strips both degrade to noise below ~16 px.
  if (discPx < PROCEDURAL_TEXTURE_MIN_PX) {
    w0 = 1; w1 = 0; w2 = 0;
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
