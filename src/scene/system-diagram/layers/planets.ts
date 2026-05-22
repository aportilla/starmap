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
    // Packed render metadata: stride 4 = [size, hasSurface, seed, tilt].
    // hasSurface is 0/1 — the shader short-circuits the surface paint
    // block on gas/ice giants when this is 0.
    const renderMeta = new Float32Array(P * 4);
    // Surface resource palette + weights — three RGB entries the surface
    // block picks from per worley cell.
    const palette0  = new Float32Array(P * 3);
    const palette1  = new Float32Array(P * 3);
    const palette2  = new Float32Array(P * 3);
    const weights   = new Float32Array(P * 3);
    // Cloud-layer palette + weights. Banded clouds pick from 4 slots
    // per worley cell: slot 0 = base blend (atm + cloud + haze) at
    // ~50% picker weight, slots 1-3 = top accent species sharing the
    // remaining weight. Patchy clouds use slot 0 as a single
    // condensate color with weights [1,0,0,0].
    //
    // The 4 colors are packed into 3 vec4 attributes to stay under
    // gl_MaxVertexAttribs on tighter GPUs: aCloudPalette0/1/2 carry
    // (slot.r, slot.g, slot.b, slot3.{r,g,b}) — slot 3's RGB is stitched
    // together from the .w components in the vertex shader.
    const cloudPalette0 = new Float32Array(P * 4);
    const cloudPalette1 = new Float32Array(P * 4);
    const cloudPalette2 = new Float32Array(P * 4);
    const cloudWeights  = new Float32Array(P * 4);
    // Surface scalars: [waterFrac, iceFrac, surfaceAge, globalness].
    const surfaceScalars = new Float32Array(P * 4);
    // Atmospheric scalars: [cloudCoverage, cloudStructure, hazeOpacity,
    // rimWidthPx]. Drives all three atmosphere layers (cloud, haze, rim).
    const atmoScalars = new Float32Array(P * 4);
    // Biome color packed as vec4: xyz = pigment, w = coverage density.
    const biomeColors = new Float32Array(P * 4);
    // Rim/haze color + per-vertex hover. Packed as vec4 [r, g, b,
    // hover] — conflated so the total attribute count fits under the
    // driver's gl_MaxVertexAttribs cap. setHovered writes hazeColors[i*4+3].
    const hazeColors = new Float32Array(P * 4);
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
      cloudPalette0[i * 4 + 0] = disc.cloudPalette[0];
      cloudPalette0[i * 4 + 1] = disc.cloudPalette[1];
      cloudPalette0[i * 4 + 2] = disc.cloudPalette[2];
      cloudPalette0[i * 4 + 3] = disc.cloudPalette[9];   // slot3.r
      cloudPalette1[i * 4 + 0] = disc.cloudPalette[3];
      cloudPalette1[i * 4 + 1] = disc.cloudPalette[4];
      cloudPalette1[i * 4 + 2] = disc.cloudPalette[5];
      cloudPalette1[i * 4 + 3] = disc.cloudPalette[10];  // slot3.g
      cloudPalette2[i * 4 + 0] = disc.cloudPalette[6];
      cloudPalette2[i * 4 + 1] = disc.cloudPalette[7];
      cloudPalette2[i * 4 + 2] = disc.cloudPalette[8];
      cloudPalette2[i * 4 + 3] = disc.cloudPalette[11];  // slot3.b
      cloudWeights[i * 4 + 0] = disc.cloudWeights[0];
      cloudWeights[i * 4 + 1] = disc.cloudWeights[1];
      cloudWeights[i * 4 + 2] = disc.cloudWeights[2];
      cloudWeights[i * 4 + 3] = disc.cloudWeights[3];
      renderMeta[i * 4 + 0] = discPx;
      renderMeta[i * 4 + 1] = disc.hasSurface ? 1 : 0;
      renderMeta[i * 4 + 2] = disc.seed;
      renderMeta[i * 4 + 3] = disc.tilt;
      surfaceScalars[i * 4 + 0] = disc.waterFrac;
      surfaceScalars[i * 4 + 1] = disc.iceFrac;
      surfaceScalars[i * 4 + 2] = disc.surfaceAge;
      surfaceScalars[i * 4 + 3] = disc.globalness;
      atmoScalars[i * 4 + 0] = disc.cloudCoverage;
      atmoScalars[i * 4 + 1] = disc.cloudStructure;
      atmoScalars[i * 4 + 2] = disc.hazeOpacity;
      atmoScalars[i * 4 + 3] = disc.rimWidthPx;
      biomeColors[i * 4 + 0] = disc.biomeColor[0];
      biomeColors[i * 4 + 1] = disc.biomeColor[1];
      biomeColors[i * 4 + 2] = disc.biomeColor[2];
      biomeColors[i * 4 + 3] = disc.biomeCoverage;
      hazeColors[i * 4 + 0] = disc.hazeColor[0];
      hazeColors[i * 4 + 1] = disc.hazeColor[1];
      hazeColors[i * 4 + 2] = disc.hazeColor[2];
      hazeColors[i * 4 + 3] = 0;
    });
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position',        new BufferAttribute(positions, 3));
    this.geometry.setAttribute('aRenderMeta',     new BufferAttribute(renderMeta, 4));
    this.geometry.setAttribute('aPalette0',       new BufferAttribute(palette0, 3));
    this.geometry.setAttribute('aPalette1',       new BufferAttribute(palette1, 3));
    this.geometry.setAttribute('aPalette2',       new BufferAttribute(palette2, 3));
    this.geometry.setAttribute('aWeights',        new BufferAttribute(weights, 3));
    this.geometry.setAttribute('aCloudPalette0',  new BufferAttribute(cloudPalette0, 4));
    this.geometry.setAttribute('aCloudPalette1',  new BufferAttribute(cloudPalette1, 4));
    this.geometry.setAttribute('aCloudPalette2',  new BufferAttribute(cloudPalette2, 4));
    this.geometry.setAttribute('aCloudWeights',   new BufferAttribute(cloudWeights, 4));
    this.geometry.setAttribute('aSurfaceScalars', new BufferAttribute(surfaceScalars, 4));
    this.geometry.setAttribute('aAtmoScalars',    new BufferAttribute(atmoScalars, 4));
    this.geometry.setAttribute('aBiomeColor',     new BufferAttribute(biomeColors, 4));
    this.geometry.setAttribute('aHazeColor',      new BufferAttribute(hazeColors, 4));
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
    const attr = this.geometry.attributes.aHazeColor as BufferAttribute;
    attr.setW(slot, value);
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
