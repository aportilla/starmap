// System-view materials: flat 2D stars + chunk pool + ice ring +
// per-mesh star disc. All four are designed to render under an
// OrthographicCamera at 1 unit = 1 buffer pixel (see SystemDiagram in
// scene/system-diagram/). No depth attenuation, no pivot dim — the
// system view is a static screen layout, not a navigable 3D space.

import { Color, ShaderMaterial, Vector2 } from 'three';
import { RING_MINOR_OVER_MAJOR } from '../system-diagram/layout/constants';
import { glsl, RASTER_PAD, snappedMaterials } from './shared';

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
//   4. **Rim** — outward halo driven by aAtmoScalars.w (rimWidthPx).
//      Color is the merged-rim blend in vRimColor (cloud slot 0 +
//      surface haze contributors, or cloud + atm column on giants).
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
export function makePlanetMaterial(initialDiscScale: number): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uDiscScale: { value: initialDiscScale },
      uViewport:  { value: new Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
      // Per-body render metadata packed: x = size in px, y = hasSurface
      // (0/1 — gas giants skip the surface block), z = seed, w = tilt.
      attribute vec4  aRenderMeta;
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
      // w currently unused — reserved for layer payload in PR 3.
      attribute vec4  aWeights;
      // Cloud-layer palette + weights. Banded clouds pick per worley
      // cell from 4 slots: slot 0 = perceptual base blend (atm + cloud
      // + haze) at ~50% picker weight, slots 1-3 = accent species
      // sharing the remaining weight. Patchy clouds use slot 0 as a
      // single condensate color (weights collapse to [1, 0, 0, 0]).
      //
      // The 4 colors are packed into 3 vec4 attributes to stay under
      // gl_MaxVertexAttribs on tighter GPUs. Each slot 0/1/2 attribute
      // carries (its.r, its.g, its.b, slot3.{r,g,b}) — slot 3 is
      // reassembled in the vertex shader as
      // vec3(aCloudPalette0.w, aCloudPalette1.w, aCloudPalette2.w).
      attribute vec4  aCloudPalette0;
      attribute vec4  aCloudPalette1;
      attribute vec4  aCloudPalette2;
      attribute vec4  aCloudWeights;
      // Surface scalars: x = waterFrac, y = iceFrac, z = surfaceAge,
      // w = globalness.
      attribute vec4  aSurfaceScalars;
      // Atmosphere scalars: x = cloudCoverage [0..1], y = cloudStructure
      // (snap-binary at 0.5 — patchy vs banded), z = hazeOpacity [0..1]
      // uniform overlay alpha, w = rimWidthPx (integer 0..N halo width).
      attribute vec4  aAtmoScalars;
      // Biome stipple: xyz = pigment color, w = coverage density [0..1].
      attribute vec4  aBiomeColor;
      // Shared rim + haze-layer color + per-vertex hover flag.
      // Layout: xyz = MERGED rim/haze color (weighted-average blend
      // across cloud, photochemistry haze, scattering, and dust — see
      // disc-palette.ts), w = hover flag (0/1, flipped by setHovered).
      // Conflated to keep the attribute count under gl_MaxVertexAttribs.
      attribute vec4  aHazeColor;

      varying float vRadius;
      varying vec2  vCenter;
      varying float vHovered;
      varying vec3  vPalette0;
      varying vec3  vPalette1;
      varying vec3  vPalette2;
      varying vec4  vWeights;
      varying vec3  vCloudPalette0;
      varying vec3  vCloudPalette1;
      varying vec3  vCloudPalette2;
      varying vec3  vCloudPalette3;
      varying vec4  vCloudWeights;
      varying float vHasSurface;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying float vSurfaceAge;
      varying float vGlobalness;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying float vCloudCoverage;
      varying float vCloudStructure;
      varying float vHazeOpacity;
      varying float vRimWidthPx;
      varying vec3  vHazeColor;
      varying vec3  vRimColor;
      uniform float uDiscScale;
      uniform vec2  uViewport;
      void main() {
        vHovered  = aHazeColor.w;
        vRimColor = vec3(aPalette0.w, aPalette1.w, aPalette2.w);
        vPalette0 = aPalette0.xyz;
        vPalette1 = aPalette1.xyz;
        vPalette2 = aPalette2.xyz;
        vWeights  = aWeights;
        vCloudPalette0 = aCloudPalette0.xyz;
        vCloudPalette1 = aCloudPalette1.xyz;
        vCloudPalette2 = aCloudPalette2.xyz;
        vCloudPalette3 = vec3(aCloudPalette0.w, aCloudPalette1.w, aCloudPalette2.w);
        vCloudWeights  = aCloudWeights;
        vHasSurface = aRenderMeta.y;
        vSeed       = aRenderMeta.z;
        vTilt       = aRenderMeta.w;
        vWaterFrac  = aSurfaceScalars.x;
        vIceFrac    = aSurfaceScalars.y;
        vSurfaceAge = aSurfaceScalars.z;
        vGlobalness = aSurfaceScalars.w;
        vCloudCoverage  = aAtmoScalars.x;
        vCloudStructure = aAtmoScalars.y;
        vHazeOpacity    = aAtmoScalars.z;
        vRimWidthPx     = aAtmoScalars.w;
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
        gl_PointSize = sz + ${glsl(RASTER_PAD)} + 2.0 * aAtmoScalars.w;
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
      varying vec3  vCloudPalette0;
      varying vec3  vCloudPalette1;
      varying vec3  vCloudPalette2;
      varying vec3  vCloudPalette3;
      varying vec4  vCloudWeights;
      varying float vHasSurface;
      varying float vSeed;
      varying float vTilt;
      varying float vWaterFrac;
      varying float vIceFrac;
      varying float vSurfaceAge;
      varying float vGlobalness;
      varying vec3  vBiomeColor;
      varying float vBiomeCoverage;
      varying float vCloudCoverage;
      varying float vCloudStructure;
      varying float vHazeOpacity;
      varying float vRimWidthPx;
      varying vec3  vHazeColor;
      varying vec3  vRimColor;

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
      // where the 3 palette slots all reduce to a single near-beige
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

      // Ocean fill color for sub-sea-level continent cells. Deep navy
      // — desaturated enough not to fight resource palette hues on
      // adjacent land cells, dark enough to read as "below sealevel"
      // against bright icy resource patches.
      const vec3 OCEAN_COLOR = vec3(0.16, 0.34, 0.55);

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

      // Outward atmospheric halo — paints OUTSIDE the disc, 0..3 px wide
      // driven by atmospheric column depth (see rimWidthFor* in
      // disc-palette.ts). No inward fade — the flat pixel aesthetic
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
      const float OUTER_BASE_ALPHA = 0.35;

      // Phase 1.5b — per-region resource-subset selection. Aggregate
      // REGION_PATCH_FACTOR fine worley cells per axis into one
      // super-cell. The super-cell hash picks one of
      // REGION_BUCKET_COUNT (= 2^3 - 1 = 7) non-empty subsets of the
      // body's three palette slots; that subset masks the body's
      // natural weights, and the fine cell pick within the super-cell
      // paints from the masked palette. Net visual: each region
      // carries a distinct combination of the body's top-3 resource
      // colors — Mercury's iron-grey, rare-earth rose, and silicate
      // rust separate into spatial regions rather than mixing
      // uniformly across the disc. This replaces the prior uniform-
      // RGB lightness modifier (which collapsed multi-resource bodies
      // to muddy shading on top of a uniform underlying texture);
      // resource-based regions stay pixel-crisp and palette-coherent.
      //
      // 6 → ~2-3 super-cells across the visible hemisphere of a 60-px
      // disc, the scale at which real planetary regional composition
      // dichotomies live (Ganymede's dark/light terrain, Mars's polar
      // plains vs. southern highlands, Mercury's regional albedo
      // patches). Inherits the fine worley pass's boundary
      // irregularity for free (super-cell edges are jittery, not
      // grid-aligned).
      const float REGION_PATCH_FACTOR = 6.0;
      const float REGION_BUCKET_COUNT = 7.0;

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

      float hash11(float x) {
        return fract(sin(x * 12.9898 + 78.233) * 43758.5453);
      }
      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // Pick one of three palette entries by a 0..1 hash, weighted by
      // the supplied weights. Skips zero-weight slots automatically.
      // Defensive fallback: weights summing to zero → p0 (palette0 is
      // always plumbed with the dominant signal).
      //
      // Used by the surface block (resource palette + region-masked
      // weights). The cloud-banded path uses pickFromCloudPalette
      // (4 slots) instead.
      vec3 pickFromPalette(float h, vec3 p0, vec3 p1, vec3 p2, vec3 weights) {
        float w = weights.x + weights.y + weights.z;
        if (w <= 0.0) return p0;
        float t = h * w;
        if (t < weights.x) return p0;
        if (t < weights.x + weights.y) return p1;
        return p2;
      }

      // 4-slot variant for the cloud-banded path: slot 0 carries the
      // perceptual base blend (atm + cloud + haze) at fixed
      // BASE_BLEND_WEIGHT, slots 1-3 carry top accent species sharing
      // the remaining weight. Picker is otherwise identical to
      // pickFromPalette — frequency-weighted, not blended.
      vec3 pickFromCloudPalette(float h, vec3 p0, vec3 p1, vec3 p2, vec3 p3, vec4 weights) {
        float w = weights.x + weights.y + weights.z + weights.w;
        if (w <= 0.0) return p0;
        float t = h * w;
        if (t < weights.x) return p0;
        if (t < weights.x + weights.y) return p1;
        if (t < weights.x + weights.y + weights.z) return p2;
        return p3;
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
        // contributors (see disc-palette.ts).
        if (r > vRadius) {
          if (r > vRadius + vRimWidthPx || vRimWidthPx < 1.0) discard;
          float distOut = r - vRadius;
          float layer = floor(distOut);
          float stackCount = vRimWidthPx - layer;
          float rimA = 1.0 - pow(1.0 - OUTER_BASE_ALPHA, stackCount);
          gl_FragColor = vec4(vRimColor, rimA);
          return;
        }

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

        vec3 col;
        if (vHasSurface > 0.5) {
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
          // Track F1 (closest) AND F2 (second-closest) cells. F2-F1
          // worley distance is the cell-boundary distance the 1.5d
          // linea pass uses to draw cracks along cell edges. Closest
          // TWO cells to any fragment in the central cell are always
          // adjacent to it, so the 3x3 neighborhood scan is sufficient
          // — no off-window candidates can sneak past.
          float minDist2 = 1e9;
          float secondMinDist2 = 1e9;
          vec2  winnerCell = cellId;
          vec2  secondCell = cellId;
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
                secondMinDist2 = minDist2;
                secondCell = winnerCell;
                minDist2 = d2;
                winnerCell = nCell;
              } else if (d2 < secondMinDist2) {
                secondMinDist2 = d2;
                secondCell = nCell;
              }
            }
          }

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
          // 701/719 stay distinct from every other surface pass — see
          // "Hash-salt budget" in PLANET-RENDER-PLAN.md.
          bool  capActive      = vGlobalness < CAP_GLOBALNESS_MAX;
          // Per-cell threshold jitter so the cap boundary follows the
          // worley grid's jittered shapes instead of reading as a clean
          // foreshortened ellipse. Cells near the boundary go in or out
          // by hash; cells well inside / outside are unaffected. Amplitude
          // scales with iceFrac so Mars's tiny cap (iceFrac 0.02) gets a
          // ~±0.01 wobble while Earth's larger cap (iceFrac 0.10) gets
          // ~±0.05 — clamped to keep very-small caps visible and very-
          // large caps from dissolving into noise. Salts 233/239 distinct
          // from every other surface pass.
          float capJitterH    = hash21(winnerCell + vec2(vSeed * 233.0, vSeed * 239.0));
          float capJitterAmp  = clamp(vIceFrac * 0.6, 0.01, 0.08);
          float capJitter     = (capJitterH - 0.5) * 2.0 * capJitterAmp;
          bool  capIcyHere    = capActive && (abs(latSinDisc) + capJitter) > (1.0 - vIceFrac);
          float cellHashIce    = hash21(winnerCell + vec2(vSeed * 701.0, vSeed * 719.0));
          // Cold bodies push iceFrac toward 1.0 (Europa-class: cold AND
          // water-bearing → full shell rather than polar caps). Gated on
          // vIceFrac > 0 so the boost doesn't fabricate ice on a cold
          // body that has none in its composition — Io (lava class,
          // 110 K, iceFraction=0) would otherwise render as a solid
          // ICE_COLOR disc because the cold-→global rule overrode its
          // actual zero ice content.
          float frozenBoost    = smoothstep(0.8, 1.0, vGlobalness) * step(0.01, vIceFrac);
          float effectiveIceFrac = mix(vIceFrac, 1.0, frozenBoost);
          bool  globalIcyHere  = !capActive && cellHashIce > (1.0 - effectiveIceFrac);
          bool  icyHere        = capIcyHere || globalIcyHere;

          // CONTINENT_GROUP-sized blocks of worley cells share one
          // ocean/land coin flip. Salt offset from the resource-pick
          // hash so the two scales decorrelate. The OCEAN_COLOR
          // override only fires on bodies warm enough for liquid
          // surface water — on a cold body (vGlobalness > 0.5, T <
          // ~225 K), water exists but as ice, so "water cells" fall
          // back to the resource palette (which on a volatile-rich
          // body like Europa reads as pale-ice colored anyway). This
          // keeps the dark-blue ocean from punching through the ice
          // shell on cryogenic moons whose surface is globally
          // frozen; the linea pass below carries the non-ice signal
          // on those bodies.
          vec2 contCell = floor(winnerCell / CONTINENT_GROUP);
          float contH = hash21(contCell + vec2(vSeed * 113.0, vSeed * 127.0));
          bool  waterHere = contH < vWaterFrac;
          bool  liquidOceanHere = waterHere && vGlobalness < 0.5;

          // Phase 1.5b — per-region resource-subset selection. The
          // super-cell hash discretizes into one of REGION_BUCKET_COUNT
          // non-empty subsets of {palette0, palette1, palette2}; the
          // subset masks the body's weights so each region paints from
          // a different combination of its top-3 resources. The
          // complement of the same bucket drives the subsurface — what
          // the crater branch exposes.
          vec2 regionCell = floor(winnerCell / REGION_PATCH_FACTOR);
          float regionH = hash21(regionCell + vec2(vSeed * 401.0, vSeed * 419.0));
          float bucketF = clamp(floor(regionH * REGION_BUCKET_COUNT), 0.0, REGION_BUCKET_COUNT - 1.0);
          int bucket = int(bucketF);
          vec3 mask;
          if      (bucket == 0) mask = vec3(1.0, 0.0, 0.0);
          else if (bucket == 1) mask = vec3(0.0, 1.0, 0.0);
          else if (bucket == 2) mask = vec3(0.0, 0.0, 1.0);
          else if (bucket == 3) mask = vec3(1.0, 1.0, 0.0);
          else if (bucket == 4) mask = vec3(1.0, 0.0, 1.0);
          else if (bucket == 5) mask = vec3(0.0, 1.0, 1.0);
          else                  mask = vec3(1.0, 1.0, 1.0);
          vec3 regionWeights = vWeights.xyz * mask;
          float resH = hash21(winnerCell + vec2(vSeed * 1009.0, vSeed * 2017.0));
          vec3 landCol = pickFromPalette(resH, vPalette0, vPalette1, vPalette2, regionWeights);

          // Biome stipple paints over land cells in the temperate band.
          // Per-pixel hash flips individual land pixels to the body's
          // biome color (archetype × stellar shift; see biomePaintFor).
          // Salts (197, 311) distinct from continent / resource hashes
          // so a single pixel doesn't draw the same noise stream twice.
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
              float bH = hash21(floor(d) + vec2(vSeed * 197.0, vSeed * 311.0));
              if (bH < effective) landCol = vBiomeColor;
            }
          }
          vec3 resourceSurface = liquidOceanHere ? OCEAN_COLOR : landCol;

          // Subsurface (complement bucket) — drives crater color. Same
          // resource hash so the surface and subsurface picks correlate
          // per cell; only the mask differs.
          vec3 subMask;
          if      (bucket == 0) subMask = vec3(0.0, 1.0, 1.0);
          else if (bucket == 1) subMask = vec3(1.0, 0.0, 1.0);
          else if (bucket == 2) subMask = vec3(1.0, 1.0, 0.0);
          else if (bucket == 3) subMask = vec3(0.0, 0.0, 1.0);
          else if (bucket == 4) subMask = vec3(0.0, 1.0, 0.0);
          else if (bucket == 5) subMask = vec3(1.0, 0.0, 0.0);
          else                  subMask = vec3(1.0, 1.0, 1.0);
          vec3 subWeights = vWeights.xyz * subMask;
          vec3 resourceSubsurface = pickFromPalette(resH, vPalette0, vPalette1, vPalette2, subWeights);

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
              float existH = hash21(nCell + vec2(vSeed * 547.0, vSeed * 569.0));
              if (existH > craterDensity) continue;
              float jx = hash21(nCell + vec2(vSeed * 587.0, vSeed * 547.0));
              float jy = hash21(nCell + vec2(vSeed * 569.0, vSeed * 587.0));
              vec2  cCenter = off + vec2(jx, jy);
              float rH = hash21(nCell + vec2(vSeed * 569.0, vSeed * 547.0));
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
                  float craterAgeH = hash21(nCell + vec2(vSeed * 631.0, vSeed * 641.0));
                  if (craterAgeH < RAY_AGE_THRESHOLD) {
                    // Size-driven ray count: tiny crater → MIN, big
                    // crater → MAX. Clamp guards the radiusNorm = 1
                    // edge from rounding past MAX.
                    float numRays = clamp(
                      RAY_COUNT_MIN + floor(radiusNorm * (RAY_COUNT_MAX - RAY_COUNT_MIN + 1.0)),
                      RAY_COUNT_MIN, RAY_COUNT_MAX);
                    float baseAngle = hash21(nCell + vec2(vSeed * 653.0, vSeed * 659.0)) * TWO_PI;
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
                    float perRayH   = hash21(nCell + vec2(vSeed * 677.0 + wedgeIdx, vSeed * 683.0));
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
            float pjx = hash21(paintCraterId + vec2(vSeed * 587.0, vSeed * 547.0));
            float pjy = hash21(paintCraterId + vec2(vSeed * 569.0, vSeed * 587.0));
            vec2  pCenter = (paintCraterId + vec2(pjx, pjy)) * CRATER_PATCH_FACTOR;
            vec2  pRegionCell = floor(pCenter / REGION_PATCH_FACTOR);
            float pRegionH = hash21(pRegionCell + vec2(vSeed * 401.0, vSeed * 419.0));
            int   pBucket = int(clamp(floor(pRegionH * REGION_BUCKET_COUNT), 0.0, REGION_BUCKET_COUNT - 1.0));
            vec3  pSubMask;
            if      (pBucket == 0) pSubMask = vec3(0.0, 1.0, 1.0);
            else if (pBucket == 1) pSubMask = vec3(1.0, 0.0, 1.0);
            else if (pBucket == 2) pSubMask = vec3(1.0, 1.0, 0.0);
            else if (pBucket == 3) pSubMask = vec3(0.0, 0.0, 1.0);
            else if (pBucket == 4) pSubMask = vec3(0.0, 1.0, 0.0);
            else if (pBucket == 5) pSubMask = vec3(1.0, 0.0, 0.0);
            else                   pSubMask = vec3(1.0, 1.0, 1.0);
            float pPalH = hash21(paintCraterId + vec2(vSeed * 587.0, vSeed * 569.0));
            vec3 pRevealCol = pickFromPalette(pPalH, vPalette0, vPalette1, vPalette2, vWeights.xyz * pSubMask);

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
          // the fragment is on). Salts 743/761 — distinct primes from
          // every other surface-pass salt.
          if (icyHere && (vIceFrac * vSurfaceAge) > LINEA_BODY_THRESHOLD) {
            float edgeDist = sqrt(secondMinDist2) - sqrt(minDist2);
            if (edgeDist < LINEA_WIDTH_FRAC) {
              vec2 edgeKey = winnerCell + secondCell;
              float edgeH = hash21(edgeKey + vec2(vSeed * 743.0, vSeed * 761.0));
              if (edgeH < LINEA_DENSITY) {
                col = resourceSubsurface;
              }
            }
          }

        } else {
          // No surface — gas / ice giant. The cloud layer below will
          // paint full-coverage bands over this fallback; the fallback
          // shows through only if cloudCoverage somehow drops below 1.0.
          col = vCloudPalette0;
        }

        // ── Cloud layer ──
        // Two geometries, chosen per body by vCloudStructure:
        //   < 0.5 (patchy): anisotropic worley cells in the sphere-
        //     projected (lon, lat) frame. Per-cell hash < vCloudCoverage
        //     paints the condensate color (vCloudPalette0). Earth's
        //     trade-wind cumulus, Mars's sparse cirrus.
        //   ≥ 0.5 (banded): two-layer worley stack in the same (lon,
        //     lat) frame, cells stretched east-west so the natural
        //     Voronoi tessellation forms strips along the rotation
        //     axis. Per-cell color hashed off the cell's lat component
        //     only → cells in one lat track share a color, so bands
        //     read parallel to the equator. Painted at alpha =
        //     vCloudCoverage. Jupiter / Saturn / Uranus / Neptune /
        //     Venus.
        if (vCloudCoverage > 0.0) {
          vec3 cloudCol = vec3(0.0);
          float cloudAlpha = 0.0;

          if (vCloudStructure < 0.5) {
            // Patchy clouds — sphere-projected anisotropic worley in the
            // same (lon, lat) frame as the surface beneath, so cloud
            // cells compress toward the limb together with continents
            // rather than floating flat over a globe. Cell pitch scales
            // by vRadius / CLOUD_LON_PX so disc-center cells stay at the
            // equivalent pixel size across disc sizes. CLOUD_LON_PX >
            // CLOUD_LAT_PX gives east-west stretch (zonal-flow direction).
            // Salts (991/997 + 1013/1019 + 1031/1033) distinct from every
            // other hash pass.
            vec2 cloudPos = vec2(lon, lat) * vRadius / vec2(CLOUD_LON_PX, CLOUD_LAT_PX);
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
            if (cH < vCloudCoverage) {
              cloudCol = vCloudPalette0;
              cloudAlpha = 1.0;
            }
          } else {
            // Banded clouds — two anisotropic worley layers in the
            // same sphere-projected (lon, lat) frame the surface and
            // patchy-cloud paths use. Cells are stretched east-west so
            // the natural Voronoi tessellation forms strips along the
            // rotation axis. Per-cell color is hashed off the cell's
            // LAT component only, so cells in the same latitude track
            // resolve to the same palette pick — the bands read as
            // parallel to the equator. Worley's natural jitter wobbles
            // the lon boundaries between adjacent bands, no separate
            // warp pass needed.
            //
            // Two layers compose, the detail layer over-painting the
            // primary on cells whose existence hash falls under
            // DETAIL_COVERAGE — the rest pass the primary through.

            // Primary band layer.
            vec2 p1 = vec2(lon, lat) * vRadius / vec2(BAND1_LON_PX, BAND1_LAT_PX);
            vec2 cellId1  = floor(p1);
            vec2 cellFrac1 = p1 - cellId1;
            vec2 winnerCell1 = cellId1;
            float minD1 = 1e9;
            for (int dx = -1; dx <= 1; dx++) {
              for (int dy = -1; dy <= 1; dy++) {
                vec2 off = vec2(float(dx), float(dy));
                vec2 nCell = cellId1 + off;
                vec2 jitter = vec2(
                  hash21(nCell + vec2(vSeed * 1103.0, vSeed * 1117.0)),
                  hash21(nCell + vec2(vSeed * 1129.0, vSeed * 1151.0))
                );
                vec2 nCenter = off + jitter;
                vec2 diff = nCenter - cellFrac1;
                float d2 = dot(diff, diff);
                if (d2 < minD1) {
                  minD1 = d2;
                  winnerCell1 = nCell;
                }
              }
            }
            float h1 = hash11(winnerCell1.y + vSeed * 41.0);
            vec3 col1 = pickFromCloudPalette(h1, vCloudPalette0, vCloudPalette1, vCloudPalette2, vCloudPalette3, vCloudWeights);
            float lj1 = (hash11(winnerCell1.y + vSeed * 67.0) - 0.5) * 2.0 * BAND_LIGHTNESS_JITTER;
            cloudCol = clamp(col1 + vec3(lj1), 0.0, 1.0);

            // Detail layer — smaller pitch, partial coverage. Cells
            // whose existence hash > DETAIL_COVERAGE pass the primary
            // through; the rest paint their own lat-coherent pick over.
            vec2 p2 = vec2(lon, lat) * vRadius / vec2(BAND2_LON_PX, BAND2_LAT_PX);
            vec2 cellId2  = floor(p2);
            vec2 cellFrac2 = p2 - cellId2;
            vec2 winnerCell2 = cellId2;
            float minD2 = 1e9;
            for (int dx = -1; dx <= 1; dx++) {
              for (int dy = -1; dy <= 1; dy++) {
                vec2 off = vec2(float(dx), float(dy));
                vec2 nCell = cellId2 + off;
                vec2 jitter = vec2(
                  hash21(nCell + vec2(vSeed * 1163.0, vSeed * 1171.0)),
                  hash21(nCell + vec2(vSeed * 1181.0, vSeed * 1193.0))
                );
                vec2 nCenter = off + jitter;
                vec2 diff = nCenter - cellFrac2;
                float d2 = dot(diff, diff);
                if (d2 < minD2) {
                  minD2 = d2;
                  winnerCell2 = nCell;
                }
              }
            }
            float existH = hash21(winnerCell2 + vec2(vSeed * 1201.0, vSeed * 1213.0));
            if (existH < DETAIL_COVERAGE) {
              float h2 = hash11(winnerCell2.y + vSeed * 79.0);
              vec3 col2 = pickFromCloudPalette(h2, vCloudPalette0, vCloudPalette1, vCloudPalette2, vCloudPalette3, vCloudWeights);
              float lj2 = (hash11(winnerCell2.y + vSeed * 83.0) - 0.5) * 2.0 * BAND_LIGHTNESS_JITTER;
              cloudCol = clamp(col2 + vec3(lj2), 0.0, 1.0);
            }

            cloudAlpha = vCloudCoverage;
          }

          col = mix(col, cloudCol, cloudAlpha);
        }

        // ── Haze layer ──
        // Surface bodies: uniform per-fragment lerp toward the aerosol
        // color. Models a well-mixed aerosol blanket (Titan tholin
        // ≈ 0.85, Venus sulfate ≈ 0.7, Mars dust ≈ 0.15, Earth = 0).
        //
        // No-surface bodies (gas / ice giants) skip the uniform
        // overlay. Their "haze" species — Jovian NH4SH, hot-Jupiter
        // silicate — is actually banded chromophore chemistry with
        // structure, not a uniform aerosol. It already feeds the
        // cloud-band palette as an accent (so the species shows up in
        // specific bands) and drives the rim color; running an
        // additional uniform mix would crush every band toward the
        // aerosol color and erase the structure.
        if (vHazeOpacity > 0.0 && vHasSurface > 0.5) {
          col = mix(col, vHazeColor, vHazeOpacity);
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
