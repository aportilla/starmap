// Static 3D k-d tree over a fixed point set. Built once at module load, queried
// forever — no insertion / deletion. Matches the catalog's static nature: stars
// are computed once in stars.ts and never mutated.
//
// Layout: flat typed-array implicit tree. For N points, sub-range [lo, hi) has
// its median at mid = (lo+hi)>>1, with left/right subtrees at [lo, mid) and
// (mid, hi). No pointers, no per-node objects, GC-free queries.
//
// Splits on the LONGEST axis of each sub-range's bbox rather than cycling
// x/y/z. The catalog is anisotropic (stars bias toward the galactic plane), so
// longest-axis splits keep depth balanced where the data has actual spread.
//
// Recursion vs iteration — deferred enhancement.
// The recursive build / nearestRec walks below are clear but
// bounded by JS engine stack depth. At any realistic catalog size we're nowhere
// near that limit — a 100k-point tree is ~17 deep, a million is ~20. If the
// catalog ever grows past that, or if a profile shows recursion overhead
// matters in tight per-frame queries, swap to iterative versions backed by a
// fixed-size Uint32Array stack (~64 slots covers any tree we'd build). The
// query pruning logic doesn't change — only the traversal mechanism — so it's
// a mechanical refactor when the time comes.

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export class KDTree3<P> {
  private readonly n: number;
  // Tree-order coordinates. Index i in these arrays is the i-th node in the
  // implicit tree, NOT the i-th input point — the build pass permutes both
  // these and srcIdx together via in-place quickselect.
  private readonly cx: Float32Array;
  private readonly cy: Float32Array;
  private readonly cz: Float32Array;
  // tree-order → original input index, so callers get back indices into the
  // array they passed to the constructor.
  private readonly srcIdx: Int32Array;
  // Split axis chosen for each node (0=x, 1=y, 2=z). Stored rather than
  // re-derived because each sub-range picks its own axis and the query walk
  // needs that decision back to know which coordinate to compare against.
  private readonly axis: Uint8Array;

  // Scratch state for the nearest() walk. Re-initialized at the top of each
  // top-level call so the recursion doesn't have to thread it as arguments —
  // smaller frames, less GC.
  private _bestSq = Infinity;
  private _bestNode = -1;

  constructor(points: readonly P[], extract: (p: P) => Vec3) {
    const n = points.length;
    this.n = n;
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.cz = new Float32Array(n);
    this.srcIdx = new Int32Array(n);
    this.axis = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = extract(points[i]);
      this.cx[i] = p.x;
      this.cy[i] = p.y;
      this.cz[i] = p.z;
      this.srcIdx[i] = i;
    }
    if (n > 0) this.build(0, n);
  }

  // ===== Public queries =====================================================

  // Nearest neighbor to (qx, qy, qz). Returns the original-array index, or -1
  // if the tree is empty. Average O(log n); worst case O(n) on pathological
  // distributions, not realistic for stellar catalogs.
  nearest(qx: number, qy: number, qz: number): number {
    if (this.n === 0) return -1;
    this._bestSq = Infinity;
    this._bestNode = -1;
    this.nearestRec(0, this.n, qx, qy, qz);
    return this._bestNode < 0 ? -1 : this.srcIdx[this._bestNode];
  }

  // ===== Build ==============================================================

  // See top-of-file note on recursion vs iteration. Build depth tracks tree
  // depth (~log2 N), so 1500 stars → ~11 deep, 100k → ~17.
  private build(lo: number, hi: number): void {
    if (hi - lo <= 1) return;
    const ax = this.longestAxis(lo, hi);
    const mid = (lo + hi) >> 1;
    this.nthElement(lo, hi, mid, ax);
    this.axis[mid] = ax;
    this.build(lo, mid);
    this.build(mid + 1, hi);
  }

  private longestAxis(lo: number, hi: number): 0 | 1 | 2 {
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = lo; i < hi; i++) {
      const x = this.cx[i], y = this.cy[i], z = this.cz[i];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    const dx = xMax - xMin, dy = yMax - yMin, dz = zMax - zMin;
    if (dx >= dy && dx >= dz) return 0;
    return dy >= dz ? 1 : 2;
  }

  // In-place Hoare quickselect — partitions [lo, hi) so position `k` holds the
  // k-th smallest value along `ax`. Median-of-three pivot selection guards
  // against the worst case on pre-sorted or near-sorted input (a real risk
  // here — the CSV-loaded catalog has some axis-aligned structure).
  private nthElement(lo: number, hi: number, k: number, ax: 0 | 1 | 2): void {
    let left = lo;
    let right = hi - 1;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.axisCoord(left, ax) > this.axisCoord(mid, ax)) this.swap(left, mid);
      if (this.axisCoord(left, ax) > this.axisCoord(right, ax)) this.swap(left, right);
      if (this.axisCoord(mid, ax) > this.axisCoord(right, ax)) this.swap(mid, right);
      const pivot = this.axisCoord(mid, ax);
      let i = left, j = right;
      while (i <= j) {
        while (this.axisCoord(i, ax) < pivot) i++;
        while (this.axisCoord(j, ax) > pivot) j--;
        if (i <= j) {
          this.swap(i, j);
          i++;
          j--;
        }
      }
      if (k <= j) right = j;
      else if (k >= i) left = i;
      else return;
    }
  }

  private axisCoord(i: number, ax: 0 | 1 | 2): number {
    return ax === 0 ? this.cx[i] : ax === 1 ? this.cy[i] : this.cz[i];
  }

  private swap(a: number, b: number): void {
    let t = this.cx[a]; this.cx[a] = this.cx[b]; this.cx[b] = t;
    t = this.cy[a]; this.cy[a] = this.cy[b]; this.cy[b] = t;
    t = this.cz[a]; this.cz[a] = this.cz[b]; this.cz[b] = t;
    const ti = this.srcIdx[a]; this.srcIdx[a] = this.srcIdx[b]; this.srcIdx[b] = ti;
  }

  // ===== Query internals ====================================================

  // See top-of-file note on recursion vs iteration.
  private nearestRec(lo: number, hi: number, qx: number, qy: number, qz: number): void {
    if (hi - lo <= 0) return;
    const mid = (lo + hi) >> 1;
    const dx = qx - this.cx[mid];
    const dy = qy - this.cy[mid];
    const dz = qz - this.cz[mid];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < this._bestSq) {
      this._bestSq = d2;
      this._bestNode = mid;
    }
    const ax = this.axis[mid];
    const diff = ax === 0 ? dx : ax === 1 ? dy : dz;
    // Recurse the near side first so _bestSq tightens before the far side's
    // pruning check — the whole point of a k-d tree's speed advantage.
    if (diff < 0) {
      this.nearestRec(lo, mid, qx, qy, qz);
      if (diff * diff < this._bestSq) this.nearestRec(mid + 1, hi, qx, qy, qz);
    } else {
      this.nearestRec(mid + 1, hi, qx, qy, qz);
      if (diff * diff < this._bestSq) this.nearestRec(lo, mid, qx, qy, qz);
    }
  }
}
