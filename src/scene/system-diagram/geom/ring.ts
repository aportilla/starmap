// Ring ellipse math — shared by the ring renderer (layers/rings.ts builds
// the tilted annulus halves) and the picker's tilted-ellipse hit test.
// `bodyVisualTiltRad` is also consumed by disc-palette/index.ts so a banded
// gas giant's atmospheric bands run parallel to its ring plane.

import type { Body } from '../../../data/stars';
import {
  RING_INNER_FRAC_FALLBACK, RING_MINOR_OVER_MAJOR, RING_OUTER_FRAC_FALLBACK,
  RING_TILT_DEG_MAX, RING_WIDTH_VIZ_SCALE,
} from '../layout/constants';
import { hash32, mulberry32 } from './prng';

// Map astronomical axialTiltDeg → visual render tilt. Real values span
// 3° (Jupiter), 23.4° (Earth), 26.7° (Saturn), 97.8° (Uranus retrograde);
// scaling by 0.5 keeps Jupiter visibly straighter than Saturn at the
// pixel level, then clamping to ±RING_TILT_DEG_MAX prevents retrograde
// rotators from breaking the back/front ring split.
const AXIAL_TILT_VIZ_SCALE = 0.5;

// Resolve a body's render tilt in radians. Drives both the planet's
// banded atmosphere orientation and any rings around it, so the two
// always read as physically coupled. Bodies missing axialTiltDeg fall
// back to a seeded random in ±RING_TILT_DEG_MAX so they don't all
// comb-align at 0.
export function bodyVisualTiltRad(body: Body): number {
  if (body.axialTiltDeg !== null) {
    const scaled = body.axialTiltDeg * AXIAL_TILT_VIZ_SCALE;
    const clamped = Math.max(-RING_TILT_DEG_MAX, Math.min(RING_TILT_DEG_MAX, scaled));
    return clamped * Math.PI / 180;
  }
  const rng = mulberry32(hash32(`visual-tilt:${body.id}`));
  return (rng() - 0.5) * 2 * RING_TILT_DEG_MAX * Math.PI / 180;
}

// Compute the ring's ellipse parameters: per-planet pixel radii + tilt.
// Radii come from the ring body's innerPlanetRadii / outerPlanetRadii;
// tilt comes from the HOST PLANET (rings sit in the planet's equatorial
// plane by physics) so a ringed giant's bands and rings always align.
export function ringEllipseParams(ring: Body, hostPlanet: Body, hostDiscPx: number): { innerR: number; outerR: number; tiltRad: number } {
  const innerFrac = ring.innerPlanetRadii ?? RING_INNER_FRAC_FALLBACK;
  const outerFrac = ring.outerPlanetRadii ?? RING_OUTER_FRAC_FALLBACK;
  const planetRadius = hostDiscPx / 2;
  const innerR = innerFrac * planetRadius;
  // Scale only the band's WIDTH — inner edge stays at innerR (outside
  // the planet rim); the outer edge moves toward the inner by
  // (1 - RING_WIDTH_VIZ_SCALE) of the CSV band width.
  const outerR = innerR + (outerFrac - innerFrac) * planetRadius * RING_WIDTH_VIZ_SCALE;
  const tiltRad = bodyVisualTiltRad(hostPlanet);
  return { innerR, outerR, tiltRad };
}

// Picker input: ring geometry params + the host planet's current
// screen-space center. innerRho2 = (innerR/outerR)² is the squared
// normalized inner-edge radius; precomputed by the caller at build time
// so hitsRing doesn't redo the divide+square on every pointer move.
export interface RingProbe {
  hostCx: number;
  hostCy: number;
  outerR: number;
  innerR: number;
  tiltRad: number;
  innerRho2: number;
}

// Tilted-ellipse annulus hit-test. Inverse-rotates the cursor delta
// into the ring's untilted frame, then tests whether the normalized
// ellipse parameter ρ² ∈ [innerR²/outerR², 1] — i.e. the cursor lies
// between the inner and outer ellipses.
//
// The back/front half is determined by the sign of the *untilted* y,
// so a click on the upper half hits the back arc and lower-half clicks
// hit the front arc. The caller picks which half to test based on
// render-order priority.
export function hitsRing(x: number, y: number, probe: RingProbe, half: 'back' | 'front'): boolean {
  const dx = x - probe.hostCx;
  const dy = y - probe.hostCy;
  // Inverse tilt (positive tiltRad rotates the ring; rotate the cursor
  // by -tiltRad to drop back into the ring's local frame).
  const cosT = Math.cos(probe.tiltRad);
  const sinT = Math.sin(probe.tiltRad);
  const lx =  dx * cosT + dy * sinT;
  const ly = -dx * sinT + dy * cosT;
  // Half: back is the upper-half ellipse (ly > 0 in scene coords where
  // y grows upward); front is the lower half.
  if (half === 'back'  && ly <= 0) return false;
  if (half === 'front' && ly >= 0) return false;
  // Normalize against the outer ellipse to get ρ². The minor axis is
  // outerR × RING_MINOR_OVER_MAJOR (and innerR scales identically), so
  // the ratio (innerR/outerR)² holds for both axes.
  const ax = lx / probe.outerR;
  const ay = ly / (probe.outerR * RING_MINOR_OVER_MAJOR);
  const rho2 = ax * ax + ay * ay;
  if (rho2 > 1) return false;
  return rho2 >= probe.innerRho2;
}
