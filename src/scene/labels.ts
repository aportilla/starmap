import {
  Camera,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import { STARS, STAR_CLUSTERS, WAYPOINT_STAR_IDS } from '../data/stars';
import { makeLabelTexture } from '../data/pixel-font';
import {
  PIVOT_FADE_NEAR,
  PIVOT_FADE_FAR,
  CAMERA_FADE_NEAR,
  CAMERA_FADE_FAR,
  clampRamp,
  invRamp,
} from './cluster-fade';
import { projectWorldToBuffer } from './project-buffer';

// Labels render in their own ortho overlay pass at 1 unit = 1 buffer pixel,
// the same scheme as Hud. World-locked anchors (cluster primary, galactic-
// centre, axis ticks) are projected by the *main* camera each frame and the
// overlay mesh is placed at the resulting buffer-pixel coords.
//
// Why an overlay instead of in-scene Sprites: under perspective, a 3D Sprite
// scales with depth. With stars now depth-attenuated, also depth-attenuating
// labels would make distant labels illegible. Constant on-screen size keeps
// typography stable while the stars do the depth-cueing work.

interface ClusterLabel {
  // Plain (default) text variant — cyan name + dim-cyan suffix, warm-white
  // for Sol. Used when the cluster is neither selected nor a candidate.
  plainMesh: Mesh;
  // Reticle-yellow text variant — same glyphs, recolored. Used when the
  // cluster is selected OR is the active candidate (hover or focus-
  // proximity). Same dimensions and same anchor offset as plainMesh, so
  // swapping between them produces no positional twitch.
  yellowMesh: Mesh;
  clusterIdx: number;
  primaryStarIdx: number;
  w: number;
  h: number;
  // Curated waymarker star (Sol, Sirius, Vega, …). Cluster labels with this
  // flag fade in via a third independent opacity ramp keyed to orbit
  // distance (see LABEL_WAYPOINT_*), so they're the only labels still
  // visible at zoom-out and act as named landmarks.
  isWaypoint: boolean;
}

// Buffer-pixel gap between a star's projected position and its label.
const LABEL_OFFSET_PX = 6;

// Reticle yellow — matches BRACKET_COLOR in cluster-brackets.ts and the
// info-card star-name color (colors.starName). Selection / candidate
// labels use this color so the "this cluster is the focus" visual language
// (yellow text + yellow brackets + yellow card name) reads as one piece.
const LABEL_YELLOW = '#ffe98a';
// Dim yellow companion for the " +N" extras suffix on multi-star clusters.
// Roughly half-luminance of LABEL_YELLOW, mirroring the dim-cyan / bright-
// cyan ratio used by the plain variant ('#2d7ab8' under '#5ec8ff').
const LABEL_YELLOW_DIM = '#8c7c40';

// Cluster-label distance fade ramps live in ./cluster-fade so droplines and
// labels stay in lockstep as either gets tuned (PIVOT_FADE_*, CAMERA_FADE_*).

// Waymarker fade-in. A separate opacity ramp keyed to the camera's
// distance from Sol (i.e. the origin) so a small curated set of well-known
// stars (WAYPOINT_STAR_IDS in data/stars.ts) gain their labels back as
// the user gets "far from home" — either by zooming out, or by panning the
// pivot away from Sol while still zoomed in. Camera-from-Sol catches both;
// orbit distance alone misses the panned-while-close case. Polarity is
// *reversed* from the ramps above: close to Sol = invisible, far = visible.
// The waypoint and per-label opacities combine via max() each frame, so a
// waypoint inside the focus/camera bubble stays continuously visible as
// the user drifts away (no gap between the regular fade-out and the
// waymarker fade-in). HIDE_BELOW is tuned against DEFAULT_VIEW.distance so
// default zoom centered on Sol sits at (or just inside) the threshold —
// waypoints stay hidden at rest and fade in as the user zooms or pans
// further out. Far excursions / near-max zoom show them solidly.
const LABEL_WAYPOINT_HIDE_BELOW = 30;
const LABEL_WAYPOINT_SHOW_ABOVE = 90;

function labelMat(tex: ReturnType<typeof makeLabelTexture>['tex']): MeshBasicMaterial {
  return new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
}

export class Labels {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly clusterLabels: ClusterLabel[] = [];

  private showLabels: boolean;
  // Selection + candidate are both mirrored from the scene each tick. Both
  // promote the cluster's label to the yellow variant and bypass the fade
  // ramps + the master showLabels toggle. Candidate is computed in scene.ts
  // (hover beats focus-proximity); Labels just renders whatever cluster
  // index lands here.
  private selectedCluster = -1;
  private candidateCluster = -1;

  // Reusable per-frame scratch.
  private readonly _world = new Vector3();
  // Doubles as projectWorldToBuffer's projection scratch + screen-coord out
  // vector (.x/.y are the buffer-pixel result; .z is throwaway NDC depth).
  private readonly _screen = new Vector3();

  // Set per-frame from scene.ts so projectWorldToBuffer can short-circuit the
  // focused star to exact buffer-center coords (see project-buffer.ts).
  private viewTarget: Vector3 | null = null;

  constructor(initialShowLabels: boolean) {
    this.showLabels = initialShowLabels;
    // One label per cluster, displayed at the primary's projected position.
    // Sol's plain-variant label is warm-white rather than cyan so it stays
    // readable when its quad overlaps the equally-cyan Sol-class dot at
    // close zoom; the yellow variant is uniform across all clusters since
    // selected / candidate state is itself the salience cue.
    //
    // Two meshes per cluster: plain (default) + yellow (selected OR
    // candidate). Eager build avoids any first-promotion canvas work and
    // the memory cost is negligible (~2 small textures × ~1k clusters).
    // Same dimensions for both so the swap is positionally invisible.
    STAR_CLUSTERS.forEach((cluster, clusterIdx) => {
      const primary = STARS[cluster.primary];
      const isSol = primary.id === 'sol';
      const plainColor = isSol ? '#ffffcc' : '#5ec8ff';
      const extras = cluster.members.length - 1;
      const plainSegments = extras > 0
        ? [{ text: primary.name, color: plainColor }, { text: ` +${extras}`, color: '#2d7ab8' }]
        : [{ text: primary.name, color: plainColor }];
      const yellowSegments = extras > 0
        ? [{ text: primary.name, color: LABEL_YELLOW }, { text: ` +${extras}`, color: LABEL_YELLOW_DIM }]
        : [{ text: primary.name, color: LABEL_YELLOW }];

      const plain = makeLabelTexture(plainSegments);
      const plainMesh = new Mesh(new PlaneGeometry(plain.w, plain.h), labelMat(plain.tex));
      plainMesh.visible = false;
      this.scene.add(plainMesh);

      const yellow = makeLabelTexture(yellowSegments);
      const yellowMesh = new Mesh(new PlaneGeometry(yellow.w, yellow.h), labelMat(yellow.tex));
      yellowMesh.visible = false;
      this.scene.add(yellowMesh);

      this.clusterLabels.push({
        plainMesh, yellowMesh,
        clusterIdx,
        primaryStarIdx: cluster.primary,
        w: plain.w, h: plain.h,
        isWaypoint: WAYPOINT_STAR_IDS.has(primary.id),
      });
    });
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show;
  }

  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  setCandidateCluster(clusterIdx: number): void {
    this.candidateCluster = clusterIdx;
  }

  // Place a label so its top-left texel lands on an integer buffer pixel —
  // necessary so all four texture corners align with the buffer pixel grid
  // and every texel renders. Snapping just the center silently drops a row
  // or column of edge pixels for odd-dimension labels.
  private placeAt(mesh: Mesh, sx: number, sy: number, w: number, h: number): void {
    const cornerX = Math.round(sx - w * 0.5);
    const cornerY = Math.round(sy - h * 0.5);
    mesh.position.set(cornerX + w * 0.5, cornerY + h * 0.5, 0);
  }

  update(camera: Camera, viewTarget: Vector3): void {
    this.viewTarget = viewTarget;

    // Camera distance from Sol (origin) drives the waymarker fade-in. Used
    // instead of orbit distance so that panning the pivot far from Sol —
    // even at close zoom — also surfaces waymarkers; you're "in unfamiliar
    // territory" the moment the camera leaves Sol's neighborhood, however
    // you got there.
    const camFromSol = camera.position.length();

    // Cluster labels — each anchored above its primary star, in one of two
    // states:
    //   - plain (default cyan / warm-white-for-Sol): depth-sorted by
    //     camera distance (renderOrder = -dCam) so nearer labels overlap
    //     farther ones. Subject to the master showLabels toggle and the
    //     pivot/camera/waypoint fade ramps.
    //   - yellow (selected OR candidate): same glyphs recolored to reticle
    //     yellow. Always visible — bypasses both the fade ramps and the
    //     master showLabels toggle, since "what's selected" and "what
    //     spacebar would select" are first-class focus state, not
    //     environmental decoration. Same anchor offset as plain (the two
    //     textures are dimensionally identical), so the swap is positionally
    //     invisible.
    // Without the per-renderOrder depth sort, all cluster labels would share
    // a uniform z, and draw order would fall back to scene-add (catalog)
    // order — far labels could paint over near ones.
    for (const L of this.clusterLabels) {
      const isSelected = L.clusterIdx === this.selectedCluster;
      const isCandidate = L.clusterIdx === this.candidateCluster;
      const isYellow = isSelected || isCandidate;
      if (!this.showLabels && !isYellow) {
        L.plainMesh.visible = false; L.yellowMesh.visible = false; continue;
      }
      const s = STARS[L.primaryStarIdx];
      this._world.set(s.x, s.y, s.z);
      if (!projectWorldToBuffer(this._world, camera, this.viewTarget, this.bufferW, this.bufferH, this._screen)) {
        L.plainMesh.visible = false; L.yellowMesh.visible = false; continue;
      }
      const dCam = this._world.distanceTo(camera.position);
      let opacity = 1;
      if (!isYellow) {
        // Standard per-label fade — focus and camera-distance ramps multiply.
        const dFocus = this._world.distanceTo(viewTarget);
        let normalOpacity = 1;
        if (dFocus >= PIVOT_FADE_FAR || dCam >= CAMERA_FADE_FAR) {
          normalOpacity = 0;
        } else {
          normalOpacity *= clampRamp(dFocus, PIVOT_FADE_NEAR, PIVOT_FADE_FAR);
          normalOpacity *= clampRamp(dCam, CAMERA_FADE_NEAR, CAMERA_FADE_FAR);
        }
        // Waymarker fade-in keyed to camera-from-Sol, max'd with the
        // regular ramp so a waypoint already inside the pivot bubble
        // doesn't blink out between the regular PIVOT_FADE_FAR cutoff
        // and WAYPOINT_HIDE_BELOW.
        const waypointOpacity = L.isWaypoint
          ? invRamp(camFromSol, LABEL_WAYPOINT_HIDE_BELOW, LABEL_WAYPOINT_SHOW_ABOVE)
          : 0;
        opacity = Math.max(normalOpacity, waypointOpacity);
        if (opacity <= 0) {
          L.plainMesh.visible = false; L.yellowMesh.visible = false; continue;
        }
      }
      const active = isYellow ? L.yellowMesh : L.plainMesh;
      const inactive = isYellow ? L.plainMesh : L.yellowMesh;
      inactive.visible = false;
      active.visible = true;
      (active.material as MeshBasicMaterial).opacity = opacity;
      const cy = this._screen.y + LABEL_OFFSET_PX + L.h * 0.5;
      this.placeAt(active, this._screen.x, cy, L.w, L.h);
      active.renderOrder = -dCam;
    }
  }
}
