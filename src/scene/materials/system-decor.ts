// System-view decor materials: chunk-pool fill (belts + debris rings),
// ice/dusty ring annulus, per-mesh star disc, outer star halo. All render
// under an OrthographicCamera at 1 unit = 1 buffer pixel. The big
// planet/moon disc material lives in ./planet; shared Bayer dither,
// hue-direction saturation, and star-crescent lighting GLSL come from
// ./chunks.

import { AdditiveBlending, Color, ShaderMaterial, Vector2 } from 'three';
import { MAX_LIGHTS, BAYER4_GLSL, HUEDIR_GLSL, STAR_CRESCENT_LIGHTING_GLSL } from './chunks';

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
      varying vec3  vColor;
      varying float vHovered;
      varying vec2  vChunkCenter;
      varying float vChunkSize;
      void main() {
        vColor = color;
        vHovered = aHovered;
        vChunkCenter = aChunkCenter;
        vChunkSize   = aChunkSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3  vColor;
      varying float vHovered;
      varying vec2  vChunkCenter;
      varying float vChunkSize;
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

      void main() {
        // Hover wins early — chunks under hover flip to solid white
        // exactly like the previous behavior; lighting doesn't paint
        // over the highlight.
        if (vHovered > 0.5) {
          gl_FragColor = vec4(1.0);
          return;
        }
        vec3 col = vColor;

        // Per-fragment sphere lighting — treat the chunk as a unit-disc-
        // inscribed shape. Polygon silhouette already clips the
        // rasterizer to the chunk's actual outline; the disc math just
        // yields a smooth depth signal inside the polygon. chunkR floor
        // at 1 px keeps the tiniest chunks (size = 2 px half-extent)
        // from divide-by-zero on the normalize.
        vec2 dLocal = gl_FragCoord.xy - vChunkCenter;
        float chunkR = max(vChunkSize, 1.0);
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

// Solid-fill mesh material for planetary rings — used by the
// triangle-strip annulus halves in SystemDiagram. Flat color, no
// shading, no AA. The caller provides geometry whose vertex positions
// live in the host planet's local frame (origin at planet center,
// env-pixel units); the mesh is positioned at the planet's cx/cy.
//
// The caller pre-lerps `color` from the icy/dusty palette endpoints
// based on the ring's resource mix (see bodyIcyness in body-palette.ts).
// `alpha` is similarly lerped — icy rings paint opaque (Saturn-class
// bright band) while dusty rings paint translucent (Uranus/Neptune-
// class faint dust). When alpha < 1 the material flips to transparent
// so the alpha lane of the fragment actually blends.
//
// Per-mesh uHovered uniform (0 / 1) inverts the entire fill to white
// on hover. No per-vertex outline math because the geometry is a
// continuous arc rather than a sprite — a 1-px rim would need a
// second pass.
export function makeRingMaterial(color: Color, alpha: number): ShaderMaterial {
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
    transparent: alpha < 1,
    // depthWrite stays on even when translucent. The diagram threads
    // a per-row-item z so each planet's stack (back-ring / disc /
    // front-ring / moons) reads as one occluding band against its
    // neighbors; without depthWrite the back half wouldn't block a
    // left-neighbor planet from painting over it at the planets pass
    // (renderOrder primary, z secondary).
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
