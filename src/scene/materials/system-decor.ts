// System-view decor materials: chunk-pool fill (belts), the dithered-
// density ring annulus (translucent floor + stippled ringlet overlay +
// planet shadow), per-mesh star disc, outer star halo. All render under an
// OrthographicCamera at 1 unit = 1 buffer pixel. The big planet/moon disc
// material lives in ./planet; shared Bayer dither, hue-direction
// saturation, and star-crescent lighting GLSL come from ./chunks.

import { AdditiveBlending, Color, ShaderMaterial, Vector2 } from 'three';
import { MAX_LIGHTS, BAYER4_GLSL, HASH_GLSL, HUEDIR_GLSL, STAR_CRESCENT_LIGHTING_GLSL } from './chunks';

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
    uniforms: {
      // Body lighting — same contract as makePlanetMaterial. Each chunk
      // is treated as a tiny sphere clipped to its irregular polygon
      // silhouette; the fragment shader reconstructs the chunk-local
      // sphere normal from gl_FragCoord vs the per-chunk center +
      // extent (threaded via aChunkCenter/aChunkSize attributes), then
      // applies per-light Lambert + banded tint identical to the
      // planet shader. See writeLightUniforms in lighting.ts.
      uLightCount:     { value: 0 },
      uLightPos:       { value: Array.from({ length: MAX_LIGHTS }, () => new Vector2()) },
      uLightColor:     { value: Array.from({ length: MAX_LIGHTS }, () => new Color()) },
      uLightIntensity: { value: new Float32Array(MAX_LIGHTS) },
    },
    vertexShader: `
      attribute float aHovered;
      // Each vertex carries its CHUNK's center + half-extent (same value
      // across every vertex of a single chunk) so the fragment shader
      // can reconstruct the chunk's local sphere normal without a per-
      // primitive uniform path.
      attribute vec2  aChunkCenter;
      attribute float aChunkSize;
      // Off-deposit color + blend direction (both constant across a
      // chunk's vertices). aColorB is the belt's OTHER deposit hue; the
      // fragment shader dithers a directional hint of it into the chunk
      // along aBlendDir, so each rock reads as its primary mineral
      // tinged by the belt's second deposit from one side.
      attribute vec3  aColorB;
      attribute vec2  aBlendDir;
      varying vec3  vColor;
      varying float vHovered;
      varying vec2  vChunkCenter;
      varying float vChunkSize;
      varying vec3  vColorB;
      varying vec2  vBlendDir;
      void main() {
        vColor = color;
        vHovered = aHovered;
        vChunkCenter = aChunkCenter;
        vChunkSize   = aChunkSize;
        vColorB      = aColorB;
        vBlendDir    = aBlendDir;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3  vColor;
      varying float vHovered;
      varying vec2  vChunkCenter;
      varying float vChunkSize;
      varying vec3  vColorB;
      varying vec2  vBlendDir;
      uniform int       uLightCount;
      uniform vec2      uLightPos[${MAX_LIGHTS}];
      uniform vec3      uLightColor[${MAX_LIGHTS}];
      uniform float     uLightIntensity[${MAX_LIGHTS}];

      // Bayer dither + star-crescent lighting, shared with the planet
      // shader via ./chunks. Same crescent model at a smaller scale — at
      // chunk-radius 2-6 px the LIT band gives a 1-3 px colored limb
      // highlight and the HOT band pins the brightest 1-2 limb pixels.
      ${BAYER4_GLSL}
      ${STAR_CRESCENT_LIGHTING_GLSL}

      // Peak coverage of the off-deposit stipple on the strong side of
      // the chunk (fades to 0 on the far side). Kept low so the chunk
      // reads as its primary mineral with a directional tinge of the
      // belt's other deposit, not a two-tone split. Eyeball-tuned.
      const float OFFCOLOR_HINT = 0.4;

      void main() {
        // Hover wins early — chunks under hover flip to solid white
        // exactly like the previous behavior; lighting doesn't paint
        // over the highlight.
        if (vHovered > 0.5) {
          gl_FragColor = vec4(1.0);
          return;
        }

        // chunkR floor at 1 px keeps the tiniest chunks (size = 2 px
        // half-extent) from divide-by-zero on the normalize. dLocal +
        // chunkR are reused below for the sphere normal.
        vec2 dLocal = gl_FragCoord.xy - vChunkCenter;
        float chunkR = max(vChunkSize, 1.0);

        // Directional off-deposit hint: a 0→1 ramp over the FAR HALF of
        // the chunk along vBlendDir (clamping proj drops the near half to
        // 0, so only ~half the rock is stippled), scaled to OFFCOLOR_HINT
        // and stippled via an offset Bayer sample (distinct from the
        // crescent fringe seeds) so one side picks up a sparse stipple of
        // the other deposit's color that fades to none toward the middle.
        float proj = dot(dLocal, normalize(vBlendDir)) / chunkR;   // ~[-1, 1]
        float ramp = clamp(proj, 0.0, 1.0);
        float bOff = bayer4(gl_FragCoord.xy + vec2(19.0, 5.0));
        vec3 col = (ramp * OFFCOLOR_HINT > bOff) ? vColorB : vColor;

        // Per-fragment sphere lighting — treat the chunk as a unit-disc-
        // inscribed shape. Polygon silhouette already clips the
        // rasterizer to the chunk's actual outline; the disc math just
        // yields a smooth depth signal inside the polygon.
        float tSq = dot(dLocal, dLocal) / (chunkR * chunkR);
        float nz = sqrt(max(0.0, 1.0 - tSq));
        vec3 N = vec3(dLocal / chunkR, nz);
        col = applyStarCrescent(col, N, vChunkCenter);

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

// Ring material for planetary rings — a solid translucent floor disc with
// a dithered ringlet structure layered on top, used by the triangle-strip
// annulus halves in SystemDiagram. The floor gives the ring its body
// (a smooth translucent band); the Bayer-stippled overlay paints brighter,
// more-opaque ringlets — broad + fine bands, one Cassini-like gap, faint
// azimuthal break-up — so the structure reads as ring detail rather than
// scattered noise. No AA, no smooth radial gradient: the only soft term is
// the per-pixel alpha of the floor, everything structural is stippled.
//
// The caller provides geometry carrying `aRho` (0 inner edge → 1 outer
// edge) and `aAngle` (0..1 around the full ellipse), with positions in the
// host planet's local frame. `color` is pre-lerped from the icy/dusty
// palette endpoints by the ring's resource mix (see bodyIcyness in
// color-science.ts). `floorAlpha` is the lerped icy↔dusty opacity of the
// solid floor (RING_FLOOR_ALPHA_*): icy rings ride a near-solid floor,
// dusty rings a faint one. `seed` is a per-ring [0,1) hash that jitters
// band frequencies / phases / gap position so two rings never comb-align.
//
// The shadow block (gated by uHasShadow) casts the host planet's shadow
// onto the ring: it reconstructs a faked-3D fragment position (screen x,y
// exact, depth from the parametric angle) and hard-cuts the arc inside the
// planet's down-sun shadow cylinder. RingsLayer writes the per-layout
// shadow inputs (center, normalized radii, dominant-star direction) — see
// its writeShadowUniforms.
//
// Per-mesh uHovered uniform (0 / 1) fills the entire annulus solid white
// on hover — matches the blob/disc hover convention.
export function makeRingMaterial(color: Color, floorAlpha: number, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor:      { value: new Color().copy(color) },
      uFloorAlpha: { value: floorAlpha },
      uSeed:       { value: seed },
      uHovered:    { value: 0 },
      // Planet-shadow inputs, written per layout by RingsLayer (see
      // setLightSources / layout). uCenter is the host planet's screen-px
      // center (so gl_FragCoord - uCenter is the planet-local offset);
      // uInvOuterR / uInnerNorm / uPlanetNorm normalize the fragment into
      // outerR units; uLightDir2D is the unit screen direction toward the
      // dominant star. uHasShadow gates the whole block off when no light
      // resolves.
      uCenter:     { value: new Vector2() },
      uInvOuterR:  { value: 0 },
      uInnerNorm:  { value: 0 },
      uPlanetNorm: { value: 0 },
      uLightDir2D: { value: new Vector2() },
      uHasShadow:  { value: 0 },
    },
    vertexShader: `
      attribute float aRho;
      attribute float aAngle;
      varying float vRho;
      varying float vAngle;
      void main() {
        vRho   = aRho;
        vAngle = aAngle;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3  uColor;
      uniform float uFloorAlpha;
      uniform float uSeed;
      uniform float uHovered;
      uniform vec2  uCenter;
      uniform float uInvOuterR;
      uniform float uInnerNorm;
      uniform float uPlanetNorm;
      uniform vec2  uLightDir2D;
      uniform float uHasShadow;
      varying float vRho;
      varying float vAngle;

      ${BAYER4_GLSL}
      ${HASH_GLSL}

      // Planet-shadow on the ring. The annulus is a circle viewed at an
      // inclination whose cosine IS RING_MINOR_OVER_MAJOR (0.20), so the
      // depth we don't draw is SIN_PHI of the minor-axis displacement —
      // enough to reconstruct a faked-3D fragment position and cast the
      // planet's shadow cylinder down-sun. Plausible, not physical: it
      // tracks WHICH SIDE the star is on (the point), not ephemeris.
      const float SIN_PHI = 0.9798;   // sqrt(1 - 0.20^2)
      // Depth of the light along the view axis (the in-plane component is
      // unit-length, so this is measured relative to 1). Above ~1 the depth
      // dominates after normalization: the sun reads as sitting far BEHIND
      // the scene, casting the shadow forward onto the ring — rather than
      // grazing down from above (small values). Positive keeps the sun on
      // the far side so the FRONT arc darkens; flipping the sign moves the
      // shadow to the opposite arc.
      const float LIGHT_Z = 1.8;
      // Brightness inside the shadow. Not 0 — a shadowed ring still reads
      // faintly, so the silhouette doesn't look chunk-missing.
      const float SHADOW_DARK = 0.30;

      // Ringlet frequencies (radians of phase swept across the radial
      // span). F1 is the broad-band set (~3-5 ringlets at the band's
      // pixel scale); F2 overlays a finer ripple. Ranges keep the
      // structure reading as banding rather than a high-frequency buzz.
      const float F1_MIN = 9.0;
      const float F1_MAX = 16.0;
      const float F2_MIN = 22.0;
      const float F2_MAX = 34.0;

      // One Cassini-like division: a hard notch centered in the mid-band
      // (kept off the edges so it reads as an internal gap, not an edge
      // erosion). It cuts the floor AND the ringlet overlay to nothing.
      // HALF_WIDTH is its radial half-extent in rho.
      const float GAP_POS_MIN    = 0.35;
      const float GAP_POS_MAX    = 0.62;
      const float GAP_HALF_WIDTH = 0.05;

      // Faint per-arc variation so the ring isn't a perfect radially-
      // symmetric stencil. Bucketed into AZIMUTH_CELLS sectors and kept
      // low-amplitude — concentric rings ARE near-symmetric, so this is
      // just enough to break the stencil look.
      const float AZIMUTH_CELLS   = 7.0;
      const float AZIMUTH_BREAKUP = 0.18;

      // Extra opacity a lit (stipple-plotted) ringlet pixel adds on top of
      // the floor — dense bands push toward near-opaque.
      const float BAND_ALPHA = 0.42;

      // Tone (not hue) tracks structure: floor pixels paint dim, lit
      // ringlet pixels paint slightly hot. Gentle spread around 1.0 keeps
      // the resource hue dominant — contrast, not recoloring.
      const float FLOOR_DIM   = 0.72;
      const float BAND_BRIGHT = 1.12;

      // Per-band brightness jitter: the broad ringlets are quantized into
      // discrete bands and each is hashed to its own multiplier, so some
      // ringlets render lighter than their neighbors instead of every band
      // sharing one tone (Saturn's bright B-ring vs dimmer A-ring read).
      // Applied to brightness, with a mild coupling into opacity so a
      // lighter band also sits a touch more solid.
      const float BAND_JITTER_MIN = 0.78;
      const float BAND_JITTER_MAX = 1.38;

      void main() {
        // Hover wins early — solid white over the whole annulus.
        if (uHovered > 0.5) { gl_FragColor = vec4(1.0); return; }

        float rho = vRho;

        // Seed-derived band parameters — stable per ring, varied across
        // rings.
        float f1  = mix(F1_MIN, F1_MAX, hash11(uSeed + 1.0));
        float f2  = mix(F2_MIN, F2_MAX, hash11(uSeed + 2.0));
        float p1  = hash11(uSeed + 3.0) * 6.2831853;
        float p2  = hash11(uSeed + 4.0) * 6.2831853;
        float gap = mix(GAP_POS_MIN, GAP_POS_MAX, hash11(uSeed + 5.0));

        // 0 at the gap center, ramping to 1 at GAP_HALF_WIDTH away — cuts
        // both floor and ringlets so the division reads as empty space.
        float gapMask = smoothstep(0.0, GAP_HALF_WIDTH, abs(rho - gap));

        // Ringlet density profile in [0,1] (broad × fine bands, broken up
        // azimuthally). Drives the dither threshold for the overlay only;
        // the floor is uniform.
        float ringlets = (0.65 + 0.35 * sin(rho * f1 + p1))
                       * (0.80 + 0.20 * sin(rho * f2 + p2));
        ringlets *= 1.0 - AZIMUTH_BREAKUP * hash11(floor(vAngle * AZIMUTH_CELLS) + uSeed);
        ringlets = clamp(ringlets, 0.0, 1.0);

        // Stipple gate for the overlay: a ringlet pixel lights when its
        // density beats the Bayer threshold. Suppressed inside the gap.
        float lit = step(bayer4(gl_FragCoord.xy), ringlets) * step(0.5, gapMask);

        // Quantize the broad ringlet phase into discrete bands (one id per
        // sine cycle), hash each to a brightness multiplier.
        float bandId = floor((rho * f1 + p1) / 6.2831853);
        float bandJitter = mix(BAND_JITTER_MIN, BAND_JITTER_MAX, hash11(bandId * 1.37 + uSeed * 7.0));

        // Solid floor (cut by the gap) + dithered ringlet opacity (a lighter
        // band rides a touch more opaque via the half-strength coupling).
        float a = uFloorAlpha * gapMask + lit * BAND_ALPHA * mix(1.0, bandJitter, 0.5);
        a = clamp(a, 0.0, 1.0);
        if (a < 0.02) discard;   // genuinely empty in the gap — no depth write

        vec3 col = uColor * mix(FLOOR_DIM, BAND_BRIGHT * bandJitter, lit);

        // Planet shadow: reconstruct the fragment's faked-3D position
        // (screen x,y exact from the pixel; depth from the parametric
        // angle), then test it against the planet's down-sun shadow
        // cylinder. Darkens the back arc behind the planet relative to the
        // dominant star.
        if (uHasShadow > 0.5) {
          vec2  s   = (gl_FragCoord.xy - uCenter) * uInvOuterR;   // outerR units
          float rr  = mix(uInnerNorm, 1.0, vRho);
          float dz  = rr * sin(vAngle * 6.2831853) * SIN_PHI;
          vec3  F   = vec3(s, dz);
          vec3  shadowDir = -normalize(vec3(uLightDir2D, LIGHT_Z));
          float along = dot(F, shadowDir);
          float perp  = length(F - along * shadowDir);
          // Hard cut: inside the planet's shadow cylinder (perp < R_p) on
          // the down-sun side (along > 0). The perp = R_p boundary is the
          // cylinder wall — two straight lines parallel to the light
          // direction, so the darkened arc gets crisp, light-aligned
          // edges (the classic shadow cut) rather than a radial fade.
          float shadow = step(0.0, along) * step(perp, uPlanetNorm);
          float k = mix(1.0, SHADOW_DARK, shadow);
          col *= k;
          a   *= k;
        }

        gl_FragColor = vec4(col, a);
      }
    `,
    // Translucent floor blends over the background; the dithered overlay
    // rides on top. Fragments in the gap discard, so the division reads
    // as true empty space.
    transparent: true,
    // The diagram threads a per-row-item z so each planet's stack
    // (back-ring / disc / front-ring / moons) reads as one occluding band
    // against its neighbors; without depthWrite the back half wouldn't
    // block a left-neighbor planet from painting over it at the planets
    // pass (renderOrder primary, z secondary).
    depthWrite: true,
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
// Interior is a solid uColor body with one Bayer-dithered ring of
// hotter/darker pixels stippled just inside the outer edge. The ring
// density falls off from the rim inward, so it reads as a noisy edge
// fringe that tapers into the body rather than as a hard inner band.
// No core brightening, no mid band — the body is the body, and the
// dither ring is what differentiates "edge of star" from a flat puck.
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

      ${BAYER4_GLSL}
      ${HUEDIR_GLSL}

      // Width of the inner-edge dithered ring, in pixels. The ring
      // hugs the outer edge of the disc; stipple density falls
      // linearly from 1.0 at the edge to 0.0 at INNER_EDGE_DEPTH_PX
      // into the body, so the fringe tapers into the solid fill
      // rather than ending on a sharp inner border.
      const float INNER_EDGE_DEPTH_PX = 8.0;

      // Inner-edge fringe parameters:
      //   - SAT_EXP saturates uColor's natural hue. Higher = the
      //     minor channels get crushed harder (more saturated
      //     fringe). 3.0 is subtle — enough to read as "richer
      //     than the body" without going neon on stars whose
      //     dominant channel is already pinned at 1.0 (cool stars
      //     have R pegged low, so high exponents pop the B fringe
      //     against the pale body).
      //   - BRIGHTNESS is a scalar dim factor (< 1.0 darkens the
      //     fringe relative to the body without touching hue).
      //     Keeping the fringe dimmer than the body is what makes
      //     it read as "shadow under the limb" rather than "hot
      //     ring around it".
      // Final fringe color = pow(hueDir(uColor), SAT_EXP) × uColor × BRIGHTNESS.
      const float INNER_EDGE_SAT_EXP    = 3.0;
      const float INNER_EDGE_BRIGHTNESS = 0.85;

      void main() {
        vec2 d = gl_FragCoord.xy - uCenter;
        float r = length(d);
        if (r > uRadius) discard;

        // Hover wins — outer 1-px ring fills white regardless of
        // body/edge shading below.
        if (uHovered > 0.5 && r > uRadius - 1.0) {
          gl_FragColor = vec4(1.0);
          return;
        }

        vec3 col = uColor;

        // Distance from the disc's outer edge, in pixels (0 at the
        // outermost rasterized pixel, growing inward). Drives the
        // density of the inner-edge stipple — pixels closer to the
        // edge are more likely to flip to the hotter shade.
        float distFromEdgePx = uRadius - r;
        if (distFromEdgePx < INNER_EDGE_DEPTH_PX) {
          float density = 1.0 - distFromEdgePx / INNER_EDGE_DEPTH_PX;
          if (density > bayer4(gl_FragCoord.xy)) {
            col = pow(hueDir(uColor), vec3(INNER_EDGE_SAT_EXP)) * uColor * INNER_EDGE_BRIGHTNESS;
          }
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: false,
    depthWrite: false,
  });
}

// Outer halo for star discs — sized large around the disc and rendered
// with additive blending so uColor bleeds into the dark background and
// any planets/chrome below. The fragment shader runs an ordered Bayer
// dither against a quadratic radial falloff, so pixels thin out with
// distance — no smooth gradient, just a stippled cloud that hugs the
// disc and fades. Each radial band paints uColor saturated by a
// different exponent so the halo cools through the star's own hue
// (orange-red for warm stars, deep blue for cool stars). Pixels
// inside uDiscRadius are discarded; the disc material paints there.
//
// Per-star uniforms: uCenter (same as the disc's uCenter), uDiscRadius
// (matches the disc's uRadius), uHaloRadius (outer extent of the halo
// in env-px), uColor (same hue as the disc — typically the system-view
// tuned class color from tuneStarColorForSystemView in stars-row.ts).
// Geometry should be a PlaneGeometry sized to fully enclose the halo
// bounding box (typically 2·uHaloRadius square). Caller positions the
// mesh at uCenter and renders BEFORE planets/belts/etc so their
// opaque/transparent passes can overpaint the halo where they overlap.
export function makeStarHaloMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uCenter:     { value: new Vector2() },
      uDiscRadius: { value: 0 },
      uHaloRadius: { value: 0 },
      uColor:      { value: new Color() },
    },
    vertexShader: `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec2 uCenter;
      uniform float uDiscRadius;
      uniform float uHaloRadius;
      uniform vec3 uColor;

      ${BAYER4_GLSL}
      ${HUEDIR_GLSL}

      // Falloff exponent — higher = density drops off faster (tighter
      // halo). 2.5 keeps the hot ring tight against the disc while the
      // ember + dark bands fan out into the broader fringe.
      const float FALLOFF_EXP = 2.5;

      // Intensity range — far pixels paint at INTENSITY_MIN, near pixels
      // burn at INTENSITY_MAX. Both are well under 1.0 so the halo
      // reads as a deep wash rather than a second bright disc — the
      // disc itself is supposed to be the bright object.
      const float INTENSITY_MIN = 0.10;
      const float INTENSITY_MAX = 0.30;

      // Heat-spectrum band thresholds in t (t = 0 at disc edge, t = 1 at
      // halo edge). Each band paints uColor with a different saturation
      // strength so the halo reads as a "cooling iron" gradient through
      // the star's OWN hue — warm stars cool toward deep red, cool
      // stars cool toward deep blue. Bayer dither on the boundary so
      // the transitions stipple instead of ringing.
      const float HOT_END   = 0.18;
      const float WARM_END  = 0.40;
      const float EMBER_END = 0.68;

      // Per-band saturation exponents — higher = harder crush on the
      // minor channels. Each successive band saturates more, so the
      // halo's outer fringe shifts deeper into uColor's dominant hue
      // (red for warm stars, blue for cool stars, etc) rather than
      // toward a hardcoded direction. With color management OFF these
      // values feed pow() directly on sRGB-coded channels (consistent
      // with the rest of the project's shader math).
      const float HOT_SAT_EXP   = 2.0;
      const float WARM_SAT_EXP  = 5.0;
      const float EMBER_SAT_EXP = 10.0;
      const float DARK_SAT_EXP  = 18.0;

      // Half-width of the band-boundary dither in t-space. Larger =
      // noisier band transitions. ~0.07 lands a few pixels of fuzz on
      // a typical halo width.
      const float BAND_DITHER = 0.07;

      void main() {
        vec2 d = gl_FragCoord.xy - uCenter;
        float r = length(d);

        // Discard inside the disc (the disc material owns those pixels)
        // and outside the halo extent (the bounding plane is square; we
        // want a round halo).
        if (r <= uDiscRadius) discard;
        if (r >= uHaloRadius) discard;

        // t ∈ [0, 1] across the halo annulus (0 = touching disc, 1 = far
        // edge). Density-falloff gates pixel visibility; color-band
        // bucketing gates pixel hue.
        float t = (r - uDiscRadius) / max(uHaloRadius - uDiscRadius, 1.0);
        float density = pow(1.0 - t, FALLOFF_EXP);

        // Ordered-dither visibility gate — pixel only plots when density
        // beats the Bayer threshold. No smooth alpha — falloff is purely
        // a function of how many pixels survive the threshold.
        float bVis = bayer4(gl_FragCoord.xy);
        if (density < bVis) discard;

        // Color-band lookup uses a separately-keyed dither (offset bayer
        // sample) so band-edge stipple doesn't correlate with visibility
        // stipple — keeps the band-color transition reading as a fuzzy
        // boundary rather than ghosting onto the visibility pattern.
        float bBand = bayer4(gl_FragCoord.xy + vec2(7.0, 13.0));
        float td = t + (bBand - 0.5) * 2.0 * BAND_DITHER;

        // Band color = pow(hueDir, SAT_EXP) × uColor. The pow term is
        // pure hue saturation (always ≤ 1 in each channel); multiplying
        // by uColor restores the original brightness scale and pulls
        // each band back toward the star's actual color. Final pixel
        // brightness comes from the intensity ramp below.
        vec3 hue = hueDir(uColor);
        vec3 hotCol   = pow(hue, vec3(HOT_SAT_EXP))   * uColor;
        vec3 warmCol  = pow(hue, vec3(WARM_SAT_EXP))  * uColor;
        vec3 emberCol = pow(hue, vec3(EMBER_SAT_EXP)) * uColor;
        vec3 darkCol  = pow(hue, vec3(DARK_SAT_EXP))  * uColor;

        vec3 col;
        if (td < HOT_END)        col = hotCol;
        else if (td < WARM_END)  col = warmCol;
        else if (td < EMBER_END) col = emberCol;
        else                     col = darkCol;

        float intensity = mix(INTENSITY_MIN, INTENSITY_MAX, density);
        gl_FragColor = vec4(col * intensity, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
