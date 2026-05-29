// Shared dot-column writer for the dropline subsystem (Droplines per-cluster
// pins + FocusMarker's view.target dropline). Both bake the dotted far-side
// variant as a fixed-period column of points along Z; this is the one place
// that math lives.

import { Float32BufferAttribute } from 'three';

// Write a vertical column of dots into `attr`, at `period` spacing along Z,
// spanning from `fromZ` toward `toZ`. The phase originates at `fromZ`: the
// first dot sits one period in from it and the last falls strictly before
// `toZ`, so both exact endpoints stay clear. X/Y are constant down the column.
//
// A span shorter than one period still gets a single dot at its midpoint so
// the pin never disappears entirely — but only when the span exceeds `minLen`
// (callers that hide degenerate near-zero pins pass their degeneracy epsilon
// here so a collapsed pin bakes no stray dot; the default 0 always draws the
// midpoint for any positive span).
//
// `maxDots` caps the column to the caller's pre-allocated capacity. Returns
// the dot count to feed setDrawRange.
export function fillVerticalDotPin(
  attr: Float32BufferAttribute,
  x: number,
  y: number,
  fromZ: number,
  toZ: number,
  period: number,
  maxDots: number,
  minLen = 0,
): number {
  const span = toZ - fromZ;
  const len = Math.abs(span);
  const dir = span >= 0 ? 1 : -1;
  let count = 0;
  for (let off = period; off < len && count < maxDots; off += period) {
    attr.setXYZ(count, x, y, fromZ + dir * off);
    count++;
  }
  if (count === 0 && len > minLen) {
    attr.setXYZ(0, x, y, fromZ + dir * len * 0.5);
    count = 1;
  }
  return count;
}
