// Materials barrel — consumers import from '.../materials' and get
// whichever symbols they need. Galaxy-view shaders live in ./galaxy.ts,
// the system-view planet/moon disc in ./planet.ts, the smaller system-
// view materials (blob, ring, star disc, star halo) in ./system-decor.ts,
// shared GLSL fragments in ./chunks.ts, and shared infrastructure
// (registry + glsl helper) in ./shared.ts.

export { setSnappedLineViewport } from './shared';
export { MAX_LIGHTS } from './chunks';
export {
  makeStarsMaterial,
  renderedStarPxSize,
  snappedDotsMat,
  snappedLineMat,
  type SnappedLineOptions,
} from './galaxy';
export {
  ATM_COLUMN_TEXEL_OFFSET,
  BODY_TEXTURE_WIDTH,
  DECK_COLOR_BASE_OFFSET,
  LAVA_TINT_TEXEL_OFFSET,
  MAX_CLOUD_LAYERS,
  OCEAN_COLOR_TEXEL_OFFSET,
  SCATTER_COLOR_TEXEL_OFFSET,
  makePlanetMaterial,
} from './planet';
export {
  makeBlobMaterial,
  makeRingMaterial,
  makeStarHaloMaterial,
  makeStarMeshMaterial,
} from './system-decor';
