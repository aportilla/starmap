// Point-in-disc hit test — the picker primitive for every circular body
// in the system diagram (stars, planets, moons). Compares squared
// distance to avoid the sqrt. `pickDiscPool` (below) shares the loop that
// walks a layer's slots and returns the first hit, so the three layers
// can't drift on either the predicate or the iteration; each layer only
// supplies how to read a slot's cx/cy/r and how to label the pick.
//
// The other picker, `hitsRing` (geom/ring.ts), deliberately lives apart:
// the circle pick is frame-independent and shared across three layers,
// while the ring pick is coupled to the ellipse parameterization that
// `ringEllipseParams` produces (it consumes a RingProbe of those same
// radii + tilt), so it stays next to the geometry that feeds it rather
// than being co-located here.

export function hitCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Walk a pool of `count` circular bodies and return the first whose disc
// contains (x, y), or null. The accessors decouple the walk from how each
// layer stores its slots: stars read mesh.position, planets/moons read a
// packed Float32Array. Generic in the pick type so this geometry module
// stays free of the layers' DiagramPick union — the caller's `makePick`
// fixes T at the call site.
export function pickDiscPool<T>(
  x: number,
  y: number,
  count: number,
  cxAt: (i: number) => number,
  cyAt: (i: number) => number,
  rAt: (i: number) => number,
  makePick: (i: number) => T,
): T | null {
  for (let i = 0; i < count; i++) {
    if (hitCircle(x, y, cxAt(i), cyAt(i), rAt(i))) return makePick(i);
  }
  return null;
}
