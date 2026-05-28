// Materials barrel — consumers import from '.../materials' and get
// whichever symbols they need. Galaxy-view shaders live in ./galaxy.ts,
// system-view shaders in ./system.ts, shared infrastructure (registry
// + glsl helper) in ./shared.ts.

export { setSnappedLineViewport } from './shared';
export {
  makeStarsMaterial,
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
  MAX_LIGHTS,
  OCEAN_COLOR_TEXEL_OFFSET,
  SCATTER_COLOR_TEXEL_OFFSET,
  makeBlobMaterial,
  makePlanetMaterial,
  makeRingMaterial,
  makeStarHaloMaterial,
  makeStarMeshMaterial,
} from './system';
