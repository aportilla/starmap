import {
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { ClusterBrackets } from './cluster-brackets';
import { Grid } from './grid';
import { Droplines } from './droplines';
import { FocusMarker, FOCUS_MARKER_NEAR } from './focus-marker';
import { InputController, type InputHandlers } from './input-controller';
import { Labels } from './labels';
import { StarPoints } from './stars';
import { setSnappedLineViewport } from './materials';
import { STAR_DIM_FULL_BELOW, STAR_DIM_OFF_ABOVE } from './cluster-fade';
import { RenderScaleObserver, effectiveScale } from './render-scale';
import { MapHud } from '../ui/map-hud';
import { STARS, STAR_CLUSTERS, clusterIndexFor, nearestClusterIdxTo } from '../data/stars';
import { getSettings } from '../settings';

// Orbit radius bounds (camera-to-target ly). Replaces the old ortho frustum
// height; under perspective, distance directly drives apparent size of
// objects at the focus.
const ZOOM_MIN = 4;
const ZOOM_MAX = 150;
const FOV_DEG = 45;
const NEAR = 0.1;
const FAR = 1000;
const DEFAULT_VIEW = { distance: 30, yaw: 1.1, pitch: 1.2 };

// Focus animation: only view.target lerps; yaw/pitch/distance stay frozen so
// the camera glides over to the new orbital pivot rather than swinging.
const FOCUS_ANIM_MS = 400;

// WASD/QE keyboard fly. Pan rate scales with view.distance so the visual
// movement speed stays consistent at any zoom level (zoom in → smaller world
// step per second, but the same screen-space rate). QE orbit is in radians
// per second.
const PAN_RATE_PER_DISTANCE = 0.5;
const ORBIT_RATE_RAD = 1.5;
// Pointer-drag orbit sensitivity: radians of yaw/pitch per CSS pixel of drag.
// Shared by single-finger drag and two-finger pan-mode orbit so swapping the
// gesture assignment doesn't change how fast the camera spins.
const ORBIT_SENSITIVITY_RAD_PER_PX = 0.005;
// Autospin yaw step per tick — the session-only "Auto-rotate" fidget.
const AUTOSPIN_RAD_PER_TICK = 0.0015;
// Clamp per-frame dt so a stalled tab or breakpoint resume doesn't hurl the
// camera across the scene on the next frame.
const MAX_TICK_DT_MS = 100;

// Squared-distance epsilon (ly²) used to decide whether view.target is "on"
// the selected cluster's COM — drives the Focus button's enabled state.
// 0.01 ly = ~38 AU; well below any visually significant offset and far
// above FP jitter from the focus lerp's terminal copy().
const FOCUS_EPSILON_SQ = 0.01 * 0.01;

interface ViewState {
  target: Vector3;
  distance: number;  // orbit radius (camera-to-target ly)
  yaw: number;
  pitch: number;
  spin: boolean;
}

export class StarmapScene {
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly scene = new Scene();
  private readonly view: ViewState;
  private readonly raycaster = new Raycaster();
  private readonly grid: Grid;
  private readonly droplines: Droplines;
  private readonly focusMarker: FocusMarker;
  private readonly labels: Labels;
  // Yellow corner-bracket indicators around clusters. Two instances render
  // simultaneously into the labels overlay scene: arms-style for the active
  // selection, dots-style for the candidate (hovered cluster, or nearest
  // to view.target when the user has panned off the selected cluster —
  // spacebar switches selection to the candidate).
  private readonly selectionBrackets: ClusterBrackets;
  private readonly candidateBrackets: ClusterBrackets;
  private readonly starPoints: StarPoints;
  private readonly hud: MapHud;
  private readonly renderScale = new RenderScaleObserver();
  private readonly input: InputController;

  // Hover-pointer state, written by the input controller via the
  // onPointerHoverChanged handler and read each tick. Drives the per-tick
  // raycast that feeds the candidate computation (hover beats focus-
  // proximity for which cluster gets the yellow label + dot brackets) and
  // the droplines hover-override. Touch input and mouse-over-HUD set
  // has=false so chrome occlusion doesn't leak through to scene picking.
  private readonly pointer = { x: 0, y: 0, has: false };
  // Currently-selected cluster, mirrored across Labels (yellow text +
  // fade-bypass), selectionBrackets (corner-arms reticle), MapHud (info
  // card + View System button), and Droplines (selected pin). Scene tracks
  // its own copy so non-routing logic — spacebar focus, future keyboard
  // actions on the selection — can read it without coupling to any one of
  // those owners' internals.
  private selectedClusterIdx = -1;
  // Candidate cluster — hovered cluster (priority), else nearest cluster
  // COM to view.target gated to "panned far enough off the selection that
  // another cluster is now closer". Written each tick, read by
  // onFocusCandidate (spacebar) to switch selection to it. -1 when no
  // candidate is currently shown. F ignores this — it always re-focuses
  // the current selection.
  private candidateClusterIdx = -1;

  // Focus animation: view.target lerps from focusFrom → focusTo over
  // FOCUS_ANIM_MS. view.distance also lerps from distanceFrom → distanceTo
  // so re-focusing onto a star already nearer than the orbit radius pulls
  // in instead of pushing the camera out to that radius. Yaw/pitch stay
  // frozen so the look direction is preserved through the glide.
  private readonly focusFrom = new Vector3();
  private readonly focusTo = new Vector3();
  private distanceFrom = 0;
  private distanceTo = 0;
  private focusAnimStart = 0;
  private focusAnimating = false;

  private rafId = 0;
  private running = false;
  // One-shot timer that auto-selects Sol shortly after start() so the grid's
  // staged expand choreography fires on first paint as a startup beat.
  // Cleared in stop() and skipped if the user has already selected by then.
  private autoSelectTimer: number | null = null;

  // Fired when the user requests the system view for a cluster — either
  // by clicking the "View System" button on the info card or by double-
  // clicking a star. AppController wires this to enterSystem().
  onViewSystem: (clusterIdx: number) => void = () => {};

  private readonly _onResize = () => this.resize();

  // Reusable per-frame scratch.
  private readonly _ndc  = new Vector2();
  private readonly _buf  = new Vector2();
  private readonly _forward = new Vector3();
  private readonly _right   = new Vector3();
  private readonly _step    = new Vector3();
  // Used to hand a Vector3-shaped COM to subsystems (Grid.setSelection)
  // whose APIs expect a Vector3 — STAR_CLUSTERS[i].com is a plain {x,y,z}.
  private readonly _comScratch = new Vector3();
  private static readonly WORLD_UP = new Vector3(0, 0, 1);

  private lastTickMs = 0;

  // Cached drawing-buffer dimensions, populated by resize(). All pixel-aware
  // shader work uses these — NOT window.innerWidth/Height — because the
  // buffer is smaller than CSS px once pixelRatio drops below 1.
  private bufferW = 0;
  private bufferH = 0;
  // Cached canvas CSS dimensions. May be slightly less than the window
  // (up to N-1 physical px lost to integer-multiple rounding in resize());
  // pointer math uses these so hovers register correctly across the canvas.
  private cssW = 0;
  private cssH = 0;

  // Renderer is owned by AppController and shared across view modes.
  // Pixel ratio + size are still driven from this scene's resize() (see
  // resize() for the integer-multiple-of-N rounding that guarantees a
  // clean nearest-neighbor upscale).
  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer) {
    this.renderer = renderer;
    const sun = STARS.find(s => s.id === 'sol')!;
    this.view = {
      target: new Vector3(sun.x, sun.y, sun.z),
      ...DEFAULT_VIEW,
      spin: false,
    };

    // PerspectiveCamera. Drop-lines now converge toward a vanishing point —
    // an intentional break with the old ortho "parallel pin" geometry, in
    // exchange for honest 3D depth cueing.
    this.camera = new PerspectiveCamera(FOV_DEG, 1, NEAR, FAR);

    this.raycaster.params.Points = { threshold: 0.6 };

    // Grid (rings + axes + arrow) is selection-driven and owns its own
    // sequential expand/collapse animation; scene only feeds it the active
    // cluster's COM via setSelection(). It starts with no active frame, so
    // nothing is drawn until the first selection lands.
    this.grid = new Grid();
    this.scene.add(this.grid.group);

    this.starPoints = new StarPoints(window.innerHeight / 2);
    this.scene.add(this.starPoints.points);

    const initialSettings = getSettings();
    this.droplines = new Droplines(initialSettings.showDroplines);
    this.scene.add(this.droplines.group);

    this.focusMarker = new FocusMarker();
    this.scene.add(this.focusMarker.group);

    this.labels = new Labels(initialSettings.showLabels);

    // Brackets render in the labels overlay scene (1 unit = 1 buffer pixel
    // ortho pass) so they share the labels' projection setup.
    this.selectionBrackets = new ClusterBrackets('arms');
    this.candidateBrackets = new ClusterBrackets('dots');
    this.labels.scene.add(this.selectionBrackets.mesh);
    this.labels.scene.add(this.candidateBrackets.mesh);

    this.hud = new MapHud(this.renderScale.scale);
    this.hud.onToggle = (id, on) => {
      if (id === 'labels') this.labels.setShowLabels(on);
      else if (id === 'drops') this.droplines.setMasterVisible(on);
      else if (id === 'spin') this.view.spin = on;
    };
    // Resolution preference (and any future settings that affect render
    // pipeline state) reach the scene via this callback. Resize re-reads
    // getSettings() and re-applies the buffer size.
    this.hud.onSettingsChanged = () => this.resize();
    this.hud.onAction = (id) => {
      if (id === 'reset') {
        // Snap reset: animating target while distance/yaw/pitch jump would
        // jolt the camera. Keep reset feeling like a hard cut.
        this.view.target.set(sun.x, sun.y, sun.z);
        this.view.distance = DEFAULT_VIEW.distance;
        this.view.yaw = DEFAULT_VIEW.yaw;
        this.view.pitch = DEFAULT_VIEW.pitch;
        this.focusAnimating = false;
        // Reset returns to the default (non-spinning) view, so clear the
        // autospin fidget and sync the panel checkbox to match.
        this.view.spin = false;
        this.hud.setToggleState('spin', false);
      }
    };
    this.hud.onDeselect = () => this.deselect();
    this.hud.onViewSystem = (idx) => this.onViewSystem(idx);
    this.hud.onFocus = (idx) => {
      const com = STAR_CLUSTERS[idx].com;
      this.animateFocusTo(com.x, com.y, com.z);
    };

    this.input = new InputController(canvas, this.buildInputHandlers());

    // Re-resize whenever DPR crosses an integer-N boundary (browser zoom,
    // monitor swap, OS scale change). resize() reads the current auto N
    // from this.renderScale and applies the user's resolution preference;
    // the HUD's Resolution radio also rebuilds its disable states off
    // the new auto value.
    this.renderScale.subscribe((scale) => {
      this.hud.setAutoScale(scale);
      this.resize();
    });
  }

  // -- public API --------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this._onResize);
    this.input.start();
    this.resize();
    this.tick();
    if (this.autoSelectTimer === null && this.selectedClusterIdx < 0) {
      this.autoSelectTimer = window.setTimeout(() => {
        this.autoSelectTimer = null;
        if (!this.running || this.selectedClusterIdx >= 0) return;
        const sunIdx = STARS.findIndex(s => s.id === 'sol');
        if (sunIdx < 0) return;
        const solCluster = clusterIndexFor(sunIdx);
        if (solCluster < 0) return;
        this.selectAndFocusCluster(solCluster);
      }, 1000);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.autoSelectTimer !== null) {
      clearTimeout(this.autoSelectTimer);
      this.autoSelectTimer = null;
    }
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this._onResize);
    this.input.stop();
    this.lastTickMs = 0;
  }

  // -- input wiring -----------------------------------------------------

  // Bridge from InputController gesture intents to scene-side state. The
  // controller is gesture-only (decides what's happening); scene applies
  // the deltas to view-state and runs selection/animation logic.
  private buildInputHandlers(): InputHandlers {
    return {
      clientToHud: (x, y, out) => this.clientToHud(x, y, out),
      pickStar: (x, y) => this.pickStar(x, y),
      starToCluster: (idx) => clusterIndexFor(idx),
      hudHandleClick: (x, y) => this.hud.handleClick(x, y),
      hudHitTest: (x, y) => this.hud.hitTest(x, y),
      hudHandlePointerMove: (x, y) => this.hud.handlePointerMove(x, y),
      applyOrbitDelta: (dx, dy) => this.applyOrbitDelta(dx, dy),
      applyTouchPan: (dx, dy) => this.applyTouchPan(dx, dy),
      zoomBy: (factor) => this.setZoom(this.view.distance * factor),
      onClickStar: (clusterIdx, button) => {
        if (button === 2) {
          // Right-click hook. Logs in dev so the wiring is observable in
          // DevTools (silent in prod); becomes a real game action when
          // right-click gets a binding.
          if (import.meta.env.DEV) console.info('[scene] right-click hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx].primary].name);
          return;
        }
        if (button === 0) this.selectAndFocusCluster(clusterIdx);
      },
      onDoubleClickStar: (clusterIdx) => this.onViewSystem(clusterIdx),
      onLongPressStar: (clusterIdx) => {
        // Long-press hook. Same shape as the right-click hook above —
        // logs in dev only; becomes a real action when touch long-press
        // gets a binding.
        if (import.meta.env.DEV) console.info('[scene] long-press hook on cluster', clusterIdx, STARS[STAR_CLUSTERS[clusterIdx].primary].name);
      },
      onPointerHoverChanged: (x, y, has) => {
        if (has) {
          this.pointer.x = x;
          this.pointer.y = y;
          this.pointer.has = true;
        } else {
          this.pointer.has = false;
        }
      },
      onEscape: () => this.deselect(),
      onFocusCandidate: () => {
        // Spacebar: candidate beats selection. Pressing space while panned
        // off the current selection (so a candidate is visible) switches
        // selection to the candidate and glides the pivot to it. Falls
        // through to "re-focus current selection" when no candidate is
        // visible.
        if (this.candidateClusterIdx >= 0) {
          this.selectAndFocusCluster(this.candidateClusterIdx);
          return;
        }
        if (this.selectedClusterIdx < 0) return;
        const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
        this.animateFocusTo(com.x, com.y, com.z);
      },
      onFocusSelection: () => {
        // F: always re-focus the current selection. Ignores any candidate
        // so F is a dedicated "back to selection" key, separate from
        // spacebar's "advance to candidate". Mirrors the Focus pill button
        // on the info card.
        if (this.selectedClusterIdx < 0) return;
        const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
        this.animateFocusTo(com.x, com.y, com.z);
      },
      onEnter: () => {
        // Enter: keyboard equivalent of the View System pill button + the
        // double-click gesture. Routes through the same onViewSystem
        // callback so the AppController scene swap stays one path.
        if (this.selectedClusterIdx < 0) return;
        this.onViewSystem(this.selectedClusterIdx);
      },
      cancelFocusAnimation: () => { this.focusAnimating = false; },
    };
  }

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). Uses cached cssW/cssH (the actual canvas size after the
  // multiple-of-N rounding in resize), not window.innerWidth/Height.
  private clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / this.cssW);
    out.y = (this.cssH - clientY) * (this.bufferH / this.cssH);
  }

  // Shared select-and-focus action: binds the selection to the given cluster
  // and glides the orbit pivot onto its COM (not any one member's position),
  // so a binary's two members both glide to the same vantage. Called from
  // the InputController's onClickStar handler and any future hook (context
  // menu, keyboard select) that wants the same behavior.
  private selectAndFocusCluster(clusterIdx: number): void {
    this.selectedClusterIdx = clusterIdx;
    this.labels.setSelectedCluster(clusterIdx);
    this.starPoints.setSelectedCluster(clusterIdx);
    this.selectionBrackets.setCluster(clusterIdx);
    this.hud.setSelectedCluster(clusterIdx);
    const com = STAR_CLUSTERS[clusterIdx].com;
    // Grid runs its own sequential expand/collapse off this call.
    // Droplines snap to the new plane immediately for now; staggering them
    // to match the ring choreography is a follow-up once the rings settle.
    this.grid.setSelection(this._comScratch.set(com.x, com.y, com.z));
    this.droplines.setSelectedCluster(clusterIdx);
    this.droplines.setFade(1);
    this.focusMarker.setSelectedCluster(clusterIdx);
    // Focus button starts in the right state for the new selection
    // (without waiting for the next tick to repaint).
    this.updateSelectedFocusedState();
    this.animateFocusTo(com.x, com.y, com.z);
  }

  // Touch-pan: midpoint translation drives view.target along the
  // camera's screen-aligned right/up axes (NOT the galactic-plane basis
  // WASD uses). Camera has zero roll, so screen-right stays in the plane
  // and is independent of pitch; screen-up tilts with pitch, so a
  // vertical drag while pitched lifts the target along the camera's
  // actual up vector instead of plunging it forward across the plane.
  // Direction is "world tracks the fingers": drag right → world shifts
  // right under the finger; drag down → world shifts down. Pixel delta
  // is converted to world units via the focus-plane scale, so a finger
  // moving N CSS px shifts the world by exactly N px at the focus
  // distance — the point under the finger stays under the finger.
  private applyTouchPan(dxPx: number, dyPx: number): void {
    const halfFovTan = Math.tan((FOV_DEG * Math.PI / 180) * 0.5);
    const lyPerPx = (2 * halfFovTan * this.view.distance) / this.cssH;
    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    const sp = Math.sin(this.view.pitch);
    const cp = Math.cos(this.view.pitch);
    this._right.set(-sy, cy, 0);
    this._step.set(-cp * cy, -cp * sy, sp);  // screen_up in world
    this.view.target.addScaledVector(this._right, -dxPx * lyPerPx);
    this.view.target.addScaledVector(this._step, dyPx * lyPerPx);
  }

  // Yaw/pitch the camera by a screen-pixel delta. Shared by single-finger
  // drag (the default) and two-finger pan-mode-when-singleTouchAction='pan',
  // both at ORBIT_SENSITIVITY_RAD_PER_PX.
  private applyOrbitDelta(dxPx: number, dyPx: number): void {
    this.view.yaw   -= dxPx * ORBIT_SENSITIVITY_RAD_PER_PX;
    this.view.pitch -= dyPx * ORBIT_SENSITIVITY_RAD_PER_PX;
    this.view.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.view.pitch));
  }

  // Per-frame WASD/QE/ZX update. Held-key set is owned by the input
  // controller; this method reads it each tick and integrates camera-pan
  // physics. Forward and right are derived from yaw alone (no pitch term)
  // so WASD pans parallel to the galactic plane regardless of camera tilt
  // — looking down at a star and pressing W glides across the plane
  // instead of plunging into it. Pitch is clamped < π so the camera always
  // has a well-defined yaw direction. Z/X translate along world up
  // (galactic plane normal) so they sink/lift the view.
  private applyHeldKeys(dt: number): void {
    const keys = this.input.getHeldKeys();
    if (keys.size === 0) return;

    const sy = Math.sin(this.view.yaw);
    const cy = Math.cos(this.view.yaw);
    // Camera = target + R*(sp*cy, sp*sy, cp); the horizontal projection of
    // (target - camera) drops the cp term. Already unit length: cy² + sy² = 1.
    this._forward.set(-cy, -sy, 0);
    this._right.crossVectors(this._forward, StarmapScene.WORLD_UP).normalize();

    this._step.set(0, 0, 0);
    if (keys.has('w')) this._step.add(this._forward);
    if (keys.has('s')) this._step.sub(this._forward);
    if (keys.has('d')) this._step.add(this._right);
    if (keys.has('a')) this._step.sub(this._right);
    if (keys.has('x')) this._step.add(StarmapScene.WORLD_UP);
    if (keys.has('z')) this._step.sub(StarmapScene.WORLD_UP);
    if (this._step.lengthSq() > 0) {
      this._step.normalize().multiplyScalar(this.view.distance * PAN_RATE_PER_DISTANCE * dt);
      this.view.target.add(this._step);
    }

    if (keys.has('q')) this.view.yaw += ORBIT_RATE_RAD * dt;
    if (keys.has('e')) this.view.yaw -= ORBIT_RATE_RAD * dt;
  }

  private deselect(): void {
    this.selectedClusterIdx = -1;
    this.labels.setSelectedCluster(-1);
    this.starPoints.setSelectedCluster(-1);
    this.selectionBrackets.setCluster(-1);
    this.hud.setSelectedCluster(-1);
    this.grid.setSelection(null);
    this.droplines.setSelectedCluster(-1);
    this.droplines.setFade(0);
    this.focusMarker.setSelectedCluster(-1);
  }

  // Push the Focus button's enabled/disabled state to the HUD. Disabled
  // when view.target sits on the selected cluster's COM (i.e. the camera
  // is already focused on it). No-op when nothing is selected — the
  // focus button is hidden in that case anyway. The HUD's setter is
  // gated, so calling this every frame only allocates on transition.
  private updateSelectedFocusedState(): void {
    if (this.selectedClusterIdx < 0) return;
    const com = STAR_CLUSTERS[this.selectedClusterIdx].com;
    const dx = this.view.target.x - com.x;
    const dy = this.view.target.y - com.y;
    const dz = this.view.target.z - com.z;
    const focused = (dx * dx + dy * dy + dz * dz) < FOCUS_EPSILON_SQ;
    this.hud.setSelectedFocused(focused);
  }

  // -- camera + zoom -----------------------------------------------------

  private setZoom(d: number): void {
    this.view.distance = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, d));
  }

  private pickStar(clientX: number, clientY: number): number {
    this._ndc.set(
      (clientX / this.cssW) * 2 - 1,
      -(clientY / this.cssH) * 2 + 1,
    );
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.starPoints.points);
    let bestD = Infinity;
    let bestIdx = -1;
    for (const h of hits) {
      if (h.distanceToRay !== undefined && h.distanceToRay < bestD) {
        bestD = h.distanceToRay;
        bestIdx = h.index ?? -1;
      }
    }
    return bestIdx;
  }

  private animateFocusTo(x: number, y: number, z: number): void {
    this.focusFrom.copy(this.view.target);
    this.focusTo.set(x, y, z);
    // Pull the orbit radius in if the new star is already closer to the
    // camera than the current radius — otherwise the lerp would translate
    // the camera away from the new target. Never push out (keep current
    // radius if the new star is farther) and clamp to ZOOM_MIN so a tight
    // focus doesn't crash through the star.
    const dx = this.camera.position.x - x;
    const dy = this.camera.position.y - y;
    const dz = this.camera.position.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.distanceFrom = this.view.distance;
    this.distanceTo = Math.max(ZOOM_MIN, Math.min(this.view.distance, d));
    this.focusAnimStart = performance.now();
    this.focusAnimating = true;
  }

  // Camera orbits target on a sphere of radius = view.distance. Under
  // perspective, that distance directly drives apparent size — no separate
  // frustum bookkeeping like the old ortho path needed.
  private updateCamera(): void {
    const sp = Math.sin(this.view.pitch), cp = Math.cos(this.view.pitch);
    const sy = Math.sin(this.view.yaw),   cy = Math.cos(this.view.yaw);
    const R = this.view.distance;
    this.camera.position.set(
      this.view.target.x + R * sp * cy,
      this.view.target.y + R * sp * sy,
      this.view.target.z + R * cp,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.view.target);
    // Force matrixWorldInverse refresh now so label projections this frame
    // see the same transform the renderer will.
    this.camera.updateMatrixWorld(true);
  }

  private resize(): void {
    // The browser's image-rendering: pixelated upscale is only exactly N:1
    // when (CSS_px × DPR) is divisible by N — i.e. the target physical-pixel
    // dimension is a multiple of N. If it isn't, the browser distributes the
    // remainder by making one buffer-pixel-wide column every (~CSS_px) actual
    // columns span (N-1) physical pixels instead of N. Labels rendered on
    // top of those compressed columns get visibly mangled (one bitmap column
    // squashed into 2 physical px instead of 3). The artifact appears to
    // "follow" labels as the camera rotates because the labels move across
    // the buffer and cross those fixed compressed columns at different
    // points within the bitmap.
    //
    // Fix: round target physical pixels DOWN to a multiple of N, then derive
    // CSS and buffer from that. Up to (N-1) physical pixels of black bezel
    // can show on the right/bottom — invisible against the dark scene.
    const dpr = window.devicePixelRatio;
    // Auto N from the observer biased by the user's resolution preference
    // (low=+1 chunkier, high=-1 sharper, medium=auto). Pulled fresh per
    // resize so flipping the radio re-applies on the next tick without
    // needing extra plumbing.
    const N = effectiveScale(this.renderScale.scale, getSettings().resolutionPreference);
    const physW = Math.floor(window.innerWidth  * dpr / N) * N;
    const physH = Math.floor(window.innerHeight * dpr / N) * N;
    const cssW = physW / dpr;
    const cssH = physH / dpr;
    this.renderer.setPixelRatio(dpr / N);
    this.renderer.setSize(cssW, cssH);
    this.cssW = cssW;
    this.cssH = cssH;
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    this.renderer.getDrawingBufferSize(this._buf);
    this.bufferW = this._buf.x;
    this.bufferH = this._buf.y;
    this.starPoints.setPxScale(this.bufferH / 2);
    this.selectionBrackets.setPxScale(this.bufferH / 2);
    this.candidateBrackets.setPxScale(this.bufferH / 2);
    setSnappedLineViewport(this.bufferW, this.bufferH);
    this.hud.resize(this.bufferW, this.bufferH);
    this.labels.resize(this.bufferW, this.bufferH);
    this.selectionBrackets.resize(this.bufferW, this.bufferH);
    this.candidateBrackets.resize(this.bufferW, this.bufferH);
  }

  // -- main loop ---------------------------------------------------------

  private tick = (): void => {
    if (!this.running) return;

    const now = performance.now();
    // Frame delta in seconds, clamped so a stalled tab resume doesn't
    // teleport the camera. First frame after start: dt = 0.
    const dt = this.lastTickMs > 0
      ? Math.min(now - this.lastTickMs, MAX_TICK_DT_MS) / 1000
      : 0;
    this.lastTickMs = now;

    if (this.view.spin) this.view.yaw += AUTOSPIN_RAD_PER_TICK;
    this.applyHeldKeys(dt);

    if (this.focusAnimating) {
      const t = Math.min(1, (performance.now() - this.focusAnimStart) / FOCUS_ANIM_MS);
      // Ease-in-out cubic: smooth at both ends, no overshoot.
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.view.target.lerpVectors(this.focusFrom, this.focusTo, e);
      this.view.distance = this.distanceFrom + (this.distanceTo - this.distanceFrom) * e;
      if (t >= 1) {
        this.view.target.copy(this.focusTo);
        this.view.distance = this.distanceTo;
        this.focusAnimating = false;
      }
    }

    this.updateCamera();
    this.updateSelectedFocusedState();
    // Grid runs its own per-frame animation off this driver call.
    // Droplines fade is binary (set in selectAndFocusCluster / deselect),
    // so no per-tick scaling is needed here.
    this.grid.update(now, this.camera.position);

    this.starPoints.setFocus(this.view.target);
    this.starPoints.setPivot(this.view.target);
    // Scale the local-focus dim by orbit distance: full effect when zoomed
    // in, smoothly off when zoomed out. Keying to view.distance (camera-to-
    // pivot) rather than a per-star camera ramp is what lets zoom-out
    // restore every star to full brightness — at large orbit radii every
    // star is far from the camera, so a per-star ramp would pin everything
    // dim no matter how far the user zooms out.
    const orbit = this.view.distance;
    const dimAmount = orbit <= STAR_DIM_FULL_BELOW ? 1
      : orbit >= STAR_DIM_OFF_ABOVE ? 0
      : 1 - (orbit - STAR_DIM_FULL_BELOW) / (STAR_DIM_OFF_ABOVE - STAR_DIM_FULL_BELOW);
    this.starPoints.setDimAmount(dimAmount);

    // Nearest cluster to the orbit pivot — computed once per tick and shared
    // by the focus marker (anchor when nothing selected) and (next commit)
    // the candidate-selection brackets. Centralizing avoids two scans per
    // frame for the same query.
    const nearestClusterIdx = nearestClusterIdxTo(
      this.view.target.x, this.view.target.y, this.view.target.z,
    );

    // Hover detection — pick the star whose ray-distance is smallest, then
    // share the cluster-mapped index with the droplines (always-show-on-
    // hover override) and the candidate computation below.
    const hovered = this.pointer.has ? this.pickStar(this.pointer.x, this.pointer.y) : -1;
    const hoveredCluster = hovered >= 0 ? clusterIndexFor(hovered) : -1;
    this.droplines.setHovered(hoveredCluster);
    this.droplines.update(this.camera, this.view.target);
    this.focusMarker.update(this.view.target, this.camera, this.focusAnimating, nearestClusterIdx);

    // Candidate cluster — only one at a time. Hover beats focus-proximity:
    // when the user is pointing at a star, that's the immediate target;
    // when they're not, the candidate falls back to the nearest cluster to
    // view.target (so the brackets reappear on whatever the keyboard pan
    // has drifted near). Both branches honor "candidate != selection" (no
    // point bracketing what's already selected).
    //
    // Hover candidate is independent of focusAnimating — cursor location
    // is real regardless of camera motion. Proximity is suppressed during
    // the glide because the pivot is in transit, not parked off a star,
    // and the brackets would just trail the camera into the new selection.
    //
    // The proximity branch additionally suppresses below FOCUS_MARKER_NEAR
    // so the brackets don't appear on the cluster the pivot is sitting on
    // (initial-load Sol case, or panning back onto a star). Same threshold
    // as the focus marker so the two indicators turn on/off together.
    //
    // Snap visibility, no fade ramp — candidate is a discrete state. The
    // unified index is pushed to brackets, labels (yellow promotion +
    // fade-bypass), and stashed for the spacebar handler.
    let candidate = -1;
    if (hoveredCluster >= 0 && hoveredCluster !== this.selectedClusterIdx) {
      candidate = hoveredCluster;
    } else if (!this.focusAnimating && nearestClusterIdx >= 0 && nearestClusterIdx !== this.selectedClusterIdx) {
      const com = STAR_CLUSTERS[nearestClusterIdx].com;
      const dx = this.view.target.x - com.x;
      const dy = this.view.target.y - com.y;
      const dz = this.view.target.z - com.z;
      if (dx * dx + dy * dy + dz * dz >= FOCUS_MARKER_NEAR * FOCUS_MARKER_NEAR) {
        candidate = nearestClusterIdx;
      }
    }
    this.candidateClusterIdx = candidate;
    this.candidateBrackets.setCluster(candidate);
    this.labels.setCandidateCluster(candidate);
    this.starPoints.setCandidateCluster(candidate);

    this.labels.update(this.camera, this.view.target);
    this.selectionBrackets.update(this.camera, this.view.target);
    this.candidateBrackets.update(this.camera, this.view.target);

    this.renderer.render(this.scene, this.camera);
    // Overlay passes — disable autoClear so the second/third renders don't
    // wipe the first. Both overlays use depthTest: false to always overlay.
    this.renderer.autoClear = false;
    this.renderer.render(this.labels.scene, this.labels.camera);
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
