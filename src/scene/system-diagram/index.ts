// SystemDiagram — flat 2D screen diagram of one star cluster.
//
// Coordinator only: owns the Three.js Scene + OrthographicCamera, holds
// the layer objects, and threads layout / pick / hover through them in
// the right order. The renderable content lives entirely in the layers
// under ./layers; the math primitives they share live in ./geom and
// ./layout.
//
// Layer ordering at construction is significant only insofar as scene
// adds happen in this order — the actual draw order is governed by
// per-row-item z banding (see layout/constants.ts) plus renderOrder
// tiebreakers.

import { OrthographicCamera, Scene } from 'three';
import { STAR_CLUSTERS } from '../../data/stars';
import { BeltsLayer } from './layers/belts';
import { MoonsLayer } from './layers/moons';
import { PlanetsLayer } from './layers/planets';
import { RingsLayer } from './layers/rings';
import { StarsRowLayer } from './layers/stars-row';
import { buildRowSlots, layoutRow, type RowSlot } from './layout/row';
import { type DiagramHit, type DiagramPick, picksEqual } from './types';

export type { DiagramPick } from './types';

export class SystemDiagram {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(0, 1, 1, 0, -1, 1);

  private bufferW = 1;
  private bufferH = 1;

  private readonly rowSlots: RowSlot[];

  private readonly stars:   StarsRowLayer;
  private readonly planets: PlanetsLayer;
  private readonly belts:   BeltsLayer;
  private readonly moons:   MoonsLayer;
  private readonly rings:   RingsLayer;

  // Currently-outlined body. setHovered() diffs against this to skip
  // no-op repaints (cursor moving within the same disc) and to clear the
  // previous outline before stamping the new one.
  private hoveredPick: DiagramPick | null = null;

  constructor(clusterIdx: number) {
    const cluster = STAR_CLUSTERS[clusterIdx];
    this.rowSlots = buildRowSlots(cluster);

    this.stars   = new StarsRowLayer(this.scene, cluster);
    this.planets = new PlanetsLayer(this.scene, this.rowSlots);
    this.belts   = new BeltsLayer(this.scene, this.rowSlots);
    this.moons   = new MoonsLayer(this.scene, this.rowSlots);
    this.rings   = new RingsLayer(this.scene, this.rowSlots);
  }

  resize(bufferW: number, bufferH: number): void {
    this.bufferW = bufferW;
    this.bufferH = bufferH;
    this.camera.left = 0; this.camera.right = bufferW;
    this.camera.bottom = 0; this.camera.top = bufferH;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private layout(): void {
    // Row layout writes cx/cy into rowSlots; subsequent passes read it.
    this.stars.layout(this.bufferW, this.bufferH);
    layoutRow(this.rowSlots, this.bufferW, this.bufferH);
    // Star positions are finalized — publish them to the body lighting
    // pass. Pulls from stars (post-layout) and pushes to every body
    // material; no per-tick update needed (the diagram is a static
    // screen layout, so lighting only changes on resize). Set before the
    // ring layout below, which reads the lights to resolve each ring's
    // dominant-star shadow direction.
    const lights = this.stars.getLightSources();
    this.planets.setLightSources(lights);
    this.moons.setLightSources(lights);
    this.belts.setLightSources(lights);
    this.rings.setLightSources(lights);
    // PlanetsLayer publishes the center index that moons + rings consume.
    this.planets.layout(this.rowSlots);
    this.belts.layout(this.rowSlots);
    const centers = this.planets.getCenterIndex();
    this.moons.layout(centers);
    this.rings.layout(centers);
  }

  // Hit-test the rendered discs at (x, y) in buffer-pixel coords and
  // return the topmost body — the one the depth test would have left
  // visible at that pixel, so the cursor and the eye always agree.
  //
  // Each row item (planet/belt + its moons/rings) draws in its own z
  // band (rowIdx · Z_STRIDE, see geom/snap.ts:bandZ), so a body in a
  // higher band fully occludes a lower band's whole stack regardless of
  // sublayer. A flat layer-priority walk gets this wrong across bands —
  // e.g. a left planet's front moon would out-rank a right planet's
  // disc even though the disc renders on top. So we collect every hit
  // with the world z it was drawn at and keep the largest z (the
  // depth-test winner). The query order below is the tiebreaker for the
  // equal-z case (one row item's own stack: front moon → front ring →
  // disc → back ring → belt → back moon → star), mirroring the
  // back-to-front render order within a band.
  pickAt(x: number, y: number): DiagramPick | null {
    const centers = this.planets.getCenterIndex();
    const hits: (DiagramHit | null)[] = [
      this.moons.pickFront(x, y),
      this.rings.pickFront(x, y, centers),
      this.planets.pickAt(x, y),
      this.rings.pickBack(x, y, centers),
      this.belts.pickAt(x, y),
      this.moons.pickBack(x, y),
      this.stars.pickAt(x, y),
    ];
    let best: DiagramHit | null = null;
    // Strict `>` keeps the earlier (higher-priority) hit on a z tie.
    for (const hit of hits) {
      if (hit && (best === null || hit.z > best.z)) best = hit;
    }
    return best?.pick ?? null;
  }

  // Stamp the 1-px outline onto the picked disc, clearing the previous
  // one if any. No-op when the pick is unchanged so continuous pointer
  // movement within the same disc doesn't churn the GPU upload.
  setHovered(pick: DiagramPick | null): void {
    if (picksEqual(pick, this.hoveredPick)) return;
    this.writeHover(this.hoveredPick, 0);
    this.writeHover(pick, 1);
    this.hoveredPick = pick;
  }

  // Dispatch to the layer that owns the picked kind. Each layer's
  // setHovered writes its own hover convention (per-vertex aHazeColor.w
  // on planets/moons, per-vertex aHovered on belts, a uHovered uniform
  // on stars/rings). The `satisfies never` default makes a newly-added
  // DiagramPick.kind fail to compile here until it's wired.
  private writeHover(pick: DiagramPick | null, value: 0 | 1): void {
    if (!pick) return;
    switch (pick.kind) {
      case 'star':   this.stars.setHovered(pick, value); return;
      case 'planet': this.planets.setHovered(pick, value); return;
      case 'belt':   this.belts.setHovered(pick, value); return;
      case 'moon':   this.moons.setHovered(pick, value); return;
      case 'ring':   this.rings.setHovered(pick, value); return;
      default:       pick satisfies never;
    }
  }

  dispose(): void {
    this.stars.dispose();
    this.planets.dispose();
    this.belts.dispose();
    this.moons.dispose();
    this.rings.dispose();
  }
}
