// Cluster fade thresholds — shared by Labels (cluster-name overlay + hover
// reticle) and Droplines (per-cluster vertical pin). Both subsystems use
// the SAME numbers so a cluster's label and its pin flip in/out together
// at the same camera pose. Tune them here in one place.
//
// Two independent ramps multiply into a per-cluster opacity. Each is
// evaluated against the cluster *primary* (not the COM) so the fade
// distance and the visual anchor (label position, drop-line top) agree.
//
//  - PIVOT ramp: `view.target` (orbit pivot) → primary distance. The
//    dominant gate at close zoom; scopes the visible cluster set to the
//    user's current point of interest.
//  - CAMERA ramp: `camera.position` → primary distance. Kicks in as the
//    user zooms out — primaries exit the camera bubble and dim independent
//    of how the pivot ramp rates them. CAMERA_FADE_NEAR is chosen so that
//    at a "reasonably close" orbit radius the camera ramp is fully open
//    and only the pivot ramp fires.
//
// Either FAR threshold hides the cluster outright; below NEAR the ramp is
// fully open. Hover and selection bypass both ramps in both consumers.

export const PIVOT_FADE_NEAR  = 10;
export const PIVOT_FADE_FAR   = 20;
export const CAMERA_FADE_NEAR = 30;
export const CAMERA_FADE_FAR  = 60;

// Linear distance-fade ramp, shared by every fade consumer so the
// "≤near full, ≥far gone, lerp between" shape lives in one place. `near`
// and `far` are the threshold pair (near < far); `d` is the measured
// distance.
//
// clampRamp: ≤near → 1, ≥far → 0 (the dominant polarity — closer is
// brighter). invRamp: ≤near → 0, ≥far → 1 (waymarker / focus-marker
// fade-IN — closer is dimmer). Both clamp to [0, 1] at the bounds, so a
// caller can drop them in unconditionally where it previously guarded the
// interior case by hand.
export function clampRamp(d: number, near: number, far: number): number {
  if (d <= near) return 1;
  if (d >= far) return 0;
  return 1 - (d - near) / (far - near);
}

export function invRamp(d: number, near: number, far: number): number {
  if (d <= near) return 0;
  if (d >= far) return 1;
  return (d - near) / (far - near);
}

// ── Dropline subsystem shared geometry + palette ───────────────────────
// Shared by Droplines (per-cluster vertical pins) and FocusMarker (the
// view.target dropline) so the two render in one identical visual language.

// On-screen colors at full opacity, premultiplied against the black bg.
// Solid (near-side of the focus plane) sits at ~32% of the source 0x3ad1e6;
// dots (far-side) run ~15% brighter so the broken-up pattern still reads at
// distance.
export const DROPLINE_COLOR_SOLID = 0x123d42;
export const DROPLINE_COLOR_DOTS  = 0x15464c;

// World-space spacing between dots on the dotted (far-side-of-plane) variant.
// Dots are baked into geometry at fixed Z intervals so perspective compresses
// them at distance and stretches them up close — a distant dropline stays
// visually tight while the focused one keeps its pattern density. 0.25 ly was
// tuned to mirror the legacy 1-px-on / 3-px-off screen-space pattern at a
// mid-range orbit.
export const DROPLINE_DOT_PERIOD_LY = 0.25;

// A pin whose endpoints land within this distance of each other has
// effectively no length and is hidden — the cluster sitting on its own focus
// plane (dz = 0) is the canonical case.
export const DROPLINE_DEGENERATE_DIST = 0.01;

// Range-ring chrome (Grid: rings + axes + galactic-centre arrow) gets its
// own zoom-fade ramp keyed to camera-to-selection-COM distance. Decoupled
// from CAMERA_FADE_* so the rings can reach full opacity slightly sooner
// on zoom-in than star labels do — the chrome is a wider on-screen feature
// (outermost ring is 20 ly across) that earns its full presence earlier.
export const GRID_FADE_NEAR = 40;
export const GRID_FADE_FAR  = 60;

// Stars-only: when to enable / disable the per-star pivot-dim local-focus
// effect (see stars shader in materials.ts). Keyed to ORBIT DISTANCE
// (view.distance = camera ↔ pivot), not per-star camera distance, because
// the user-facing intent is "zoomed in = focus dimming, zoomed out =
// everything bright." A per-star camera ramp would never re-brighten on
// zoom-out — every star is far from a zoomed-out camera, including the
// nearby ones we want bright.
//
// Bounds are tuned against DEFAULT_VIEW.distance = 30: full effect at and
// below default zoom, smooth disappear from FULL_BELOW → OFF_ABOVE, no
// effect beyond OFF_ABOVE (well inside the [4, 150] zoom range so the
// "zoom-out reveals the galaxy uniformly" cue is unmistakable).
export const STAR_DIM_FULL_BELOW = 40;
export const STAR_DIM_OFF_ABOVE  = 100;
