// Planets layer — one Points pool covering every planet across every
// cluster member. Position writes come from row-laid-out RowSlot.cx/cy;
// after layout, the layer publishes a PlanetCenterIndex that moons +
// rings consume to anchor relative to their host.

import { BufferAttribute, BufferGeometry, Points, Scene, ShaderMaterial } from 'three';
import { BODIES } from '../../../data/stars';
import { makePlanetMaterial } from '../../materials';
import { buildDiscPalette } from '../disc-palette';
import { RENDER_ORDER_PLANET, Z_PLANET, Z_STRIDE } from '../layout/constants';
import type { RowSlot } from '../layout/row';
import type { DiagramPick, PlanetCenterIndex } from '../types';

export class PlanetsLayer {
  // planetIndices[i] = bodyIdx of the i-th planet in row order.
  // planetDiscPx[i] = its disc diameter in env-px.
  private readonly planetIndices: readonly number[];
  private readonly planetDiscPx: readonly number[];
  // bodyIdx → slot index in planetIndices, so setHovered can write the
  // per-vertex hover flag without scanning planetIndices on every change.
  private readonly slotByBodyIdx: ReadonlyMap<number, number>;
  private readonly geometry: BufferGeometry | null;
  private readonly material: ShaderMaterial | null;
  private readonly points: Points | null;

  // Built fresh each layout pass. Stays empty when there are no
  // planets in the cluster.
  private centerIndex: Map<number, { cx: number; cy: number; rowIdx: number }> = new Map();

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    this.planetIndices = planetItems.map(r => r.bodyIdx);
    this.planetDiscPx  = planetItems.map(r => r.widthPx);
    this.slotByBodyIdx = new Map(this.planetIndices.map((b, i) => [b, i]));

    if (this.planetIndices.length === 0) {
      this.geometry = null;
      this.material = null;
      this.points   = null;
      return;
    }

    const P = this.planetIndices.length;
    const positions = new Float32Array(P * 3);
    const sizesAttr = new Float32Array(P);
    // aHovered carries the per-vertex hover flag (0 or 1) consumed by
    // the fragment shader's outline branch. Starts all-zero; setHovered
    // flips one entry at a time.
    const hovered   = new Float32Array(P);
    // Procedural-texture inputs — see disc-palette.ts and makePlanetMaterial.
    const palette0  = new Float32Array(P * 3);
    const palette1  = new Float32Array(P * 3);
    const palette2  = new Float32Array(P * 3);
    const weights   = new Float32Array(P * 3);
    const modes     = new Float32Array(P);
    const seeds     = new Float32Array(P);
    const tilts     = new Float32Array(P);
    const albedos   = new Float32Array(P);
    this.planetIndices.forEach((bIdx, i) => {
      const b = BODIES[bIdx];
      const discPx = this.planetDiscPx[i];
      const disc = buildDiscPalette(b, discPx);
      palette0[i * 3 + 0] = disc.palette[0];
      palette0[i * 3 + 1] = disc.palette[1];
      palette0[i * 3 + 2] = disc.palette[2];
      palette1[i * 3 + 0] = disc.palette[3];
      palette1[i * 3 + 1] = disc.palette[4];
      palette1[i * 3 + 2] = disc.palette[5];
      palette2[i * 3 + 0] = disc.palette[6];
      palette2[i * 3 + 1] = disc.palette[7];
      palette2[i * 3 + 2] = disc.palette[8];
      weights[i * 3 + 0] = disc.weights[0];
      weights[i * 3 + 1] = disc.weights[1];
      weights[i * 3 + 2] = disc.weights[2];
      modes[i] = disc.mode;
      seeds[i] = disc.seed;
      tilts[i] = disc.tilt;
      albedos[i] = disc.albedo;
      // aSize carries the final pixel diameter; uDiscScale = 1.0 so the
      // shader's floor(aSize * 1.0 + 0.5) is a no-op pass-through.
      sizesAttr[i] = discPx;
    });
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSize',    new BufferAttribute(sizesAttr, 1));
    this.geometry.setAttribute('aHovered', new BufferAttribute(hovered, 1));
    this.geometry.setAttribute('aPalette0', new BufferAttribute(palette0, 3));
    this.geometry.setAttribute('aPalette1', new BufferAttribute(palette1, 3));
    this.geometry.setAttribute('aPalette2', new BufferAttribute(palette2, 3));
    this.geometry.setAttribute('aWeights',  new BufferAttribute(weights, 3));
    this.geometry.setAttribute('aMode',     new BufferAttribute(modes, 1));
    this.geometry.setAttribute('aSeed',     new BufferAttribute(seeds, 1));
    this.geometry.setAttribute('aTilt',     new BufferAttribute(tilts, 1));
    this.geometry.setAttribute('aAlbedo',   new BufferAttribute(albedos, 1));
    this.material = makePlanetMaterial(1.0);
    this.points = new Points(this.geometry, this.material);
    this.points.renderOrder = RENDER_ORDER_PLANET;
    // Three.js computes the bounding sphere from the initial all-zero
    // positions and never recomputes it when the position attribute
    // changes on resize. Disabling frustum culling sidesteps the stale
    // sphere; per-vertex GPU clipping still discards anything genuinely
    // off-screen.
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  // Write planet Points positions from the rowSlots' (already-laid-out)
  // cx/cy. Iterates the planet-only subset in row order, so index i
  // lines up with planetIndices[i]. Also rebuilds the PlanetCenterIndex
  // for moons + rings to consume.
  layout(rowSlots: readonly RowSlot[]): void {
    this.centerIndex.clear();
    if (!this.geometry || !this.points) return;
    const positions = this.geometry.attributes.position.array as Float32Array;
    let pi = 0;
    for (const item of rowSlots) {
      if (item.kind !== 'planet') continue;
      positions[pi * 3 + 0] = item.cx;
      positions[pi * 3 + 1] = item.cy;
      positions[pi * 3 + 2] = item.rowIdx * Z_STRIDE + Z_PLANET;
      this.centerIndex.set(item.bodyIdx, { cx: item.cx, cy: item.cy, rowIdx: item.rowIdx });
      pi++;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  // Read-only view of the published planet centers. Empty before the
  // first layout() call.
  getCenterIndex(): PlanetCenterIndex {
    return this.centerIndex;
  }

  pickAt(x: number, y: number): DiagramPick | null {
    if (!this.geometry) return null;
    const pos = this.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < this.planetIndices.length; i++) {
      const cx = pos[i * 3 + 0];
      const cy = pos[i * 3 + 1];
      const r = this.planetDiscPx[i] / 2;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        return { kind: 'planet', bodyIdx: this.planetIndices[i] };
      }
    }
    return null;
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'planet' || !this.geometry) return;
    const slot = this.slotByBodyIdx.get(pick.bodyIdx);
    if (slot === undefined) return;
    const attr = this.geometry.attributes.aHovered as BufferAttribute;
    attr.setX(slot, value);
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
