// Shared disc-geometry packing for planets + moons. Both layers render
// through makePlanetMaterial and feed it the identical attribute set +
// per-body cloud-layer DataTexture; the only differences are where the
// disc size comes from (row width vs moon slot) and how many materials
// get attached (planets split disc/halo, moons single). This module owns
// the buildDiscPalette → BufferAttribute / DataTexture packing so that
// contract — and the BODY_TEXTURE_WIDTH texel layout — lives in one place
// rather than drifting between two near-identical copies.

import {
  BufferAttribute, BufferGeometry, DataTexture, FloatType, NearestFilter,
  RGBAFormat,
} from 'three';
import { BODIES } from '../../../data/stars';
import {
  ATM_COLUMN_TEXEL_OFFSET, BODY_TEXTURE_WIDTH, DECK_COLOR_BASE_OFFSET,
  LAVA_TINT_TEXEL_OFFSET, MAX_CLOUD_LAYERS,
  OCEAN_COLOR_TEXEL_OFFSET, SCATTER_COLOR_TEXEL_OFFSET,
} from '../../materials';
import { buildDiscPalette } from '../disc-palette';

// One body to pack: its index into BODIES and its disc diameter in env-px.
export interface BodyDiscEntry {
  bodyIdx: number;
  discPx: number;
}

export interface BodyDiscGeometry {
  geometry: BufferGeometry;
  // Per-body cloud-layer metadata. Null only for an empty entry list;
  // callers that always pass ≥1 body get a texture. The owning layer is
  // responsible for disposing it (Three.js won't free it with the
  // geometry/material).
  cloudTex: DataTexture | null;
}

// Build the shared Points geometry (positions zeroed — the layer rewrites
// them in its own layout pass) and the companion cloud-layer DataTexture.
// Attribute layout is consumed by makePlanetMaterial; keep the two in sync.
export function buildBodyDiscGeometry(entries: readonly BodyDiscEntry[]): BodyDiscGeometry {
  const P = entries.length;
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
  // Surface palette slots 0/1/2 (xyz) widened to vec4 to piggyback
  // the merged rim color: palette0.w = rimColor.r, palette1.w = .g,
  // palette2.w = .b. Stays under gl_MaxVertexAttribs without adding
  // a new attribute slot. The vertex shader unpacks .w → vRimColor
  // so the rim/halo/inward-fade can paint a different blend than the
  // species-pure interior haze overlay (which still uses aHazeColor).
  const palette0  = new Float32Array(P * 4);
  const palette1  = new Float32Array(P * 4);
  const palette2  = new Float32Array(P * 4);
  // Surface palette weights (xyz, sum-to-1). The .w slot carries the
  // per-body limb Rayleigh scatter strength for the rim hue shift.
  const weights   = new Float32Array(P * 4);
  // Surface scalars: [waterFrac, iceFrac, surfaceAge, globalness].
  const surfaceScalars = new Float32Array(P * 4);
  // Atmospheric scalars: [hazeOpacity, rimWidthPx, moltenCoverage,
  // emissionTempNorm]. Cloud coverage / windSpeedMS / altitude live
  // per-layer in uCloudLayerData.
  const atmoScalars = new Float32Array(P * 4);
  // Biome color packed as vec4: xyz = pigment, w = coverage density.
  const biomeColors = new Float32Array(P * 4);
  // Rim/haze color + per-vertex hover. Packed as vec4 [r, g, b,
  // hover] — conflated so the total attribute count fits under the
  // driver's gl_MaxVertexAttribs cap. setHovered writes hazeColors[i*4+3].
  const hazeColors = new Float32Array(P * 4);
  entries.forEach(({ bodyIdx, discPx }, i) => {
    const b = BODIES[bodyIdx];
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
    weights[i * 4 + 3] = disc.scatterStrength;
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
    // Per-body ocean color — sampled by the surface block for liquid-
    // water cells. See `oceanColorFor` in disc-palette.ts.
    const oceanOff = rowBase + OCEAN_COLOR_TEXEL_OFFSET * 4;
    cloudLayerData[oceanOff + 0] = disc.oceanColor[0];
    cloudLayerData[oceanOff + 1] = disc.oceanColor[1];
    cloudLayerData[oceanOff + 2] = disc.oceanColor[2];
    // Per-body limb Rayleigh scatter color — target hue for the rim
    // halo's depth-graded Rayleigh shift. One texel, RGB in xyz.
    const scatOff = rowBase + SCATTER_COLOR_TEXEL_OFFSET * 4;
    cloudLayerData[scatOff + 0] = disc.scatterColor[0];
    cloudLayerData[scatOff + 1] = disc.scatterColor[1];
    cloudLayerData[scatOff + 2] = disc.scatterColor[2];
    // Lava composition signal — sulfur fraction in .r (gba reserved).
    const lavaOff = rowBase + LAVA_TINT_TEXEL_OFFSET * 4;
    cloudLayerData[lavaOff + 0] = disc.lavaSulfurFrac;
    surfaceScalars[i * 4 + 0] = disc.waterFrac;
    surfaceScalars[i * 4 + 1] = disc.iceFrac;
    surfaceScalars[i * 4 + 2] = disc.surfaceAge;
    surfaceScalars[i * 4 + 3] = disc.globalness;
    atmoScalars[i * 4 + 0] = disc.hazeOpacity;
    atmoScalars[i * 4 + 1] = disc.rimWidthPx;
    atmoScalars[i * 4 + 2] = disc.moltenCoverage;
    atmoScalars[i * 4 + 3] = disc.emissionTempNorm;
    biomeColors[i * 4 + 0] = disc.biomeColor[0];
    biomeColors[i * 4 + 1] = disc.biomeColor[1];
    biomeColors[i * 4 + 2] = disc.biomeColor[2];
    biomeColors[i * 4 + 3] = disc.biomeCoverage;
    hazeColors[i * 4 + 0] = disc.hazeColor[0];
    hazeColors[i * 4 + 1] = disc.hazeColor[1];
    hazeColors[i * 4 + 2] = disc.hazeColor[2];
    hazeColors[i * 4 + 3] = 0;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',        new BufferAttribute(positions, 3));
  geometry.setAttribute('aRenderMeta',     new BufferAttribute(renderMeta, 4));
  geometry.setAttribute('aPalette0',       new BufferAttribute(palette0, 4));
  geometry.setAttribute('aPalette1',       new BufferAttribute(palette1, 4));
  geometry.setAttribute('aPalette2',       new BufferAttribute(palette2, 4));
  geometry.setAttribute('aWeights',        new BufferAttribute(weights, 4));
  geometry.setAttribute('aSurfaceScalars', new BufferAttribute(surfaceScalars, 4));
  geometry.setAttribute('aAtmoScalars',    new BufferAttribute(atmoScalars, 4));
  geometry.setAttribute('aBiomeColor',     new BufferAttribute(biomeColors, 4));
  geometry.setAttribute('aHazeColor',      new BufferAttribute(hazeColors, 4));
  geometry.setAttribute('aBodyIndex',      new BufferAttribute(bodyIndex, 1));
  // DataTexture holding per-body cloud-layer metadata. NearestFilter
  // because we sample at integer (col, row) coords; no interpolation
  // wanted between neighboring bodies' rows.
  const cloudTex = P > 0
    ? new DataTexture(cloudLayerData, BODY_TEXTURE_WIDTH, P, RGBAFormat, FloatType)
    : null;
  if (cloudTex !== null) {
    cloudTex.minFilter = NearestFilter;
    cloudTex.magFilter = NearestFilter;
    cloudTex.needsUpdate = true;
  }
  return { geometry, cloudTex };
}
