// Labeled action button — pill border + centered text, two pre-built
// textures (off / hover). Uses paintPillButton for the visual so it stays
// in lockstep with the panel-row "Reset view" button styling.
//
// Owns its own textures (one (off, hover) pair per label string) and
// disposes them in dispose(). Differs from IconButton, which borrows from
// a shared texture pool — the orchestrator pattern only pays off when
// multiple instances share the same icon, and labeled buttons are unique
// per label.

import { CanvasTexture } from 'three';
import { getFont, measurePixelText } from '../data/pixel-font';
import { PILL_PAD_X, PILL_PAD_Y, paintPillButton } from './painter';
import { Widget, paintToTexture } from './widget';

export interface ActionButtonOpts {
  renderOrder?: number;
  hitPad?: number;
}

export class ActionButton extends Widget {
  private hover = false;
  private disabled = false;
  private readonly offTex: CanvasTexture;
  private readonly hoverTex: CanvasTexture;
  private readonly disabledTex: CanvasTexture;

  constructor(label: string, opts: ActionButtonOpts = {}) {
    super(opts.renderOrder ?? 100);
    if (opts.hitPad !== undefined) this.setHitPad(opts.hitPad);

    const w = measurePixelText(label) + PILL_PAD_X * 2;
    const h = getFont().lineHeight + PILL_PAD_Y * 2;

    this.offTex      = buildTexture(label, { hover: false }, w, h);
    this.hoverTex    = buildTexture(label, { hover: true  }, w, h);
    this.disabledTex = buildTexture(label, { hover: false, disabled: true }, w, h);

    this.setSize(w, h);
    this.material.map = this.offTex;
    this.material.needsUpdate = true;
    this.mesh.visible = true;
  }

  setHover(h: boolean): void {
    if (this.hover === h) return;
    this.hover = h;
    this.applyTexture();
  }

  // Disabled overrides hover: the texture is locked to disabledTex and
  // the host widget should also skip hit-testing for this button.
  setDisabled(d: boolean): void {
    if (this.disabled === d) return;
    this.disabled = d;
    this.applyTexture();
  }

  get isDisabled(): boolean { return this.disabled; }

  resetHover(): void { this.setHover(false); }

  private applyTexture(): void {
    const tex = this.disabled
      ? this.disabledTex
      : (this.hover ? this.hoverTex : this.offTex);
    this.material.map = tex;
    this.material.needsUpdate = true;
  }

  override dispose(): void {
    this.offTex.dispose();
    this.hoverTex.dispose();
    this.disabledTex.dispose();
    super.dispose();
  }
}

function buildTexture(
  label: string,
  opts: { hover: boolean; disabled?: boolean },
  w: number,
  h: number,
): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paintPillButton(c.getContext('2d')!, 0, 0, label, opts);
  return paintToTexture(c);
}
