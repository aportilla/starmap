// Yellow corner brackets enclosing every member of a cluster's rendered
// disc bbox. Used in two display states:
//   - 'arms': full L-corner reticle (the selected cluster's "active" indicator)
//   - 'dots': single-pixel corners (the candidate cluster's "potential
//     selection" indicator — pan the pivot away and the nearest cluster
//     gets bracketed; spacebar switches selection to it)
//
// Both styles share the bbox-of-members projection math, the corner
// positions, and the color (matches colors.starName so brackets read as
// part of the same "selected / about-to-select system" visual language as
// the info card). Texture and arm-length differ by style; the bracket
// CORNER positions are identical, so a candidate's dots sit exactly where
// the selection's arms would.
//
// One mesh per instance. Selection and candidate are two separate
// instances rendered simultaneously into the labels overlay scene at
// 1 unit = 1 buffer pixel. setCluster(-1) hides the mesh outright (no
// fade ramp — visibility is binary, snap on / snap off).

import {
  Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Vector3,
} from 'three';
import { STARS, STAR_CLUSTERS } from '../data/stars';
import { renderedStarPxSize } from './materials';

export type BracketStyle = 'arms' | 'dots';

const BRACKET_GAP_PX  = 4;   // pixels between outermost disc edge and bracket corner
const BRACKET_MIN_SIZE = 12; // floor (per axis) so tiny stars still get a visible bracket
const BRACKET_COLOR   = '#ffe98a';

function buildBracketTexture(size: number, style: BracketStyle): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = BRACKET_COLOR;
  const S = size;
  if (style === 'arms') {
    // Arms scale with bracket size to preserve the original ~20% ratio (the
    // old fixed 25/5 pair), clamped so very small reticles still get a
    // visible bracket and very large ones don't grow ungainly arms.
    const A = Math.max(3, Math.min(8, Math.round(size * 0.2)));
    // Each corner = two 1px arms forming an L pointing outward into that
    // corner. Canvas Y is top-down here; the texture maps onto a quad whose
    // own coords are flipped, so visually all four corners are symmetric.
    g.fillRect(0, 0, A, 1);         g.fillRect(0, 0, 1, A);          // TL
    g.fillRect(S - A, 0, A, 1);     g.fillRect(S - 1, 0, 1, A);      // TR
    g.fillRect(0, S - 1, A, 1);     g.fillRect(0, S - A, 1, A);      // BL
    g.fillRect(S - A, S - 1, A, 1); g.fillRect(S - 1, S - A, 1, A);  // BR
  } else {
    // Single-pixel dot at each of the four corners. Same corner positions
    // as the 'arms' style so a candidate's dots line up exactly where a
    // selection's arms would — a candidate becoming the selection just
    // grows arms outward from the same dots, no positional shift.
    g.fillRect(0, 0, 1, 1);              // TL
    g.fillRect(S - 1, 0, 1, 1);          // TR
    g.fillRect(0, S - 1, 1, 1);          // BL
    g.fillRect(S - 1, S - 1, 1, 1);      // BR
  }
  const t = new CanvasTexture(c);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter;
  t.wrapS = ClampToEdgeWrapping; t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  return t;
}

export class ClusterBrackets {
  readonly mesh: Mesh;
  private readonly style: BracketStyle;
  private bufferW = 1;
  private bufferH = 1;
  // Mirrors the stars shader's uPxScale uniform — needed CPU-side to
  // compute each star's rendered size for the bbox.
  private pxScale = 1;
  private clusterIdx = -1;
  private currentSize = -1;

  // Reusable per-frame scratch.
  private readonly _proj = new Vector3();
  private readonly _world = new Vector3();
  private readonly _view = new Vector3();
  private readonly _screen = { x: 0, y: 0 };

  // Set per-frame from scene.ts so projectToBuffer can short-circuit the
  // orbit-target equality case (see projectToBuffer).
  private viewTarget: Vector3 | null = null;

  constructor(style: BracketStyle) {
    this.style = style;
    const mat = new MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
  }

  // Mirrors StarPoints.setPxScale — call from the same spot in scene.ts so
  // the bracket size formula sees the same uPxScale the shader does.
  setPxScale(s: number): void {
    this.pxScale = s;
  }

  // -1 hides the mesh. Otherwise the next update() projects the cluster's
  // members and sizes the bracket to enclose them.
  setCluster(idx: number): void {
    this.clusterIdx = idx;
  }

  // Project a world position into buffer-pixel coords (Y-up, origin at
  // bottom-left). Returns false if the point sits behind the near plane or
  // beyond the far plane — caller skips it from the bbox.
  //
  // Two stability gates, same shape as Labels.projectToBuffer:
  //
  // 1. **viewTarget short-circuit.** When the world point is bit-exactly
  //    the camera's orbit target, the projection is NDC (0,0) by
  //    construction; skipping the matrix math pins the result to exact
  //    buffer center. Fires for the COM-anchor on every selected cluster
  //    and additionally for the member projection on any cluster where
  //    (mass * x) / mass round-trips to the primary's coordinates bit-
  //    exact (Sol, YZ Ceti, every power-of-2 mass).
  //
  // 2. **Pre-snap to nearest 0.5 buffer px.** Catches the cases where
  //    the short-circuit silently misses by 1 ULP — e.g. Tau Ceti's
  //    (mass=0.783, x=10.293…) round-trips with a single-bit error on x.
  //    Without this snap, the member's screen.x lands at `cx + ε` with
  //    ε non-zero but tiny, `dx = r + |ε|`, and
  //    `Math.ceil(2 * (r + 4 + |ε|))` flips between `2r+8` and `2r+9`
  //    as ε's magnitude crosses the ULP threshold of the addition.
  //    Snapping screen.x/y to a multiple of 0.5 here zeroes |screen − cx|
  //    when the projection lands within ¼ px of the snapped anchor (which
  //    a focused star always does), so the ceil input is an exact
  //    integer and the size is deterministic.
  private projectToBuffer(world: Vector3, camera: Camera): boolean {
    if (this.viewTarget && world.equals(this.viewTarget)) {
      this._screen.x = this.bufferW * 0.5;
      this._screen.y = this.bufferH * 0.5;
      return true;
    }
    this._proj.copy(world).project(camera);
    if (this._proj.z < -1 || this._proj.z > 1) return false;
    this._screen.x = Math.round((this._proj.x * 0.5 + 0.5) * this.bufferW * 2) / 2;
    this._screen.y = Math.round((this._proj.y * 0.5 + 0.5) * this.bufferH * 2) / 2;
    return true;
  }

  // On-screen disc diameter (buffer px) for a star under the current camera,
  // so the brackets track what the user actually sees rather than sitting at a
  // fixed size around tiny dwarfs and close-up giants alike. Delegates to
  // renderedStarPxSize (materials/galaxy.ts), the canonical mirror of the
  // stars shader's size math — both read the same shader constants.
  private computeRenderedStarSize(starIdx: number, camera: Camera): number {
    const s = STARS[starIdx];
    this._view.set(s.x, s.y, s.z).applyMatrix4(camera.matrixWorldInverse);
    return renderedStarPxSize(s.pxSize, this._view.z, this.pxScale);
  }

  // Rebuild the texture + quad when the bracket size changes. Cached by
  // integer size: the shader floors disc size to whole pixels, so during
  // continuous zoom we only rebuild on each integer step (~tens of times
  // across a full zoom range). Keeps GPU upload cost negligible.
  private ensureSize(size: number): void {
    if (size === this.currentSize) return;
    const mat = this.mesh.material as MeshBasicMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = buildBracketTexture(size, this.style);
    mat.needsUpdate = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new PlaneGeometry(size, size);
    this.currentSize = size;
  }

  // Place the mesh so its top-left texel lands on an integer buffer pixel —
  // necessary so all four texture corners align with the buffer pixel grid
  // and every texel renders. Snapping just the center silently drops a row
  // or column of edge pixels for odd-dimension brackets.
  private placeAt(sx: number, sy: number, size: number): void {
    const cornerX = Math.round(sx - size * 0.5);
    const cornerY = Math.round(sy - size * 0.5);
    this.mesh.position.set(cornerX + size * 0.5, cornerY + size * 0.5, 0);
  }

  update(camera: Camera, viewTarget: Vector3): void {
    this.viewTarget = viewTarget;
    if (this.clusterIdx < 0) {
      this.mesh.visible = false;
      return;
    }
    const cluster = STAR_CLUSTERS[this.clusterIdx];

    // Anchor the bracket on the cluster COM rather than the bbox midpoint
    // of projected members. When view.target sits on this COM (i.e. the
    // camera is orbiting the selected cluster), projectToBuffer's NDC-(0,0)
    // short-circuit pins the anchor to exact buffer center — otherwise the
    // bbox midpoint inherits the matrix's ~1e-7 NDC FP noise and the
    // bracket twitches 1px laterally every orbit frame as placeAt()'s
    // Math.round crosses pixel boundaries. Routing the anchor through
    // projectToBuffer (rather than through the per-member bbox midpoint)
    // is what lets the trick apply: view.target only ever equals the COM,
    // never an arbitrary member.
    this._world.set(cluster.com.x, cluster.com.y, cluster.com.z);
    if (!this.projectToBuffer(this._world, camera)) {
      this.mesh.visible = false;
      return;
    }
    const cx = this._screen.x;
    const cy = this._screen.y;

    // Bracket size: max offset of any member's rendered disc from the
    // anchor, so the bracket grows symmetrically around the stable COM.
    // Tilted binaries / triples expand the radius to cover both members;
    // single-member clusters collapse to a tight square around the disc.
    // Per-member FP noise now only nudges this radius (one Math.ceil hop),
    // never the position. If a member is behind the camera
    // (projectToBuffer false) we still draw brackets around the visible
    // ones rather than hiding the whole bracket.
    let radius = 0;
    for (const memIdx of cluster.members) {
      const s = STARS[memIdx];
      this._world.set(s.x, s.y, s.z);
      if (!this.projectToBuffer(this._world, camera)) continue;
      const r = this.computeRenderedStarSize(memIdx, camera) * 0.5;
      const dx = Math.abs(this._screen.x - cx) + r;
      const dy = Math.abs(this._screen.y - cy) + r;
      if (dx > radius) radius = dx;
      if (dy > radius) radius = dy;
    }

    const size = Math.max(BRACKET_MIN_SIZE, Math.ceil(2 * (radius + BRACKET_GAP_PX)));
    this.ensureSize(size);
    this.mesh.visible = true;
    this.placeAt(cx, cy, size);
  }
}
