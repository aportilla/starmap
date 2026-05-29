// SystemScene — flat 2D diagram of one star cluster. Peer of StarmapScene;
// AppController swaps which one's tick() loop is driving the shared canvas.
//
// The whole scene is rendered through SystemDiagram (its own ortho scene at
// 1 unit = 1 buffer pixel). No 3D camera, no orbit, no zoom — this view is
// a static screen diagram, not a navigable space. SystemHud sits on top.

import { type WebGLRenderer } from 'three';
import { SystemHud } from '../ui/system-hud';
import { SystemDiagram } from './system-diagram';
import { ViewportSizer } from './viewport-sizer';

export class SystemScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;

  private readonly diagram: SystemDiagram;
  private readonly hud: SystemHud;
  private readonly viewport = new ViewportSizer();

  private rafId = 0;
  private running = false;

  private readonly _onPointerDown  = (e: PointerEvent) => this.onPointerDown(e);
  private readonly _onPointerMove  = (e: PointerEvent) => this.onPointerMove(e);
  private readonly _onPointerLeave = ()                => this.onPointerLeave();
  private readonly _onKeyDown      = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly _onResize       = () => this.resize();

  private readonly _hudPt = { x: 0, y: 0 };

  // Fired when the user requests to exit the system view (ESC or back
  // button click).
  onExit: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, renderer: WebGLRenderer, clusterIdx: number) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.diagram = new SystemDiagram(clusterIdx);
    this.hud = new SystemHud(clusterIdx);
    this.hud.onBack = () => this.onExit();

    // DPR boundary crossings (zoom, monitor swap) re-trigger resize so the
    // pixel-ratio + buffer dims pick up the new integer N.
    this.viewport.subscribe(() => {
      if (this.running) this.resize();
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachListeners();
    this.resize();
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.detachListeners();
  }

  // Idempotent — safe to call after stop().
  dispose(): void {
    this.stop();
    this.diagram.dispose();
    this.hud.dispose();
    this.viewport.dispose();
  }

  // -- listeners --------------------------------------------------------

  private attachListeners(): void {
    this.canvas.addEventListener('pointerdown',  this._onPointerDown);
    this.canvas.addEventListener('pointermove',  this._onPointerMove);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize',  this._onResize);
  }

  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown',  this._onPointerDown);
    this.canvas.removeEventListener('pointermove',  this._onPointerMove);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize',  this._onResize);
  }

  private onPointerDown(e: PointerEvent): void {
    // Only role of pointer-down here is routing clicks to the HUD (the
    // back button). The diagram is static — no drag/orbit fallback.
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    this.hud.handleClick(this._hudPt.x, this._hudPt.y);
  }

  private onPointerMove(e: PointerEvent): void {
    this.viewport.clientToHud(e.clientX, e.clientY, this._hudPt);
    const onButton = this.hud.handlePointerMove(this._hudPt.x, this._hudPt.y);
    this.canvas.style.cursor = onButton ? 'pointer' : '';
    // Body hover info card — skip the picker when the cursor is over
    // any interactive HUD chrome (back button) so a tooltip can't
    // appear under the chrome the user is aiming at.
    const overChrome = this.hud.hitTest(this._hudPt.x, this._hudPt.y) !== 'transparent';
    const pick = overChrome ? null : this.diagram.pickAt(this._hudPt.x, this._hudPt.y);
    this.diagram.setHovered(pick);
    this.hud.setHoveredBody(pick, this._hudPt.x, this._hudPt.y);
  }

  private onPointerLeave(): void {
    // Cursor left the canvas — clear the outline and hide the tooltip
    // so they don't linger on stale state when the cursor comes back.
    this.diagram.setHovered(null);
    this.hud.setHoveredBody(null, 0, 0);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.onExit();
  }

  // -- resize / render --------------------------------------------------

  private resize(): void {
    // ViewportSizer.apply does the load-bearing integer-multiple-of-N snap +
    // pushes the new dims into every pixel-snapped material's uViewport —
    // including the diagram's planet/moon material via makePlanetMaterial.
    this.viewport.apply(this.renderer);
    this.diagram.resize(this.viewport.bufferW, this.viewport.bufferH);
    this.hud.resize(this.viewport.bufferW, this.viewport.bufferH);
  }

  private tick = (): void => {
    if (!this.running) return;
    this.renderer.render(this.diagram.scene, this.diagram.camera);
    this.renderer.autoClear = false;
    this.renderer.render(this.hud.scene, this.hud.camera);
    this.renderer.autoClear = true;
    this.rafId = requestAnimationFrame(this.tick);
  };
}
