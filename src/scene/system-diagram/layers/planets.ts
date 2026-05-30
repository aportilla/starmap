// Planets layer — one Points pool covering every planet across every
// cluster member. Position writes come from row-laid-out RowSlot.cx/cy;
// after layout, the layer publishes a PlanetCenterIndex that moons +
// rings consume to anchor relative to their host. The disc geometry +
// cloud DataTexture are built by the shared buildBodyDiscGeometry (see
// body-disc.ts) — moons pack the identical attribute set.

import {
  BufferGeometry, DataTexture, Points, Scene, ShaderMaterial,
} from 'three';
import { makePlanetMaterial } from '../../materials';
import { buildBodyDiscGeometry, setBodyDiscHovered } from './body-disc';
import { pickDiscPool } from '../geom/hit';
import { disableCulling } from '../geom/cull';
import { disposePool } from './dispose';
import { RENDER_ORDER_PLANET, RENDER_ORDER_PLANET_HALO, Z_PLANET, Z_STRIDE } from '../layout/constants';
import type { RowSlot } from '../layout/row';
import { writeLightUniforms } from '../lighting';
import type { DiagramPick, PlanetCenterIndex, StarLightSource } from '../types';

export class PlanetsLayer {
  // planetIndices[i] = bodyIdx of the i-th planet in row order.
  // planetDiscPx[i] = its disc diameter in env-px.
  private readonly planetIndices: readonly number[];
  private readonly planetDiscPx: readonly number[];
  // bodyIdx → slot index in planetIndices, so setHovered can write the
  // per-vertex hover flag without scanning planetIndices on every change.
  private readonly slotByBodyIdx: ReadonlyMap<number, number>;
  private readonly geometry: BufferGeometry | null;
  // Two materials + two Points sharing one geometry. Disc renders at
  // RENDER_ORDER_PLANET (10) and discards halo fragments; halo renders
  // at RENDER_ORDER_PLANET_HALO (20, after front-rings/moons) and
  // discards disc fragments. See makePlanetMaterial's mode arg for the
  // rationale.
  private readonly discMaterial: ShaderMaterial | null;
  private readonly haloMaterial: ShaderMaterial | null;
  private readonly discPoints: Points | null;
  private readonly haloPoints: Points | null;
  // Per-body cloud-layer texture, kept so dispose() can free it (Three.js
  // won't release it with the geometry/material).
  private readonly cloudTex: DataTexture | null;

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
      this.discMaterial = null;
      this.haloMaterial = null;
      this.discPoints   = null;
      this.haloPoints   = null;
      this.cloudTex     = null;
      return;
    }

    const P = this.planetIndices.length;
    const { geometry, cloudTex } = buildBodyDiscGeometry(
      this.planetIndices.map((bodyIdx, i) => ({ bodyIdx, discPx: this.planetDiscPx[i] })),
    );
    this.geometry = geometry;
    this.cloudTex = cloudTex;
    this.discMaterial = makePlanetMaterial(1.0, 'disc');
    this.haloMaterial = makePlanetMaterial(1.0, 'halo');
    for (const m of [this.discMaterial, this.haloMaterial]) {
      m.uniforms.uCloudLayerData.value = cloudTex;
      m.uniforms.uCloudLayerRows.value = P;
    }
    this.discPoints = new Points(this.geometry, this.discMaterial);
    this.discPoints.renderOrder = RENDER_ORDER_PLANET;
    this.haloPoints = new Points(this.geometry, this.haloMaterial);
    this.haloPoints.renderOrder = RENDER_ORDER_PLANET_HALO;
    // Position attribute is rewritten each layout — see disableCulling.
    disableCulling(this.discPoints);
    disableCulling(this.haloPoints);
    scene.add(this.discPoints);
    scene.add(this.haloPoints);
  }

  // Write planet Points positions from the rowSlots' (already-laid-out)
  // cx/cy. Iterates the planet-only subset in row order, so index i
  // lines up with planetIndices[i]. Also rebuilds the PlanetCenterIndex
  // for moons + rings to consume.
  layout(rowSlots: readonly RowSlot[]): void {
    this.centerIndex.clear();
    if (!this.geometry) return;
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

  // Push the current cluster's star positions / colors / intensities
  // into both materials so the lighting pass in makePlanetMaterial picks
  // up the per-fragment crescent tint. Cheap (a handful of uniform
  // writes); called once per resize from SystemDiagram.layout.
  setLightSources(lights: readonly StarLightSource[]): void {
    if (!this.discMaterial || !this.haloMaterial) return;
    writeLightUniforms(this.discMaterial, lights);
    writeLightUniforms(this.haloMaterial, lights);
  }

  pickAt(x: number, y: number): DiagramPick | null {
    if (!this.geometry) return null;
    const pos = this.geometry.attributes.position.array as Float32Array;
    return pickDiscPool(
      x, y, this.planetIndices.length,
      i => pos[i * 3 + 0],
      i => pos[i * 3 + 1],
      i => this.planetDiscPx[i] / 2,
      i => ({ kind: 'planet', bodyIdx: this.planetIndices[i] }),
    );
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'planet' || !this.geometry) return;
    const slot = this.slotByBodyIdx.get(pick.bodyIdx);
    if (slot === undefined) return;
    setBodyDiscHovered(this.geometry, slot, value);
  }

  dispose(): void {
    // One geometry + cloudTex shared by both passes; the halo material is
    // the second consumer of that shared geometry, so it frees separately.
    disposePool({ geometry: this.geometry, material: this.discMaterial, cloudTex: this.cloudTex });
    this.haloMaterial?.dispose();
  }
}
