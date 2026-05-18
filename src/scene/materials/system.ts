// System-view materials: flat 2D stars + chunk pool + ice ring +
// per-mesh star disc. All four are designed to render under an
// OrthographicCamera at 1 unit = 1 buffer pixel (see SystemDiagram in
// scene/system-diagram/). No depth attenuation, no pivot dim — the
// system view is a static screen layout, not a navigable 3D space.

import { Color, ShaderMaterial, Vector2 } from 'three';
import { RING_MINOR_OVER_MAJOR } from '../system-diagram/layout/constants';
import { glsl, RASTER_PAD, snappedMaterials } from './shared';

// Planet + moon disc material. Renders a pixel-crisp disc whose interior
// is one of two procedural textures:
//
//   - **Surface mode (aMode = 0)** — worley/voronoi cell texture: the
//     disc is divided into SURFACE_PATCH_PX-wide cells, each with a
//     jittered center seeded per-body; every fragment picks a palette
//     entry by hashing its nearest cell. Gives organic lumpy ground
//     cover rather than per-pixel speckle. Driven CPU-side by the
//     world-class color + 2 dominant resources from the body's resource
//     grid.
//   - **Banded mode (aMode = 1)** — Jupiter-style atmospheric zones.
//     The disc is rotated into a band-aligned frame using the planet's
//     axial tilt (so bands run parallel to any rings — see
//     bodyVisualTiltRad in geom/ring.ts), divided into a radius-scaled
//     count of non-uniform-width strips with seed-jittered edges, and
//     each fragment's band assignment is perturbed by a chunky
//     horizontal warp so band boundaries undulate like turbulent zonal
//     flow rather than slicing the disc as straight lines. Each band
//     picks from the body's top 3 atmospheric gases by per-band hash.
//
// Per-vertex attributes drive both modes:
//   aPalette0/1/2  — three RGB palette entries
//   aWeights       — three [0..1] weights (sum to ~1; the picker treats
//                    zero-weight slots as ineligible)
//   aMode          — 0 = surface, 1 = banded
//   aSeed          — per-body [0..1) random; salts every hash so two
//                    planets with the same palette still texture differently
//   aTilt          — banded-mode rotation in radians. Surface-mode discs
//                    ignore it but still carry the attribute so the layer
//                    schema stays uniform across modes.
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
export function makePlanetMaterial(initialDiscScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uDiscScale: { value: initialDiscScale },
      uViewport:  { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      // Per-body render metadata packed into one vec4 to stay under the
      // GPU's gl_MaxVertexAttribs cap (8 on some integrated GPUs / WebGL1
      // contexts). Layout: x = size in px, y = mode, z = seed, w = tilt.
      attribute vec4  aRenderMeta;
      attribute float aHovered;
      attribute vec3  aPalette0;
      attribute vec3  aPalette1;
      attribute vec3  aPalette2;
      attribute vec3  aWeights;
      // Four per-fragment 0..1 scalars packed into one attribute.
      // Layout: x = waterFrac, y = iceFrac, z = biomeCoverage,
      // w = hazeTint. Unpacked into individual varyings below so the
      // fragment shader can stay readable.
      attribute vec4  aCoverageScalars;
      attribute vec3  aBiomeColor;
      attribute vec3  aHazeColor;
      // Atmospheric stroke widths/densities packed together.
      // Layout: x = rimWidthPx (haze or rayleigh rim, 0..N integer px),
      // y = cloudDensity (1.3c H2O patch coverage, 0..CLOUD_MAX).
      attribute vec2  aAtmoStrokes;
      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec3  vWeights;
      varying float vMode;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying vec3  vHazeColor;
      varying float vHazeTint;
      varying float vRimWidthPx;
      varying float vCloudDensity;
      uniform float uDiscScale;
      uniform vec2  uViewport;
      void main() {
        vHovered  = aHovered;
        vPalette0 = aPalette0;
        vPalette1 = aPalette1;
        vPalette2 = aPalette2;
        vWeights  = aWeights;
        vMode     = aRenderMeta.y;
        vSeed     = aRenderMeta.z;
        vTilt     = aRenderMeta.w;
        vWaterFrac     = aCoverageScalars.x;
        vIceFrac       = aCoverageScalars.y;
        vBiomeColor    = aBiomeColor;
        vBiomeCoverage = aCoverageScalars.z;
        vHazeColor   = aHazeColor;
        vHazeTint    = aCoverageScalars.w;
        vRimWidthPx  = aAtmoStrokes.x;
        vCloudDensity = aAtmoStrokes.y;

        // Integer-pixel disc diameter. Floor + 0.5 → round-to-nearest.
        float sz = floor(aRenderMeta.x * uDiscScale + 0.5);
        // Sprite extent must include the atmospheric halo that extends
        // 0..3 px OUTSIDE the disc (1.3a/b outward rim), so the
        // rasterizer covers that region. Without the extra padding the
        // halo fragments would never be rasterized. RASTER_PAD adds the
        // small fixed bounding-box headroom; the rim term adds enough
        // space for the per-body halo width.
        gl_PointSize = sz + ${glsl(RASTER_PAD)} + 2.0 * aAtmoStrokes.x;
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
      varying vec3  vWeights;
      varying float vMode;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying vec3  vHazeColor;
      varying float vHazeTint;
      varying float vRimWidthPx;
      varying float vCloudDensity;

      // Banded-mode density: bands per radius pixel. Tuned so a
      // Uranus-class disc (~43 px radius) gets ~30 bands; Jupiter
      // (~60 px radius) lands at ~42, smallest banded body (20 px
      // radius) at ~14. Per-disc band count is derived from vRadius at
      // fragment time — keeps band height in screen pixels roughly
      // constant across disc sizes so tiny moons don't render bands as
      // single-pixel barber stripes and gas giants don't read as
      // 8-strip cartoons.
      //
      // MAX_BAND_COUNT is the loop cap GLSL ES requires as a constant;
      // an early break uses the actual per-disc bandCount inside.
      const float BAND_DENSITY = 0.7;
      const int MAX_BAND_COUNT = 50;

      // Boundary-warp constants. WARP_CHUNK_PX = integer-px width of
      // one along-band warp step (3 px → coarse pixel-art stair-step
      // wobble rather than per-pixel hash noise). Warp amplitude is
      // derived per-disc from band size below so the wobble stays
      // visible without leaping narrow bands at any disc radius.
      const float WARP_CHUNK_PX = 3.0;

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
      // the same color — e.g. an H2/He gas giant with no chromophore,
      // where the 3 palette slots all reduce to a single near-beige
      // and a per-band hue pick would otherwise paint every strip the
      // same RGB. 0.06 = ±6% value swing: invisible against a high-
      // contrast Jovian palette (where the inter-gas hue gap is much
      // larger), but resolves to readable cream / tan / dark-tan
      // strips on a near-monochrome one.
      const float BAND_LIGHTNESS_JITTER = 0.06;

      // Surface-mode worley cell pitch in buffer pixels. A 60-px planet
      // disc gets ~15 cells across; jittered cell centers make the
      // patch silhouettes non-grid-aligned, so the ground reads as
      // organic lumps rather than rectangular tiles.
      const float SURFACE_PATCH_PX = 4.0;

      // Continent grouping: every CONTINENT_GROUP worley cells along
      // each axis share one ocean/land decision. Inherits the worley
      // boundary irregularity for free (rather than grid-aligned 16-px
      // squares), so continents have ragged Earth-like coasts at no
      // extra shader cost beyond one hash. 4 → ~16 px continents.
      const float CONTINENT_GROUP = 4.0;

      // Ocean fill color for sub-sea-level continent cells. Deep navy
      // — desaturated enough not to fight resource palette hues on
      // adjacent land cells, dark enough to read as "below sealevel"
      // against bright icy resource patches.
      const vec3 OCEAN_COLOR = vec3(0.16, 0.34, 0.55);

      // Polar cap fill. Pale ice-white — not pure white so the cap
      // still reads as "frozen surface" rather than "missing pixels"
      // against a dark scene background.
      const vec3 ICE_COLOR = vec3(0.93, 0.97, 1.0);

      // Biome stipple latitude window. Past BIOME_LAT_MAX (|sin lat| ≈
      // sin(58°)) life thins to zero; BIOME_LAT_RAMP feathers the edge
      // so the transition reads as "thinning toward the poles" rather
      // than a hard band cutoff. The cap branch above already masks
      // anything past 1 - iceFrac; this window narrows further so a
      // capless Earth-class body's biome still doesn't crawl over its
      // arctic regions where photosynthetic life would be marginal.
      const float BIOME_LAT_MAX  = 0.85;
      const float BIOME_LAT_RAMP = 0.15;

      // Phase 1.3c cloud cells — anisotropic worley in the equator-
      // aligned frame. CLOUD_LON_PX > CLOUD_LAT_PX gives cells stretched
      // east-west (zonal-flow direction), so cloud silhouettes read as
      // wind-swept streaks rather than axis-aligned grid squares. The
      // jittered-center worley pass produces irregular cell boundaries
      // that follow the ratio. Earth at ~60 px disc gets ~5 cells across
      // the equator and ~12 across latitudes — plenty of variation.
      const float CLOUD_LON_PX = 12.0;
      const float CLOUD_LAT_PX = 5.0;

      // Fixed cloud color — near-white, slightly cool. Same value as
      // GAS_COLOR[H2O] in stars.ts, hardcoded here so the shader doesn't
      // need a per-body cloud-color attribute (cloud color is always
      // H2O white — the only chromophore routing to this pass is H2O).
      const vec3 CLOUD_COLOR = vec3(0.894, 0.925, 0.941);

      // Phase 1.3a/b atmospheric rim — paints both OUTSIDE the disc (the
      // halo extending into space, 0..3 px driven by pressure) AND
      // INSIDE the disc near the limb (an edge-on column-thickness fade
      // proportional to disc radius, simulating atmospheric haze across
      // the planet's near-tangential limb).
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
      //
      // **Fake transparency.** Outward halo fragments output
      // rimColor × alpha as opaque, treating the scene background as
      // black. This keeps the planet material at transparent=false
      // so depthWrite and the diagram's per-vertex z-stack still
      // function. Inward fade is a per-fragment lerp on the surface
      // color — always opaque output.
      const float OUTER_BASE_ALPHA = 0.35;
      const float INNER_BASE_ALPHA = 0.08;
      // Width of the inward fade as a fraction of disc radius. Bands
      // within this width grow as 1, 2, 3, ... px from the limb inward
      // following the sphere-projection foreshortening curve — see the
      // inward-fade block below.
      const float INWARD_RIM_FRACTION = 0.4;

      // Per-pixel dither amplitude (in pixels of distFromLimb) applied
      // to the inward-fade band boundaries. 1.5 → each pixel jitters by
      // up to ±0.75 px before its band index is computed, so pixels
      // near a boundary scatter binary between the two sides. Net
      // visual: adjacent concentric bands blur into each other and the
      // rim reads as organic haze rather than clean stripes.
      const float INWARD_BAND_DITHER = 4.0;

      float hash11(float x) {
        return fract(sin(x * 12.9898 + 78.233) * 43758.5453);
      }
      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // Pick one of three palette entries by a 0..1 hash, weighted by
      // vWeights. Skips zero-weight slots automatically. Defensive
      // fallback: weights summing to zero → palette0 (the world-class
      // base color is always plumbed there).
      vec3 pickFromPalette(float h) {
        float w = vWeights.x + vWeights.y + vWeights.z;
        if (w <= 0.0) return vPalette0;
        float t = h * w;
        if (t < vWeights.x) return vPalette0;
        if (t < vWeights.x + vWeights.y) return vPalette1;
        return vPalette2;
      }

      void main() {
        vec2 d = gl_FragCoord.xy - vCenter;
        float r = length(d);

        // Outside the disc — paint the atmospheric halo (1.3a/b outward)
        // if any, else discard. Sprite is sized to give us vRimWidthPx
        // pixels of overdraw space in the outward direction. Stack count
        // for layer L = (W - L): innermost layer (closest to disc) is
        // covered by the widest stroke and every narrower stroke, so it
        // accumulates the most opacity. Output uses real alpha so the
        // halo blends correctly with rings, moons, and other scene
        // elements behind it (the planet material is transparent=true
        // for this reason — see the material config below).
        if (r > vRadius) {
          if (r > vRadius + vRimWidthPx || vRimWidthPx < 1.0) discard;
          float distOut = r - vRadius;
          float layer = floor(distOut);
          float stackCount = vRimWidthPx - layer;
          float rimA = 1.0 - pow(1.0 - OUTER_BASE_ALPHA, stackCount);
          gl_FragColor = vec4(vHazeColor, rimA);
          return;
        }

        vec3 col;
        if (vMode < 0.5) {
          // Surface — worley/voronoi cells. Divide the disc into
          // SURFACE_PATCH_PX-wide cells, jitter each cell's center
          // per-body, and pick the palette entry for the nearest cell.
          // Salted by vSeed so two same-palette planets get distinct
          // patch layouts. 9 candidate cells (3x3 neighborhood) is the
          // minimum needed for correct nearest-cell when centers are
          // jittered within the full unit cell.
          vec2 cellPos = d / SURFACE_PATCH_PX;
          vec2 cellId  = floor(cellPos);
          vec2 cellFrac = cellPos - cellId;
          float minDist2 = 1e9;
          vec2  winnerCell = cellId;
          for (int dx = -1; dx <= 1; dx++) {
            for (int dy = -1; dy <= 1; dy++) {
              vec2 off = vec2(float(dx), float(dy));
              vec2 nCell = cellId + off;
              vec2 jitter = vec2(
                hash21(nCell + vec2(vSeed * 13.0,  vSeed * 19.0)),
                hash21(nCell + vec2(vSeed * 23.0,  vSeed * 29.0))
              );
              vec2 nCenter = off + jitter;
              vec2 diff = nCenter - cellFrac;
              float d2 = dot(diff, diff);
              if (d2 < minDist2) {
                minDist2 = d2;
                winnerCell = nCell;
              }
            }
          }

          // Sphere projection — reconstruct the forward-hemisphere
          // surface normal at this fragment and dot it with the
          // band-aligned pole (tipped forward by arcsin(POLE_SIN), same
          // foreshortening the rings and banded mode use). latSinS is
          // the sine of latitude on the visible sphere; polar caps
          // hug |latSinS| ≈ 1. Tilt rotation matches banded mode so
          // a ringed terrestrial's caps and ring share one vantage.
          float cT = cos(vTilt);
          float sT = sin(vTilt);
          float lxs =  d.x * cT + d.y * sT;
          float lys = -d.x * sT + d.y * cT;
          float nxs = lxs / vRadius;
          float nys = lys / vRadius;
          float nzs = sqrt(max(0.0, 1.0 - nxs * nxs - nys * nys));
          float latSinS = nys * POLE_COS + nzs * POLE_SIN;

          // Layered fill, evaluated in priority order:
          //   1. Polar cap — |latSin| past (1 - iceFrac). iceFrac=1 fills
          //      the whole disc (Europa); iceFrac=0.1 leaves just the
          //      pole rim (Earth); iceFrac=0 disables (Venus).
          //   2. Ocean — coarse-cell hash < waterFrac flips this
          //      continent cell to flat OCEAN_COLOR. Earth at 0.71 lands
          //      ~71% of continent cells under sea level.
          //   3. Land — existing resource-palette pick from the fine
          //      worley winner cell.
          if (abs(latSinS) > 1.0 - vIceFrac) {
            col = ICE_COLOR;
          } else {
            // CONTINENT_GROUP-sized blocks of worley cells share one
            // ocean/land coin flip. Salt offset from the resource-pick
            // hash so the two scales decorrelate.
            vec2 contCell = floor(winnerCell / CONTINENT_GROUP);
            float contH = hash21(contCell + vec2(vSeed * 113.0, vSeed * 127.0));
            if (contH < vWaterFrac) {
              col = OCEAN_COLOR;
            } else {
              float h = hash21(winnerCell + vec2(vSeed * 1009.0, vSeed * 2017.0));
              col = pickFromPalette(h);
              // Biome stipple — per-pixel hash on disc-local integer
              // pixel coords flips individual land pixels to the body's
              // biome color (archetype × stellar shift; see
              // biomePaintFor in stars.ts). Coverage density comes from
              // biosphereTier — microbial sparse, gaian dense. Latitude
              // taper concentrates the effect on the temperate band.
              // Salts (197, 311) are distinct from the continent (113,
              // 127) and resource (1009, 2017) hashes so a single pixel
              // doesn't draw ocean/land and biome from the same noise
              // stream. Skipped when coverage is zero (no biome, banded
              // body, or sub-threshold disc) to save the hash cost.
              if (vBiomeCoverage > 0.0) {
                float taper = 1.0 - smoothstep(
                  BIOME_LAT_MAX - BIOME_LAT_RAMP,
                  BIOME_LAT_MAX,
                  abs(latSinS)
                );
                float effective = vBiomeCoverage * taper;
                if (effective > 0.0) {
                  float bH = hash21(floor(d) + vec2(vSeed * 197.0, vSeed * 311.0));
                  if (bH < effective) col = vBiomeColor;
                }
              }
            }

            // Phase 1.3c H2O cloud patches — anisotropic worley cells in
            // the equator-aligned frame. Paints CLOUD_COLOR over land +
            // ocean cells (cap is excluded by construction — this branch
            // only runs when |latSinS| <= 1 - vIceFrac). Cells stretched
            // east-west give a zonal-flow / wind-swept silhouette rather
            // than axis-aligned grid squares. Salts (991/997 + 1013/1019
            // + 1031/1033) are distinct primes from continent (113/127),
            // resource (1009/2017), and biome (197/311) so cloud
            // placement decorrelates from every other surface feature.
            if (vCloudDensity > 0.0) {
              float cCT = cos(vTilt);
              float cST = sin(vTilt);
              float clx =  d.x * cCT + d.y * cST;
              float cly = -d.x * cST + d.y * cCT;
              vec2 cloudPos = vec2(clx / CLOUD_LON_PX, cly / CLOUD_LAT_PX);
              vec2 cloudCellId = floor(cloudPos);
              vec2 cloudFrac   = cloudPos - cloudCellId;
              float minCloudD2 = 1e9;
              vec2  winnerCloudCell = cloudCellId;
              for (int dx = -1; dx <= 1; dx++) {
                for (int dy = -1; dy <= 1; dy++) {
                  vec2 off = vec2(float(dx), float(dy));
                  vec2 nCell = cloudCellId + off;
                  vec2 jitter = vec2(
                    hash21(nCell + vec2(vSeed * 991.0,  vSeed * 997.0)),
                    hash21(nCell + vec2(vSeed * 1013.0, vSeed * 1019.0))
                  );
                  vec2 nCenter = off + jitter;
                  vec2 diff = nCenter - cloudFrac;
                  float d2 = dot(diff, diff);
                  if (d2 < minCloudD2) {
                    minCloudD2 = d2;
                    winnerCloudCell = nCell;
                  }
                }
              }
              float cH = hash21(winnerCloudCell + vec2(vSeed * 1031.0, vSeed * 1033.0));
              if (cH < vCloudDensity) col = CLOUD_COLOR;
            }
          }

          // Phase 1.3a haze tint — uniform per-fragment lerp toward the
          // haze color across every surface paint (resource, ocean, ice,
          // biome, clouds). vHazeTint = 0 on bodies without a haze-class
          // chromophore so this is a no-op.
          if (vHazeTint > 0.0) col = mix(col, vHazeColor, vHazeTint);

        } else {
          // Banded atmosphere — Jupiter-style zonal flow.
          //
          // 1. Rotate disc-local d by -vTilt so ly runs across-band
          //    (acts as latitude) and lx runs along-band. vTilt is
          //    derived from the host planet's axialTiltDeg by
          //    bodyVisualTiltRad, so the band axis matches the ring
          //    plane on ringed giants.
          float cT = cos(vTilt);
          float sT = sin(vTilt);
          float lx =  d.x * cT + d.y * sT;
          float ly = -d.x * sT + d.y * cT;

          // 2. Sphere projection: reconstruct the forward-hemisphere
          //    surface normal at this fragment, then take its dot with
          //    the band-aligned pole (tipped forward by arcsin(POLE_SIN)
          //    so we peek over the top of the planet, same vantage the
          //    ring annulus is drawn from). latSin then varies as the
          //    sine of latitude on the visible sphere — bands trace
          //    out latitude-line arcs that smile across the disc rather
          //    than straight horizontal strips.
          float nx = lx / vRadius;
          float ny = ly / vRadius;
          float nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
          float latSin = ny * POLE_COS + nz * POLE_SIN;

          // 3. Per-disc band count from vRadius. Floor at 6 keeps
          //    sub-Uranus banded bodies (Venus-class rocky worlds) from
          //    rendering as 1-2 strips; cap at MAX_BAND_COUNT prevents
          //    the loops below from running past their compile-time
          //    upper bound.
          int bandCount = int(clamp(floor(vRadius * BAND_DENSITY + 0.5), 6.0, float(MAX_BAND_COUNT)));
          float bandCountF = float(bandCount);

          // 4. Boundary warp: integer along-band chunks each pick a
          //    per-chunk lat offset, so band edges undulate in coarse
          //    pixel-art stair-steps. Warp amplitude scales with band
          //    height (vRadius / bandCount) so the wobble stays
          //    proportional — always ~75% of an average band's height,
          //    visible at every disc size without leaping bands.
          float warpAmpPx = vRadius / bandCountF * 0.75;
          float chunkX = floor(lx / WARP_CHUNK_PX);
          float warp = (hash11(chunkX + vSeed * 31.0) - 0.5) * 2.0 * warpAmpPx / vRadius;
          float lat = clamp(latSin + warp, -1.0, 1.0);

          // 5. Non-uniform band edges. Each band has width 0.5 + 1.5 *
          //    hash11(i + seed*7) so seed-driven jitter alternates
          //    narrow lanes with wide zones. Two-pass: first sum the
          //    weights to get the total normalization, then walk the
          //    cumulative sum to find which band our warped lat lands
          //    in. Loops are bounded by the compile-time MAX_BAND_COUNT
          //    constant (GLSL ES requirement) with an early break on
          //    the per-disc bandCount.
          float totalW = 0.0;
          for (int i = 0; i < MAX_BAND_COUNT; i++) {
            if (i >= bandCount) break;
            totalW += 0.5 + 1.5 * hash11(float(i) + vSeed * 7.0);
          }
          float pos = (lat + 1.0) * 0.5 * totalW;
          float accum = 0.0;
          float bandIdx = 0.0;
          for (int i = 0; i < MAX_BAND_COUNT; i++) {
            if (i >= bandCount) break;
            accum += 0.5 + 1.5 * hash11(float(i) + vSeed * 7.0);
            if (pos >= accum) bandIdx = float(i + 1);
          }
          // Clamp the last-band edge case (pos can land just past accum
          // from float drift; without this the warped poles flicker to
          // bandIdx = bandCount which has no palette mapping defined).
          bandIdx = min(bandIdx, bandCountF - 1.0);

          // 6. Per-band palette pick. The * 41.0 salt keeps the
          //    band→palette hash uncorrelated from the * 7.0 salt
          //    used for band widths above.
          float h = hash11(bandIdx + vSeed * 41.0);
          col = pickFromPalette(h);

          // 7. Per-band lightness perturbation — see BAND_LIGHTNESS_JITTER
          //    block above. Uniform RGB delta preserves hue; the * 67.0
          //    salt keeps it uncorrelated from both band width (*7) and
          //    palette pick (*41).
          float lightJ = (hash11(bandIdx + vSeed * 67.0) - 0.5) * 2.0 * BAND_LIGHTNESS_JITTER;
          col = clamp(col + vec3(lightJ), 0.0, 1.0);
        }

        // Phase 1.3a/b INWARD fade — atmospheric haze visible inside
        // the disc near the limb, simulating column thickening under
        // edge-on viewing geometry. Applies to BOTH surface and banded
        // modes: surface bodies show haze over land/ocean/biome, banded
        // bodies show haze over the band paint. Width = radius ×
        // INWARD_RIM_FRACTION, purely radius-driven.
        //
        // Band widths grow as 1, 2, 3, ... px from the limb inward —
        // the sphere-projection foreshortening curve. Sampling equal
        // angular shells from the visible meridian projects to image
        // bands with widths proportional to k (the shell index), giving
        // thin bands at the limb and wider ones toward the disc center.
        // Cumulative width through band k is (k+1)(k+2)/2, so the
        // inverse map from distFromLimb d to bandIdx is:
        //   bandIdx = floor((sqrt(1 + 8d) - 1) / 2)
        //
        // Same stroke-stacking model as the outward halo: band B
        // counted from the limb inward gets coverage of (numBands - B)
        // strokes — limb-side band is most opaque, fading inward.
        if (vRimWidthPx >= 1.0) {
          float maxInward = floor(vRadius * INWARD_RIM_FRACTION);
          float distIn = vRadius - r;
          if (distIn < maxInward) {
            // Dither distFromLimb on a per-pixel hash so band boundaries
            // scatter binary across a 1–2 px transition zone instead of
            // landing on perfect concentric circles. Salts (829, 853)
            // are distinct primes from continent (113, 127), resource
            // (1009, 2017), biome (197, 311), and cloud (991/997/...).
            float dJ = hash21(floor(d) + vec2(vSeed * 829.0, vSeed * 853.0)) - 0.5;
            float distInJ = max(0.0, distIn + dJ * INWARD_BAND_DITHER);
            float bandIdx  = floor((sqrt(1.0 + 8.0 * distInJ) - 1.0) / 2.0);
            float numBands = floor((sqrt(1.0 + 8.0 * maxInward) - 1.0) / 2.0);
            float stackCount = numBands - bandIdx;
            if (stackCount > 0.0) {
              float fadeA = 1.0 - pow(1.0 - INNER_BASE_ALPHA, stackCount);
              col = mix(col, vHazeColor, fadeA);
            }
          }
        }

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

// Blob material — flat-color triangle-mesh fill for irregular polygon
// chunks (belt + debris-ring debris). Geometry is indexed triangles
// authored CPU-side in buffer-pixel coords; the rasterizer determines
// the visible silhouette. Per-vertex color (so one pool can mix
// asteroid + ice + debris hues) and per-vertex hover flag — when set,
// the fragment shader inverts the triangle to white. Every vertex in
// one chunk shares the same hover value by construction, so the whole
// polygon highlights as a unit on hover.
//
// No pixel snapping: triangle vertices are placed at CPU-rounded
// integer pixel coords and the rasterizer handles fragment coverage
// from there. The polygon silhouette is what makes a chunk feel like
// debris rather than a sprite, so any sub-pixel edge variation reads
// as a coarse-pixel-art feature rather than noise.
export function makeBlobMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float aHovered;
      varying vec3 vColor;
      varying float vHovered;
      void main() {
        vColor = color;
        vHovered = aHovered;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vHovered;
      void main() {
        vec3 col = vHovered > 0.5 ? vec3(1.0) : vColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    vertexColors: true,
    transparent: false,
    // See makePlanetMaterial — the system diagram uses vertex z to
    // bundle each planet's elements as one z-layer; the chunks need to
    // write depth too so adjacent planets' rings/discs occlude this
    // pool correctly.
    depthWrite: true,
  });
}

// Solid-fill mesh material for planetary rings — used by the
// triangle-strip annulus halves in SystemDiagram. Flat color, no
// shading, no AA. The caller provides geometry whose vertex positions
// live in the host planet's local frame (origin at planet center,
// env-pixel units); the mesh is positioned at the planet's cx/cy.
//
// The caller pre-lerps `color` from the icy/dusty palette endpoints
// based on the ring's resource mix (see bodyIcyness in data/stars.ts).
// `alpha` is similarly lerped — icy rings paint opaque (Saturn-class
// bright band) while dusty rings paint translucent (Uranus/Neptune-
// class faint dust). When alpha < 1 the material flips to transparent
// + depthWrite=false so the stars and background show through.
//
// Per-mesh uHovered uniform (0 / 1) inverts the entire fill to white
// on hover. No per-vertex outline math because the geometry is a
// continuous arc rather than a sprite — a 1-px rim would need a
// second pass.
export function makeRingMaterial(color: Color, alpha: number): ShaderMaterial {
  const transparent = alpha < 1;
  return new ShaderMaterial({
    uniforms: {
      uColor:   { value: new Color().copy(color) },
      uAlpha:   { value: alpha },
      uHovered: { value: 0 },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uHovered;
      void main() {
        vec3 col = uHovered > 0.5 ? vec3(1.0) : uColor;
        float a  = uHovered > 0.5 ? 1.0 : uAlpha;
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent,
    // See makePlanetMaterial — ring meshes ride the per-planet z
    // stride too. The back / front mesh pair sits at z slightly
    // bracketing the host planet's z so the planet disc paints over
    // the back half and the front half overpaints the planet.
    // depthWrite stays off for translucent rings so the background
    // shows through their gaps rather than masking it.
    depthWrite: !transparent,
  });
}

// Mesh-based pixel-disc material — same procedural circle as the flat
// stars material, but rasterized through a PlaneGeometry quad instead
// of a GL_POINTS sprite. The Mesh path lets the disc's center sit
// outside the viewport (above the top edge): triangle primitives are
// clipped per-fragment by the GPU, whereas GL_POINTS discards any
// point sprite whose vertex falls outside the clip volume — so the
// "star peeks down from above the screen" framing is only possible
// with the mesh path.
//
// Per-star uniforms: uCenter (buffer-pixel coords, parity-snapped by
// the caller), uRadius, uColor. Geometry should be a PlaneGeometry
// sized to fully enclose the disc bounding box (typically d×d where
// d = 2·radius). Caller positions the mesh at uCenter.
export function makeStarMeshMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCenter:  { value: new Vector2() },
      uRadius:  { value: 0 },
      uColor:   { value: new Color() },
      // Hover outline toggle (0 = off, 1 = on). One material per disc, so
      // this lives as a uniform — no need for a per-vertex attribute path
      // here. Outline rings the bottom-strip of the top-clipped disc.
      uHovered: { value: 0 },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec2 uCenter;
      uniform float uRadius;
      uniform vec3 uColor;
      uniform float uHovered;
      void main() {
        vec2 d = gl_FragCoord.xy - uCenter;
        float r = length(d);
        if (r > uRadius) discard;
        vec3 col = (uHovered > 0.5 && r > uRadius - 1.0) ? vec3(1.0) : uColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    depthWrite: false,
  });
}
