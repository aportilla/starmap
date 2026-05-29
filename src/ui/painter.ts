// Stateless pixel-art draw primitives. Each fn takes a 2D context plus
// integer (x, y) plus options, paints into the context, and (where useful)
// returns the rendered dimensions so callers can lay out subsequent rows.
//
// No Three.js imports — these are pure Canvas2D paint helpers. Texture
// upload happens in the Widget layer.
//
// All callers pass *integer* top-left coords. The painter never adjusts
// for sub-pixel alignment; misaligned input → misaligned output.

import { drawPixelText, measurePixelText, getFont, type FontSpec } from '../data/pixel-font';
import { colors, fonts, sizes } from './theme';

// Interior padding of a paintPillButton action pill (text-to-border). The
// single source for this value — panel.ts reads these to size action rows
// without re-measuring the painted pill.
export const PILL_PAD_X = 6;
export const PILL_PAD_Y = 3;

// 4-strip 1-px border. No fill. Use paintSurface() if you also want a bg.
export function paintBorder(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string = colors.borderAccent,
): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y + h - 1, w, 1);
  g.fillRect(x, y, 1, h);
  g.fillRect(x + w - 1, y, 1, h);
}

export interface SurfaceOpts {
  bg?: string;
  // Pass `null` to skip the border (e.g. title block, which draws its
  // own accent strip rather than a full border).
  border?: string | null;
}

// Background fill + optional 1-px border. Defaults: panel/card surface.
export function paintSurface(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  opts?: SurfaceOpts,
): void {
  const bg = opts?.bg ?? colors.surface;
  const border = opts?.border === undefined ? colors.borderAccent : opts.border;
  g.fillStyle = bg;
  g.fillRect(x, y, w, h);
  if (border !== null) paintBorder(g, x, y, w, h, border);
}

// Close-X — a sizes.closeBox×closeBox square sitting flush in a panel's
// top-right corner. Paints an L-shaped border (left + bottom strokes only)
// so the corner reads as a clean continuation of the host panel's top +
// right border. The X glyph is centered with sizes.closeGlyph dimensions.
//
// Glyph color is parameterized for hover swap; the L-strut is structural,
// always border-accent (or the caller-supplied borderColor).
export function paintCloseX(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  glyphColor: string,
  borderColor: string = colors.borderAccent,
): void {
  const SIZE = sizes.closeBox;
  const GLYPH = sizes.closeGlyph;

  g.fillStyle = borderColor;
  g.fillRect(x,         y,             1, SIZE);     // left
  g.fillRect(x,         y + SIZE - 1,  SIZE, 1);     // bottom

  // X glyph centered. (SIZE - GLYPH) / 2 = 4 with current values.
  const off = (SIZE - GLYPH) / 2;
  g.fillStyle = glyphColor;
  for (let i = 0; i < GLYPH; i++) {
    g.fillRect(x + off + i, y + off + i,             1, 1);
    g.fillRect(x + off + i, y + off + (GLYPH - 1 - i), 1, 1);
  }
}

export interface CheckboxOpts {
  on: boolean;
  borderColor?: string;
}

// 9×9 checkbox with 1-px border; if `on`, stamps a 3×3 fill in the center.
// Centering math: (9 - 3) / 2 = 3, exact pixel boundary.
export function paintCheckbox(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  opts: CheckboxOpts,
): void {
  const SIZE = sizes.checkbox;
  const FILL = sizes.checkboxFill;
  const border = opts.borderColor ?? colors.borderAccent;

  g.fillStyle = border;
  g.fillRect(x,            y,            SIZE, 1);
  g.fillRect(x,            y + SIZE - 1, SIZE, 1);
  g.fillRect(x,            y,            1, SIZE);
  g.fillRect(x + SIZE - 1, y,            1, SIZE);

  if (opts.on) {
    const off = (SIZE - FILL) / 2;
    g.fillRect(x + off, y + off, FILL, FILL);
  }
}

// Centered left-pointing triangle. Apex at column 0 of the middle row;
// base on the right. With TRIANGLE_W=4 and TRIANGLE_H=7 the triangle fits
// inside the standard sizes.iconBox (17×17) with comfortable padding.
export function paintLeftArrow(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const TRIANGLE_W = 4;
  const TRIANGLE_H = 7;
  const offX = x + Math.floor((size - TRIANGLE_W) / 2);
  const offY = y + Math.floor((size - TRIANGLE_H) / 2);
  g.fillStyle = color;
  // Each row has length (W - dist) and starts at column dist, where dist
  // is the row's distance from the vertical center. Center row spans the
  // full width 0..W-1; outer rows narrow toward the right edge.
  const center = (TRIANGLE_H - 1) / 2;
  for (let r = 0; r < TRIANGLE_H; r++) {
    const dist = Math.abs(r - center);
    g.fillRect(offX + dist, offY + r, TRIANGLE_W - dist, 1);
  }
}

// Three horizontal lines centered in a `size`×`size` square — the
// hamburger "menu" glyph for the settings trigger. With size=17 the lines
// sit at rows 5, 8, 11 (5 px above the top line, 5 below the bottom, 2 px
// gaps between).
export function paintHamburger(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const lineW = 9;
  const lineX = x + (size - lineW) / 2;  // 4 when size=17
  g.fillStyle = color;
  g.fillRect(lineX, y + 5,  lineW, 1);
  g.fillRect(lineX, y + 8,  lineW, 1);
  g.fillRect(lineX, y + 11, lineW, 1);
}

export interface SegmentedPillOpts {
  selected: boolean;
  hover: boolean;
  // Optional: when true, dim border + dim text, no hover swap, no
  // visible selected-state lift. The host widget is responsible for
  // ignoring hover/click hits while in this state. A disabled pill
  // that's also `selected` keeps the surfaceOn fill so the user sees
  // their pref is intact even when it's a no-op at the current display.
  // Tabs always pass false (or omit); radios pass it conditionally.
  disabled?: boolean;
  // Caller-supplied target width — all pills in a strip render at the
  // same width so the row reads as a unit even when labels differ.
  width: number;
  font?: FontSpec;
}

// Pill for a segmented control: tab strips and radio rows both use this.
// Distinct from paintPillButton because the selected state is durable
// (not transient hover) and uses surfaceOn fill — the same selected-fill
// the burger icon adopts when its panel is open, so the "this is the
// chosen one" reading is consistent across HUD chrome. Width is
// caller-supplied (not measured from text) so a strip of three pills
// renders at uniform width. Returns rendered height for layout cursor
// advance.
export function paintSegmentedPill(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  opts: SegmentedPillOpts,
): { h: number } {
  const padY = sizes.panelTabPadY;
  const lineH = getFont(opts.font ?? fonts.body).lineHeight;
  const W = opts.width;
  const H = lineH + padY * 2;
  const disabled = opts.disabled === true;

  // Border: dim when disabled (overrides selected/hover); accent for
  // selected/hover; dim otherwise.
  const borderColor = disabled
    ? colors.borderDim
    : (opts.selected || opts.hover ? colors.borderAccent : colors.borderDim);
  // Fill: selected → surfaceOn, otherwise plain surface. Disabled+selected
  // still gets the fill so the user can see their pref is intact.
  const bg = opts.selected ? colors.surfaceOn : colors.surface;
  // Text: dim when disabled (overrides selected); bright on selected
  // surfaceOn fill; hover-bright for non-selected hover; body otherwise.
  const textColor = disabled
    ? colors.titleDim
    : (opts.selected
      ? colors.glyphOnState
      : (opts.hover ? colors.textBodyHover : colors.textBody));

  paintSurface(g, x, y, W, H, { bg, border: borderColor });

  const textW = measurePixelText(text, opts.font);
  const textX = x + Math.round((W - textW) / 2);
  drawPixelText(g, text, textX, y + padY, textColor, opts.font);

  return { h: H };
}

export interface PillButtonOpts {
  hover: boolean;
  // Disabled overrides hover: dim border + dim text, no hover swap. The
  // host widget is responsible for ignoring hover/click hits while in
  // this state — paint just renders the visual.
  disabled?: boolean;
  font?: FontSpec;
}

// Pill-bordered action button with centered text. Returns rendered size
// so callers can advance their layout cursor.
export function paintPillButton(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  opts: PillButtonOpts,
): { w: number; h: number } {
  const padX = PILL_PAD_X;
  const padY = PILL_PAD_Y;
  const textW = measurePixelText(text, opts.font);
  const W = textW + padX * 2;
  const H = getFont(opts.font).lineHeight + padY * 2;

  const borderColor = opts.disabled
    ? colors.borderDim
    : (opts.hover ? colors.borderAccent : colors.borderDim);
  const textColor = opts.disabled
    ? colors.titleDim
    : (opts.hover ? colors.glyphOnHover : colors.titleBright);

  // Solid bg fill — buttons read as opaque against the scene so stars
  // behind them don't show through, matching the panel/card surface
  // family. Without this fill, the pointer-blocking added at the HUD
  // layer would be invisible: the user would see a star under the
  // button and expect hover/click to reach it.
  paintSurface(g, x, y, W, H, { bg: colors.surface, border: borderColor });

  const textX = x + Math.round((W - textW) / 2);
  drawPixelText(g, text, textX, y + padY, textColor, opts.font);

  return { w: W, h: H };
}
