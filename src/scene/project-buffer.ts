// Project a world position into the overlay's buffer-pixel space (Y-up,
// origin at bottom-left), shared by the Labels overlay and the cluster
// brackets — both place quads at 1 unit = 1 buffer pixel and need the exact
// same projection + stability gates so a label and its bracket never disagree
// by a pixel on the same anchor.
//
// Writes the screen coords into outScreen.x / outScreen.y and reuses outScreen
// as the projection scratch, so the caller owns the single allocation (one
// scratch Vector3 on `this`) and nothing is allocated per call. Returns false
// if the point sits behind the near plane or beyond the far plane — caller
// hides / skips its quad in that case.
//
// Two stability gates layered on top of the raw projection:
//
// 1. **viewTarget short-circuit.** When the world point is bit-exactly the
//    camera's orbit target, the projection should land at NDC (0,0) by
//    construction; the matrix math gets it almost-right with a tiny residue
//    that varies with yaw, so the focused anchor twitches as the camera
//    orbits. Skipping the math nails it to exact buffer center every frame.
//    Only fires on Vector3.equals (bit-exact) — so the focused primary / COM,
//    but never an arbitrary member whose (mass * x) / mass differs by 1 ULP.
//
// 2. **Pre-snap to nearest 0.5 buffer px.** Catches the cases the
//    short-circuit doesn't. Downstream the consumer rounds (placeAt's
//    Math.round, the bracket's Math.ceil), whose discontinuity sits at X.5 /
//    integer boundaries. For unlucky buffer / quad parity combinations a
//    focused star projects EXACTLY onto that discontinuity, and any
//    sign-flipping FP noise — however microscopic — flips the rounded result
//    by 1 px. Snapping to a multiple of 0.5 moves the discontinuity to
//    X.25 / X.75, which the projection essentially never lands on, so the
//    downstream round/ceil is deterministic regardless of noise.

import type { Camera, Vector3 } from 'three';

export function projectWorldToBuffer(
  world: Vector3,
  camera: Camera,
  viewTarget: Vector3 | null,
  bufW: number,
  bufH: number,
  outScreen: Vector3,
): boolean {
  if (viewTarget && world.equals(viewTarget)) {
    outScreen.x = bufW * 0.5;
    outScreen.y = bufH * 0.5;
    return true;
  }
  outScreen.copy(world).project(camera);
  if (outScreen.z < -1 || outScreen.z > 1) return false;
  outScreen.x = Math.round((outScreen.x * 0.5 + 0.5) * bufW * 2) / 2;
  outScreen.y = Math.round((outScreen.y * 0.5 + 0.5) * bufH * 2) / 2;
  return true;
}
