// Focus-point indicator: a small ring at view.target, with an optional
// vertical dropline down to the selected cluster's plane.
//
// The ring renders whenever view.target sits past a small threshold from
// the nearest "anchor" star — when a cluster is selected, that's the
// selection COM; otherwise it's the nearest cluster COM, so the marker
// fades in as the user pans into empty space between stars and stays
// hidden while sitting on or near a star (including initial-load at Sol).
//
// The dropline portion exists only when a cluster is selected — that's
// the only state where a plane exists to drop to. Without a selection
// the ring renders alone.
//
// Geometry is anchored at the group's local origin and the group is
// translated to view.target each tick. Top of the dropline stays at local
// (0,0,0); bottom rewrites to (0,0, planeZ - view.target.z). Dots span the
// same local Z range at fixed-period offsets — same pattern density as
// the per-cluster droplines (DROPLINE_DOT_PERIOD_LY) so the depth cue reads
// consistently. Solid/dotted swap by camera side of plane mirrors
// droplines.ts.

import {
  BufferGeometry,
  Camera,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Line,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { STAR_CLUSTERS } from '../data/stars';
import { snappedDotsMat, snappedLineMat } from './materials';
import { fillVerticalDotPin } from './dot-pin';
import {
  DROPLINE_COLOR_SOLID,
  DROPLINE_COLOR_DOTS,
  DROPLINE_DOT_PERIOD_LY,
  DROPLINE_DEGENERATE_DIST,
} from './cluster-fade';

// Ring matches the grid rings (same blue, same base opacity at full ramp)
// so the marker reads as a small companion to them rather than a different
// element class.
const RING_COLOR = 0x1e6fc4;
const RING_BASE_OPACITY = 0.32;
const RING_RADIUS_LY = 0.4;
const RING_SEGMENTS = 32;

// Distance ramp keyed to |view.target − anchor COM| (selected cluster, or
// nearest cluster when nothing is selected). Below NEAR the marker is
// hidden outright; above FAR it sits at full base opacity. Linear in
// between — pure function of the current pan offset, no animation state,
// so the marker tracks view.target frame-by-frame without lag.
//
// NEAR is exported so the candidate-brackets gate uses the same threshold:
// "pivot is sitting on a star" reads identically for both the focus marker
// and the candidate-target indicator.
export const FOCUS_MARKER_NEAR = 0.5;
const FOCUS_MARKER_FAR  = 1.5;

// Pre-allocated capacity. Most pans stay near the selection plane, but
// Z/X keyboard fly can put view.target tens of ly off — give the buffer
// enough room that the user can't pan past it.
const MAX_DOTS = 200;

export class FocusMarker {
  readonly group = new Group();
  private readonly ring: Line;
  private readonly solid: Line;
  private readonly dots: Points;
  private readonly ringMat: ShaderMaterial;
  private readonly solidMat: ShaderMaterial;
  private readonly dotsMat: ShaderMaterial;
  private selectedCluster = -1;

  constructor() {
    this.group.visible = false;

    const ringPts: Vector3[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      ringPts.push(new Vector3(Math.cos(a) * RING_RADIUS_LY, Math.sin(a) * RING_RADIUS_LY, 0));
    }
    this.ringMat = snappedLineMat({ color: RING_COLOR, opacity: 0 });
    this.ring = new Line(new BufferGeometry().setFromPoints(ringPts), this.ringMat);
    this.group.add(this.ring);

    this.solidMat = snappedLineMat({ color: DROPLINE_COLOR_SOLID, opacity: 0 });
    const solidGeom = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 0),
    ]);
    (solidGeom.attributes.position as Float32BufferAttribute).setUsage(DynamicDrawUsage);
    this.solid = new Line(solidGeom, this.solidMat);
    this.group.add(this.solid);

    this.dotsMat = snappedDotsMat({ color: DROPLINE_COLOR_DOTS, opacity: 0 });
    const dotsArr = new Float32Array(MAX_DOTS * 3);
    const dotsGeom = new BufferGeometry();
    const dotsAttr = new Float32BufferAttribute(dotsArr, 3);
    dotsAttr.setUsage(DynamicDrawUsage);
    dotsGeom.setAttribute('position', dotsAttr);
    dotsGeom.setDrawRange(0, 0);
    this.dots = new Points(dotsGeom, this.dotsMat);
    this.group.add(this.dots);
  }

  setSelectedCluster(clusterIdx: number): void {
    this.selectedCluster = clusterIdx;
  }

  update(viewTarget: Vector3, camera: Camera, focusAnimating: boolean, nearestClusterIdx: number): void {
    // Suppress during the focus glide — the pivot is in transit toward a
    // new COM, not parked off a star, so the "where am I looking" hint
    // would just trail the camera as it zooms in and read as noise.
    if (focusAnimating) {
      this.group.visible = false;
      return;
    }

    // Anchor distance — selection COM when selected, otherwise nearest
    // cluster COM (precomputed by the scene; shared with the candidate
    // marker so we only run the scan once per tick). The "nearest" anchor
    // keeps the marker hidden while view.target sits on/near any star
    // (Sol on initial load, or any star the camera happens to be lined
    // up with) and fades it in as the user pans into empty space between
    // stars.
    const anchorIdx = this.selectedCluster >= 0 ? this.selectedCluster : nearestClusterIdx;
    if (anchorIdx < 0) {
      this.group.visible = false;
      return;
    }
    const anchorDist = this.distToCluster(viewTarget, anchorIdx);

    if (anchorDist <= FOCUS_MARKER_NEAR) {
      this.group.visible = false;
      return;
    }

    this.group.visible = true;
    this.group.position.copy(viewTarget);

    const ramp = anchorDist >= FOCUS_MARKER_FAR
      ? 1
      : (anchorDist - FOCUS_MARKER_NEAR) / (FOCUS_MARKER_FAR - FOCUS_MARKER_NEAR);
    this.ringMat.uniforms.uOpacity.value = ramp * RING_BASE_OPACITY;

    // Dropline portion: only when a cluster is selected — that's the
    // only state where a plane exists to drop to. Ring renders alone
    // otherwise.
    if (this.selectedCluster < 0) {
      this.solid.visible = false;
      this.dots.visible = false;
      return;
    }

    const planeZ = STAR_CLUSTERS[this.selectedCluster].com.z;
    const localBottomZ = planeZ - viewTarget.z;
    const dropLen = Math.abs(localBottomZ);

    if (dropLen < DROPLINE_DEGENERATE_DIST) {
      this.solid.visible = false;
      this.dots.visible = false;
      return;
    }

    // Solid when view.target sits on the camera's side of the plane,
    // dotted on the far side — same rule as the per-cluster pins so the
    // depth language stays uniform across the scene.
    const camAbove = camera.position.z >= planeZ;
    const targetAbove = viewTarget.z >= planeZ;
    const sameSide = targetAbove === camAbove;

    if (sameSide) {
      this.solid.visible = true;
      this.dots.visible = false;
      const pos = this.solid.geometry.attributes.position as Float32BufferAttribute;
      pos.setXYZ(1, 0, 0, localBottomZ);
      pos.needsUpdate = true;
      this.solidMat.uniforms.uOpacity.value = ramp;
    } else {
      this.solid.visible = false;
      this.dots.visible = true;
      // Local frame: 0 is the ring (top, at view.target), localBottomZ is the
      // plane. Dots run from the ring toward the plane at fixed period.
      const pos = this.dots.geometry.attributes.position as Float32BufferAttribute;
      const count = fillVerticalDotPin(
        pos, 0, 0, 0, localBottomZ, DROPLINE_DOT_PERIOD_LY, MAX_DOTS,
      );
      pos.needsUpdate = true;
      this.dots.geometry.setDrawRange(0, count);
      this.dotsMat.uniforms.uOpacity.value = ramp;
    }
  }

  private distToCluster(viewTarget: Vector3, clusterIdx: number): number {
    const com = STAR_CLUSTERS[clusterIdx].com;
    const dx = viewTarget.x - com.x;
    const dy = viewTarget.y - com.y;
    const dz = viewTarget.z - com.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
