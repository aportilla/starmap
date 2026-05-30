// Pure per-tick view-state → display-state derivations the galaxy scene's
// tick() composes. Pulled out of the imperative loop so each rule is a
// standalone, testable function rather than an inline branch threaded through
// camera/selection state: the candidate-cluster rule, the focus-proximity
// check, and the orbit-keyed star-dim ramp. No Three.js coupling — they take
// plain {x,y,z} so a test (or any caller) can pass a literal.

import { STAR_CLUSTERS } from '../data/stars';
import { FOCUS_MARKER_NEAR } from './focus-marker';
import { STAR_DIM_FULL_BELOW, STAR_DIM_OFF_ABOVE, clampRamp } from './cluster-fade';

interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// Squared-distance epsilon (ly²) used to decide whether view.target is "on"
// the selected cluster's COM — drives the Focus button's enabled state.
// 0.01 ly = ~38 AU; well below any visually significant offset and far
// above FP jitter from the focus lerp's terminal copy().
export const FOCUS_EPSILON_SQ = 0.01 * 0.01;

// The candidate cluster is the one the dot-brackets + yellow label mark and
// the one spacebar advances the selection to — only ever one at a time.
// Hover beats focus-proximity: when the user is pointing at a star, that's
// the immediate target; when they're not, the candidate falls back to the
// nearest cluster to view.target (so the brackets reappear on whatever the
// keyboard pan has drifted near). Both branches honor "candidate != selection"
// (no point bracketing what's already selected). Returns -1 for no candidate.
//
// Hover candidate is independent of focusAnimating — cursor location is real
// regardless of camera motion. Proximity is suppressed during the glide
// because the pivot is in transit, not parked off a star, and the brackets
// would just trail the camera into the new selection.
//
// The proximity branch additionally suppresses below FOCUS_MARKER_NEAR so the
// brackets don't appear on the cluster the pivot is sitting on (initial-load
// Sol case, or panning back onto a star). Same threshold as the focus marker
// so the two indicators turn on/off together.
export function resolveCandidateCluster(
  hoveredCluster: number,
  nearestClusterIdx: number,
  selectedClusterIdx: number,
  target: Vec3Like,
  focusAnimating: boolean,
): number {
  if (hoveredCluster >= 0 && hoveredCluster !== selectedClusterIdx) {
    return hoveredCluster;
  }
  if (!focusAnimating && nearestClusterIdx >= 0 && nearestClusterIdx !== selectedClusterIdx) {
    const com = STAR_CLUSTERS[nearestClusterIdx].com;
    const dx = target.x - com.x;
    const dy = target.y - com.y;
    const dz = target.z - com.z;
    if (dx * dx + dy * dy + dz * dz >= FOCUS_MARKER_NEAR * FOCUS_MARKER_NEAR) {
      return nearestClusterIdx;
    }
  }
  return -1;
}

// True when view.target sits on a cluster's COM (within FOCUS_EPSILON_SQ) —
// i.e. the camera is already focused on it, so the Focus button disables.
export function isTargetFocusedOnCom(target: Vec3Like, com: Vec3Like): boolean {
  const dx = target.x - com.x;
  const dy = target.y - com.y;
  const dz = target.z - com.z;
  return (dx * dx + dy * dy + dz * dz) < FOCUS_EPSILON_SQ;
}

// Local-focus dim strength as a function of orbit distance (camera-to-pivot
// ly): full effect when zoomed in, smoothly off when zoomed out. Keying to
// orbit distance rather than a per-star camera ramp is what lets zoom-out
// restore every star to full brightness — at large orbit radii every star is
// far from the camera, so a per-star ramp would pin everything dim no matter
// how far the user zooms out.
export function dimAmountForOrbit(orbit: number): number {
  return clampRamp(orbit, STAR_DIM_FULL_BELOW, STAR_DIM_OFF_ABOVE);
}
