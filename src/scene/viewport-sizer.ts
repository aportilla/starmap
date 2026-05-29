import { Vector2, type WebGLRenderer } from 'three';

import { getSettings } from '../settings';
import { setSnappedLineViewport } from './materials';
import { RenderScaleObserver, effectiveScale, type RenderScale } from './render-scale';

// Owns the load-bearing pixel-snap math every scene's resize() needs: sizing
// the render buffer to an integer multiple of N so the browser's
// `image-rendering: pixelated` nearest-neighbor upscale divides cleanly.
//
// The browser's pixelated upscale is only exactly N:1 when (CSS_px × DPR) is
// divisible by N — i.e. the target physical-pixel dimension is a multiple of
// N. If it isn't, the browser distributes the remainder by making one
// buffer-pixel-wide column every (~CSS_px) actual columns span (N-1) physical
// pixels instead of N. Labels rendered on top of those compressed columns get
// visibly mangled (one bitmap column squashed into 2 physical px instead of
// 3). The artifact appears to "follow" labels as the camera rotates because
// the labels move across the buffer and cross those fixed compressed columns
// at different points within the bitmap.
//
// Fix: round target physical pixels DOWN to a multiple of N, then derive CSS
// and buffer from that. Up to (N-1) physical pixels of black bezel can show on
// the right/bottom — invisible against the dark scene.
//
// Each scene composes one of these, calls apply() at the top of its resize(),
// then runs its own subsystem resizes off the updated bufferW/bufferH.
export class ViewportSizer {
  cssW = 0;
  cssH = 0;
  bufferW = 0;
  bufferH = 0;

  private readonly observer = new RenderScaleObserver();
  private readonly _buf = new Vector2();

  // Auto integer N from the observer (before the per-resize preference bias).
  get scale(): RenderScale {
    return this.observer.scale;
  }

  // DPR boundary crossings (browser zoom, monitor swap, OS scale change). The
  // callback fires only when N actually crosses a boundary.
  subscribe(cb: (scale: RenderScale) => void): () => void {
    return this.observer.subscribe(cb);
  }

  dispose(): void {
    this.observer.dispose();
  }

  // Resize the renderer to the snapped buffer and refresh the cached css/buffer
  // dims + the snapped-material viewport. N is the auto value biased by the
  // user's resolution preference (low=+1 chunkier, high=-1 sharper, medium=auto),
  // pulled fresh here so flipping the radio re-applies on the next resize without
  // extra plumbing.
  apply(renderer: WebGLRenderer): void {
    const dpr = window.devicePixelRatio;
    const N = effectiveScale(this.observer.scale, getSettings().resolutionPreference);
    const physW = Math.floor(window.innerWidth  * dpr / N) * N;
    const physH = Math.floor(window.innerHeight * dpr / N) * N;
    const cssW = physW / dpr;
    const cssH = physH / dpr;
    renderer.setPixelRatio(dpr / N);
    renderer.setSize(cssW, cssH);
    this.cssW = cssW;
    this.cssH = cssH;
    renderer.getDrawingBufferSize(this._buf);
    this.bufferW = this._buf.x;
    this.bufferH = this._buf.y;
    setSnappedLineViewport(this.bufferW, this.bufferH);
  }

  // Map a CSS-pixel client coord into HUD buffer coords (Y-up, origin at
  // bottom-left). Uses cached cssW/cssH (the actual canvas size after the
  // multiple-of-N rounding), not window.innerWidth/Height.
  clientToHud(clientX: number, clientY: number, out: { x: number; y: number }): void {
    out.x = clientX * (this.bufferW / this.cssW);
    out.y = (this.cssH - clientY) * (this.bufferH / this.cssH);
  }
}
