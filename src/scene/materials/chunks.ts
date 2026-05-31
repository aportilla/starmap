// Shared GLSL fragments for the system-view materials. The planet/moon
// disc (./planet) and the decor materials (./system-decor) are otherwise
// independent shaders, but several primitives are identical across them —
// keeping one canonical copy here stops the four Bayer-dither blocks (and
// the two star-crescent lighting loops) from drifting apart.
//
// Most exports are GLSL source strings meant to be interpolated into a
// shader template at global (pre-main) scope, e.g. `${BAYER4_GLSL}`. A few
// are plain scalars shared with the host shaders' TS — MAX_LIGHTS, plus the
// LIGHT_Z_BIAS / RIM_GLOW_FOCUS lighting-depth pair below — interpolated as
// numeric literals (via `glsl()` for the floats) so one source of truth
// drives both the GLSL and any CPU-side use.

import { glsl } from './shared';

// Body lighting (per-fragment colored crescent, driven by star disc
// positions). Five-slot ceiling covers the largest realistic multi-star
// clusters in the catalog (Capella's 4-star + room for a distant
// companion) with headroom; per-fragment fragments past the active count
// are gated by uLightCount, so unused slots cost nothing. Layer code
// clamps the source list to MAX_LIGHTS before uploading.
export const MAX_LIGHTS = 5;

// 4x4 ordered (Bayer) dither threshold keyed on env-pixel coords —
// values in {0/16 .. 15/16}, closed-form, no branches, no texture. This
// is the project's signature stippling primitive; the planet disc, the
// blob/chunk fill, and both star materials all dither against it.
export const BAYER4_GLSL = /* glsl */ `
      float bayer4(vec2 p) {
        vec2 q = mod(floor(p), vec2(4.0));
        vec2 outer = floor(q / 2.0);
        vec2 inner = mod(q, vec2(2.0));
        float bInner = inner.x * 2.0 + inner.y * 3.0 - inner.x * inner.y * 4.0;
        float bOuter = outer.x * 2.0 + outer.y * 3.0 - outer.x * outer.y * 4.0;
        return (4.0 * bInner + bOuter) / 16.0;
      }`;

// Canonical sin-fract value hashes — the project's hash primitives,
// used by every worley / region / crater / lava / cloud pass to seed
// jittered cell centers and per-cell coverage gates. hash11 maps a
// scalar → [0,1); hash21 maps a 2D cell coord → [0,1). The classic
// fract(sin(·) * 43758.5453) construction: cheap, stateless, no
// texture. Stippling the results against the Bayer dither hides the
// well-known diagonal banding of sin-hashes at our pixel scale.
// Interpolate before any chunk (or main) that hashes.
export const HASH_GLSL = /* glsl */ `
      float hash11(float x) {
        return fract(sin(x * 12.9898 + 78.233) * 43758.5453);
      }
      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }`;

// Hue-direction operator: normalize a color so its max channel is 1,
// giving a pure-hue unit vector. Raising it to a power crushes the minor
// channels while leaving the dominant one untouched — a saturation
// operator that works for any hue (warm stars cool toward red, cool stars
// toward deep blue) via one code path rather than per-channel modulators.
// Used by both star materials' fringe/halo color.
export const HUEDIR_GLSL = /* glsl */ `
      vec3 hueDir(vec3 c) {
        float m = max(max(c.r, c.g), c.b);
        return c / max(m, 1e-3);
      }`;

// ── Light depth (the shared coupling knob) ──
// LIGHT_Z_BIAS is the z-component of the (pre-normalized) light direction:
// how far the star sits behind the bodies, pushed into the screen and away
// from the viewer. It is the SINGLE knob that sets how backlit every body
// reads, and two otherwise-separate effects derive their spread from it so
// they always move together:
//   • the disc surface crescent (STAR_CRESCENT_LIGHTING_GLSL below) — more
//     negative pinches the lit lambert toward the limb (thinner crescent).
//   • the atmospheric loft glow's rim arc (planet.ts rimHalo) — RIM_GLOW_FOCUS
//     is derived here so a deeper light steepens the rim's angular taper and
//     the glow arc tightens in lock-step with the crescent.
// Turn this one number and both the surface crescent and the rim arc narrow
// together. Magnitude only — the sign is fixed negative (the disc normal's
// +z faces the viewer, so a negative L.z peaks the lambert at the limb).
export const LIGHT_Z_BIAS = -0.85;

// Rim loft-glow angular focus, derived from the light depth. The rim's
// half-lambert wrap (facing ∈ [0,1], 1 sunward → 0.5 at the terminator) is
// raised to this power; a higher power steepens the taper so the glow dies
// sooner past the terminator. Coupling is linear in |LIGHT_Z_BIAS|:
// RIM_FOCUS_BASE (the grazing-light taper at zero depth) plus a per-depth
// slope. Raise RIM_FOCUS_PER_DEPTH for a stronger rim response to depth;
// this is the one structural coefficient that fixes how fast the rim arc
// tracks the crescent.
const RIM_FOCUS_BASE = 1.0;
const RIM_FOCUS_PER_DEPTH = 1.8;
export const RIM_GLOW_FOCUS = RIM_FOCUS_BASE + RIM_FOCUS_PER_DEPTH * Math.abs(LIGHT_Z_BIAS);

// Star-crescent reflectance lighting. `N` is the fragment's reconstructed
// surface normal (caller supplies it — the planet uses vRadius/vCenter,
// the blob uses vChunkSize/vChunkCenter), `center` is the body center in
// buffer-pixel coords. Each star runs its OWN band check on its own
// per-fragment lambert, then stacks its tint additively: where star A
// dominates the local lambert (its rim segment) and star B is sub-
// threshold, only A's hue paints, so the per-star color directionality
// survives instead of washing to an averaged hue. The per-light dither
// offset (7·i, 11·i) keeps each star's Bayer fringe from cascading on top
// of the next; the (31, 17) base seed keeps this crescent pass's fringe
// distinct from the planet rim (43+7i, 29+11i) and lava (53, 19) passes so
// their stipple patterns never phase-align. LIGHT_Z_BIAS pushes the source
// into the screen so the lit hemisphere faces away from the viewer (a
// crescent, not a full face).
//
// Depends on bayer4 (interpolate BAYER4_GLSL before this) and the
// uLight* uniforms (uLightCount / uLightPos / uLightColor /
// uLightIntensity) being declared by the host shader.

export const STAR_CRESCENT_LIGHTING_GLSL = /* glsl */ `
      const float LIGHT_Z_BIAS         = ${glsl(LIGHT_Z_BIAS)};
      const float LIGHT_BAND_LOW       = 0.18;
      const float LIGHT_BAND_HIGH      = 0.52;
      const float LIGHT_DITHER_WIDTH   = 0.08;
      const float LIGHT_TINT_STRENGTH  = 0.12;
      const float LIGHT_HOT_BOOST      = 0.10;

      vec3 applyStarCrescent(vec3 col, vec3 N, vec2 center) {
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= uLightCount) break;
          vec2 dir2d = normalize(uLightPos[i] - center);
          vec3 L = normalize(vec3(dir2d, LIGHT_Z_BIAS));
          float lam = max(0.0, dot(N, L)) * uLightIntensity[i];
          float bL = bayer4(gl_FragCoord.xy + vec2(31.0 + float(i) * 7.0, 17.0 + float(i) * 11.0));
          float ditheredMag = lam + (bL - 0.5) * 2.0 * LIGHT_DITHER_WIDTH;
          if (ditheredMag > LIGHT_BAND_LOW) {
            col = clamp(col + uLightColor[i] * LIGHT_TINT_STRENGTH, 0.0, 1.0);
          }
          if (ditheredMag > LIGHT_BAND_HIGH) {
            col = clamp(col + uLightColor[i] * LIGHT_HOT_BOOST, 0.0, 1.0);
          }
        }
        return col;
      }`;
