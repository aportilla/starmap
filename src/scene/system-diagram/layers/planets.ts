// Planets layer — one Points pool covering every planet across every
// cluster member. Position writes come from row-laid-out RowSlot.cx/cy;
// after layout, the layer publishes a PlanetCenterIndex that moons +
// rings consume to anchor relative to their host.

import {
  BufferAttribute, BufferGeometry, DataTexture, FloatType, NearestFilter,
  Points, RGBAFormat, Scene, ShaderMaterial,
} from 'three';
import { BODIES } from '../../../data/stars';
import {
  ATM_COLUMN_TEXEL_OFFSET, BODY_TEXTURE_WIDTH, DECK_COLOR_BASE_OFFSET,
  makePlanetMaterial, MAX_CLOUD_LAYERS,
} from '../../materials';
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
    // Packed render metadata: stride 4 = [size, surfaceOpacity, seed,
    // tilt]. surfaceOpacity is 1 on terrestrials (paint the surface
    // worley) and 0 on gas/ice giants (surface palette has been
    // substituted with atmColumnColor → flat-fill tint shows through
    // cloud rents).
    const renderMeta = new Float32Array(P * 4);
    // Per-body row index (one float, identifies the body's row in
    // uCloudLayerData). Three.js Points geometry has one vertex per
    // body so we can pass this as a plain attribute.
    const bodyIndex = new Float32Array(P);
    // Per-body data texture — packed Float32 RGBA, width
    // BODY_TEXTURE_WIDTH, height P. Each row carries one body's
    // MAX_CLOUD_LAYERS layer slots + 4 cloud-palette texels (palette
    // slot 0/1/2 with slot 3's RGB packed into the .w lanes, plus a
    // weights vec4). Kept off vertex attributes to stay under the
    // gl_MaxVertexAttribs cap.
    const cloudLayerData = new Float32Array(P * BODY_TEXTURE_WIDTH * 4);
    // Surface resource palette + weights — three RGB entries the surface
    // block picks from per worley cell.
    // Surface palette slots 0/1/2 (xyz) widened to vec4 to piggyback
    // the merged rim color: palette0.w = rimColor.r, palette1.w = .g,
    // palette2.w = .b. Stays under gl_MaxVertexAttribs without adding
    // a new attribute slot. The vertex shader unpacks .w → vRimColor
    // so the rim/halo/inward-fade can paint a different blend than the
    // species-pure interior haze overlay (which still uses aHazeColor).
    const palette0  = new Float32Array(P * 4);
    const palette1  = new Float32Array(P * 4);
    const palette2  = new Float32Array(P * 4);
    // Surface palette weights (xyz, sum-to-1). The .w slot is currently
    // unused and reserved for layer payload in PR 3.
    const weights   = new Float32Array(P * 4);
    // Surface scalars: [waterFrac, iceFrac, surfaceAge, globalness].
    const surfaceScalars = new Float32Array(P * 4);
    // Atmospheric scalars: [hazeOpacity, rimWidthPx, _, _]. Cloud
    // coverage / windSpeedMS / altitude live per-layer in uCloudLayerData.
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
      palette0[i * 4 + 0] = disc.palette[0];
      palette0[i * 4 + 1] = disc.palette[1];
      palette0[i * 4 + 2] = disc.palette[2];
      palette0[i * 4 + 3] = disc.rimColor[0];
      palette1[i * 4 + 0] = disc.palette[3];
      palette1[i * 4 + 1] = disc.palette[4];
      palette1[i * 4 + 2] = disc.palette[5];
      palette1[i * 4 + 3] = disc.rimColor[1];
      palette2[i * 4 + 0] = disc.palette[6];
      palette2[i * 4 + 1] = disc.palette[7];
      palette2[i * 4 + 2] = disc.palette[8];
      palette2[i * 4 + 3] = disc.rimColor[2];
      weights[i * 4 + 0] = disc.weights[0];
      weights[i * 4 + 1] = disc.weights[1];
      weights[i * 4 + 2] = disc.weights[2];
      weights[i * 4 + 3] = 0;
      renderMeta[i * 4 + 0] = discPx;
      renderMeta[i * 4 + 1] = disc.surfaceOpacity;
      renderMeta[i * 4 + 2] = disc.seed;
      renderMeta[i * 4 + 3] = disc.tilt;
      bodyIndex[i] = i;
      // Pack up to MAX_CLOUD_LAYERS decks (scalars + per-deck palette).
      // Empty slots stay zeroed (coverage = 0 → shader skips).
      const rowBase = i * BODY_TEXTURE_WIDTH * 4;
      for (let li = 0; li < disc.cloudLayers.length && li < MAX_CLOUD_LAYERS; li++) {
        const l = disc.cloudLayers[li];
        const scalarOff = rowBase + li * 4;
        cloudLayerData[scalarOff + 0] = l.coverage;
        cloudLayerData[scalarOff + 1] = l.windSpeedMS;
        cloudLayerData[scalarOff + 2] = l.altitudeNorm;
        // Per-layer hash salt so each deck's worley cells fall on
        // different positions. Layer index alone is enough.
        cloudLayerData[scalarOff + 3] = li;
        // Per-deck color: one RGBA texel, condensate hue in .rgb.
        const colBase = rowBase + (DECK_COLOR_BASE_OFFSET + li) * 4;
        cloudLayerData[colBase + 0] = l.color[0];
        cloudLayerData[colBase + 1] = l.color[1];
        cloudLayerData[colBase + 2] = l.color[2];
      }
      // Atm column color — painted as no-surface base + visible through
      // cloud rents. One texel per body, RGB in xyz (alpha unused).
      const atmOff = rowBase + ATM_COLUMN_TEXEL_OFFSET * 4;
      cloudLayerData[atmOff + 0] = disc.atmColumnColor[0];
      cloudLayerData[atmOff + 1] = disc.atmColumnColor[1];
      cloudLayerData[atmOff + 2] = disc.atmColumnColor[2];
      surfaceScalars[i * 4 + 0] = disc.waterFrac;
      surfaceScalars[i * 4 + 1] = disc.iceFrac;
      surfaceScalars[i * 4 + 2] = disc.surfaceAge;
      surfaceScalars[i * 4 + 3] = disc.globalness;
      atmoScalars[i * 4 + 0] = disc.hazeOpacity;
      atmoScalars[i * 4 + 1] = disc.rimWidthPx;
      atmoScalars[i * 4 + 2] = 0;
      atmoScalars[i * 4 + 3] = 0;
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
    this.geometry.setAttribute('aPalette0',       new BufferAttribute(palette0, 4));
    this.geometry.setAttribute('aPalette1',       new BufferAttribute(palette1, 4));
    this.geometry.setAttribute('aPalette2',       new BufferAttribute(palette2, 4));
    this.geometry.setAttribute('aWeights',        new BufferAttribute(weights, 4));
    this.geometry.setAttribute('aSurfaceScalars', new BufferAttribute(surfaceScalars, 4));
    this.geometry.setAttribute('aAtmoScalars',    new BufferAttribute(atmoScalars, 4));
    this.geometry.setAttribute('aBiomeColor',     new BufferAttribute(biomeColors, 4));
    this.geometry.setAttribute('aHazeColor',      new BufferAttribute(hazeColors, 4));
    this.geometry.setAttribute('aBodyIndex',      new BufferAttribute(bodyIndex, 1));
    // DataTexture holding per-body cloud-layer metadata. NearestFilter
    // because we sample at integer (col, row) coords; no interpolation
    // wanted between neighboring bodies' rows.
    const cloudTex = new DataTexture(
      cloudLayerData, BODY_TEXTURE_WIDTH, P, RGBAFormat, FloatType,
    );
    cloudTex.minFilter = NearestFilter;
    cloudTex.magFilter = NearestFilter;
    cloudTex.needsUpdate = true;
    this.material = makePlanetMaterial(1.0);
    this.material.uniforms.uCloudLayerData.value = cloudTex;
    this.material.uniforms.uCloudLayerRows.value = P;
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
