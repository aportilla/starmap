// Planet/moon disc material — the procedural layered-composite shader
// (surface → cloud → haze → rim) for the system-view diagram. Renders
// under an OrthographicCamera at 1 unit = 1 buffer pixel; no depth
// attenuation, no pivot dim. Shares the Bayer dither + star-crescent
// lighting GLSL with the decor materials (see ./chunks). The four smaller
// system-view materials (blob, ring, star disc, star halo) live in
// ./system-decor.

import { Color, ShaderMaterial, Vector2 } from 'three';
import { RING_MINOR_OVER_MAJOR } from '../system-diagram/layout/constants';
import { glsl, RASTER_PAD, snappedMaterials } from './shared';
import { MAX_LIGHTS, BAYER4_GLSL, HASH_GLSL, STAR_CRESCENT_LIGHTING_GLSL } from './chunks';

// Planet + moon disc material. Renders a pixel-crisp disc whose interior
// is a layered composite, bottom to top:
//
//   1. **Surface** (only when aRenderMeta.y > 0.5) — sphere-projected
//      worley/voronoi cell texture: every fragment reconstructs its
//      surface normal, derives latitude + longitude in the band-aligned
//      frame, and hashes into a cell whose coords are (lon, lat) scaled
//      so disc-center cells stay at SURFACE_PATCH_PX while limb cells
//      compress under foreshortening. Driven CPU-side by world-class
//      color + dominant resources. Skipped on gas/ice giants — the
//      cloud layer is their canvas; a fallback to aCloudPalette0
//      provides their base color.
//   2. **Cloud** (when aAtmoScalars.x > 0) — coverage + structure scalars
//      pick one of two geometries per body:
//        - cloudStructure < 0.5: anisotropic worley patches in the
//          equator-aligned frame, paints aCloudPalette0 on cells whose
//          per-cell hash < cloudCoverage. Earth's broken trade-wind
//          decks.
//        - cloudStructure ≥ 0.5: two-layer worley stack in sphere-
//          projected (lon, lat), cells stretched east-west so the
//          natural Voronoi tessellation forms strips along the rotation
//          axis. Per-cell color is picked from the cell's latitude
//          component only — cells in the same lat track share a color,
//          so the bands read parallel to the equator. Painted at
//          alpha = cloudCoverage. Jupiter / Saturn / Uranus / Neptune /
//          Venus.
//   3. **Haze** (when aAtmoScalars.z > 0) — uniform per-fragment lerp
//      toward aHazeColor by hazeOpacity. Unified blend across bulk atm
//      gases × pressure, Rayleigh scattering, formation-gated aerosol
//      products (Titan tholin, Venus sulfate, Jovian NH4SH), and lifted
//      mineral dust. Surface bodies only (no-surface uniform overlay
//      would crush the cloud-band structure on gas giants).
//   4. **Rim** — outward atmospheric-loft halo driven by aAtmoScalars.y
//      (rimWidthPx). The base hue is the merged-rim blend in vRimColor
//      (cloud slot 0 + surface haze contributors, or cloud + atm column
//      on giants), but the halo is LIT by the in-scene stars rather than
//      a flat ring (see the "atmospheric loft glow" + "Rayleigh hue
//      shift" constant blocks). Per fragment: a half-lambert angular wrap
//      glows the loft on the star-facing limb (extending past the
//      terminator, further than the disc-interior crescent), colored as
//      gas × starlight (hue-preserving multiply) with a gated white
//      forward-scatter tip; opacity ramps from a faint night floor to
//      full on the lit limb. Then a depth-graded, hue-ONLY Rayleigh shift
//      rotates the color toward the body's per-gas scatter hue (sampled
//      from the body texture) re-illuminated by the starlight — strongest
//      in the outermost loft layer — scaled by the body's Rayleigh
//      fraction (vWeights.w) so a clear-air limb (Earth) shifts blue
//      while an absorption/aerosol-dominated one (Venus) barely moves.
//
// Cloud-structure snaps binary at 0.5 in v1; the procgen distributions
// produce mostly 0 (terrestrial patchy) or 1 (banded / venusian / gas
// giant) so intermediate values are rare.
//
// Pixel-crisp constraints (see README §Pixel-perfect rendering):
//   - The disc still does parity-aware center snap so `gl_FragCoord -
//     vCenter` lands at symmetric pixel offsets.
//   - Cell boundaries are computed from integer pixel offsets, so each
//     rendered pixel resolves to exactly one cell — the texture is
//     integer-pixel grained.
//   - No AA, no gradients, no inter-palette blending.
//
// Designed for an OrthographicCamera at 1 unit = 1 buffer pixel (vertex
// positions are buffer-pixel coords). `aSize` is the per-body disc
// diameter; `uDiscScale` is a global multiplier (planets + moons pass 1.0,
// the diagram already bakes its own sizing).
// Max cloud decks the shader iterates per body. Per-body data lives in
// uCloudLayerData, a DataTexture of width = BODY_TEXTURE_WIDTH and
// height = body count. Texel layout per body row:
//   [0..MAX_CLOUD_LAYERS)            — per-layer scalars (coverage, windSpeedMS, alt, seed)
//   [MAX_CLOUD_LAYERS]               — atm column color (rgb, .a unused)
//   [MAX_CLOUD_LAYERS+1 .. +1+N)     — per-deck color (one RGBA texel per
//                                       deck; .a unused). Single condensate
//                                       color — multi-color character on
//                                       banded bodies emerges from coverage
//                                       rents revealing the deeper deck,
//                                       not from in-deck mixing.
//   [MAX_CLOUD_LAYERS+1+N]           — per-body ocean color (rgb, .a unused).
//                                       Painted in surface-liquid cells (see
//                                       `oceanColorFor` in disc-palette/ocean.ts).
//   [MAX_CLOUD_LAYERS+1+N+1]          — per-body limb Rayleigh scatter color
//                                       (rgb, .a unused). Target hue for the
//                                       rim's depth-graded Rayleigh shift (see
//                                       `scatteringRimFor` in disc-palette/atmosphere.ts);
//                                       its strength rides on aWeights.w.
//   [MAX_CLOUD_LAYERS+1+N+2]          — per-body lava composition signal
//                                       (.r = sulfur fraction; gba unused).
//                                       The molten sub-pass lifts the ember's
//                                       green channel by .r so sulfurous
//                                       volcanism (Io) reads yellower than
//                                       silicate lava (see lavaSulfurFrac in
//                                       disc-palette/lava.ts).
// Pulling everything off vertex attributes brings the per-pool attribute
// count back under the gl_MaxVertexAttribs cap.
// Up to 4 stratified decks per body — 3 chemistry decks (Jupiter
// stack: H2O / NH4SH / NH3) plus 1 synthetic "base" deck prepended
// for no-surface bodies in disc-palette. The base deck paints the
// bulk atm column with subtle lat-band lj jitter so a gas giant
// reads as gently banded foundation under its real cloud chemistry,
// instead of a flat fill underneath sparse decks.
export const MAX_CLOUD_LAYERS = 4;
const ATM_COLUMN_TEXEL_OFFSET = MAX_CLOUD_LAYERS;
const DECK_COLOR_BASE_OFFSET = MAX_CLOUD_LAYERS + 1;
const OCEAN_COLOR_TEXEL_OFFSET = MAX_CLOUD_LAYERS + 1 + MAX_CLOUD_LAYERS;
// Per-body limb Rayleigh scatter color (rgb; .a unused) — the gas-specific
// hue the rim halo's depth-graded Rayleigh shift targets. Strength rides
// on aWeights.w, so only the color needs a texel here.
const SCATTER_COLOR_TEXEL_OFFSET = MAX_CLOUD_LAYERS + 1 + MAX_CLOUD_LAYERS + 1;
// Per-body lava composition signal (.r = sulfur fraction; gba unused) —
// the abiotic surface-sulfur fraction that the molten sub-pass uses to
// shift the ember yellower (see lavaSulfurFrac in disc-palette/lava.ts). One
// channel today; the rest of the texel is reserved for future
// compositional lava hues.
const LAVA_TINT_TEXEL_OFFSET = MAX_CLOUD_LAYERS + 1 + MAX_CLOUD_LAYERS + 1 + 1;
export const BODY_TEXTURE_WIDTH =
  MAX_CLOUD_LAYERS + 1 + MAX_CLOUD_LAYERS + 1 + 1 + 1;
export { ATM_COLUMN_TEXEL_OFFSET, DECK_COLOR_BASE_OFFSET, OCEAN_COLOR_TEXEL_OFFSET, SCATTER_COLOR_TEXEL_OFFSET, LAVA_TINT_TEXEL_OFFSET };

// mode='all' renders disc + halo (moons; keeps the original single-pass
// behavior). mode='disc' or 'halo' splits the disc-interior and the
// outward halo into two passes so the diagram can render all planet
// halos AFTER front rings/moons — the halo otherwise blends against
// background (and depth-rejects the front-ring) when a right neighbor's
// halo extends over a left neighbor's front-ring/moon. See README's
// "Per-row-item depth" section + RENDER_ORDER_PLANET_HALO.
export function makePlanetMaterial(initialDiscScale: number, mode: 'all' | 'disc' | 'halo' = 'all'): ShaderMaterial {
  const defines: Record<string, string> = {};
  if (mode === 'disc') defines.DISC_ONLY = '1';
  if (mode === 'halo') defines.HALO_ONLY = '1';
  const m = new ShaderMaterial({
    defines,
    uniforms: {
      uDiscScale: { value: initialDiscScale },
      uViewport:  { value: new Vector2(window.innerWidth, window.innerHeight) },
      uCloudLayerData: { value: null },
      uCloudLayerRows: { value: 1 },
      // Per-fragment lighting inputs (see MAX_LIGHTS comment).
      // uLightCount gates the loop in the fragment shader; positions are
      // in buffer-pixel coords (parity-snapped CPU-side), colors are
      // the system-view-tuned star RGB triples (StarLightSource.color),
      // intensities are per-cluster-normalized [0, 1]. Slot instances
      // are stable so per-resize updates land via .set() / .setRGB()
      // without garbage.
      uLightCount:     { value: 0 },
      uLightPos:       { value: Array.from({ length: MAX_LIGHTS }, () => new Vector2()) },
      uLightColor:     { value: Array.from({ length: MAX_LIGHTS }, () => new Color()) },
      uLightIntensity: { value: new Float32Array(MAX_LIGHTS) },
    },
    vertexShader: `
      // Per-body render metadata packed: x = size in px,
      // y = surfaceOpacity (0..1 — 1 on terrestrials, 0 on gas/ice
      // giants where the surface palette has been substituted with
      // atmColumnColor for cloud-rent reveal), z = seed, w = tilt.
      attribute vec4  aRenderMeta;
      // Body row index in uCloudLayerData (one float per vertex,
      // matches the body's slot in the per-pool buffer).
      attribute float aBodyIndex;
      // Surface resource palette + weights.
      // Surface palette resource slots (xyz) + merged rim color packed in
      // .w slots (palette0.w = rimColor.r, palette1.w = .g, palette2.w =
      // .b). Reconstructed in the vertex shader as vRimColor. Keeps the
      // species-pure interior haze overlay (which still uses aHazeColor)
      // visually distinct from the limb-blended rim/halo/inward-fade.
      attribute vec4  aPalette0;
      attribute vec4  aPalette1;
      attribute vec4  aPalette2;
      // xyz = surface palette resource weights (sum-to-1 normalized);
      // w = per-body limb Rayleigh scatter strength [0..1] (scales the
      // rim's depth-graded hue shift; see scatteringRimFor in
      // disc-palette/atmosphere.ts). Reaches the fragment shader via vWeights.w.
      attribute vec4  aWeights;
      // Surface scalars: x = waterFrac, y = iceFrac, z = surfaceAge,
      // w = globalness.
      attribute vec4  aSurfaceScalars;
      // Atmosphere scalars: x = hazeOpacity [0..1] uniform overlay
      // alpha, y = rimWidthPx (integer 0..N halo width), z = moltenCoverage
      // [0..1] (lava emission — how much of the disc is molten), w =
      // emissionTempNorm [0..1] (normalized lava emission temperature →
      // emberRamp). Per-layer cloud data (coverage / windSpeedMS /
      // altitudeNorm) lives in uCloudLayerData sampled by aBodyIndex.
      attribute vec4  aAtmoScalars;
      // Biome stipple: xyz = pigment color, w = coverage density [0..1].
      attribute vec4  aBiomeColor;
      // Shared rim + haze-layer color + per-vertex hover flag.
      // Layout: xyz = MERGED rim/haze color (weighted-average blend
      // across cloud, photochemistry haze, scattering, and dust — see
      // disc-palette/index.ts), w = hover flag (0/1, flipped by setHovered).
      // Conflated to keep the attribute count under gl_MaxVertexAttribs.
      attribute vec4  aHazeColor;

      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec4  vWeights;
      varying float vSurfaceOpacity;
      varying float vBodyIndex;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying float vSurfaceAge;
      varying float vGlobalness;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying float vHazeOpacity;
      varying float vRimWidthPx;
      varying vec3  vHazeColor;
      varying vec3  vRimColor;
      varying float vMoltenCoverage;
      varying float vEmissionTempNorm;
      uniform float uDiscScale;
      uniform vec2  uViewport;
      void main() {
        vHovered  = aHazeColor.w;
        vRimColor = vec3(aPalette0.w, aPalette1.w, aPalette2.w);
        vPalette0 = aPalette0.xyz;
        vPalette1 = aPalette1.xyz;
        vPalette2 = aPalette2.xyz;
        vWeights  = aWeights;
        vSurfaceOpacity = aRenderMeta.y;
        vBodyIndex      = aBodyIndex;
        vSeed       = aRenderMeta.z;
        vTilt       = aRenderMeta.w;
        vWaterFrac  = aSurfaceScalars.x;
        vIceFrac    = aSurfaceScalars.y;
        vSurfaceAge = aSurfaceScalars.z;
        vGlobalness = aSurfaceScalars.w;
        vHazeOpacity = aAtmoScalars.x;
        vRimWidthPx  = aAtmoScalars.y;
        vMoltenCoverage   = aAtmoScalars.z;
        vEmissionTempNorm = aAtmoScalars.w;
        vBiomeColor    = aBiomeColor.xyz;
        vBiomeCoverage = aBiomeColor.w;
        vHazeColor   = aHazeColor.xyz;

        // Integer-pixel disc diameter. Floor + 0.5 → round-to-nearest.
        float sz = floor(aRenderMeta.x * uDiscScale + 0.5);
        // Sprite extent must include the atmospheric halo that extends
        // 0..3 px OUTSIDE the disc, so the rasterizer covers that
        // region. Without the extra padding the halo fragments would
        // never be rasterized. RASTER_PAD adds the small fixed bounding-
        // box headroom; the rim term adds enough space for the per-
        // body halo width.
        gl_PointSize = sz + ${glsl(RASTER_PAD)} + 2.0 * aAtmoScalars.y;
        vRadius = sz * 0.5;

        // Parity-aware snap of the projected center to the pixel grid:
        // even sz → integer (pixel boundary), odd sz → integer + 0.5
        // (pixel center). Load-bearing for symmetric disc rasterization
        // under the gl_FragCoord − vCenter offset path.
        float oddOff = mod(sz, 2.0) * 0.5;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 ndc = clip.xy / clip.w;
        vec2 fp = (ndc * 0.5 + 0.5) * uViewport;
        vec2 px = floor(fp - oddOff + 0.5) + oddOff;
        vCenter = px;
        ndc = (px / uViewport) * 2.0 - 1.0;
        gl_Position = vec4(ndc * clip.w, clip.z, clip.w);
      }
    `,
    fragmentShader: `
      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec4  vWeights;
      varying float vSurfaceOpacity;
      varying float vBodyIndex;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying float vSurfaceAge;
      varying float vGlobalness;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying float vHazeOpacity;
      varying float vRimWidthPx;
      varying vec3  vHazeColor;
      varying vec3  vRimColor;
      varying float vMoltenCoverage;
      varying float vEmissionTempNorm;
      uniform sampler2D uCloudLayerData;
      uniform float     uCloudLayerRows;

      // Per-fragment lighting inputs. uLightCount is the active source
      // count [0..MAX_LIGHTS]; positions are buffer-pixel coords
      // (matched to vCenter's frame). Loop guarded against uLightCount
      // so unused slots don't contribute; the JS side never writes past
      // the active count, but zero-initialized slots wouldn't hurt
      // visually either (intensity 0 nukes their lambert term).
      uniform int       uLightCount;
      uniform vec2      uLightPos[${MAX_LIGHTS}];
      uniform vec3      uLightColor[${MAX_LIGHTS}];
      uniform float     uLightIntensity[${MAX_LIGHTS}];

      // Perspective foreshortening for banded mode — the disc is treated
      // as the projection of a sphere whose rotation axis is tipped
      // forward (toward the viewer) by arcsin(POLE_SIN). POLE_SIN is
      // pinned to RING_MINOR_OVER_MAJOR so the bands curve as latitude
      // lines viewed from the same oblique angle the ring annulus uses
      // — a ringed giant's bands and ring share one coherent vantage
      // point rather than reading as a sphere wearing a flat-stamped
      // texture next to a top-down ring.
      const float POLE_SIN = ${glsl(RING_MINOR_OVER_MAJOR)};
      const float POLE_COS = sqrt(1.0 - POLE_SIN * POLE_SIN);

      // Per-band ± additive lightness perturbation. Keeps bands
      // visually distinct when the palette entries collapse to nearly
      // the same color — e.g. an H2/He gas giant with no cloud chemistry mix,
      // where the palette slots all reduce to a single near-beige
      // and a per-band hue pick would otherwise paint every strip the
      // same RGB. 0.06 = ±6% value swing: invisible against a high-
      // contrast Jovian palette (where the inter-gas hue gap is much
      // larger), but resolves to readable cream / tan / dark-tan
      // strips on a near-monochrome one.
      const float BAND_LIGHTNESS_JITTER = 0.06;

      // Banded-mode worley pitches in env-px. Two layers, both
      // anisotropic east-west (LON > LAT) so Voronoi cells form
      // horizontal strips. Primary layer is the dominant visible band
      // paint; detail layer overlays smaller stripes at partial
      // coverage for sub-band texture.
      //
      // LON1=24 puts ~7-8 cells along the equator on a Jupiter-class
      // 60-px disc; LAT1=5 gives ~12 lat tracks pole-to-pole. ~5:1
      // aniso. Wider aniso ratios produced sliverlike fragments that
      // didn't read as bands; 5:1 hits the "cells look like band
      // segments" sweet spot. Detail layer at half the LON pitch and
      // ~2 px LAT pitch adds sub-band stripes at 50% cell coverage.
      const float BAND1_LON_PX = 24.0;
      const float BAND1_LAT_PX = 5.0;
      const float BAND2_LON_PX = 12.0;
      const float BAND2_LAT_PX = 2.0;
      const float DETAIL_COVERAGE = 0.5;

      // Cloud-deck wind→banding curve (consumed by the cloud-layer loop;
      // see its comment for the full derivation). bandness smoothsteps
      // from WIND_BANDNESS_LOW_MS (Earth jet stream, patchy) to
      // WIND_BANDNESS_HIGH_MS (Jupiter-class, lat-strip aligned); the
      // east-west cell pitch stretches via sqrt(windSpeed /
      // WIND_STRETCH_REFERENCE_MS) toward BAND_MAX_LON_PX at full bandness.
      const float WIND_BANDNESS_LOW_MS      = 30.0;
      const float WIND_BANDNESS_HIGH_MS     = 150.0;
      const float WIND_STRETCH_REFERENCE_MS = 600.0;
      const float BAND_MAX_LON_PX           = 120.0;

      // Surface-mode worley cell pitch — equivalent screen-pixels at
      // disc center. Cells live in sphere-space (lon, lat) scaled by
      // vRadius / SURFACE_PATCH_PX, so a 60-px planet disc still gets
      // ~15 cells across the equator but the cells foreshorten as they
      // approach the limb (the natural sphere-projection compression).
      // Jittered cell centers in the angular frame make the patch
      // silhouettes non-grid-aligned; the ground reads as organic lumps
      // wrapping a globe rather than rectangular tiles stamped on a
      // disc.
      const float SURFACE_PATCH_PX = 4.0;

      // Sphere-projection inset for surface mode. The disc edge maps
      // to the point on the sphere where (nxs, nys) reach
      // SPHERE_VISIBLE_FRAC of the unit normal, not to the true limb
      // (FRAC = 1.0). At FRAC = 1 cells pinch to sub-pixel widths near
      // the rim and read as noise; below 1.0 the projection covers
      // only the central cone of the hemisphere, so foreshortening is
      // bounded — cells at the disc edge are scaled by
      // sqrt(1 - FRAC²) of disc-center size, never zero. 0.85 →
      // disc edge sits at asin(0.85) = 58° from the pole; edge cells
      // are ~53% of disc-center size; the disc still reads as a globe
      // but stays pixel-coherent under the chunky aesthetic.
      // Surface-mode only — banded mode keeps the full FRAC = 1.0
      // projection because its latitude arcs need the strong
      // foreshortening to look spherical.
      const float SPHERE_VISIBLE_FRAC = 0.85;

      // Continent grouping: every CONTINENT_GROUP worley cells along
      // each axis share one ocean/land decision. Inherits the worley
      // boundary irregularity for free (rather than grid-aligned 16-px
      // squares), so continents have ragged Earth-like coasts at no
      // extra shader cost beyond one hash. 4 → ~16 px continents.
      const float CONTINENT_GROUP = 4.0;

      // Coastal-fringe highlight deltas (consumed by the two-ring coast
      // logic in the surface block). Ring 1 (one worley cell from land)
      // paints a solid +COAST_LIGHT_DELTA shoreline; ring 2 (two cells
      // out) dithers that same highlight at COAST_R2_COVERAGE density so
      // the band fades into the deep ocean instead of ending hard.
      const float COAST_LIGHT_DELTA = 0.14;
      const float COAST_R2_COVERAGE = 0.35;

      // Ocean fill color is per-body and read from vOceanColor (sampled
      // from uCloudLayerData), derived in disc-palette/ocean.ts so two
      // close-analog bodies get distinguishable hues. See
      // oceanColorFor.

      // Polar cap fill. Pale ice-white — not pure white so the cap
      // still reads as "frozen surface" rather than "missing pixels"
      // against a dark scene background.
      const vec3 ICE_COLOR = vec3(0.93, 0.97, 1.0);

      // Globalness threshold separating the cap regime (warm /
      // transitional bodies → surface-deposit caps at high latitude,
      // pure ICE_COLOR) from the global regime (cold bodies → bulk
      // cryosphere, scattered cells with surfaceAge controlling
      // regolith burial). Pinned to the lower edge of frozenBoost's
      // smoothstep so a body either stays fully in the cap regime
      // (frozenBoost = 0) or transitions into the global regime
      // (frozenBoost > 0) — no overlap. Mars at globalness ≈ 0.74 sits
      // in cap; Europa / Triton at globalness = 1.0 sit in global.
      const float CAP_GLOBALNESS_MAX = 0.8;

      // Biome stipple latitude window. Past BIOME_LAT_MAX (|sin lat| ≈
      // sin(58°)) life thins to zero; BIOME_LAT_RAMP feathers the edge
      // so the transition reads as "thinning toward the poles" rather
      // than a hard band cutoff. The cap branch above already masks
      // anything past 1 - iceFrac; this window narrows further so a
      // capless Earth-class body's biome still doesn't crawl over its
      // arctic regions where photosynthetic life would be marginal.
      const float BIOME_LAT_MAX  = 0.85;
      const float BIOME_LAT_RAMP = 0.15;

      // Patchy-cloud worley cell pitch — equivalent disc-pixel pitch at
      // disc center. Cells live in sphere-projected (lon, lat) space the
      // same way SURFACE_PATCH_PX cells do, so cloud cells and surface
      // cells compress toward the limb together rather than the clouds
      // floating in a flat plane over a globe. CLOUD_LON_PX > CLOUD_LAT_PX
      // gives east-west stretch (zonal-flow direction) so silhouettes
      // read as wind-swept streaks rather than axis-aligned grid squares.
      const float CLOUD_LON_PX = 12.0;
      const float CLOUD_LAT_PX = 5.0;

      // Env-pixel width of the Bayer-dither fringe at cloud cell edges
      // (consumed by the cloud-layer loop). Fragments inside a firing
      // cell, within CLOUD_EDGE_DITHER_PX of the boundary to a non-firing
      // neighbor, stipple against the layer beneath; cell interiors stay
      // perfectly crisp. The fringe is what distinguishes cloud
      // silhouettes from same-tone surface (or same-tone deeper deck) —
      // a hard worley edge can otherwise disappear into a same-tone
      // neighbor and the cell reads as part of the underlying texture.
      const float CLOUD_EDGE_DITHER_PX = 1.5;

      // Heavy-haze surface dither (consumed by the haze-blanket block).
      // A saturated haze lerp otherwise flattens a surface body to a
      // featureless tinted disc (Venus / magma-ocean class); a small
      // ±HAZE_DITHER_AMP luminance jitter — Bayer ordered dither mixed
      // HAZE_DITHER_HASH_MIX toward a per-pixel hash so the 4×4 tile
      // doesn't read as a crosshatch — breaks the flat fill. Gated by
      // smoothstep(GATE_LOW, GATE_HIGH, hazeOpacity) so light-haze bodies
      // (Earth / Mars, visible surface texture) don't pick up a pattern
      // they don't need.
      const float HAZE_DITHER_AMP       = 0.06;
      const float HAZE_DITHER_GATE_LOW  = 0.3;
      const float HAZE_DITHER_GATE_HIGH = 0.7;
      const float HAZE_DITHER_HASH_MIX  = 0.4;

      // Outward atmospheric halo — paints OUTSIDE the disc, 0..3 px wide
      // driven by atmospheric column depth (see rimWidthFor* in
      // disc-palette/atmosphere.ts). No inward fade — the flat pixel aesthetic
      // doesn't want a soft gradient inside the disc edge.
      //
      // **Stroke-stacking model.** For a halo of width W, conceptually
      // we paint W concentric strokes — one of each width from W down
      // to 1 — each at the same base opacity. Layer L (counted from the
      // disc edge outward) is covered by (W - L) of those strokes, so
      // its effective alpha is 1 - (1 - alpha)^(W - L). The innermost layer
      // gets the most coverage (densest column at the limb); outer
      // layers fade naturally as fewer strokes overlap them. Computed
      // inline rather than actually painting W strokes — the math is
      // the closed form of multiple back-to-front blends.
      const float OUTER_BASE_ALPHA = 0.5;

      // Per-region primary/secondary/tertiary slot election. Aggregate
      // REGION_PATCH_FACTOR fine worley cells per axis into one super-
      // cell, then pickRegionSlots elects one DOMINANT palette slot
      // for the region (covering ~1-SECONDARY_COVERAGE of its cells), a
      // SECONDARY slot for sparse decoration, and a TERTIARY slot held
      // for the crater / linea reveal beneath. Net visual: each region
      // carries one of the body's archetype colors plus a sparse
      // second-archetype speckle — an iron-grey region with rust-
      // stained specks adjacent to a rust region with grey specks.
      //
      // The dominant/decoration split is load-bearing. A per-cell
      // random pick across multiple palette slots paints near-50/50
      // alternation between adjacent cells, which on barren bodies —
      // archetype slots collapsed toward similar mid-greys via the
      // abundance lerp in disc-palette/index.ts — reads as a hard
      // checkerboard at SURFACE_PATCH_PX cell pitch. Keeping each
      // region monochromatic-ish (~80% one slot) breaks the alternation
      // grain while preserving inter-region color variety.
      //
      // 6 → ~2-3 super-cells across the visible hemisphere of a 60-px
      // disc, the scale at which real planetary regional composition
      // dichotomies live (Ganymede's dark/light terrain, Mars's polar
      // plains vs. southern highlands, Mercury's regional albedo
      // patches). Inherits the fine worley pass's boundary
      // irregularity for free (super-cell edges are jittery, not
      // grid-aligned).
      const float REGION_PATCH_FACTOR = 6.0;
      // Fraction of cells inside a region that promote from primary to
      // secondary. 0.20 ≈ 1 in 5 cells; low enough that each region
      // reads as one dominant colour with sparse contrast rather than
      // checkerboard alternation.
      const float SECONDARY_COVERAGE = 0.20;

      // Phase 1.5c — discrete crater features + ejecta rays. Crater
      // seed cells are CRATER_PATCH_FACTOR × the fine worley cell
      // pitch in the same sphere-projected (lon, lat) frame as 1.5a/b.
      // Each cell may contain one impact crater whose existence
      // probability scales with (1 - surfaceAge)² (squared so age
      // drives crater density steeply — Mercury / Luna / Callisto
      // saturate while Earth-class bodies show only rare impacts,
      // matching the impact-rate decline over geologic time without
      // modeling it explicitly).
      //
      // Crater interior: solid paint from the SUBSURFACE mask — the
      // complement of the surface region's 1.5b bucket — so a metals-
      // surface region with rare-earth subsurface shows pink-grey
      // craters on a dark grey region. Surface features carry the
      // body's own resource palette without any new color attribute.
      // Solid-color paint deliberately preserved under the chunky
      // aesthetic — no rim/floor brightness variation to avoid the
      // muddy-shading regression that derailed 1.5b's first attempt.
      //
      // Ejecta rays: thin radial streaks emanating from craters,
      // modeling fresh-impact ray systems (Tycho on Luna, Hokusai on
      // Mercury, bright ray craters on Callisto). Per-crater
      // RAY_COUNT angular sectors hashed for existence; an
      // independent per-crater "individual age" hash drives ray
      // brightness so most craters carry no rays (old / eroded) and
      // a fraction carry bright streaks (fresh). Pixel-thin: ray
      // wedge tolerance scales as 1/dist so a ray stays ~1 px wide
      // at any distance from the crater. Rays paint ICE_COLOR
      // universally (same convention as the in-crater "fresh
      // exposed" paint on ancient icy bodies).
      //
      // Tuning targets:
      //   1.5 = each crater seed cell spans 1.5 fine cells (~6 px
      //         equivalent at disc center). Visible hemisphere of a
      //         60-px disc holds ~90 crater seed cells.
      //   0.85 = max existence probability at surfaceAge=0. With the
      //         (1-age)² scaling, Callisto at age=0.05 → 0.77 cells
      //         have craters; Earth at age=0.7 → 0.08 (rare); Io
      //         at age=1.0 → 0.
      //   [0.20, 0.7] = crater radius range in crater-cell-fraction
      //         units. MIN set so even the smallest crater paints at
      //         least a 2×2 px block at disc center (radius ≥ 1.2 px
      //         covers ≥4 fragments under worst-case pixel-grid
      //         alignment) — sub-pixel craters would render as single
      //         lost pixels or noise. Combined with cubic bias toward
      //         small (median rH³ ≈ 0.125), typical craters render
      //         at ~3 px diameter while rare big ones hit ~8 px. MAX
      //         kept ≤ 1.0 so crater interiors stay inside the 3×3
      //         inner containment check.
      //   7×7 scan = needed for the ray pass since per-crater max
      //         ray length is RAY_REACH_BIG_MUL × radius for the
      //         biggest craters, up to ~3.5 cell-units. Inner 3×3
      //         still bounds the crater interior check; outer rings
      //         only contribute rays.
      const float CRATER_PATCH_FACTOR = 1.5;
      const float CRATER_DENSITY_MAX  = 0.85;
      const float CRATER_RADIUS_MIN   = 0.20;
      const float CRATER_RADIUS_MAX   = 0.7;

      // Ejecta-ray parameters. Rays paint as solid full-strength
      // lines (no distance fade, no alpha attenuation) using the
      // same fill computation as the crater interior. The per-
      // crater age hash gates whether a crater has rays at all;
      // ray-bearing craters get a size-driven ray count (bigger
      // craters throw more rays) and per-ray length jitter so the
      // silhouette doesn't read as a perfectly symmetric starburst.
      //
      //   RAY_REACH_MIN_MUL / RAY_REACH_MAX_MUL / RAY_REACH_BIG_MUL
      //                       = per-ray length is hashed per (crater,
      //                         ray-index) and lerped in [MIN, max],
      //                         in crater-radius units. Each ray on
      //                         the same crater can be a different
      //                         length. The per-crater "max" linearly
      //                         scales between RAY_REACH_MAX_MUL (for
      //                         the smallest qualifying crater) and
      //                         RAY_REACH_BIG_MUL (for the biggest)
      //                         so larger impacts throw longer rays.
      //                         Sharp cutoff at the end (no fade).
      //                         BIG_MUL capped so max possible ray
      //                         reach (~3.5 cell-units) stays inside
      //                         the 7×7 scan window.
      //   RAY_AGE_THRESHOLD   = per-crater age hash ceiling. Crater
      //                         renders rays iff craterAgeH < this.
      //                         0.40 → ~2 in 5 qualifying craters
      //                         (those above RAY_MIN_RADIUS) bear a
      //                         fresh ray system.
      //   RAY_MIN_RADIUS      = crater-radius floor for ray
      //                         emission (in crater-cell-fraction
      //                         units). Tiny impacts don't throw
      //                         visible ray systems IRL (insufficient
      //                         ejecta velocity) and at our pixel
      //                         scale a sub-pixel ray reads as noise.
      //                         0.25 ≈ 1.5 px crater radius / 3 px
      //                         diameter at disc center — only
      //                         craters at or above the meaningful
      //                         visual threshold spawn ejecta.
      //   RAY_COUNT_MIN/MAX   = ray count range. Count is driven by
      //                         crater radius (linearly mapped from
      //                         radius range to [MIN, MAX]) — tiny
      //                         craters get the minimum, biggest
      //                         craters get MAX. MIN held at 3 so
      //                         no ray-bearing crater shows a single
      //                         stray streak.
      //   RAY_PIXEL_WIDTH     = ray line width in pixels. Thickness
      //                         in wedgeProg space scales inversely
      //                         with distance so the streak stays
      //                         this many px wide along its length.
      //   RAY_MIN_DISC_RADIUS = below this disc radius the pass is
      //                         skipped — 1 px-wide streaks on a
      //                         tiny moon read as noise.
      const float RAY_REACH_MIN_MUL   = 1.5;
      const float RAY_REACH_MAX_MUL   = 3.5;
      const float RAY_REACH_BIG_MUL   = 5.0;
      const float RAY_AGE_THRESHOLD   = 0.40;
      const float RAY_MIN_RADIUS      = 0.25;
      const float RAY_COUNT_MIN       = 3.0;
      const float RAY_COUNT_MAX       = 6.0;
      const float RAY_PIXEL_WIDTH     = 0.6;
      const float RAY_MIN_DISC_RADIUS = 12.0;
      const float TWO_PI              = 6.28318530;

      // Phase 1.5d — linea (Europa-style cracks). Paints subsurface
      // resource color along Voronoi cell boundaries (F2 − F1 worley
      // distance) where the body has young icy crust. Same layered
      // resource model as craters; only the geometry differs (line
      // features along cell edges instead of point features filling
      // disc cells).
      //
      //   LINEA_BODY_THRESHOLD = 0.5 — body-wide gate on
      //     iceFraction × surfaceAge. Sol anchors:
      //       Europa     0.85 × 0.85 ≈ 0.72  → linea fires
      //       Enceladus  0.95 × 0.95 ≈ 0.90  → linea fires
      //       Ganymede   0.60 × 0.30 ≈ 0.18  → suppressed
      //       Callisto   0.70 × 0.05 ≈ 0.035 → suppressed
      //       Earth      0.10 × 0.70 ≈ 0.07  → suppressed
      //   LINEA_WIDTH_FRAC = 0.18 — cell-fraction band along the cell
      //     boundary that paints as linea. Roughly 1.5 px wide at the
      //     SURFACE_PATCH_PX-pitch cell size.
      //   LINEA_DENSITY = 0.18 — fraction of cell edges promoted to
      //     linea. The remaining ~82% of edges stay invisible so the
      //     network reads as a thin crisscross rather than a tiled
      //     grid.
      const float LINEA_BODY_THRESHOLD = 0.5;
      const float LINEA_WIDTH_FRAC     = 0.18;
      const float LINEA_DENSITY        = 0.18;

      // ── Lava / molten-surface emission ──
      // Self-luminous incandescence composed onto the surface from two
      // physically distinct drives folded CPU-side into two scalars
      // (disc-palette/lava.ts): vMoltenCoverage (how much of the disc is molten)
      // and vEmissionTempNorm (normalized emission temperature → emberRamp).
      // Insolation-hot worlds get full coverage at the surface temperature;
      // tidally-heated bodies (Io) get sparse hot pools at intrinsic lava
      // temperature on an otherwise-cold crust. One model, no per-class
      // branch — coverage + temperature carry the whole range.
      //
      // The look is built in three tiers (matching how a real molten
      // surface reads), bottom to top:
      //   1. Cooled-lava crust — the whole molten surface is first tinted
      //      toward warm dusky basalt (LAVA_CRUST_COLOR), fading in with
      //      coverage. This is the chilled rock the surface freezes into
      //      between active features; it's what makes the non-glowing
      //      majority read "lava world" instead of generic dark regolith.
      //   2. Fissure network — thin cracks along F1/F2 cell boundaries
      //      (the same metric the linea pass uses), width growing with
      //      coverage². Most fissures are COOLED (dull dark-red, well below
      //      the body's peak melt temp); a sparse fraction (HOT_FRAC) are
      //      fresh and run at full temp, scattering bright streaks through
      //      the dull web.
      //   3. Caldera / lava lakes — sparse cells (per-cell hash < coverage²
      //      so they read as a handful of volcanic centers, not a rash),
      //      with an incandescent core that runs slightly ABOVE the body's
      //      mean emission temp (a fresh lake exposes the hottest interior
      //      melt) and cools to the rim.
      // meltSoft = max(crack, pool) decides which fragments are molten at
      // all; it's binarized against a Bayer threshold so the molten/solid
      // boundary stipples pixel-crisp, and a step() floor keeps the crust
      // between features exactly solid (no stray glow speckle). The local
      // emission temperature is chosen per tier (pool core hot → fissure
      // dull) and fed to emberRamp.
      //
      // The emissive (post-lighting additive) is raised to LAVA_EMISSIVE_
      // FOCUS so it concentrates on the hottest fragments — dull cooled
      // fissures sit just above the crust without blooming, while caldera
      // cores punch bright and survive the reflectance lighting pass.
      // Salts: SALT_LAVA_POOL_* (calderas), SALT_LAVA_CRACK_HOT (per-
      // fissure hot/cool). See the hash-salt budget block.
      const float LAVA_CRACK_WIDTH_MIN = 0.04;
      // Capped well below 1.0 so even a fully-molten world keeps the fissure
      // network reading as a NETWORK over a partly-visible dusky crust,
      // rather than one saturated melt tone flooding the whole disc. The
      // "more molten" read at high coverage comes from denser/larger lava
      // lakes (the coarse pool grid below) and a hotter ember, not from the
      // cracks swallowing the crust.
      const float LAVA_CRACK_WIDTH_MAX = 0.55;
      const float LAVA_POOL_RADIUS     = 0.7;
      // Bloom: pow(FOCUS) gates it to the hot fragments (dusky crust /
      // cool fissures stay un-bloomed so the base reads in-palette), GAIN
      // sets the hot-accent glow strength, and the (1 - localNorm·FALLOFF)
      // term trims it back at the very top so white-hot cores don't clip.
      const float LAVA_EMISSIVE_GAIN   = 0.55;
      const float LAVA_EMISSIVE_FOCUS  = 2.0;
      const float LAVA_EMISSIVE_FALLOFF = 0.3;
      // Cap on the fraction of coarse cells that become lava lakes, so even
      // a fully-molten world keeps a dusky crust majority with vivid lakes
      // as the accent (rather than orange flooding the whole disc). The
      // "hotter" read at high temp comes from the ember color + bloom on
      // those lakes, not from lakes covering everything.
      const float LAVA_POOL_MAX_COVER  = 0.5;
      // Caldera grid coarseness, in fine-surface-worley-cell units, lerped
      // by coverage: a barely-melted body gets modest lakes, a near-fully-
      // molten one gets large coherent lakes (big magma pools between dark
      // crust islands) instead of per-cell confetti.
      const float LAVA_POOL_PATCH_MIN = 2.0;
      const float LAVA_POOL_PATCH_MAX = 4.0;
      // Cooled-lava crust — warm dusky basalt the molten surface freezes
      // into. Tint fades in over [0, LAVA_CRUST_TINT_COV] coverage so a
      // barely-melted hot world keeps its native palette.
      const vec3  LAVA_CRUST_COLOR    = vec3(0.34, 0.20, 0.21);
      const float LAVA_CRUST_TINT_MAX = 0.80;
      const float LAVA_CRUST_TINT_COV = 0.40;
      // Fissures are COOLED exposed boundaries — dull dark-red at this
      // fraction of the body's emission temp; LAVA_CRACK_HOT_FRAC of them
      // are fresh/active and glow at full temp instead.
      const float LAVA_CRACK_TEMP_MUL = 0.42;
      const float LAVA_CRACK_HOT_FRAC = 0.18;
      // Caldera core boost — fraction of the REMAINING temperature headroom
      // (1 - emitNorm) the lake core adds above the body mean, so a dim body
      // (Io) gets a strong orange pop while a near-white-hot body barely
      // lifts (avoids blowing caldera cores out to white-yellow). Additive
      // in norm-space, scaled by poolCore so the lake center is hottest.
      const float LAVA_POOL_CORE_BOOST = 0.30;
      // Composition hue nudge — sulfurous volcanism (Io's SO2/sulfate
      // surface, sampled per-body in LAVA_TINT_TEXEL_OFFSET.r) lifts the
      // ember's GREEN channel proportional to its red, shifting orange →
      // yellow (R high + G lifted, B untouched) rather than washing toward
      // white. GREEN_LIFT is the per-unit-red lift; STRENGTH scales the
      // whole effect by the body's sulfur fraction. A silicate-vapor lava
      // world (no sulfur) is untouched and stays red-orange.
      const float LAVA_SULFUR_GREEN_LIFT = 0.5;
      const float LAVA_SULFUR_STRENGTH   = 0.85;

      // ── Body lighting ──
      // Pixel-art colored highlight arc keyed off the in-scene star disc
      // positions (see MAX_LIGHTS in ./chunks + StarsRowLayer.
      // getLightSources). The body is treated as a sphere — un-inset
      // normal N = (d.x/r, d.y/r, sqrt(1 − …)) covers the full visible
      // hemisphere, no SPHERE_VISIBLE_FRAC inset because we want the
      // lit zone to extend cleanly to the disc edge rather than pinch
      // off like the surface worley cells do. vTilt is intentionally
      // not applied — light comes from screen-space star positions,
      // not the body's spin frame, so the lit side stays anchored to
      // the geometric subsolar direction regardless of axial tilt.
      //
      // Per-light lambert:
      //   dir2d = normalize(starPos − vCenter)
      //   L     = normalize(vec3(dir2d, LIGHT_Z_BIAS))
      //   λ_i   = max(0, dot(N, L)) × intensity_i
      //
      // LIGHT_Z_BIAS pushes the light source AWAY from the viewer (into
      // the screen, behind the body) so the lit hemisphere faces away
      // from us — and we only see the thin sliver of it that wraps
      // around the limb on the star-facing side. Reads as "star is far
      // in the distance behind the bodies" rather than "lamp suspended
      // overhead." Negative because the disc normal's z-component is
      // forward-facing (+z = toward viewer); a negative L.z makes dot(N,L)
      // peak at the limb (where N.z ≈ 0 and N.xy aligns with L.xy)
      // and trough at the disc center (where N = (0,0,1) is anti-
      // parallel to L). Magnitude controls crescent thickness — more
      // negative = thinner, almost edge-on rim; closer to 0 = thicker
      // crescent reaching deeper toward disc center.
      //
      // Compositing: two bands, dithered against bayer4 so transitions
      // stipple rather than ring. LIT band adds a per-light-color tint
      // (weighted-average hue across all stars). HOT band stacks an
      // additional brightness boost on the brightest crescent tip.
      // Unlit fragments pass through untouched. The LIGHT_* constants +
      // applyStarCrescent come from ./chunks (inserted with bayer4 below).

      // ── Atmospheric loft glow ──
      // The outward rim halo (the puffy atmosphere lofted past the limb)
      // glows with the host star's color filtered through the gas's own
      // hue, brightest on the star-facing limb and dim on the night side.
      // Geometry is purely angular — the rim has no surface normal, so we
      // compare each rim fragment's outward direction (normalize(d)) to
      // the screen-space direction toward each star. A HALF-LAMBERT wrap
      // (dot × 0.5 + 0.5) is used rather than a clamped max(0, dot): the
      // lofted atmosphere is lit by forward-scattered starlight that
      // wraps around the whole limb when the body is backlit, so the glow
      // must extend PAST the terminator and reach well into the night-
      // side rim — further around than the disc-interior surface crescent
      // (which uses a clamped lambert and dies at the terminator). The
      // wrap is 1 on the star-facing limb, 0.5 at the terminator, and
      // tapers toward 0 at the anti-solar point. RIM_GLOW_FOCUS (a power
      // > 1) then steepens that taper so the glow reaches a bit past the
      // terminator and fades out, rather than carrying all the way around
      // to the night-side limb.
      //
      // Color model (multiplicative — the naturalistic core): the
      // atmosphere scatters incident starlight filtered through its own
      // gas color, so the lit hue is vRimColor × uLightColor. A
      // white/cream star leaves the gas hue INTACT (Titan stays orange);
      // a red dwarf warms it; a blue star cools it — the light modulates
      // the atmosphere's color rather than replacing it. Because both
      // inputs are ≤ 1 the product never clips, so the gas character is
      // preserved. Critically the glow's STRENGTH comes from alpha +
      // extent (below), NOT from over-driving the color: a large
      // RIM_GLOW_GAIN clips the dominant channels to 1.0, equalizes them,
      // and bleaches the hue toward the raw star white — exactly the wash
      // we're avoiding. Keep RIM_GLOW_GAIN modest (a touch over 1 for a
      // gentle luminous lift).
      //
      // The one star-colored term is RIM_TIP_WHITE: a small white
      // forward-scatter highlight gated to the very brightest sunward
      // sliver via pow(lit, RIM_TIP_FOCUS), so the extreme limb catches a
      // bright-edge pop (as on real backlit hazes) without bleaching the
      // rest of the arc. Set RIM_TIP_WHITE = 0 for a pure gas×light glow.
      //
      // mix() runs from vRimColor (the gas's own color, shown on the deep
      // night limb) toward that illuminated hue by the per-fragment lit
      // factor.
      //
      // Alpha: the existing radial stack falloff is multiplied by an
      // angular term that ramps from RIM_DARK_FLOOR (faint night-side
      // ambient band — the atmosphere is still there, just unlit) to 1.0
      // on the lit limb. Dithered against bayer4 so the angular fade
      // stipples instead of feathering (pixel-crisp aesthetic).
      const float RIM_GLOW_FOCUS   = 2.0;
      const float RIM_GLOW_GAIN    = 1.25;
      const float RIM_TIP_WHITE    = 0.35;
      const float RIM_TIP_FOCUS    = 5.0;
      const float RIM_DARK_FLOOR   = 0.15;
      const float RIM_DITHER_WIDTH = 0.10;

      // ── Rayleigh hue shift through the lofted column ──
      // The lofted atmosphere progressively re-tints the glow toward the
      // Rayleigh-scattered hue with COLUMN DEPTH — strongest in the
      // outermost loft layer, weakest at the inner edge (a 1-px loft gets
      // the full single-layer shift). This is a HUE-ONLY operator: it
      // never changes the glow's brightness or opacity. Brightness is held
      // by renormalizing the shifted color back to the base color's
      // luminance (so mixing toward it preserves luminance exactly, since
      // luminance is linear in the channels), and the alpha is left
      // untouched — it only rotates the color.
      //
      // The target hue is the body's PER-GAS scatter color (vScatterColor,
      // sampled from the per-body texture; the frac×SCATTERING_POTENCY
      // blend computed in disc-palette/atmosphere.ts — N2/O2 blue, CO2 cool-grey, CH4
      // cyan, SO2 yellow) re-illuminated by the STARLIGHT. So it's dynamic
      // to BOTH: the gas sets the scatter hue, the star sets the incident
      // spectrum — a white/blue star yields a vivid fringe, a red dwarf a
      // dim grey-violet one. The per-body Rayleigh FRACTION (vWeights.w)
      // scales the shift so clear-air bodies (Earth) shift strongly while
      // absorption- / aerosol-dominated ones (Venus) barely move.
      // RIM_RAYLEIGH_STRENGTH is a global trim on top of that per-body
      // amount; set it to 0 to disable the hue shift.
      const float RIM_RAYLEIGH_STRENGTH = 1.0;

      // ── Hash-salt budget ──
      // Every per-body hash salt lives here so the whole budget is grep-able
      // in one place and a collision (two passes sharing a pair) is visible at
      // a glance — the doc-only budget in PLANET-RENDER-PLAN.md couldn't catch
      // a silent reuse. Each SALT_* is the (x, y) offset pair added to a cell
      // before its two decorrelated jitter hashes; call sites multiply it by
      // the per-body vSeed (or, in pickRegionSlots, the seed param) so each
      // body re-rolls independently. The LAYER_SALT_* pairs fold the per-deck
      // layerSeed into the cloud hashes so each deck's cells differ.
      //
      // The crater set deliberately reuses 547/569/587 across existence,
      // jitter X/Y, and radius as distinct ORDERED pairs — distinct ordered
      // pairs still decorrelate, and 5 draws needed more pairs than 547/569
      // alone gave. The paint pass (crater interior + ray fill) re-derives a
      // crater's center, so it reuses SALT_CRATER_JITTER_X/_Y by design.
      const vec2 SALT_SURFACE_JITTER_A = vec2(13.0, 19.0);
      const vec2 SALT_SURFACE_JITTER_B = vec2(23.0, 29.0);
      const vec2 SALT_CONTINENT        = vec2(113.0, 127.0);
      const vec2 SALT_COAST_DITHER     = vec2(257.0, 379.0);
      const vec2 SALT_BIOME_STIPPLE    = vec2(197.0, 311.0);
      const vec2 SALT_CAP_JITTER       = vec2(233.0, 239.0);
      const vec2 SALT_ICE_PRIORITY     = vec2(701.0, 719.0);
      const vec2 SALT_REGION_PRIMARY   = vec2(401.0, 419.0);
      const vec2 SALT_REGION_SECONDARY = vec2(431.0, 433.0);
      const vec2 SALT_RESOURCE_PICK    = vec2(1009.0, 2017.0);
      const vec2 SALT_CRATER_EXIST     = vec2(547.0, 569.0);
      const vec2 SALT_CRATER_JITTER_X  = vec2(587.0, 547.0);
      const vec2 SALT_CRATER_JITTER_Y  = vec2(569.0, 587.0);
      const vec2 SALT_CRATER_RADIUS    = vec2(569.0, 547.0);
      const vec2 SALT_CRATER_AGE       = vec2(631.0, 641.0);
      const vec2 SALT_RAY_ANGLE        = vec2(653.0, 659.0);
      const vec2 SALT_RAY_PERRAY       = vec2(677.0, 683.0);
      const vec2 SALT_LINEA_EDGE       = vec2(743.0, 761.0);
      const vec2 SALT_LAVA_CRACK_HOT   = vec2(853.0, 857.0);
      const vec2 SALT_LAVA_POOL_JIT_A  = vec2(859.0, 863.0);
      const vec2 SALT_LAVA_POOL_JIT_B  = vec2(877.0, 881.0);
      const vec2 SALT_LAVA_POOL_EXIST  = vec2(883.0, 887.0);
      const vec2 SALT_CLOUD_JITTER_A   = vec2(991.0, 997.0);
      const vec2 SALT_CLOUD_JITTER_B   = vec2(1013.0, 1019.0);
      const vec2 SALT_CLOUD_EXIST      = vec2(1031.0, 1033.0);
      const vec2 LAYER_SALT_CLOUD_JIT_A = vec2(13.0, 17.0);
      const vec2 LAYER_SALT_CLOUD_JIT_B = vec2(19.0, 23.0);
      const vec2 LAYER_SALT_CLOUD_EXIST = vec2(29.0, 31.0);
      const float SALT_BAND_LIGHTNESS  = 67.0;
      const float LAYER_SALT_BAND      = 13.0;

      ${HASH_GLSL}

      // 4x4 Bayer matrix lookup keyed on env-pixel coords, returns
      // value in {0/16, 1/16, ..., 15/16}. Built recursively from the
      // 2x2 pattern [[0,2],[3,1]] — closed-form (x*2 + y*3 - x*y*4)
      // for (x,y) ∈ {0,1}², no branches, no texture lookup. Used as
      // an ordered-dither threshold against per-cell coverage gates
      // so cells whose hash lands near the threshold render stippled
      // rather than binary-fire.
      ${BAYER4_GLSL}
      ${STAR_CRESCENT_LIGHTING_GLSL}

      // Worley F1/F2 cell scan over the 3×3 neighborhood. For a fragment
      // at cellFrac within integer cell cellId, finds the nearest (F1)
      // and second-nearest (F2) jittered cell centers and returns their
      // squared distances (d1 ≤ d2) and owning cell ids by out-param.
      // saltA/saltB are the per-pass hash-salt offsets added to each
      // candidate cell before its two jitter hashes (two decorrelated
      // seeds → two salts); the caller folds any per-layer salt in. The
      // closest two cells to any interior fragment are always inside the
      // 3×3 neighborhood, so the scan is exhaustive. One body for the
      // three identical scans — surface (1.5a), cloud decks, and lava
      // calderas (which read only F1) — so the cell math can't drift.
      void worleyF1F2(vec2 cellId, vec2 cellFrac, vec2 saltA, vec2 saltB,
                      out vec2 f1cell, out vec2 f2cell, out float d1, out float d2) {
        d1 = 1e9;
        d2 = 1e9;
        f1cell = cellId;
        f2cell = cellId;
        for (int dx = -1; dx <= 1; dx++) {
          for (int dy = -1; dy <= 1; dy++) {
            vec2 off = vec2(float(dx), float(dy));
            vec2 nCell = cellId + off;
            vec2 jitter = vec2(
              hash21(nCell + saltA),
              hash21(nCell + saltB)
            );
            vec2 nCenter = off + jitter;
            vec2 diff = nCenter - cellFrac;
            float dd = dot(diff, diff);
            if (dd < d1) {
              d2 = d1;
              f2cell = f1cell;
              d1 = dd;
              f1cell = nCell;
            } else if (dd < d2) {
              d2 = dd;
              f2cell = nCell;
            }
          }
        }
      }

      // Elect a region's (primary, secondary, tertiary) palette slots.
      // Primary and secondary are weighted draws against weights;
      // secondary samples from the non-primary slots only. Tertiary is
      // the leftover index in {0,1,2}. Degenerates to (0,0,0) for the
      // (1,0,0) flat-fill weight case so a 1-slot body collapses
      // cleanly.
      //
      // Salts: SALT_REGION_PRIMARY / SALT_REGION_SECONDARY. This election
      // re-runs for the crater-paint reveal below (same regionCell math),
      // keeping the seed map stable across the surface + crater passes.
      ivec3 pickRegionSlots(vec2 regionCell, vec3 weights, float seed) {
        float wT = weights.x + weights.y + weights.z;
        if (wT <= 0.0) return ivec3(0, 0, 0);
        float pH = hash21(regionCell + seed * SALT_REGION_PRIMARY);
        float t = pH * wT;
        int primary;
        if      (t < weights.x)              primary = 0;
        else if (t < weights.x + weights.y)  primary = 1;
        else                                 primary = 2;
        vec3 secW = weights;
        if      (primary == 0) secW.x = 0.0;
        else if (primary == 1) secW.y = 0.0;
        else                   secW.z = 0.0;
        float wT2 = secW.x + secW.y + secW.z;
        int secondary = primary;
        if (wT2 > 0.0) {
          float sH = hash21(regionCell + seed * SALT_REGION_SECONDARY);
          float t2 = sH * wT2;
          if      (t2 < secW.x)            secondary = 0;
          else if (t2 < secW.x + secW.y)   secondary = 1;
          else                             secondary = 2;
        }
        int tertiary = (secondary == primary) ? primary : (3 - primary - secondary);
        return ivec3(primary, secondary, tertiary);
      }

      // Rec.709 relative luminance — used by the Rayleigh rim hue shift
      // to renormalize the re-tinted color back to the base brightness.
      float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      // Look up a palette slot by index.
      vec3 slotColor(int idx, vec3 p0, vec3 p1, vec3 p2) {
        if (idx == 0) return p0;
        if (idx == 1) return p1;
        return p2;
      }

      // Incandescent color ramp keyed on normalized emission temperature
      // t ∈ [0,1] (0 ≈ 800 K Draper point — dull cherry; 1 ≈ 2400 K — gold-
      // orange). Piecewise mix through the heat spectrum a molten silicate
      // surface traverses: cherry → red → red-orange → orange → gold. The
      // hot end is deliberately held at gold-orange rather than the true
      // white-yellow of a 2400 K blackbody — a fully-white-hot disc reads as
      // "bleached" rather than "molten" under the chunky aesthetic, so we
      // keep lava firmly in the red→gold band. Hand-tuned anchors rather
      // than an exact Planck
      // locus — they read as "lava" under the chunky aesthetic, and with
      // color management OFF the sRGB-coded values feed straight through.
      // At t = 0 the ramp is dark-but-nonzero so the very coolest molten
      // fragments still glow faintly; a body whose emission temperature
      // never reaches the Draper floor maps to vEmissionTempNorm = 0 AND
      // moltenCoverage ≈ 0 (both vanish together below ~800 K), so this is
      // only ever evaluated where something is genuinely incandescent.
      vec3 emberRamp(float t) {
        t = clamp(t, 0.0, 1.0);
        // Split character: the COOL end (crust / dull fissures — the
        // dominant area of the disc) is desaturated and dusky so the base
        // sits in the same low-chroma family as the rest of the palette;
        // the HOT end (lake cores, fresh fissures — the sparse accents)
        // re-saturates into vivid orange so the molten features actually
        // read as molten, not painted rock. The glowing pop on the hot end
        // is finished by the emissive bloom (which is gated to hot
        // fragments), so a pure-red wash never dominates the disc.
        vec3 c0 = vec3(0.28, 0.13, 0.11);  // ~800 K  dusky ember-brown
        vec3 c1 = vec3(0.50, 0.21, 0.15);  // ~1100 K dusky brick red
        vec3 c2 = vec3(0.82, 0.33, 0.10);  // ~1500 K vivid orange-red
        vec3 c3 = vec3(0.98, 0.50, 0.15);  // ~1900 K vivid orange
        vec3 c4 = vec3(1.00, 0.72, 0.32);  // ~2400 K bright gold
        if (t < 0.25) return mix(c0, c1, t / 0.25);
        if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
        if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
        return mix(c3, c4, (t - 0.75) / 0.25);
      }

      // ── Lava emission ── (see the LAVA_* constant block + emberRamp)
      // Composes a molten incandescent surface onto the crust. Coexists
      // with the passes above without a gate: a molten body has
      // surfaceAge ≈ 1 → no craters, and iceFrac = 0 → no linea/ice, so
      // the field is clear exactly where lava belongs. The
      // emitNorm > 0 guard is the Draper-point floor: a body whose
      // emission temperature never reaches ~800 K (a warm-but-solid
      // world, or a cryovolcanic body whose vent material is cold)
      // never paints, regardless of how much coverage it carries.
      vec3 lavaPass(vec3 col, float lon, float lat, float vBodyV,
                    float minDist2, float secondMinDist2, vec2 winnerCell, vec2 secondCell,
                    out vec3 lavaEmissive) {
        lavaEmissive = vec3(0.0);
        if (vMoltenCoverage > 0.0 && vEmissionTempNorm > 0.0) {
          // Tier 1 — cooled-lava crust backdrop. Warm the whole molten
          // surface toward dusky basalt, fading in with coverage so a
          // barely-melted hot world keeps its native palette. Molten
          // features paint over this below.
          float crustTint = LAVA_CRUST_TINT_MAX * smoothstep(0.0, LAVA_CRUST_TINT_COV, vMoltenCoverage);
          col = mix(col, LAVA_CRUST_COLOR, crustTint);

          // Tier 2 — fissure network. Distance to the F1/F2 cell boundary,
          // widened by coverage² toward LAVA_CRACK_WIDTH_MAX (capped well
          // below 1 so the web never floods the disc). The square keeps
          // low-coverage bodies (Io, magma ocean) as hairline fissures
          // while a hot world gets a denser web (lavaEdge only reaches
          // ~0.3-0.5 at cell centers, so a linear ramp would over-fill).
          float lavaEdge = sqrt(secondMinDist2) - sqrt(minDist2);
          float crackW   = mix(LAVA_CRACK_WIDTH_MIN, LAVA_CRACK_WIDTH_MAX, vMoltenCoverage * vMoltenCoverage);
          float crack    = 1.0 - smoothstep(crackW * 0.5, crackW, lavaEdge);
          // Per-fissure hot/cool class, keyed on the shared edge cell so a
          // whole segment is one temperature (not per-pixel noise). Most
          // fissures are cooled (dull); a sparse fraction run fresh/hot.
          vec2  edgeKey      = winnerCell + secondCell;
          float crackHotH    = hash21(edgeKey + vSeed * SALT_LAVA_CRACK_HOT);
          float crackTempMul = (crackHotH < LAVA_CRACK_HOT_FRAC) ? 1.0 : LAVA_CRACK_TEMP_MUL;

          // Tier 3 — calderas / lava lakes on a COARSER grid than the fine
          // surface worley (patch grows with coverage), so lakes read as a
          // few coherent pools rather than per-cell confetti — and a near-
          // fully-molten world becomes large lava lakes between dark crust
          // islands instead of speckle. Uses the shared worleyF1F2 scan in
          // the coarse frame (F1 only — the lake cell that contains the
          // fragment) for round blobby lakes. Sparse cells (coverage²) so
          // they read as a handful of volcanic centers; core hotter than
          // the rim via distance to the coarse cell center. Salts
          // SALT_LAVA_POOL_JIT_A/_B (jitter), SALT_LAVA_POOL_EXIST.
          float poolPatch = SURFACE_PATCH_PX * mix(LAVA_POOL_PATCH_MIN, LAVA_POOL_PATCH_MAX, vMoltenCoverage);
          vec2  pCellPos  = vec2(lon, lat) * vRadius / poolPatch;
          vec2  pCellId   = floor(pCellPos);
          vec2  pFrac     = pCellPos - pCellId;
          float pBestD2, pIgnoreD2;
          vec2  pWinner, pIgnoreCell;
          worleyF1F2(pCellId, pFrac,
                     vSeed * SALT_LAVA_POOL_JIT_A, vSeed * SALT_LAVA_POOL_JIT_B,
                     pWinner, pIgnoreCell, pBestD2, pIgnoreD2);
          float poolH    = hash21(pWinner + vSeed * SALT_LAVA_POOL_EXIST);
          float isPool   = step(poolH, min(vMoltenCoverage * vMoltenCoverage, LAVA_POOL_MAX_COVER));
          float poolDist = sqrt(pBestD2);
          float poolCore = 1.0 - smoothstep(0.0, LAVA_POOL_RADIUS, poolDist);
          float pool     = isPool * poolCore;

          // Presence (which fragments are molten) — binarized against a
          // Bayer threshold for a pixel-crisp edge; the step(0.001, …)
          // floor keeps the crust between features exactly solid.
          float meltSoft = max(crack, pool);
          float bLava    = bayer4(gl_FragCoord.xy + vec2(53.0, 19.0));
          float meltBin  = step(0.001, meltSoft) * step(bLava, meltSoft);
          if (meltBin > 0.0) {
            // Temperature per tier: a caldera (where present) wins with
            // its core-boosted hot norm; otherwise the fissure norm
            // (dull, unless this segment hashed hot).
            float poolNorm  = min(1.0, vEmissionTempNorm + LAVA_POOL_CORE_BOOST * (1.0 - vEmissionTempNorm) * poolCore);
            float crackNorm = vEmissionTempNorm * crackTempMul;
            float localNorm = (pool >= crack) ? poolNorm : crackNorm;
            vec3  ember     = emberRamp(localNorm);
            // Composition hue nudge — sulfurous volcanism reads yellower.
            // Lift green proportional to red so orange → yellow without
            // bleaching toward white; scaled by the body's sulfur frac.
            float sulfurU    = (float(${LAVA_TINT_TEXEL_OFFSET}) + 0.5) / float(${BODY_TEXTURE_WIDTH});
            float sulfurFrac = texture2D(uCloudLayerData, vec2(sulfurU, vBodyV)).r;
            if (sulfurFrac > 0.0) {
              vec3 sulfurEmber = clamp(ember + vec3(0.0, ember.r * LAVA_SULFUR_GREEN_LIFT, 0.0), 0.0, 1.0);
              ember = mix(ember, sulfurEmber, sulfurFrac * LAVA_SULFUR_STRENGTH);
            }
            // Molten material fully obscures the crust beneath (solid
            // replace, matching the crater-interior convention).
            col = ember;
            // Emissive lifts molten zones above the reflectance crescent.
            // pow(focus) keeps dull fissures from blooming; the (1 -
            // localNorm·falloff) term then tapers the bloom back DOWN at
            // the hot end, where the ember is already bright and extra
            // additive would only clip the channels toward white.
            lavaEmissive = ember * LAVA_EMISSIVE_GAIN
                         * pow(localNorm, LAVA_EMISSIVE_FOCUS)
                         * (1.0 - localNorm * LAVA_EMISSIVE_FALLOFF);
          }
        }
        return col;
      }

      // Surface (or atm-column) base color for one fragment. Composes the
      // full terrestrial surface stack — worley patches, ice/cap regime,
      // ocean + coastal fringe, region palette election, biome stipple,
      // craters + ejecta rays, linea, and molten lava — for surface bodies
      // (vSurfaceOpacity > 0.5), or paints the gas/ice-giant atm column for
      // the rest. lavaEmissive returns the self-luminous lava contribution
      // (zero off molten bodies) for the caller to add back after lighting.
      // The sphere-projection locals (d/lxs/lys/lon/lat) and per-body texture
      // samples (ocean / atm-column color, body-row v) come from main();
      // everything else reads from varyings/uniforms in scope.
      vec3 surfaceColor(vec2 d, float lxs, float lys, float lon, float lat,
                        vec3 vOceanColor, vec3 vAtmColumnColor, float vBodyV,
                        out vec3 lavaEmissive) {
        lavaEmissive = vec3(0.0);
        vec3 col;
        if (vSurfaceOpacity > 0.5) {
          // Latitude for cap / biome tests uses the un-inset projection
          // so the visible disc rim covers the true sphere pole. The
          // worley pass above wants the inset to bound cell foreshortening
          // (cells pinch to nothing at the true limb), but the cap test
          // wants |latSinDisc| to reach 1 at the disc edge along the
          // band-aligned pole — otherwise small-iceFrac caps (Earth ~0.05,
          // Mars ~0.03) fall under the visible-latitude ceiling and clip
          // entirely. Computed from unscaled (nx, ny, nz) for that reason.
          float nx = lxs / vRadius;
          float ny = lys / vRadius;
          float nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
          float latSinDisc = ny * POLE_COS + nz * POLE_SIN;

          // Surface — sphere-projected worley/voronoi cells (1.5a).
          // Cell space is (lon, lat), scaled by vRadius / SURFACE_PATCH_PX
          // so disc-center cells stay at SURFACE_PATCH_PX while cells
          // toward the limb compress along the foreshortening curve.
          // The disc reads as a globe — features near the limb shrink
          // and elongate parallel to the horizon exactly as on a real
          // sphere — without paying any per-feature projection cost
          // beyond the asin+atan above. Salted by vSeed so two same-
          // palette planets get distinct patch layouts. 9 candidate
          // cells (3x3 neighborhood) is the minimum needed for correct
          // nearest-cell when centers are jittered within the full
          // unit cell.
          vec2 cellPos = vec2(lon, lat) * vRadius / SURFACE_PATCH_PX;
          vec2 cellId  = floor(cellPos);
          vec2 cellFrac = cellPos - cellId;
          // Track F1 (closest) AND F2 (second-closest) cells. The F2-F1
          // worley distance is the cell-boundary distance the 1.5d linea
          // pass draws cracks along. Salts SALT_SURFACE_JITTER_A/_B.
          float minDist2, secondMinDist2;
          vec2  winnerCell, secondCell;
          worleyF1F2(cellId, cellFrac,
                     vSeed * SALT_SURFACE_JITTER_A, vSeed * SALT_SURFACE_JITTER_B,
                     winnerCell, secondCell, minDist2, secondMinDist2);

          // Phase 1.6 — ice is a contextual surface state composed onto
          // the body's bulk surface, not its own latitude-band override.
          // Three things drive the per-fragment composition:
          //   icyHere           — does ice cover this fragment? Decided
          //     by mixing a cap-latitude priority and a per-cell hash
          //     priority via vGlobalness (warm → cap pattern; cold →
          //     global random pattern; in between → hybrid).
          //   resourceSurface   — the body's bulk character at this
          //     fragment: ocean (waterFrac cell) or 1.5b region-masked
          //     resource pick (+ biome stipple).
          //   resourceSubsurface — the 1.5c complement-masked resource
          //     pick, used by the crater branch as "what's underneath."
          // Layer order is keyed off vSurfaceAge:
          //   young (high age) → ice on top, resource below.
          //   old   (low age)  → resource on top (regolith), ice below.
          // Continuous lerp so a mid-age body mixes both reads.

          // Two physically distinct ice geometries, partitioned by
          // vGlobalness:
          //   Cap pattern (warm / transitional bodies, globalness <
          //     CAP_GLOBALNESS_MAX) — surface deposit at high latitude.
          //     Earth's water-ice caps, Mars's seasonal CO2 + water
          //     polar caps. Independent of bulk surface composition;
          //     paints pure ICE_COLOR (bypasses the surfaceAge blend
          //     used by the global path below).
          //   Global pattern (cold bodies, globalness ≥ CAP_GLOBALNESS_MAX)
          //     — bulk cryosphere. Europa, Triton, Callisto. Random
          //     scattered cells with effectiveIceFrac ramping to 1.0 at
          //     extreme cold; surfaceAge controls how much ice sits on
          //     top vs buried under regolith.
          //
          // The partition lines up with frozenBoost's smoothstep, so a
          // body is either fully in the cap regime (frozenBoost=0) or
          // moving into the global regime (frozenBoost > 0). Salts
          // SALT_ICE_PRIORITY.
          bool  capActive      = vGlobalness < CAP_GLOBALNESS_MAX;
          // Per-cell threshold jitter so the cap boundary follows the
          // worley grid's jittered shapes instead of reading as a clean
          // foreshortened ellipse. Cells near the boundary go in or out
          // by hash; cells well inside / outside are unaffected. Amplitude
          // scales with iceFrac so Mars's tiny cap (iceFrac 0.02) gets a
          // ~±0.01 wobble while Earth's larger cap (iceFrac 0.10) gets
          // ~±0.05 — clamped to keep very-small caps visible and very-
          // large caps from dissolving into noise. Salts SALT_CAP_JITTER.
          float capJitterH    = hash21(winnerCell + vSeed * SALT_CAP_JITTER);
          float capJitterAmp  = clamp(vIceFrac * 0.6, 0.01, 0.08);
          float capJitter     = (capJitterH - 0.5) * 2.0 * capJitterAmp;
          bool  capIcyHere    = capActive && (abs(latSinDisc) + capJitter) > (1.0 - vIceFrac);
          float cellHashIce    = hash21(winnerCell + vSeed * SALT_ICE_PRIORITY);
          // Cold bodies push iceFrac toward 1.0 (Europa-class: cold AND
          // water-bearing → full shell rather than polar caps). Gated on
          // vIceFrac > 0 so the boost doesn't fabricate ice on a cold
          // body that has none in its composition — Io (lava class,
          // 110 K, iceFraction=0) would otherwise render as a solid
          // ICE_COLOR disc because the cold-→global rule overrode its
          // actual zero ice content.
          float frozenBoost    = smoothstep(CAP_GLOBALNESS_MAX, 1.0, vGlobalness) * step(0.01, vIceFrac);
          float effectiveIceFrac = mix(vIceFrac, 1.0, frozenBoost);
          bool  globalIcyHere  = !capActive && cellHashIce > (1.0 - effectiveIceFrac);
          bool  icyHere        = capIcyHere || globalIcyHere;

          // CONTINENT_GROUP-sized blocks of worley cells share one
          // ocean/land coin flip. Salt offset from the resource-pick
          // hash so the two scales decorrelate. The ocean override
          // only fires on bodies warm enough for liquid surface
          // liquid — on a cold body (vGlobalness > 0.5, T < ~225 K),
          // water exists but as ice, so "water cells" fall back to
          // the resource palette (which on a volatile-rich body like
          // Europa reads as pale-ice colored anyway). This keeps the
          // ocean tint from punching through the ice shell on
          // cryogenic moons whose surface is globally frozen; the
          // linea pass below carries the non-ice signal on those
          // bodies.
          vec2 contCell = floor(winnerCell / CONTINENT_GROUP);
          vec2 contSalt = vSeed * SALT_CONTINENT;
          float contH = hash21(contCell + contSalt);
          bool  waterHere = contH < vWaterFrac;
          bool  liquidOceanHere = waterHere && vGlobalness < 0.5;

          // Coastal fringe. Only the worley cells AT THE EDGE of a
          // water continent block (the row/column touching a land
          // block) get a sparse highlight/lowlight dither within the
          // body's own ocean hue — never bleeding toward land color.
          // Keeps a large ocean area from reading as a flat fill while
          // leaving the deep interior pure.
          //
          // Detection: step ONE worley cell in each axis and re-floor
          // to a continent block. Interior worley cells stay in the
          // same block (water → no flag). Only the 1-cell-wide ring
          // along a block's boundary actually crosses into a neighbor
          // block, which may evaluate to land.
          //
          // Coastal fringe — two graded rings.
          //
          // Ring 1 (one worley cell from a land continent block): solid
          //   +COAST_LIGHT_DELTA highlight on every pixel — reads as a
          //   continuous shoreline ringing each continent.
          // Ring 2 (two worley cells out): sparse-dithered highlight
          //   at COAST_R2_COVERAGE density — fades the band into the
          //   deeper ocean rather than ending in a hard edge.
          // Interior (no land within 2 worley cells in any axis):
          //   plain vOceanColor.
          //
          // Both rings are detected by stepping winnerCell ±1 / ±2
          // and re-flooring to a continent block; interior cells stay
          // in this (water) block on every step so they don't flag.
          // 8 hash21 evaluations per ocean fragment, cheap GPU-side.
          vec3 oceanCol = vOceanColor;
          if (liquidOceanHere) {
            float n1E = hash21(floor((winnerCell + vec2( 1.0,  0.0)) / CONTINENT_GROUP) + contSalt);
            float n1W = hash21(floor((winnerCell + vec2(-1.0,  0.0)) / CONTINENT_GROUP) + contSalt);
            float n1N = hash21(floor((winnerCell + vec2( 0.0,  1.0)) / CONTINENT_GROUP) + contSalt);
            float n1S = hash21(floor((winnerCell + vec2( 0.0, -1.0)) / CONTINENT_GROUP) + contSalt);
            bool ring1 = (n1E >= vWaterFrac) || (n1W >= vWaterFrac)
                      || (n1N >= vWaterFrac) || (n1S >= vWaterFrac);

            if (ring1) {
              oceanCol = clamp(vOceanColor * (1.0 + COAST_LIGHT_DELTA), 0.0, 1.0);
            } else {
              float n2E = hash21(floor((winnerCell + vec2( 2.0,  0.0)) / CONTINENT_GROUP) + contSalt);
              float n2W = hash21(floor((winnerCell + vec2(-2.0,  0.0)) / CONTINENT_GROUP) + contSalt);
              float n2N = hash21(floor((winnerCell + vec2( 0.0,  2.0)) / CONTINENT_GROUP) + contSalt);
              float n2S = hash21(floor((winnerCell + vec2( 0.0, -2.0)) / CONTINENT_GROUP) + contSalt);
              bool ring2 = (n2E >= vWaterFrac) || (n2W >= vWaterFrac)
                        || (n2N >= vWaterFrac) || (n2S >= vWaterFrac);
              if (ring2) {
                float dH = hash21(floor(d) + vSeed * SALT_COAST_DITHER);
                if (dH < COAST_R2_COVERAGE) {
                  oceanCol = clamp(vOceanColor * (1.0 + COAST_LIGHT_DELTA), 0.0, 1.0);
                }
              }
            }
          }

          // Per-region (primary, secondary, tertiary) palette election;
          // primary covers most cells, secondary fills sparse decoration,
          // tertiary stays unused on the surface. See the
          // REGION_PATCH_FACTOR comment block above for the why.
          vec2 regionCell = floor(winnerCell / REGION_PATCH_FACTOR);
          ivec3 slots = pickRegionSlots(regionCell, vWeights.xyz, vSeed);
          float resH = hash21(winnerCell + vSeed * SALT_RESOURCE_PICK);
          int chosenSlot = (resH < SECONDARY_COVERAGE) ? slots.y : slots.x;
          vec3 landCol = slotColor(chosenSlot, vPalette0, vPalette1, vPalette2);

          // Biome stipple paints over land cells in the temperate band.
          // Per-pixel hash flips individual land pixels to the body's
          // biome color (archetype × stellar shift; see biomePaintFor).
          // Salts SALT_BIOME_STIPPLE — distinct from the continent /
          // resource hashes so one pixel never draws the same stream twice.
          // No-op when vBiomeCoverage is zero (no biome / banded /
          // sub-threshold disc).
          if (vBiomeCoverage > 0.0) {
            float taper = 1.0 - smoothstep(
              BIOME_LAT_MAX - BIOME_LAT_RAMP,
              BIOME_LAT_MAX,
              abs(latSinDisc)
            );
            float effective = vBiomeCoverage * taper;
            if (effective > 0.0) {
              float bH = hash21(floor(d) + vSeed * SALT_BIOME_STIPPLE);
              if (bH < effective) landCol = vBiomeColor;
            }
          }
          vec3 resourceSurface = liquidOceanHere ? oceanCol : landCol;

          // Subsurface = the region's tertiary slot. Surface only ever
          // paints primary + secondary, so tertiary is the buried
          // mineralogy a crater impact or linea crack would expose.
          // Collapses to primary on 1-slot bodies (flat fill).
          vec3 resourceSubsurface = slotColor(slots.z, vPalette0, vPalette1, vPalette2);

          // Default fragment color. Three branches:
          //   capIcyHere   → pure ICE_COLOR (surface cap deposit; the
          //     bulk surface age is irrelevant — Mars's caps are
          //     seasonal surface ice, not regolith-buried cryosphere).
          //   globalIcyHere → surfaceAge-blended ice/resource (young
          //     icy body shows ice on top; old icy body shows resource
          //     regolith on top with ice buried underneath).
          //   else          → bulk resource surface.
          if (capIcyHere) {
            col = ICE_COLOR;
          } else if (globalIcyHere) {
            col = mix(resourceSurface, ICE_COLOR, vSurfaceAge);
          } else {
            col = resourceSurface;
          }

          // Phase 1.5c — discrete crater features + ejecta rays.
          // Crater seed cells aggregate CRATER_PATCH_FACTOR² fine
          // cells in the same sphere-projected frame as 1.5a/b. Scan
          // the 5×5 neighborhood: existence hash against
          // (1 - surfaceAge)², jittered center, cubic radius. Closest
          // containing crater wins for the interior paint; ray
          // contributions from any crater in scan whose rays reach
          // this fragment accumulate alpha-stacked into rayAccumA.
          //
          // Crater interior paint composes by layer order:
          //   young (ice on top): crater reveals the body's
          //     subsurface palette (impact punches through the ice
          //     layer to expose the other resources beneath).
          //   old (regolith on top): crater reveals ICE_COLOR where
          //     ice exists at this fragment, else subsurface palette
          //     (no ice to reveal).
          // Per-crater color uses the CRATER's region bucket (not the
          // fragment's), so a crater straddling a region boundary paints
          // one uniform color rather than fracturing along the seam.
          //
          // Ray paint is ICE_COLOR (matches the Tycho/Hokusai bright-
          // fresh-material convention; works on icy bodies as exposed
          // ice and on dry bodies as the canonical "fresh impact"
          // signal). Painted only when the fragment isn't already
          // inside a crater body — interior paint always wins.
          //
          // Salt allocation (vSeed × prime, vSeed × prime):
          //   crater existence:  (547, 569)
          //   crater jitter X:   (587, 547)
          //   crater jitter Y:   (569, 587)
          //   crater radius:     (569, 547) — reversed pair distinct from existence
          //   crater palette:    (587, 569)
          //   crater age (ray):  (631, 641) — per-crater impact recency
          //   ray base angle:    (653, 659) — per-crater angular offset
          //   per-ray length:    (677, 683) — per-(crater, ray-index) length jitter
          vec2 craterCellPos  = cellPos / CRATER_PATCH_FACTOR;
          vec2 craterCellId   = floor(craterCellPos);
          vec2 craterCellFrac = craterCellPos - craterCellId;
          float ageMissing    = 1.0 - vSurfaceAge;
          float craterDensity = ageMissing * ageMissing * CRATER_DENSITY_MAX;

          float bestDist  = 1e9;
          vec2  bestCraterId = vec2(0.0);
          bool  inCrater  = false;

          // Ejecta tracking — set when any ray-bearing crater in the
          // 5×5 scan touches this fragment with one of its 3..6 rays.
          // bestRayCraterId carries the CLOSEST ray-source so the
          // post-loop paint can resolve the ray to the same fill
          // color that crater's interior would paint. Rays are
          // excavated material — they should match what the crater
          // bowl exposes, not a universal ICE_COLOR.
          // Gated on disc size — 1-px rays read as noise below
          // RAY_MIN_DISC_RADIUS.
          bool  onRay           = false;
          bool  rayActive       = vRadius > RAY_MIN_DISC_RADIUS;
          vec2  bestRayCraterId = vec2(0.0);
          float bestRayDist     = 1e9;

          for (int dx = -3; dx <= 3; dx++) {
            for (int dy = -3; dy <= 3; dy++) {
              vec2 off = vec2(float(dx), float(dy));
              vec2 nCell = craterCellId + off;
              float existH = hash21(nCell + vSeed * SALT_CRATER_EXIST);
              if (existH > craterDensity) continue;
              float jx = hash21(nCell + vSeed * SALT_CRATER_JITTER_X);
              float jy = hash21(nCell + vSeed * SALT_CRATER_JITTER_Y);
              vec2  cCenter = off + vec2(jx, jy);
              float rH = hash21(nCell + vSeed * SALT_CRATER_RADIUS);
              // Cubic bias: 50th percentile rH=0.5 → rH³=0.125 →
              // tiny crater; only rH > ~0.95 produces big craters.
              float radius = CRATER_RADIUS_MIN + (CRATER_RADIUS_MAX - CRATER_RADIUS_MIN) * rH * rH * rH;
              float dist = length(cCenter - craterCellFrac);
              if (dist < radius && dist < bestDist) {
                bestDist = dist;
                bestCraterId = nCell;
                inCrater = true;
              }

              // Ejecta ray pass — fragment sits outside the crater
              // body but possibly inside one of its rays. Per-crater
              // age hash gates ray emission; ray count scales with
              // crater radius (bigger craters throw more rays); each
              // individual ray has its own hashed length so the
              // silhouette isn't a perfect starburst. No distance
              // fade: rays paint as solid strokes from the crater
              // rim out to the per-ray length cutoff.
              if (rayActive && radius >= RAY_MIN_RADIUS && dist > radius) {
                // Size-driven max reach: tiny qualifying crater gets
                // RAY_REACH_MAX_MUL as its top end, biggest crater
                // gets RAY_REACH_BIG_MUL. Same radiusNorm drives ray
                // count below — both effects scale together so big
                // craters get MORE and LONGER rays.
                float radiusNorm   = (radius - CRATER_RADIUS_MIN) / (CRATER_RADIUS_MAX - CRATER_RADIUS_MIN);
                float craterMaxMul = mix(RAY_REACH_MAX_MUL, RAY_REACH_BIG_MUL, radiusNorm);
                float rayMaxReach  = radius * craterMaxMul;
                if (dist < rayMaxReach) {
                  float craterAgeH = hash21(nCell + vSeed * SALT_CRATER_AGE);
                  if (craterAgeH < RAY_AGE_THRESHOLD) {
                    // Size-driven ray count: tiny crater → MIN, big
                    // crater → MAX. Clamp guards the radiusNorm = 1
                    // edge from rounding past MAX.
                    float numRays = clamp(
                      RAY_COUNT_MIN + floor(radiusNorm * (RAY_COUNT_MAX - RAY_COUNT_MIN + 1.0)),
                      RAY_COUNT_MIN, RAY_COUNT_MAX);
                    float baseAngle = hash21(nCell + vSeed * SALT_RAY_ANGLE) * TWO_PI;
                    vec2  toFrag    = craterCellFrac - cCenter;
                    float angle     = atan(toFrag.y, toFrag.x);
                    float angleStep = TWO_PI / numRays;
                    float relPhase  = (angle - baseAngle) / angleStep;
                    float wedgeIdx  = floor(relPhase);
                    float wedgeProg = fract(relPhase) - 0.5;
                    // Per-ray length jitter — same crater, different
                    // rays get different reach. Hash keyed on the
                    // ray's wedge index so the length stays stable
                    // across fragments inside one ray. Per-crater
                    // craterMaxMul caps the upper end so big craters
                    // can throw longer rays than small ones.
                    float perRayH   = hash21(nCell + vSeed * SALT_RAY_PERRAY + vec2(wedgeIdx, 0.0));
                    float perRayReach = radius * mix(RAY_REACH_MIN_MUL, craterMaxMul, perRayH);
                    if (dist < perRayReach) {
                      // Pixel-width tolerance: RAY_PIXEL_WIDTH px wide
                      // = RAY_PIXEL_WIDTH/distPx radians; divided by
                      // wedge angular width (angleStep) gives the
                      // tolerance in wedgeProg units. Inverse-distance
                      // keeps the streak the same pixel width along
                      // its length.
                      float distPx    = dist * CRATER_PATCH_FACTOR * SURFACE_PATCH_PX;
                      float thickness = RAY_PIXEL_WIDTH * numRays / (max(distPx, 1.0) * TWO_PI);
                      if (abs(wedgeProg) < thickness) {
                        onRay = true;
                        // Closest ray-source wins when multiple
                        // craters' rays cross this fragment, so the
                        // paint resolves to that crater's region.
                        if (dist < bestRayDist) {
                          bestRayDist = dist;
                          bestRayCraterId = nCell;
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          if (inCrater || onRay) {
            // Unified crater-interior + ejecta-ray paint. Both branches
            // share the same fill computation — they're the same
            // excavated material, just deposited in different places
            // (the bowl itself vs the radial ejecta). bestCraterId
            // wins when the fragment is inside a crater body;
            // otherwise the closest ray-source crater drives the
            // paint, so a Mercury impact throws subsurface-grey
            // rays and a Callisto impact throws ICE_COLOR rays —
            // the same colors those impacts' bowls would expose.
            //
            // Per-crater region picks the subsurface mask, so every
            // fragment of one crater (interior + every ray) paints
            // the same color rather than fragmenting along the
            // region-boundary seams the surface pass would normally
            // honor.
            vec2 paintCraterId = inCrater ? bestCraterId : bestRayCraterId;
            float pjx = hash21(paintCraterId + vSeed * SALT_CRATER_JITTER_X);
            float pjy = hash21(paintCraterId + vSeed * SALT_CRATER_JITTER_Y);
            vec2  pCenter = (paintCraterId + vec2(pjx, pjy)) * CRATER_PATCH_FACTOR;
            vec2  pRegionCell = floor(pCenter / REGION_PATCH_FACTOR);
            ivec3 pSlots = pickRegionSlots(pRegionCell, vWeights.xyz, vSeed);
            vec3 pRevealCol = slotColor(pSlots.z, vPalette0, vPalette1, vPalette2);

            vec3 pYoung = pRevealCol;
            vec3 pOld   = icyHere ? ICE_COLOR : pRevealCol;
            col = mix(pOld, pYoung, vSurfaceAge);
          }

          // Phase 1.5d — linea. Voronoi cell-boundary cracks painted
          // with the body's subsurface palette. Fires where the body
          // has young icy crust (Europa, Enceladus). Body-level gate
          // on iceFraction × surfaceAge keeps the pass off non-icy or
          // ancient surfaces; fragment-level icyHere gate keeps cracks
          // confined to the actual ice. Painting subsurface fits the
          // layered resource model — a linea is "the ice shell cracked
          // open and the underlying composition is visible."
          //
          // Edge geometry: F2 − F1 worley distance is roughly the
          // perpendicular distance from the fragment to the nearest
          // cell boundary. Fragments within LINEA_WIDTH_FRAC of any
          // boundary are eligible. Only LINEA_DENSITY of edges promote
          // to actual linea, gated by a per-edge hash so the network
          // reads as a sparse crisscross rather than every-cell-edge.
          // The edge key is winnerCell + secondCell (commutative, so
          // the same edge keyed identically regardless of which side
          // the fragment is on). Salts SALT_LINEA_EDGE.
          if (icyHere && (vIceFrac * vSurfaceAge) > LINEA_BODY_THRESHOLD) {
            float edgeDist = sqrt(secondMinDist2) - sqrt(minDist2);
            if (edgeDist < LINEA_WIDTH_FRAC) {
              vec2 edgeKey = winnerCell + secondCell;
              float edgeH = hash21(edgeKey + vSeed * SALT_LINEA_EDGE);
              if (edgeH < LINEA_DENSITY) {
                col = resourceSubsurface;
              }
            }
          }

          // ── Lava emission ── composite molten incandescence onto the
          // crust and accumulate the post-lighting emissive (see lavaPass()).
          col = lavaPass(col, lon, lat, vBodyV,
                         minDist2, secondMinDist2, winnerCell, secondCell,
                         lavaEmissive);

        } else {
          // No surface — gas / ice giant. Paint the atm column tint
          // directly (sampled from the per-body data texture); cloud
          // decks below composite on top via the loop.
          col = vAtmColumnColor;
        }
        return col;
      }

      // ── Cloud layers ──
      // Up to MAX_CLOUD_LAYERS stratified decks composite back-to-front
      // by altitudeNorm. Per-body deck data lives in uCloudLayerData
      // (DataTexture) sampled by vBodyIndex — kept off vertex attribs
      // to stay under the gl_MaxVertexAttribs cap as layer count grows.
      // Each deck pre-tints toward vHazeColor by the haze that would
      // sit above it under a uniform-density column approximation:
      //   hazeAbove = vHazeOpacity * (1 - altitudeNorm)
      // Deeper decks get more haze tint (more atmosphere above them);
      // top decks barely tint. The uniform haze pass below composites
      // the full blanket once over the surface; deck pre-tinting is
      // the cheap equivalent of interleaving haze sub-layers between
      // every deck without sampling haze multiple times.
      //
      // Cloud rendering is a single unified worley sampler. Per-deck
      // wind speed (m/s, peak cloud-top zonal jets) drives two
      // dimensions of the banding effect via independent curves:
      //   - bandness (0..1) — smoothstep from Earth jet stream
      //     (~30 m/s, patchy cumulus → both-axes color hash) to
      //     Jupiter-class (~150 m/s, lat-strip aligned → lat-only
      //     hash). Controls hash mode + lerps toward bandedLonPx
      //     below as cells transition from cellular to lat-aligned.
      //   - bandedLonPx — east-west cell pitch at full bandness.
      //     Sqrt curve over windSpeed / WIND_STRETCH_REFERENCE_MS so
      //     low wind speeds already produce visible stretching
      //     (Jupiter ~130 lands at ~13:1 aspect) while high speeds
      //     saturate gracefully (Neptune ~600 caps at 24:1, Saturn
      //     ~450 at 21:1, Uranus ~250 at 17:1). Sqrt rather than
      //     linear because real wind speeds span an order of
      //     magnitude across the gas giants and a linear curve
      //     leaves Jupiter under-stretched relative to its bands.
      vec3 cloudLayers(vec3 col, float lon, float lat, float vBodyV) {
        for (int li = 0; li < ${MAX_CLOUD_LAYERS}; li++) {
          float layerU = (float(li) + 0.5) / float(${BODY_TEXTURE_WIDTH});
          vec4 layer = texture2D(uCloudLayerData, vec2(layerU, vBodyV));
          float coverage = layer.x;
          if (coverage <= 0.0) continue;
          float windSpeedMS = layer.y;
          float altitudeNorm = layer.z;
          float layerSeed = layer.w;
          float bandness = smoothstep(WIND_BANDNESS_LOW_MS, WIND_BANDNESS_HIGH_MS, windSpeedMS);
          float windFactor = sqrt(clamp(windSpeedMS / WIND_STRETCH_REFERENCE_MS, 0.0, 1.0));
          float bandedLonPx = mix(BAND1_LON_PX, BAND_MAX_LON_PX, windFactor);
          float lonPx = mix(CLOUD_LON_PX, bandedLonPx, bandness);

          // Per-deck color — one RGBA texel, condensate hue in .rgb.
          float pDeckColU = (float(${DECK_COLOR_BASE_OFFSET}) + float(li) + 0.5) / float(${BODY_TEXTURE_WIDTH});
          vec3 deckColor = texture2D(uCloudLayerData, vec2(pDeckColU, vBodyV)).rgb;

          // LAT pitch lerps from CLOUD_LAT_PX (patchy) to BAND1_LAT_PX
          // (banded) by bandness. LON pitch already encodes the wind-
          // speed stretching via lonPx above.
          vec2 cellAspect = vec2(
            lonPx,
            mix(CLOUD_LAT_PX, BAND1_LAT_PX, bandness)
          );
          vec2 p = vec2(lon, lat) * vRadius / cellAspect;
          vec2 cellId = floor(p);
          vec2 cellFrac = p - cellId;
          // Track both nearest (F1) and second-nearest (F2) jittered cell
          // centers. F2 is consulted by the edge-dither check below — the
          // distance to the F1/F2 boundary tells us how far inside our
          // own cell we are, and whether the neighbor would have fired.
          // The LAYER_SALT_* pairs fold layerSeed into the base cloud salts
          // so each deck's cells land on different positions.
          float minD2, secondD2;
          vec2 winnerCell, secondCell;
          worleyF1F2(cellId, cellFrac,
                     vSeed * SALT_CLOUD_JITTER_A + layerSeed * LAYER_SALT_CLOUD_JIT_A,
                     vSeed * SALT_CLOUD_JITTER_B + layerSeed * LAYER_SALT_CLOUD_JIT_B,
                     winnerCell, secondCell, minD2, secondD2);

          // Existence gate — binary per-cell hash. Cells whose hash sits
          // below coverage paint the deck; above this they skip, revealing
          // the next-deeper deck (or surface / atmColumnColor beneath).
          float existH = hash21(winnerCell + vSeed * SALT_CLOUD_EXIST + layerSeed * LAYER_SALT_CLOUD_EXIST);
          if (existH >= coverage) continue;

          // Edge dither — two cases share one boundary-distance metric
          // but apply different thresholds for the asymmetry each wants.
          //
          // Distance from the fragment to the F1/F2 perpendicular bisector
          // (in worley units) is (sqrt(secondD2) - sqrt(minD2)) * 0.5 —
          // the bisector is equidistant by definition, so this measures
          // how deep inside F1's cell the fragment sits. Multiply by the
          // tighter cell-aspect axis to convert to env-pixels: in banded
          // cells the visible boundaries run along the lat-stretched axis,
          // so the lat dimension is the one we care about.
          float existH2 = hash21(secondCell + vSeed * SALT_CLOUD_EXIST + layerSeed * LAYER_SALT_CLOUD_EXIST);
          float boundaryWorley = (sqrt(secondD2) - sqrt(minD2)) * 0.5;
          float boundaryPx = boundaryWorley * min(cellAspect.x, cellAspect.y);
          float t = clamp(boundaryPx / CLOUD_EDGE_DITHER_PX, 0.0, 1.0);
          float b = bayer4(gl_FragCoord.xy);

          // ljCell decides which cell's BAND_LIGHTNESS_JITTER colors this
          // fragment. Defaults to F1; the firing/firing case below may
          // swap in F2 for fragments inside the dither fringe.
          vec2 ljCell = winnerCell;

          if (existH2 >= coverage) {
            // F1 fires, F2 doesn't — cloud/no-cloud boundary. Asymmetric:
            // Bayer-out fragments fall through to the layer beneath, so
            // the cloud silhouette gains a stipple halo against same-tone
            // surface (water cloud over snowcap) or deeper decks (NH3
            // rent revealing NH4SH on Jupiter).
            if (b >= t) continue;
          } else {
            // F1 fires, F2 also fires — cloud/cloud boundary inside the
            // deck. Two adjacent worley cells share the same condensate
            // color but get distinct BAND_LIGHTNESS_JITTER via
            // hash11(cell.y), so for cells in different lat rows there's
            // a visible (and at high coverage, ONLY) tonal seam between
            // them. Symmetric stipple: fragments in the dither fringe
            // pick up F2's lj instead of F1's so the bands taper into
            // each other. Threshold 0.5 + 0.5*t gives 50% F1/50% F2 at
            // the bisector, ramping to 100% F1 at the fringe edge —
            // visible band-edge dither even on a 100%-coverage deck
            // (Venus H2SO4) where no rents exist to dither against.
            if (b >= 0.5 + 0.5 * t) ljCell = secondCell;
          }

          // Per-cell brightness jitter — keyed to lat so cells in the
          // same band share tonal life, gives a deck visual texture
          // without introducing alien hues. ljCell is F1 except at
          // band/band boundaries where the symmetric dither above swaps
          // in F2.
          float lj = (hash11(ljCell.y + vSeed * SALT_BAND_LIGHTNESS + layerSeed * LAYER_SALT_BAND) - 0.5) * 2.0 * BAND_LIGHTNESS_JITTER;
          vec3 cloudCol = clamp(deckColor + vec3(lj), 0.0, 1.0);

          // Haze pre-tint by altitude — deep decks read as more
          // haze-tinted; top decks barely tint. Approximates
          // interleaved uniform-density haze without per-deck sampling.
          float hazeAbove = vHazeOpacity * (1.0 - altitudeNorm);
          vec3 tinted = mix(cloudCol, vHazeColor, hazeAbove);

          col = tinted;
        }
        return col;
      }

      // Atmospheric-loft rim halo color + alpha for one fragment OUTSIDE
      // the disc (distOut = pixels past the rim). Radial stack falloff sets
      // the base alpha; with active lights each star paints its own
      // directional loft glow (half-lambert wrap past the terminator +
      // gated white tip) plus a depth-graded, hue-only Rayleigh shift toward
      // the body's per-gas scatter color. Returns vec4(rimColor, rimAlpha);
      // see the RIM_* / OUTER_BASE_ALPHA constant block for the tuning.
      vec4 rimHalo(vec2 d, float distOut) {
        float layer = floor(distOut);
        float stackCount = vRimWidthPx - layer;
        float rimA = 1.0 - pow(1.0 - OUTER_BASE_ALPHA, stackCount);

        // Directional loft glow — see the atmospheric-loft constant
        // block. With no active lights, fall back to the static gas-
        // color ring (no angular term) so a lightless body doesn't
        // render a black-on-one-side halo.
        vec3  rimCol = vRimColor;
        if (uLightCount > 0) {
          vec2  rimDir = normalize(d);
          vec3  glowAccum = vec3(0.0);
          vec3  lightAccum = vec3(0.0);
          float litSum = 0.0;
          float litMax = 0.0;
          for (int i = 0; i < ${MAX_LIGHTS}; i++) {
            if (i >= uLightCount) break;
            vec2 Ldir = normalize(uLightPos[i] - vCenter);
            // Half-lambert wrap so the loft glow reaches past the
            // terminator around the whole backlit limb (see block).
            float facing = dot(rimDir, Ldir) * 0.5 + 0.5;
            float lit = pow(facing, RIM_GLOW_FOCUS) * uLightIntensity[i];
            // Per-light dither offset so multiple stars' stipple
            // patterns don't cascade (mirrors the disc lighting pass).
            float bL = bayer4(gl_FragCoord.xy + vec2(43.0 + float(i) * 7.0, 29.0 + float(i) * 11.0));
            lit = clamp(lit + (bL - 0.5) * 2.0 * RIM_DITHER_WIDTH, 0.0, 1.0);
            // Gas filters the starlight (hue-preserving multiply,
            // gentle gain), plus a small white tip gated to the
            // brightest sunward sliver so only the extreme limb pops.
            vec3 scattered = vRimColor * uLightColor[i] * RIM_GLOW_GAIN;
            float tip = pow(lit, RIM_TIP_FOCUS) * RIM_TIP_WHITE;
            vec3 illum = scattered + uLightColor[i] * tip;
            glowAccum += mix(vRimColor, illum, lit) * lit;
            lightAccum += uLightColor[i] * lit;
            litSum += lit;
            litMax = max(litMax, lit);
          }
          // Color: per-star illuminated hues averaged by their lit
          // weights (each star paints its own arc its own color); the
          // gas color shows through where nothing lights the rim.
          rimCol = (litSum > 0.0) ? glowAccum / litSum : vRimColor;
          // Alpha: radial stack falloff × angular ramp from the faint
          // night-side ambient floor to full on the lit limb. litMax
          // (not the sum) so overlapping crescents don't double-opaque.
          rimA *= mix(RIM_DARK_FLOOR, 1.0, litMax);

          // Rayleigh hue shift, graded by column depth — outermost loft
          // layer most, inner edge least. HUE ONLY: the target hue is
          // renormalized to rimCol's luminance, so mixing toward it
          // leaves brightness unchanged, and rimA is never touched.
          // Target = the body's per-gas scatter color re-illuminated by
          // the lit-weighted average starlight; shift amount scales by
          // the per-body Rayleigh fraction (vWeights.w). See block.
          float scatterStrength = vWeights.w;
          if (litSum > 0.0 && RIM_RAYLEIGH_STRENGTH > 0.0 && scatterStrength > 0.0) {
            float scatV = (vBodyIndex + 0.5) / max(uCloudLayerRows, 1.0);
            float scatU = (float(${SCATTER_COLOR_TEXEL_OFFSET}) + 0.5) / float(${BODY_TEXTURE_WIDTH});
            vec3  scatterColor = texture2D(uCloudLayerData, vec2(scatU, scatV)).rgb;
            vec3  rayTarget = (lightAccum / litSum) * scatterColor;
            float tgtL = lum(rayTarget);
            if (tgtL > 0.0) {
              vec3 rayHue = rayTarget * (lum(rimCol) / tgtL);
              // Depth fraction: outermost layer → 1, inner → 1/width.
              float depth = clamp((floor(distOut) + 1.0) / vRimWidthPx, 0.0, 1.0);
              rimCol = mix(rimCol, rayHue, depth * scatterStrength * RIM_RAYLEIGH_STRENGTH);
            }
          }
        }
        return vec4(rimCol, rimA);
      }

      void main() {
        vec2 d = gl_FragCoord.xy - vCenter;
        float r = length(d);

        // Outside the disc — paint the atmospheric halo if any, else
        // discard. Sprite is sized to give us vRimWidthPx pixels of
        // overdraw space in the outward direction. Stack count for layer
        // L = (W - L): innermost layer (closest to disc) is covered by
        // the widest stroke and every narrower stroke, so it accumulates
        // the most opacity. Output uses real alpha so the halo blends
        // correctly with rings, moons, and other scene elements behind
        // it (the planet material is transparent=true for this reason —
        // see the material config below). vRimColor is the weighted-
        // average merger across cloud + species haze + scattering + dust
        // contributors (see disc-palette/index.ts).
        if (r > vRadius) {
          #ifdef DISC_ONLY
            discard;
          #else
            if (r > vRadius + vRimWidthPx || vRimWidthPx < 1.0) discard;
            float distOut = r - vRadius;
            gl_FragColor = rimHalo(d, distOut);
            return;
          #endif
        }
        #ifdef HALO_ONLY
          discard;
        #endif

        // Sphere projection — reconstruct the forward-hemisphere surface
        // normal at this fragment and dot it with the band-aligned pole
        // (tipped forward by arcsin(POLE_SIN), same foreshortening the
        // rings and banded mode use). latSinS is the sine of latitude on
        // the visible sphere; polar caps hug |latSinS| ≈ 1. Tilt rotation
        // matches banded mode so a ringed terrestrial's caps and ring
        // share one vantage.
        //
        // Hoisted above the surface gate because two consumers need it:
        // the surface block (worley cells in lon/lat) and the patchy
        // cloud block (worley cells in the same frame, so clouds and
        // continents compress toward the limb together). Banded clouds
        // keep their own un-inset projection because their latitude
        // arcs need to reach the true pole.
        //
        // Frame derivation: in the band-aligned tilted frame the pole
        // points along P = (0, POLE_COS, POLE_SIN) and the prime
        // meridian (lon = 0 at the equator, facing the viewer) along
        // F = (0, -POLE_SIN, POLE_COS); east is +x. For a surface
        // normal n = (nxs, nys, nzs):
        //   sin(lat) = dot(n, P) = nys*POLE_COS + nzs*POLE_SIN
        //   cos(lat) cos(lon) = dot(n, F) = nzs*POLE_COS - nys*POLE_SIN
        //   cos(lat) sin(lon) = dot(n, E) = nxs
        // so lat = asin(latSinS) and lon = atan2(nxs, lonF). atan2 is
        // well-defined across the visible hemisphere; the only
        // singularity (visible pole) is a sub-pixel region masked by
        // the ice cap for any body with iceFrac > 0.
        float cT = cos(vTilt);
        float sT = sin(vTilt);
        float lxs =  d.x * cT + d.y * sT;
        float lys = -d.x * sT + d.y * cT;
        // Inset the projection by SPHERE_VISIBLE_FRAC so the disc edge
        // maps inside the hemisphere rather than to the true limb —
        // bounds cell foreshortening so they stop pinching to sub-pixel
        // widths near the rim. See the constant block.
        float nxs = (lxs / vRadius) * SPHERE_VISIBLE_FRAC;
        float nys = (lys / vRadius) * SPHERE_VISIBLE_FRAC;
        float nzs = sqrt(max(0.0, 1.0 - nxs * nxs - nys * nys));
        float latSinS = nys * POLE_COS + nzs * POLE_SIN;
        float lat     = asin(latSinS);
        float lonF    = nzs * POLE_COS - nys * POLE_SIN;
        float lon     = atan(nxs, lonF);

        // Atm column color sampled from the data texture once per
        // fragment. Painted as the disc base on no-surface bodies
        // (visible through cloud rents, dominating the limb where
        // clouds don't fully occlude). On surface bodies the surface
        // block paints over it and it never shows directly.
        float vBodyV = (vBodyIndex + 0.5) / max(uCloudLayerRows, 1.0);
        float atmColU = (float(${ATM_COLUMN_TEXEL_OFFSET}) + 0.5) / float(${BODY_TEXTURE_WIDTH});
        vec3 vAtmColumnColor = texture2D(uCloudLayerData, vec2(atmColU, vBodyV)).rgb;
        // Per-body ocean color — derived from solvent species, biotic
        // pigment mix, suspended mineral sediment, CDOM yellow substance,
        // host-star SED, and sky reflection (see oceanColorFor in
        // disc-palette/ocean.ts). Replaces the old hard-coded OCEAN_COLOR
        // constant so two close-analog bodies get distinguishable hues.
        float oceanColU = (float(${OCEAN_COLOR_TEXEL_OFFSET}) + 0.5) / float(${BODY_TEXTURE_WIDTH});
        vec3 vOceanColor = texture2D(uCloudLayerData, vec2(oceanColU, vBodyV)).rgb;

        // Surface (or atm-column) base color + self-luminous lava emission.
        // lavaEmissive is added back AFTER the reflectance lighting pass (see
        // the post-lighting additive), so it lives at main() scope to survive
        // the surface/cloud/haze composite; surfaceColor zeroes it on every
        // non-molten body. col is the base the haze + cloud decks composite over.
        vec3 lavaEmissive;
        vec3 col = surfaceColor(d, lxs, lys, lon, lat,
                                vOceanColor, vAtmColumnColor, vBodyV,
                                lavaEmissive);

        // ── Haze blanket ──
        // Surface bodies: uniform per-fragment lerp toward the unified
        // haze color (bulk atm gases + Rayleigh + aerosol products +
        // dust, all weighted, soft-capped). Painted BETWEEN the surface
        // and the cloud decks so each cloud deck's altitude-driven
        // pre-tint composites coherently — clouds at higher altitudes
        // sit above less of the column and tint less toward vHazeColor.
        // Gas / ice giants skip the uniform overlay: their aerosols are
        // band-localized chromophores feeding the cloud band palette;
        // a uniform mix would crush the structure.
        if (vHazeOpacity > 0.0 && vSurfaceOpacity > 0.5) {
          col = mix(col, vHazeColor, vHazeOpacity);
          // Break the flat tinted disc a saturated haze lerp leaves
          // behind with a gated luminance jitter (see the HAZE_DITHER_*
          // const block for the rationale + tuning).
          float bayerT = bayer4(gl_FragCoord.xy);
          float hashT  = hash21(floor(gl_FragCoord.xy));
          float ditherT = mix(bayerT, hashT, HAZE_DITHER_HASH_MIX) - 0.5;
          float ditherGate = smoothstep(HAZE_DITHER_GATE_LOW, HAZE_DITHER_GATE_HIGH, vHazeOpacity);
          col += vec3(ditherT * HAZE_DITHER_AMP * ditherGate);
        }

        // ── Cloud layers ── composite the stratified condensate decks over
        // the surface+haze base (or atm column on no-surface bodies). See
        // cloudLayers() for the wind→banding model + edge-dither cases.
        col = cloudLayers(col, lon, lat, vBodyV);

        // ── Lighting pass ──
        // See the LIGHT_* constant block for the math + tuning rationale.
        // Runs after all surface/cloud/haze paint so the tint composites
        // onto the final body color, and BEFORE the hover rim so hover
        // still wins on the outermost pixel ring.
        //
        // Per-light independent banding (NOT averaging across lights):
        // each star runs its own band check on its own per-fragment
        // lambert, then stacks its tint additively. Where star A
        // dominates the local lambert (left rim) and star B is sub-
        // threshold, only A's hue paints — B's contribution doesn't
        // dilute the color signal. Overlap regions get both tints
        // additively layered, which reads as a brighter combined zone
        // where the crescents meet. The alternative — summing all
        // lambert contributions and applying one averaged-hue tint —
        // washes out the per-star color directionality even when
        // each star physically dominates its own rim segment.
        vec3 N_lit = vec3(d.x / vRadius, d.y / vRadius,
                          sqrt(max(0.0, 1.0 - (d.x * d.x + d.y * d.y) / (vRadius * vRadius))));
        col = applyStarCrescent(col, N_lit, vCenter);

        // ── Lava self-luminous emission ──
        // Added AFTER the reflectance lighting pass so molten zones exceed
        // the star-lit crescent (≤ ~0.22) and read as light sources rather
        // than bright albedo — and so the glow shows on the night-side limb
        // (emission is star-independent). Scaled down by haze so a thick
        // magma-ocean atmosphere veils the raw punch-through (the surface
        // block already let the cloud/haze layers paint over the ember).
        col = clamp(col + lavaEmissive * (1.0 - vHazeOpacity * 0.7), 0.0, 1.0);

        // 1-px hover rim — same as the previous flat-disc material. The
        // discard above bounds the disc; this swap stamps the outermost
        // pixel ring (where r > vRadius - 1) to white when hovered, so
        // the body reads distinct from anything it overlaps.
        if (vHovered > 0.5 && r > vRadius - 1.0) col = vec3(1.0);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    // Transparent because the atmospheric halo (1.3a/b outward) outputs
    // a partial alpha that needs to blend with whatever's behind it
    // (rings, moons, other bodies). Disc-interior fragments still output
    // alpha=1.0, so they're opaque-equivalent under the standard blend.
    transparent: true,
    // depthWrite intentionally true — the system diagram threads a
    // per-vertex z based on each planet's row index so each planet's
    // stack (back-ring / back-moon / disc / front-ring / front-moon)
    // renders as a single z-layer above or below its neighbors. The
    // renderOrder field on each layer enforces the painter's-algorithm
    // sequence within the transparent bucket, so back-rings and back-
    // moons paint before the planet halo and front-rings/front-moons
    // paint after it.
    depthWrite: true,
  });
  snappedMaterials.push(m);
  return m;
}
