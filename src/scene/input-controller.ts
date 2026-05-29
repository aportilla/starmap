// Pointer/keyboard gesture controller. Owns every listener StarmapScene
// used to bind directly — pinch classifier, drag-vs-click discrimination,
// touch long-press, double-click window, WASD/QE/ZX held-key set — and
// dispatches high-level intents back to the scene through the InputHandlers
// callback bundle.
//
// The split: this module decides *what gesture is happening* (orbit drag,
// pinch zoom, pinch pan, click vs drag, long-press, etc.); the scene
// decides *how that gesture should affect the camera and selection*. Pure
// camera math (applyOrbitDelta, applyTouchPan, setZoom) and selection
// logic stay in scene.ts; this module never reads or mutates view state
// directly.
//
// Held-key state lives here but is consumed by the scene each tick via
// getHeldKeys() — keydown/keyup/blur all run through the listener bound
// in this class, but per-frame WASD physics stays with the camera code
// that actually integrates the deltas.

import { getSettings } from '../settings';
import { type HitResult } from '../ui/hit-test';

// A pointer release that moved less than this many CSS pixels from its
// pressdown counts as a click (vs the start of an orbit drag). Forgiving
// enough to absorb hand jitter on a press.
const CLICK_DRAG_PX = 4;

// Two-finger classifier thresholds (CSS px). The gesture stays 'undecided'
// (no zoom, no pan applied) until one of these is exceeded:
//   - PAN: Euclidean distance the midpoint of the two pointers has
//     traveled from gesture start.
//   - ZOOM: scalar change in the distance between the two pointers
//     (|currentDist - startDist|). Doubled relative to PAN because in a
//     symmetric pinch BOTH fingers contribute to the separation change,
//     so 80 px of separation ≈ each finger moving 40 px — comparable
//     per-finger effort to a 40 px pan. When both signals cross in the
//     same frame, the larger ratio (signal/threshold) wins. Both metrics
//     are scalar magnitudes, so the heuristic is orientation-agnostic
//     (same numbers whether the fingers are stacked, side-by-side, or
//     diagonal). Sized well above touch-down jitter so contact-stabilization
//     noise can never cross either threshold on its own — the user has
//     to actually engage with the gesture before a mode locks.
const GESTURE_COMMIT_PAN_PX = 40;
const GESTURE_COMMIT_ZOOM_PX = 80;

// "Actively moving along the separation axis" threshold for the pinch-vs-pan
// classifier (CSS px). A finger whose displacement projects below this onto
// the separation axis is treated as anchored — even if the other finger is
// shooting off in the same signed direction, that's an anchor-style pinch
// (thumb-fixed, index-splays), not a pan. Only when BOTH fingers project
// above this *and* share a sign do we conclude the pair is translating
// together (asymmetric pan along u), and zero out the zoom signal.
const ACTIVE_PROJ_PX = 2;

// Window within which a second left-click on the same cluster counts as a
// double-click (and opens the system view). Sized for a deliberate double
// rather than a fast fidget.
const DOUBLE_CLICK_MS = 350;

// Long-press: touch-only hook held alive as a placeholder for a future game
// action (context menu, secondary command, etc.). LONG_PRESS_MS gates the
// timer fire; LONG_PRESS_MOVE_PX cancels it when the holding finger drifts
// (looser than CLICK_DRAG_PX because users drift more during a held press
// than a quick tap).
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 8;

// Wheel-zoom base: zoom factor is WHEEL_ZOOM_BASE^deltaY, so each wheel
// notch multiplies the orbit distance by a small constant (a bit >1 zooms
// out on positive deltaY, <1/notch zooms in on negative).
const WHEEL_ZOOM_BASE = 1.0015;

// A tracked pointer's CSS-pixel position.
type Pt = { x: number; y: number };

export interface InputHandlers {
  // Map a CSS-pixel client coord into HUD buffer coords. Scene owns the
  // cssW/H/bufferW/H cache populated by its own resize().
  clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void;
  // Star raycasting against the current scene/camera. Returns a star
  // index or -1.
  pickStar(clientX: number, clientY: number): number;
  // Resolve a star index to its containing cluster index.
  starToCluster(starIdx: number): number;

  // HUD layer — controller asks the HUD whether each pointer event lands
  // on chrome before it acts on it. handleClick returns true to mean
  // "claimed; don't enter the gesture state machine."
  hudHandleClick(bufX: number, bufY: number): boolean;
  hudHitTest(bufX: number, bufY: number): HitResult;
  hudHandlePointerMove(bufX: number, bufY: number): void;

  // Camera mutations — controller computes deltas in CSS pixels and the
  // scene applies them to view-state with the right sensitivity / clamps.
  applyOrbitDelta(dxPx: number, dyPx: number): void;
  applyTouchPan(dxPx: number, dyPx: number): void;
  // Multiply view.distance by `factor`, clamped to the orbit-radius bounds.
  zoomBy(factor: number): void;

  // High-level intents emitted after gesture classification.
  onClickStar(clusterIdx: number, button: number): void;
  onDoubleClickStar(clusterIdx: number): void;
  onLongPressStar(clusterIdx: number): void;
  // Hover-pointer state for the scene's per-tick raycast (drives candidate
  // promotion: hovered cluster becomes the yellow-label / dot-bracketed
  // target). x/y are ignored when has=false.
  onPointerHoverChanged(clientX: number, clientY: number, has: boolean): void;
  onEscape(): void;
  // Spacebar: act on the candidate. If a candidate cluster is shown,
  // promote it to selection + glide the pivot to its COM. Otherwise fall
  // back to re-focusing the current selection (or no-op if nothing is
  // selected).
  onFocusCandidate(): void;
  // F key + the Focus pill button: always re-focus the currently-selected
  // cluster's COM. Ignores any candidate — F is "go home", not "advance".
  // No-op when nothing is selected.
  onFocusSelection(): void;
  // Enter key: open the system view for the currently-selected cluster.
  // Keyboard equivalent of the View System pill button + double-click.
  // Ignores any candidate (you must first select via click or spacebar);
  // no-op when nothing is selected.
  onEnter(): void;

  // Cancel any in-flight focus-glide animation when the user takes manual
  // control of the camera (pinch zoom/pan, WASD/QE/ZX). Drag-orbit and
  // single-finger touch-pan deliberately don't trigger this — see the
  // comments at the call sites for which gestures cancel and which don't.
  cancelFocusAnimation(): void;
}

export class InputController {
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: InputHandlers;

  // Drag state. Any pointer drag = orbit (yaw/pitch) by default; touch
  // can be remapped to pan via the singleTouchAction setting. Single-
  // button mice always orbit.
  private dragging = false;
  private dragButton = 0;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;

  // Active pointers, keyed by pointerId. size === 1 → orbit drag;
  // size >= 2 → pinch (orbit suppressed). Tracking via pointer events
  // unifies mouse + touch + pen and lets pinch detection run off the same
  // event stream as the drag, so a second finger landing mid-drag cleanly
  // hands off to pinch instead of running both gestures simultaneously.
  // Without unification, iPad Safari pinches arrive with a yaw jolt: the
  // first finger's pointermove fires while touchmove zooms.
  private readonly pointers = new Map<number, Pt>();
  private pinching = false;
  // Two-finger gesture commits to either zoom or pan on the first
  // significant movement; once committed it stays in that mode for the
  // rest of the gesture so a slight separation drift mid-pan can't yank
  // the zoom (and vice versa). 'undecided' is the sampling window.
  private pinchMode: 'undecided' | 'zoom' | 'pan' = 'undecided';
  private pinchDist = 0;
  // Midpoint of the active two-pointer pair, in CSS pixels.
  private pinchMidX = 0;
  private pinchMidY = 0;
  // Snapshot of dist + mid at gesture start. The undecided-mode classifier
  // measures sepDelta and midDelta from these anchors and commits to
  // whichever signal first overshoots its own threshold (GESTURE_COMMIT_*);
  // on a same-frame tie, the larger ratio (signal/threshold) wins.
  private pinchStartDist = 0;
  private pinchStartMidX = 0;
  private pinchStartMidY = 0;
  // Per-finger start positions, in the same iteration order as
  // measurePinch/capturePinchMid. Used by the classifier to project each
  // finger's motion onto the separation axis: a real pinch has the two
  // projections in OPPOSITE directions; an asymmetric pan along that axis
  // has them in the SAME direction. Without this gate, finger asymmetry
  // along the line between fingers fakes a sepDelta that can outrun the
  // midpoint delta and mis-commit a pan to zoom.
  private pinchStartAx = 0;
  private pinchStartAy = 0;
  private pinchStartBx = 0;
  private pinchStartBy = 0;

  // Held-key state for WASD pan + QE orbit + ZX lift. Continuous-while-held;
  // cleared on blur so a key whose keyup got swallowed (alt-tab, etc.)
  // doesn't get stuck and carry the camera off-screen. Scene reads via
  // getHeldKeys() in its tick loop.
  private readonly heldKeys = new Set<string>();

  // Input-source preemption. The OS keeps reporting the cursor's last known
  // position forever, but once the user starts driving with the keyboard
  // (WASDQEZX) that position is stale data — in a dense starfield it would
  // otherwise pin the hover candidate on whatever the cursor happens to be
  // parked over, flickering against the keyboard-driven focus-proximity
  // candidate. Pressing any nav key marks the pointer stale and emits a
  // one-shot has=false to clear hover; the next pointermove flips it back
  // to fresh. Releasing keys does NOT unstale — only actual cursor motion
  // does — so the candidate can't snap back onto a static cursor after the
  // user stops keying.
  private pointerStale = false;

  // Long-press timer state. Armed in onPointerDown for touch pointers only,
  // cancelled by movement / second finger / lift / OS-cancel / stop().
  // longPressFired suppresses the trailing pointerup's click path so a hold
  // doesn't double-fire as both long-press AND tap-select-and-focus.
  private longPressTimer: number | null = null;
  private longPressPointerId = -1;
  private longPressFired = false;

  // Double-click tracking. A second left-click on the same cluster within
  // DOUBLE_CLICK_MS of the first emits onDoubleClickStar; either a click on
  // a different cluster or a timed-out gap restarts the window.
  private lastClickAt = 0;
  private lastClickClusterIdx = -1;

  // Reusable scratch for HUD coord conversion.
  private readonly _hudPt = { x: 0, y: 0 };

  // Bound listeners stored so removeEventListener works in stop().
  private readonly _onPointerDown   = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerUp     = (e: PointerEvent) => this.onPointerUp(e);
  private readonly _onPointerMove   = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerCancel = (e: PointerEvent) => this.onPointerCancel(e);
  private readonly _onWheel         = (e: WheelEvent) => this.onWheel(e);
  private readonly _onContextMenu   = (e: Event) => e.preventDefault();
  private readonly _onKeyDown       = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onKeyUp         = (e: KeyboardEvent) => this.onKeyUp(e);
  private readonly _onBlur          = () => this.heldKeys.clear();

  constructor(canvas: HTMLCanvasElement, handlers: InputHandlers) {
    this.canvas = canvas;
    this.handlers = handlers;
  }

  start(): void {
    this.canvas.addEventListener('pointerdown',   this._onPointerDown);
    this.canvas.addEventListener('pointerup',     this._onPointerUp);
    this.canvas.addEventListener('pointermove',   this._onPointerMove);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('wheel',         this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu',   this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    window.addEventListener('blur',    this._onBlur);
  }

  stop(): void {
    this.canvas.removeEventListener('pointerdown',   this._onPointerDown);
    this.canvas.removeEventListener('pointerup',     this._onPointerUp);
    this.canvas.removeEventListener('pointermove',   this._onPointerMove);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('wheel',         this._onWheel);
    this.canvas.removeEventListener('contextmenu',   this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    window.removeEventListener('blur',    this._onBlur);
    this.cancelLongPress();
  }

  // Scene reads this each tick to drive WASD/QE/ZX physics.
  getHeldKeys(): ReadonlySet<string> {
    return this.heldKeys;
  }

  // -- pointer events ---------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    // HUD click intercepts orbit so dragging-on-button doesn't move the camera.
    // HUD-claimed taps never enter the pointers map, so a follow-up second
    // finger won't trigger pinch from a half-tracked first finger.
    this.handlers.clientToHud(e.clientX, e.clientY, this._hudPt);
    if (this.handlers.hudHandleClick(this._hudPt.x, this._hudPt.y)) return;

    // Snapshot pre-add size so we can tell whether THIS pointerdown is
    // the 1→2 transition that starts a pinch, vs an extraneous third+
    // finger landing on top of an already-active pinch.
    const wasMulti = this.pointers.size >= 2;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Third (or later) finger landing mid-pinch — palm contact, accidental
    // tap, etc. Track the pointer so it gets cleaned up on lift, but do
    // NOT resnapshot or reset pinchMode; the user's locked mode and
    // gesture-start anchor must survive the brush.
    if (wasMulti) return;

    if (this.pointers.size >= 2) {
      // Second finger landed mid-drag → enter pinch and abandon the orbit
      // gesture. Without this hand-off, the first finger's pointermoves would
      // keep yawing/pitching the camera while the pinch is zooming.
      this.cancelLongPress();
      this.dragging = false;
      document.body.classList.remove('grabbing');
      this.pinching = true;
      this.pinchMode = 'undecided';
      this.pinchDist = this.measurePinch();
      this.pinchStartDist = this.pinchDist;
      this.capturePinchMid();
      this.pinchStartMidX = this.pinchMidX;
      this.pinchStartMidY = this.pinchMidY;
      this.capturePinchStart();
      return;
    }

    this.dragging = true;
    this.dragButton = e.button;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.downX = e.clientX; this.downY = e.clientY;
    document.body.classList.add('grabbing');

    // Touch-only long-press hook: hold a finger still on a star for
    // LONG_PRESS_MS and onLongPressStar fires. Mouse and pen are excluded
    // so a regular click doesn't accidentally fire it. Cancelled by
    // movement, second-finger entry, lift, OS-cancel, or stop().
    if (e.pointerType === 'touch') {
      this.longPressPointerId = e.pointerId;
      this.longPressFired = false;
      const x = e.clientX, y = e.clientY;
      this.longPressTimer = window.setTimeout(() => this.fireLongPress(x, y), LONG_PRESS_MS);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const wasPinching = this.pinching;
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();

    if (wasPinching) {
      // Stay in pinch mode while any pointer remains. Lifting one of two
      // fingers shouldn't snap straight back to orbit drag — the user is
      // mid-gesture and the lone finger may still be moving from the pinch.
      if (this.pointers.size === 0) {
        this.pinching = false;
        this.pinchDist = 0;
        this.pinchMode = 'undecided';
      }
      return;
    }

    // Long-press already fired its hook while the finger was still down.
    // Swallow the trailing pointerup so the same hold doesn't also register
    // as a tap-select-and-focus.
    if (this.longPressFired) {
      this.longPressFired = false;
      this.dragging = false;
      document.body.classList.remove('grabbing');
      return;
    }

    if (!this.dragging) return;
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    const isClick = moved < CLICK_DRAG_PX;
    this.dragging = false;
    document.body.classList.remove('grabbing');

    if (!isClick) return;
    const hit = this.handlers.pickStar(e.clientX, e.clientY);
    if (hit < 0) return;
    const clusterIdx = this.handlers.starToCluster(hit);
    const button = this.dragButton;
    // Right-click hook (placeholder). Emitted but no double-click logic.
    if (button === 2) {
      this.handlers.onClickStar(clusterIdx, 2);
      return;
    }
    if (button !== 0) return;
    this.handlers.onClickStar(clusterIdx, 0);
    // Double-click on the same cluster within the window → emit
    // onDoubleClickStar. Reset the window after firing so a triple-click
    // doesn't fire the second event twice.
    const now = performance.now();
    if (now - this.lastClickAt < DOUBLE_CLICK_MS && this.lastClickClusterIdx === clusterIdx) {
      this.handlers.onDoubleClickStar(clusterIdx);
      this.lastClickAt = 0;
      this.lastClickClusterIdx = -1;
    } else {
      this.lastClickAt = now;
      this.lastClickClusterIdx = clusterIdx;
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    // Pointer cancelled by the OS (palm rejection, gesture stolen, etc).
    // Drop it from tracking and reset gesture state so the next gesture
    // starts clean.
    this.pointers.delete(e.pointerId);
    this.cancelLongPress();
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) {
      this.pinching = false;
      this.pinchMode = 'undecided';
      this.dragging = false;
      document.body.classList.remove('grabbing');
    }
  }

  private onPointerMove(e: PointerEvent): void {
    // Cursor moved → pointer is fresh again, hover takes over from any
    // prior keyboard-nav suppression. The existing has=true emit below
    // re-enables hover the same tick (unless gated by touch/HUD).
    this.pointerStale = false;

    // Hit-test the HUD layer first. Touch input has no hover semantics
    // (drop pointer regardless); mouse/pen leak to the world only when
    // the HUD is fully transparent at the cursor — anything 'opaque' or
    // 'interactive' must occlude scene picking, otherwise a star behind
    // a panel/button would still light up its hover label.
    this.handlers.clientToHud(e.clientX, e.clientY, this._hudPt);
    const hudHit = this.handlers.hudHitTest(this._hudPt.x, this._hudPt.y);
    if (e.pointerType === 'touch' || hudHit !== 'transparent') {
      this.handlers.onPointerHoverChanged(e.clientX, e.clientY, false);
    } else {
      this.handlers.onPointerHoverChanged(e.clientX, e.clientY, true);
    }
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Cancel a pending long-press the moment the holding finger drifts
    // beyond LONG_PRESS_MOVE_PX from its press position — we'd rather
    // commit to orbit/pan than fire the hook under a moving finger.
    if (this.longPressTimer !== null && e.pointerId === this.longPressPointerId) {
      const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
      if (moved > LONG_PRESS_MOVE_PX) this.cancelLongPress();
    }

    if (this.pinching) {
      // Two-finger gesture stays 'undecided' (nothing applied) until either
      // sepDelta exceeds GESTURE_COMMIT_ZOOM_PX or midDelta exceeds
      // GESTURE_COMMIT_PAN_PX. The signal that overshoots its own threshold
      // by more locks the mode for the rest of the gesture.
      if (this.pointers.size >= 2) {
        const d = this.measurePinch();
        const oldMidX = this.pinchMidX;
        const oldMidY = this.pinchMidY;
        this.capturePinchMid();

        if (this.pinchMode === 'undecided') {
          // Pan signal: Euclidean distance the midpoint has traveled.
          const midDelta = Math.hypot(
            this.pinchMidX - this.pinchStartMidX,
            this.pinchMidY - this.pinchStartMidY,
          );
          // Pinch signal: scalar change in finger separation. Gated by
          // the per-finger projections onto the start separation axis u
          // so an asymmetric pan ALONG u (both fingers moving the same
          // way at different speeds) doesn't fake a separation change.
          let sepDelta = 0;
          if (this.pinchStartDist > 0) {
            const [a, b] = this.firstTwoPointers();
            const ux = (this.pinchStartBx - this.pinchStartAx) / this.pinchStartDist;
            const uy = (this.pinchStartBy - this.pinchStartAy) / this.pinchStartDist;
            const projA = (a.x - this.pinchStartAx) * ux + (a.y - this.pinchStartAy) * uy;
            const projB = (b.x - this.pinchStartBx) * ux + (b.y - this.pinchStartBy) * uy;
            const bothActive = Math.abs(projA) > ACTIVE_PROJ_PX && Math.abs(projB) > ACTIVE_PROJ_PX;
            const sameDirection = bothActive && projA * projB > 0;
            if (!sameDirection) sepDelta = Math.abs(d - this.pinchStartDist);
          }
          // Independent thresholds (zoom doubled because both fingers
          // contribute to separation change). Compare ratios so the
          // signal that overshoots its own threshold by more wins when
          // both cross in the same frame.
          const sepRatio = sepDelta / GESTURE_COMMIT_ZOOM_PX;
          const midRatio = midDelta / GESTURE_COMMIT_PAN_PX;
          if (Math.max(sepRatio, midRatio) >= 1) {
            this.pinchMode = sepRatio > midRatio ? 'zoom' : 'pan';
          }
        }

        if (this.pinchMode === 'zoom') {
          if (d > 0 && this.pinchDist > 0) this.handlers.zoomBy(this.pinchDist / d);
          this.handlers.cancelFocusAnimation();
        } else if (this.pinchMode === 'pan') {
          const ddx = this.pinchMidX - oldMidX;
          const ddy = this.pinchMidY - oldMidY;
          if (ddx !== 0 || ddy !== 0) {
            // singleTouchAction = 'pan' swaps the camera-control mapping:
            // single touch becomes the panner, and the two-finger pan
            // gesture drives orbit. The disambiguator (pinch vs pan)
            // doesn't change — only what the 'pan' commit *does*.
            if (getSettings().singleTouchAction === 'pan') {
              this.handlers.applyOrbitDelta(ddx, ddy);
            } else {
              this.handlers.applyTouchPan(ddx, ddy);
            }
          }
          this.handlers.cancelFocusAnimation();
        }
        this.pinchDist = d;
      }
      return;
    }

    // Update HUD hover state. While actively dragging the camera we skip the
    // HUD hover update so the cursor doesn't lose its grabbing affordance.
    // Cursor follows hudHit so it only switches to pointer over an
    // interactive element — opaque chrome (panel bg, info card body)
    // keeps the default cursor.
    if (!this.dragging) {
      this.handlers.hudHandlePointerMove(this._hudPt.x, this._hudPt.y);
      this.canvas.style.cursor = hudHit === 'interactive' ? 'pointer' : '';
      return;
    }
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    // Single-touch behavior is configurable: 'orbit' (default) yaws/pitches
    // the camera; 'pan' translates view.target along the camera's
    // screen-aligned axes, leaving orbit to the two-finger gesture. Mouse
    // and pen drags ignore the setting and always orbit.
    if (e.pointerType === 'touch' && getSettings().singleTouchAction === 'pan') {
      this.handlers.applyTouchPan(dx, dy);
    } else {
      this.handlers.applyOrbitDelta(dx, dy);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.handlers.zoomBy(Math.pow(WHEEL_ZOOM_BASE, e.deltaY));
  }

  // -- keyboard ---------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.handlers.onEscape();
      return;
    }
    if (e.key === 'Enter') {
      // Enter = open the system view for the selected cluster. Skip when
      // a modifier is held so Cmd/Ctrl/Alt+Enter stays free for future
      // bindings (and the browser's own Enter handling on focused chrome
      // — though our HUD is canvas-rendered with no DOM focus targets).
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      this.handlers.onEnter();
      e.preventDefault();
      return;
    }
    if (e.key === ' ') {
      // Spacebar = act on the candidate (or fall back to re-focusing the
      // current selection).
      this.handlers.onFocusCandidate();
      // preventDefault even on no-op — spacebar would otherwise scroll
      // the page (visible if the canvas is shorter than the viewport
      // after the multiple-of-N rounding in scene resize).
      e.preventDefault();
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      // F = re-focus the current selection only. Ignores candidate so
      // there's always a dedicated "back to selection" key separate from
      // the candidate-advance key. Skip Cmd/Ctrl/Alt+F so the browser's
      // find shortcut still works.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.handlers.onFocusSelection();
      e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e' || k === 'z' || k === 'x') {
      // Skip when a browser-shortcut modifier is held (Cmd+W close tab,
      // Ctrl+S save, Alt+D address-bar focus, etc.) — let the browser have
      // those. Shift stays live so it remains available for future tuning
      // (e.g. boost) without breaking shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      this.heldKeys.add(k);
      // Keyboard is now driving — gate off hover until the cursor moves
      // again (see pointerStale). One-shot the has=false emit on the
      // fresh→stale transition so the candidate clears this tick; auto-
      // repeated keydowns then short-circuit.
      if (!this.pointerStale) {
        this.pointerStale = true;
        this.handlers.onPointerHoverChanged(0, 0, false);
      }
      // User taking manual control cancels any in-flight focus glide,
      // otherwise the lerp would fight the WASD translation.
      this.handlers.cancelFocusAnimation();
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.heldKeys.delete(e.key.toLowerCase());
  }

  // -- long-press / pinch helpers --------------------------------------

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private fireLongPress(clientX: number, clientY: number): void {
    this.longPressTimer = null;
    const hit = this.handlers.pickStar(clientX, clientY);
    if (hit < 0) return;
    const clusterIdx = this.handlers.starToCluster(hit);
    this.handlers.onLongPressStar(clusterIdx);
    this.longPressFired = true;
  }

  // The active two-pointer pair, in first-seen Map-iteration order. Every
  // pinch computation (separation, midpoint, per-finger start anchor) reads
  // the same two pointers in the same order. Only call with size >= 2 — the
  // non-null assertions assume both entries exist.
  private firstTwoPointers(): [Pt, Pt] {
    const it = this.pointers.values();
    return [it.next().value!, it.next().value!];
  }

  private measurePinch(): number {
    const [a, b] = this.firstTwoPointers();
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private capturePinchMid(): void {
    const [a, b] = this.firstTwoPointers();
    this.pinchMidX = (a.x + b.x) * 0.5;
    this.pinchMidY = (a.y + b.y) * 0.5;
  }

  private capturePinchStart(): void {
    const [a, b] = this.firstTwoPointers();
    this.pinchStartAx = a.x; this.pinchStartAy = a.y;
    this.pinchStartBx = b.x; this.pinchStartBy = b.y;
  }
}
