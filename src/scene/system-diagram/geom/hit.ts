// Point-in-disc hit test — the picker primitive for every circular body
// in the system diagram (stars, planets, moons). Compares squared
// distance to avoid the sqrt. The per-layer pick loops still own their
// own cx/cy/r sourcing and the returned DiagramPick kind; only this
// predicate is shared so the test can't drift between layers. Sibling of
// `hitsRing` (geom/ring.ts), the tilted-ellipse annulus test.

export function hitCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
