// Tuning knobs for the system-view diagram, hoisted out of the layer
// code so the "edit a number, reload, eyeball" loop touches one file.
// Geometry, layout, and color values live here; pure math constants
// (e.g. RING_MINOR_OVER_MAJOR) sit alongside the layout values they
// pair with.

// --- Stars row ---

// Per-star disc-diameter multiplier on top of the galaxy-tuned pxSize.
// Stars render as top-clipped half-discs hanging off the buffer top,
// so most of the disc area is off-screen — scale up generously to
// suggest "substantial body poking through".
export const DISC_SCALE = 9;

// Fraction of the disc radius pushed above the viewport top. 0 = center
// on edge (half disc visible). 0.4 = center is 40% of radius above edge,
// 30% of disc visible as a strip below the edge. Higher = stars feel
// bigger because more is "hidden up there"; ≥ 0.5 starts making small
// stars vanish entirely (visible portion < a few px).
export const STAR_OFFSCREEN_FRAC = 0.3;

// Edge-to-edge horizontal gap between adjacent stars, expressed as a
// fraction of the largest member's disc diameter. Smaller than a full-
// disc-row value would be because discs are top-clipped — they read
// smaller, so less breathing room is needed.
export const STAR_HORIZ_GAP_FACTOR = 0.3;
// Floor for the star gap when the row is width-constrained; below this
// we start scaling disc sizes down.
export const MIN_STAR_GAP = 2;

// Outer radius of the star halo as a multiple of the disc radius. The
// halo is a dithered additive cloud that bleeds a saturation-stepped
// gradient (hot/warm/ember/dark, all in the star's own hue) into the
// surrounding scene (see makeStarHaloMaterial in materials/system-decor.ts).
// 3.0 pushes the dark fringe well into the dome area so the wash
// bleeds past the planet row before fading to black, giving the
// system a sense of being bathed in the star's light rather than
// parked in front of it. Planets paint over the halo where they overlap.
export const STAR_HALO_RADIUS_FACTOR = 3.0;

// System-view-only base-color tuning. Lifts a star's minor channels
// toward white by an amount proportional to how SATURATED the star's
// class color is (max(R,G,B) − min(R,G,B)). Highly saturated catalog
// colors — deep blue O/B/A or deep red M/BD — collide with the
// saturated dithered inner-edge ring + halo to read as "neon" against
// the body. Lifting the body softens it toward white in system view
// only; the fringe stays a touch darker, restoring natural balance.
// Galaxy view keeps the true class color (these constants only apply
// to the system diagram). Two knobs:
//   - SATURATION_LIFT_RATE: how strongly saturation drives lift.
//     ~1.4 puts Vega around lift 0.30 (subtle whitening); higher
//     values lift more.
//   - SATURATION_LIFT_MAX: hard cap on the lift so very saturated
//     stars (M, BD) don't fully wash out — without this, an M dwarf
//     with sat ≈ 0.58 would lift past 0.8 and lose its warm character.
export const SYSTEM_VIEW_SATURATION_LIFT_RATE = 1.4;
export const SYSTEM_VIEW_SATURATION_LIFT_MAX  = 0.35;

// --- Body dome ---

// Distance from the TOP of the screen to the dome's PEAK (where the
// middle planet sits). Fixed — the top of the arc stays at a constant
// gap below the stars regardless of viewport size; only the dome's
// edges move (see DOME_PEAK_*_PX below).
export const PLANET_PEAK_FROM_TOP = 120;

// Dome height — vertical drop from the peak to the edges. Scales with
// viewport area so bigger screens get a more pronounced arc; the edges
// drop lower while the peak stays anchored. Area drives the lerp
// (rather than width or height alone) because the arc reads as
// "proportional to how much real estate you have."
export const DOME_PEAK_MIN_PX = 60;
export const DOME_PEAK_MAX_PX = 120;
// Anchor points for the lerp (env-px², post-render-scale). 400k ≈ small
// laptop viewport; 2M ≈ full-HD desktop.
export const DOME_AREA_MIN = 400_000;
export const DOME_AREA_MAX = 2_000_000;

// --- Planet + moon disc sizing ---

// Planet disc diameter (px) is two radius→size mappings blended into one
// curve (see planetDiscPx in row.ts). The catalog's radii are bimodal:
// rocky worlds spread smoothly from Mercury (0.38 R⊕) to ~2 R⊕, then gas
// giants pile up at 10–12 R⊕ because electron-degeneracy pressure flattens
// the mass→radius curve (a 0.5 and a 10 Jupiter-mass planet are both ~1 R_J).
// A single cube-root curve renders that pile-up as a near-flat plateau, so
// the two regimes get their own mapping:
//   • low-end: cube-root compression, Earth (1 R⊕) pinned to PLANET_DISC_BASE.
//   • high-end: a locally-linear slope across the dense giant band, so giants
//     that differ by a few R⊕ get a few px of separation instead of clamping.
// The blend hands off across [PLANET_DISC_BLEND_LO, PLANET_DISC_BLEND_HI],
// then a soft-min asymptotes the top to PLANET_DISC_ASYMPTOTE (a practical
// max approached, never reached — no hard clip / cliff) and a soft-max eases
// the smallest bodies onto PLANET_DISC_MIN. The whole curve is monotonic, so
// a bigger radius always renders at least as large.

// Smallest disc diameter (soft floor) and the practical max diameter the
// curve asymptotes toward. PLANET_DISC_MIN also seeds the belt height
// fallback when a star has no planets (see belts.ts).
export const PLANET_DISC_MIN = 36;
export const PLANET_DISC_ASYMPTOTE = 132;
// Low-end multiplier on cbrt(radiusEarth); equals Earth's pinned diameter
// since cbrt(1) = 1. Sets where rocky worlds land.
export const PLANET_DISC_BASE = 54;
// High-end mapping (giant band): px ≈ SLOPE·radiusEarth + OFFSET before the
// asymptote bends it over. The slope is what gives Jupiter-vs-super-Jupiter
// visible size separation.
export const PLANET_DISC_GIANT_SLOPE = 6.2;
export const PLANET_DISC_GIANT_OFFSET = 44;
// Radius band (R⊕) over which the low-end curve hands off to the high-end
// mapping via smoothstep.
export const PLANET_DISC_BLEND_LO = 4;
export const PLANET_DISC_BLEND_HI = 9;
// Knee widths (px) of the soft-min ceiling and soft-max floor — larger =
// gentler, earlier-starting bend; smaller = sharper corner.
export const PLANET_DISC_TOP_KNEE = 7;
export const PLANET_DISC_FLOOR_KNEE = 4;

// Moon discs use a plain cbrt curve with hard clamps (discPxFromRadius in
// row.ts) — moon radii are all sub-Earth, so they never reach the giant
// band that the planet curve exists to spread, and a simple compression
// reads fine. The 50 px cap exceeds the planet floor on purpose: moons
// read against their parent, not against the smallest planet in the
// system, and big moons cluster around big planets (Ganymede / Titan orbit
// gas giants), so a 50 px moon always sits next to a 100+ px parent in
// practice. Floor at 10 keeps tiny inner moons visible against a Jupiter.
export const MOON_DISC_MIN = 10;
export const MOON_DISC_MAX = 50;
// Multiplier on cbrt(radiusEarth). 67 lands Ganymede / Titan (~0.4 R⊕)
// at the 50 px cap and Luna (~0.27 R⊕) at ~43 px.
export const MOON_DISC_BASE = 67;

// Moon-center distance from parent center, expressed as an offset
// relative to parent's rim. 0 = moon centered exactly on the parent's
// rim (half the moon disc inside the parent, half outside). Positive
// pushes moons outward; negative pulls them inward.
export const MOON_EDGE_BIAS = 0;

// Disc-diameter floor (env-px) below which a body forces flat fill
// rather than running the procedural surface/banded texture. At smaller
// sizes the per-pixel palette pick reads as screen-door noise instead
// of texture, and bands collapse to barber-pole stripes. The smallest
// moons (10 px) land below this and render as one solid palette entry.
export const PROCEDURAL_TEXTURE_MIN_PX = 16;

// --- Belts ---

// Belts occupy a row slot like a planet, but render as a vertical
// column of irregular angular blobs (polygon meshes) rather than a
// single disc. Slot width is fixed (not derived from belt mass) so a
// system's row-layout math stays simple.
export const BELT_SLOT_WIDTH = 36;
// Vertical extent of a belt column, expressed as a multiple of the
// largest planet disc on the row. ~3× makes the band feel like a
// structural feature spanning a real swath of the system rather than
// a compact cluster — wide enough to read distinctly from a tightly
// packed moon system but not so tall it crashes into the stars or
// the ships area. Clamped by BELT_HEIGHT_MAX_PX so a row carrying a
// large gas giant doesn't stretch the column to the full viewport.
export const BELT_HEIGHT_FACTOR = 3.0;
// Absolute ceiling (env-px) on a belt column's height. Caps the
// proportional BELT_HEIGHT_FACTOR scaling so only the biggest-planet
// rows (gas giants near PLANET_DISC_MAX) get trimmed; typical rows
// stay fully proportional.
export const BELT_HEIGHT_MAX_PX = 260;
// Chunk count range per belt. Smallest masses bottom out at MIN; the
// largest belts approach MAX. Log-based so a 100× mass range only
// doubles chunk count. This is the mass-derived count *before* the
// small-body inflation below — belts with smaller parent bodies divide
// the rendered chunk size down (see BELT_CHUNK_SCALE_*) and bump the
// count up to keep painted area (≈ belt mass) roughly fixed, so a dust
// cascade reads as a dense fine swarm rather than a sparse one.
export const BELT_CHUNKS_MIN = 20;
export const BELT_CHUNKS_MAX = 50;
// Absolute ceiling on chunk count after small-body inflation. A belt
// with the smallest chunks (sizeScale at BELT_CHUNK_SCALE_MIN) would
// otherwise inflate its mass-count by 1/sizeScale²; this caps the
// vertex budget so a tiny-bodied belt can't blow up the pool.
export const BELT_CHUNKS_HARD_MAX = 150;
// Per-chunk polygon half-extent in env-px. A chunk's silhouette is one
// of the blob.ts shape-library polygons (POTATO_SHAPES / CRYSTAL_SHAPES)
// inscribed in a unit circle, scaled by this size and rotated by a
// per-chunk angle, so the visible footprint is roughly (2*size) ×
// (2*size) with the polygon filling ~60% of the bbox. This is the
// *base* palette — each belt scales the whole array by a multiplier
// derived from its largestBodyKm (see below), so the relative
// within-belt size spread is preserved while the absolute scale tracks
// the parent-body inventory.
export const BELT_CHUNK_SIZES = [2, 3, 4, 5, 6];
// largestBodyKm → per-belt multiplier on BELT_CHUNK_SIZES. A belt's
// largest parent body spans ~1 km (trace dust cascades) to ~2400 km
// (Pluto/Eris-class KBO inventories); that ~3-decade log range maps
// onto a size multiplier. BELT_CHUNK_SIZES is already tuned for the
// large end, so SCALE_MAX is 1.0 — a Ceres/Pluto-class shepherded belt
// renders at the base palette and everything smaller scales *down*
// toward SCALE_MIN, so a floor dust band reads as fine gravel rather
// than boulders. The rendered chunk scale tracks the same metadata the
// info card reports.
export const BELT_CHUNK_KM_MIN = 1;
export const BELT_CHUNK_KM_MAX = 2500;
export const BELT_CHUNK_SCALE_MIN = 0.5;
export const BELT_CHUNK_SCALE_MAX = 1.0;

// --- Rings ---
//
// Rings render as a tilted ellipse around the host planet. Ice rings
// are solid triangle-strip annuli (back-half mesh draws before the
// planet, front-half after, so the planet disc occludes one and the
// front mesh overpaints the other); debris rings are angular-blob
// polygons scattered along the same ellipse path with the same
// back/front split. Both share the geometry constants below so a
// planet that rolls "ice" vs "debris" sits in the same physical space.

// Perspective compression: how much the ring's vertical extent is
// squished relative to its horizontal extent. 0.20 is a Saturn-like
// "looking down at it from above" angle — flat enough that the ring
// clearly reads as edge-tilted, not so flat that the back/front split
// loses its visual punch.
export const RING_MINOR_OVER_MAJOR = 0.20;
// Per-ring tilt range in degrees. Each ring picks its tilt from the
// uniform [-RING_TILT_DEG_MAX, +RING_TILT_DEG_MAX] using a seed off
// the ring's id, so the same ring always tilts the same direction but
// different planets in the same system don't comb-align.
export const RING_TILT_DEG_MAX = 14;
// Visual scale applied to the ring's RADIAL WIDTH (outer − inner) at
// render time. The CSV's innerPlanetRadii / outerPlanetRadii stay in
// physical units (Saturn's rings really do extend ~2.3 R_S); this
// multiplier pulls the OUTER edge in toward the inner edge so the band
// reads as stubbier without bringing the inner edge inside the
// planet's silhouette. Inner edge stays at innerPlanetRadii × R_p
// (always outside the planet rim).
export const RING_WIDTH_VIZ_SCALE = 0.5;

// Segments per half-ellipse for the ring triangle strips. 24 is the
// floor where the silhouette stops reading as a polygon at the largest
// realistic planet sizes; bumping past 32 is wasted geometry.
export const RING_SEGMENTS = 24;

// Fallback ring extent (in host-planet radii) when the body carries no
// innerPlanetRadii / outerPlanetRadii — a generic Saturn-ish band so a
// ring still renders rather than collapsing to zero width.
export const RING_INNER_FRAC_FALLBACK = 1.1;
export const RING_OUTER_FRAC_FALLBACK = 2.0;

// --- Per-row-item depth ---
//
// Each row item (planet or belt) gets a slot of z range Z_STRIDE in
// world coordinates. Larger row index → larger world z → smaller
// fragment depth under our OrthographicCamera (near=-1, far=1,
// projection negates z so world_z=+1 maps to depth=0). The default
// depthFunc (LessEqual) lets smaller depth win, so the rightmost
// row item draws on top. With depthWrite enabled across the system-
// diagram materials, each planet's whole stack (back-moon → back-ring
// → disc → front-ring → front-moon) renders as one contiguous z-band
// that fully occludes — or is fully occluded by — neighboring
// planets' stacks. Z_STRIDE × max-row-items must fit inside the
// camera's [-1, 1] z range (Z_STRIDE 0.001 → 1000-item ceiling, far
// past any realistic system size).
export const Z_STRIDE = 0.001;
// Sub-offsets within one row item's z band. Listed deepest to most
// forward — back layers have NEGATIVE offsets (smaller world z =
// drawn under the planet disc); front layers have POSITIVE offsets
// (larger world z = drawn over the disc). Sub-offsets are an order
// of magnitude smaller than Z_STRIDE so adjacent row items' stacks
// never z-interleave.
export const Z_BACK_MOON  = -0.00040;
export const Z_BACK_RING  = -0.00030;
export const Z_BELT       =  0.00000;
export const Z_PLANET     =  0.00000;
export const Z_FRONT_RING = +0.00030;
export const Z_FRONT_MOON = +0.00040;

// --- Render order ---
//
// Render order is a secondary tiebreaker behind z (which the row-item
// banding above handles). These values keep tied-z scenarios settling
// the right way — e.g. an equal-z moon next to a ring chunk.

// Star halos draw FIRST — additive blending into the cleared
// framebuffer. Every later pass (belts, planets, rings, moons) paints
// over them, so the warm wash ends up behind every body in the scene.
// Star discs themselves keep the default renderOrder 0; the halo
// discards inside the disc radius so the disc still renders on top.
export const RENDER_ORDER_STAR_HALO  = -1;
export const RENDER_ORDER_BACK_MOON  = 5;
export const RENDER_ORDER_BELT       = 6;
export const RENDER_ORDER_PLANET     = 10;
// Back rings run AFTER planet discs so a translucent back-half can
// blend over a left-neighbor's disc (otherwise it would paint against
// the cleared framebuffer and depth-reject the disc that's "behind"
// it). Within R's own stack, the back ring is still hidden by R's
// disc via depth test (back ring at z_R - 0.0003 fails LessEqual
// against R's disc at z_R) — render-order doesn't need to enforce
// it. Belts (opaque) don't have the same blend issue, so they stay
// at renderOrder 6.
export const RENDER_ORDER_BACK_RING  = 12;
export const RENDER_ORDER_FRONT_RING = 13;
export const RENDER_ORDER_FRONT_MOON = 15;
// Planet atmospheric halo runs last so it blends over the left
// neighbor's front-ring / front-moon (which the planet pass at
// renderOrder 10 hasn't drawn yet). Within the pass, depth test
// keeps R's halo from painting over R's own front ring/moon
// (higher z) and lets it paint over L's full stack (lower z).
export const RENDER_ORDER_PLANET_HALO = 20;
