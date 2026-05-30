// Range-ring + axis + galactic-centre-arrow grid, anchored at the currently
// selected cluster's center of mass. Owns its own selection-driven animation:
// rings appear/disappear sequentially (innermost ring first on expand,
// outermost first on collapse) so the frame settles into the new position
// rather than popping. A two-frame design (A/B) lets the previous selection's
// collapse run concurrently with the new selection's expand on swap.
//
// Public surface: setSelection(com | null) + update(now). The caller
// (StarmapScene) routes selection logic; per-element choreography is
// internal to this module.

import { BufferGeometry, Group, Line, LineSegments, Object3D, ShaderMaterial, Vector3 } from 'three';
import { snappedLineMat } from './materials';
import { GRID_FADE_NEAR, GRID_FADE_FAR, clampRamp } from './cluster-fade';

const GRID_OPACITY  = 0.32;
const ARROW_OPACITY = 0.45;

const RING_RADII = [5, 10, 15, 20] as const;
const RING_SEGMENTS = 128;

// Per-step interval (ms). Asymmetric on purpose: expand is slower so each
// ring lights up as a deliberate beat as the frame settles around the new
// selection; collapse is brisker because it's leaving and the user has
// already moved their attention elsewhere. The schedule below has 4 steps;
// total animation time = (steps - 1) * stagger.
const RING_STAGGER_EXPAND_MS   = 100;
const RING_STAGGER_COLLAPSE_MS = 80;

type FrameState = 'idle' | 'expanding' | 'holding' | 'collapsing';

interface Frame {
  group: Group;
  // Step schedule: index k holds the elements that toggle at step k of an
  // expand (and at the matching reversed step on collapse). Wired in
  // buildFrame so the choreography lives in one place.
  steps: Object3D[][];
  state: FrameState;
  animStartMs: number;
  // World position the frame is anchored at — mirrors group.position.
  // Compared against incoming COMs to detect re-clicks on the same selection.
  position: Vector3;
  // Per-frame materials so each frame's uOpacity can ramp independently
  // off its own COM's camera distance. During a selection swap the OLD
  // (collapsing) frame and the NEW (expanding) frame sit at different
  // COMs and would otherwise share one fade value.
  lineMat: ShaderMaterial;
  arrowMat: ShaderMaterial;
}

function ringPoints(radius: number, segments: number): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return pts;
}

function buildFrame(): Frame {
  const lineMat  = snappedLineMat({ color: 0x1e6fc4, opacity: GRID_OPACITY });
  const arrowMat = snappedLineMat({ color: 0x1e6fc4, opacity: ARROW_OPACITY });
  const group = new Group();
  group.visible = false;

  const rings: Line[] = RING_RADII.map(r => {
    const geom = new BufferGeometry().setFromPoints(ringPoints(r, RING_SEGMENTS));
    const ln = new Line(geom, lineMat);
    ln.visible = false;
    group.add(ln);
    return ln;
  });

  const xAxis = new Line(
    new BufferGeometry().setFromPoints([new Vector3(-20, 0, 0), new Vector3(20, 0, 0)]),
    lineMat,
  );
  xAxis.visible = false;
  group.add(xAxis);

  const yAxis = new Line(
    new BufferGeometry().setFromPoints([new Vector3(0, -20, 0), new Vector3(0, 20, 0)]),
    lineMat,
  );
  yAxis.visible = false;
  group.add(yAxis);

  const arrowShaft = new Line(
    new BufferGeometry().setFromPoints([new Vector3(20, 0, 0), new Vector3(24, 0, 0)]),
    arrowMat,
  );
  arrowShaft.visible = false;
  group.add(arrowShaft);

  const arrowHead = new LineSegments(
    new BufferGeometry().setFromPoints([
      new Vector3(24, 0, 0), new Vector3(22.8,  0.7, 0),
      new Vector3(24, 0, 0), new Vector3(22.8, -0.7, 0),
    ]),
    arrowMat,
  );
  arrowHead.visible = false;
  group.add(arrowHead);

  // Innermost ring fires at step 0 so expansion reads as "ripple outward
  // from the selection's center"; the outermost ring + axes + arrow share
  // the final step so the +X arrow caps the frame at full extent.
  const steps: Object3D[][] = [
    [rings[0]],
    [rings[1]],
    [rings[2]],
    [rings[3], xAxis, yAxis, arrowShaft, arrowHead],
  ];

  return {
    group,
    steps,
    state: 'idle',
    animStartMs: 0,
    position: new Vector3(),
    lineMat,
    arrowMat,
  };
}

export class Grid {
  readonly group = new Group();
  // Two frames let an old selection's collapse and a new selection's
  // expand run concurrently on a swap. At most one is "active" (currently
  // expanding or holding) — the other is idle, or running a previous
  // selection's collapse.
  private readonly frames: [Frame, Frame];
  // Index of the frame holding the active selection, or -1 when no
  // selection is showing. A frame in the collapsing state is never the
  // active one — it's a previous selection running out the clock.
  private activeIdx = -1;

  constructor() {
    // Per-frame materials let each frame's zoom-fade opacity ramp track its
    // own COM during a selection swap (collapsing OLD frame and expanding
    // NEW frame typically sit at different camera distances).
    this.frames = [buildFrame(), buildFrame()];
    for (const f of this.frames) this.group.add(f.group);
  }

  // Set or swap the active selection's anchor. Pass null to collapse the
  // current selection without replacement. Re-passing the active selection's
  // exact COM is a no-op (avoids restarting the animation on a re-click).
  setSelection(com: Vector3 | null): void {
    if (com === null) {
      if (this.activeIdx >= 0) {
        this.startCollapse(this.frames[this.activeIdx]);
        this.activeIdx = -1;
      }
      return;
    }

    if (this.activeIdx >= 0 && this.frames[this.activeIdx].position.equals(com)) return;

    // Begin collapsing whatever was active so its sequence runs concurrently
    // with the new frame's expand. Both frames render together for the
    // overlap window — the AB pattern's whole point.
    if (this.activeIdx >= 0) this.startCollapse(this.frames[this.activeIdx]);

    const target = this.pickFrame();
    this.startExpand(target, com);
    this.activeIdx = this.frames.indexOf(target);
  }

  // Per-tick driver. Cheap when no animations are running (idle/holding
  // frames bail immediately). Camera position drives the zoom-fade ramp
  // applied to each non-idle frame's materials, so the ring chrome dims
  // out as the camera retreats from the selection. Uses GRID_FADE_*
  // (slightly tighter than the labels' CAMERA_FADE_*) so the chrome
  // reaches full opacity a touch sooner on zoom-in.
  update(now: number, cameraPos: Vector3): void {
    for (const f of this.frames) {
      this.tickFrame(f, now);
      this.applyZoomFade(f, cameraPos);
    }
  }

  // -- internal --------------------------------------------------------

  // Pick a frame for a fresh expand. Prefer idle. If both are mid-animation
  // (rapid third+ click within an active swap), snap-end the older one and
  // reuse it — the newest selection always gets a clean expand from step 0;
  // the most-recent previous selection keeps its collapse running.
  private pickFrame(): Frame {
    const idle = this.frames.find(f => f.state === 'idle');
    if (idle) return idle;
    const [a, b] = this.frames;
    const older = a.animStartMs <= b.animStartMs ? a : b;
    this.snapEnd(older);
    return older;
  }

  private startExpand(f: Frame, com: Vector3): void {
    f.position.copy(com);
    f.group.position.copy(com);
    f.group.visible = true;
    for (const objs of f.steps) for (const o of objs) o.visible = false;
    f.state = 'expanding';
    f.animStartMs = performance.now();
  }

  private startCollapse(f: Frame): void {
    if (f.state === 'idle' || f.state === 'collapsing') return;
    f.state = 'collapsing';
    f.animStartMs = performance.now();
  }

  // Force a frame to its terminal state instantly. Used when the frame
  // pool is exhausted and we need to recycle one for a fresh expand.
  private snapEnd(f: Frame): void {
    if (f.state === 'idle') return;
    if (f.state === 'collapsing') {
      for (const objs of f.steps) for (const o of objs) o.visible = false;
      f.group.visible = false;
      f.state = 'idle';
      return;
    }
    if (f.state === 'expanding') {
      for (const objs of f.steps) for (const o of objs) o.visible = true;
      f.state = 'holding';
    }
  }

  // Walk the schedule for a frame whose animation is in flight. Each step k
  // fires when elapsed crosses k * stagger — visibility writes are
  // idempotent, so re-firing already-fired steps each tick is harmless.
  // Collapse reverses the order so the OUTERMOST ring (paired with axes +
  // arrow) is the first thing to disappear, and uses its own (faster)
  // stagger.
  private tickFrame(f: Frame, now: number): void {
    if (f.state !== 'expanding' && f.state !== 'collapsing') return;
    const elapsed = now - f.animStartMs;
    const totalSteps = f.steps.length;

    if (f.state === 'expanding') {
      for (let k = 0; k < totalSteps; k++) {
        if (elapsed >= k * RING_STAGGER_EXPAND_MS) {
          for (const o of f.steps[k]) o.visible = true;
        }
      }
      if (elapsed >= (totalSteps - 1) * RING_STAGGER_EXPAND_MS) f.state = 'holding';
      return;
    }

    for (let k = 0; k < totalSteps; k++) {
      if (elapsed >= k * RING_STAGGER_COLLAPSE_MS) {
        for (const o of f.steps[totalSteps - 1 - k]) o.visible = false;
      }
    }
    if (elapsed >= (totalSteps - 1) * RING_STAGGER_COLLAPSE_MS) {
      f.group.visible = false;
      f.state = 'idle';
    }
  }

  // Zoom-fade: ramp each non-idle frame's material opacity off the camera's
  // distance to that frame's COM. Idle frames are invisible already — skip
  // the uniform write.
  private applyZoomFade(f: Frame, cameraPos: Vector3): void {
    if (f.state === 'idle') return;
    const dCam = cameraPos.distanceTo(f.position);
    const ramp = clampRamp(dCam, GRID_FADE_NEAR, GRID_FADE_FAR);
    f.lineMat.uniforms.uOpacity.value  = ramp * GRID_OPACITY;
    f.arrowMat.uniforms.uOpacity.value = ramp * ARROW_OPACITY;
  }
}
