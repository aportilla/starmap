// Tabbed popover panel. Title + a tab strip + the active tab's sections.
// Four row kinds:
//
//   toggle:     checkbox glyph + label, click flips a boolean
//   action:     pill-styled button, click fires an event
//   keybinding: read-only key/description pair (no hit zone)
//   radio:      segmented pill chooser; per-pill hover; disabled pills
//               render dimmed and absorb clicks without dispatching
//
// The orchestrator calls setHoveredRow / setHoveredTab / setHoveredRadio on
// pointer-move, and Panel rebuilds (only when the id actually changed).
// Click dispatch is the orchestrator's job — Panel just exposes hit-test
// methods so the orchestrator can route events:
//
//   hitTab     — tab strip (above the body)
//   probeRadio — any radio pill (returns disabled flag so caller can
//                decide between dispatch / cursor swap / absorb)
//   hitRow     — toggle or action row (radios are intentionally excluded;
//                they sit inside row Y bands but only consume sub-rects,
//                so falling through to a row-wide hit would be wrong)
//
// Width is measured across ALL tabs' contents (not just the active one), so
// switching tabs never resizes the panel — width flicker is worse than a
// few wasted px on shorter tabs.
//
// The panel's close-X is NOT owned by Panel — it's a sibling IconButton
// in the orchestrator. Dismissal policy (close to nothing, close to
// previous screen, etc.) is per-dialog, so we don't bake it in.

import { drawPixelText, getFont, measurePixelText } from '../data/pixel-font';
import { BasePanel } from './base-panel';
import {
  paintCheckbox,
  paintPillButton,
  paintSegmentedPill,
  paintSurface,
  PILL_PAD_X,
  PILL_PAD_Y,
} from './painter';
import { colors, fonts, sizes } from './theme';

export interface RadioOption {
  value: string;
  label: string;
  // True when the option exists but can't be selected at the current
  // state (e.g. resolution 'High' on a 1:1 display). Disabled+selected
  // is a valid combination — the saved pref stays highlighted but rendered
  // dim, so the user sees 'this is your pref but it has no effect now'.
  disabled?: boolean;
}

export type PanelRow =
  | { kind: 'toggle'; id: string; label: string; on: boolean }
  | { kind: 'action'; id: string; label: string }
  | { kind: 'keybinding'; key: string; desc: string }
  | { kind: 'radio'; id: string; selected: string; options: RadioOption[] };

export interface PanelSection {
  header?: string;
  rows: PanelRow[];
}

export interface TabSpec {
  id: string;
  label: string;
  sections: PanelSection[];
}

export interface PanelSpec {
  title?: string;
  tabs: TabSpec[];
  activeTabId: string;
}

export interface PanelHit {
  kind: 'toggle' | 'action';
  id: string;
}

// Result of probing a radio pill. `disabled` is surfaced rather than
// filtered so the caller can pick its policy: dispatch only when enabled,
// but absorb the click and report 'opaque' for cursor purposes either way.
export interface RadioProbe {
  rowId: string;
  value: string;
  disabled: boolean;
}

export interface TabHit {
  id: string;
}

interface RowZone {
  id: string;
  kind: 'toggle' | 'action';
  // Y-down coords from the panel's top-left (texture space).
  y: number;
  h: number;
}

interface RadioZone {
  rowId: string;
  value: string;
  // Y-down coords from the panel's top-left (texture space).
  x: number;
  y: number;
  w: number;
  h: number;
  disabled: boolean;
}

interface TabZone {
  id: string;
  // Y-down coords from the panel's top-left (texture space).
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Panel extends BasePanel {
  private spec: PanelSpec = { tabs: [], activeTabId: '' };
  private hoveredRowId: string | null = null;
  private hoveredTabId: string | null = null;

  // Hit zones recorded during the last paintInto() pass. Translated to
  // HUD Y-up at hit-test time using the laid-out panel position.
  private rowZones: RowZone[] = [];
  private radioZones: RadioZone[] = [];
  private tabZones: TabZone[] = [];

  // Hovered radio pill, keyed by `${rowId}:${value}`. Per-pill so multiple
  // radio rows in the same panel highlight independently. Decoupled from
  // hoveredRowId because radios live inside a row-shaped layout but the
  // hover unit is the pill, not the row.
  private hoveredRadioKey: string | null = null;

  // Replace the spec and rebuild. Width/height may change → orchestrator
  // must re-anchor after this call.
  setSpec(spec: PanelSpec): void {
    this.spec = spec;
    this.rebuild();
  }

  // Update the hovered-row id and rebuild (label colors flip). No-op when
  // the id is unchanged so a pointermove storm doesn't trigger a rebuild
  // storm.
  setHoveredRow(id: string | null): void {
    if (this.hoveredRowId === id) return;
    this.hoveredRowId = id;
    this.rebuild();
  }

  // Update the hovered-tab id and rebuild (inactive tab borders swap on
  // hover). Same no-op gating as setHoveredRow.
  setHoveredTab(id: string | null): void {
    if (this.hoveredTabId === id) return;
    this.hoveredTabId = id;
    this.rebuild();
  }

  // Update the hovered radio pill, keyed by `${rowId}:${value}`. Same
  // no-op gating as the other hover setters.
  setHoveredRadio(key: string | null): void {
    if (this.hoveredRadioKey === key) return;
    this.hoveredRadioKey = key;
    this.rebuild();
  }

  // Shared zone hit-test. Zones are recorded in panel-local Y-down texture
  // space; the cursor arrives in HUD Y-up buffer coords. The conversion
  // anchors on panelTop (the panel's top edge in Y-up = v.y + v.h), so a
  // zone's Y-up band is [panelTop - zone.y - zone.h, panelTop - zone.y).
  //
  // checkX controls whether the zone's X sub-rect is range-checked: tab and
  // radio zones carry per-pill x/w and must be checked (so gaps between
  // pills fall through); row zones span the panel width and are X-checked by
  // the caller instead. Returns the first matching zone, or null.
  private hitZone<Z extends { y: number; h: number; x?: number; w?: number }>(
    bufX: number,
    bufY: number,
    zones: readonly Z[],
    checkX: boolean,
  ): Z | null {
    const v = this.visibleBounds;
    const panelTop = v.y + v.h;
    for (const z of zones) {
      if (checkX) {
        const left = v.x + (z.x ?? 0);
        const right = left + (z.w ?? 0);
        if (bufX < left || bufX >= right) continue;
      }
      const topHud = panelTop - z.y;
      const botHud = topHud - z.h;
      if (bufY >= botHud && bufY < topHud) return z;
    }
    return null;
  }

  // Hit-test toggle / action rows in HUD buffer coords. Caller ensures
  // bufY is Y-up; this method converts to panel-local Y-down using the
  // panel's current visible bounds.
  //
  // Radio rows are intentionally NOT covered here — they sit inside row
  // Y bands but only consume sub-rects, and a row-wide hit would absorb
  // clicks in the gaps between pills. Use probeRadio() for radio hits.
  hitRow(bufX: number, bufY: number): PanelHit | null {
    if (!this.visible) return null;
    const v = this.visibleBounds;
    // Rows span the full panel width, so X is checked panel-wide here rather
    // than per-zone (RowZone carries no x/w).
    if (bufX < v.x || bufX >= v.x + v.w) return null;
    const r = this.hitZone(bufX, bufY, this.rowZones, false);
    return r ? { id: r.id, kind: r.kind } : null;
  }

  // Probe the radio pill at this point, including disabled pills. Returns
  // null when the cursor is over a non-pill area (panel padding, row gap,
  // outside the panel). Caller decides what to do with disabled hits:
  // typically absorb (block scene pick) but don't dispatch / cursor-swap.
  probeRadio(bufX: number, bufY: number): RadioProbe | null {
    if (!this.visible) return null;
    const rz = this.hitZone(bufX, bufY, this.radioZones, true);
    return rz ? { rowId: rz.rowId, value: rz.value, disabled: rz.disabled } : null;
  }

  // Tab strip hit-test. Same Y-up → Y-down conversion as hitRow.
  hitTab(bufX: number, bufY: number): TabHit | null {
    if (!this.visible) return null;
    const t = this.hitZone(bufX, bufY, this.tabZones, true);
    return t ? { id: t.id } : null;
  }

  // True if the point lies anywhere inside the panel's visible rect.
  // Used to absorb taps so they don't fall through to whatever's behind.
  hitsBackground(bufX: number, bufY: number): boolean {
    return this.visible && this.visibleBounds.contains(bufX, bufY);
  }

  // -- two-pass paint ---------------------------------------------------

  // Width of one tab pill — uniform across the strip so the three tabs
  // read as a unit. Sized to fit the longest label + standard padding.
  private tabPillWidth(): number {
    let maxLabelW = 0;
    for (const t of this.spec.tabs) {
      const w = measurePixelText(t.label);
      if (w > maxLabelW) maxLabelW = w;
    }
    return maxLabelW + sizes.panelTabPadX * 2;
  }

  // Total width of the tab strip — N pills + (N-1) gaps.
  private tabStripWidth(): number {
    const n = this.spec.tabs.length;
    if (n === 0) return 0;
    return n * this.tabPillWidth() + (n - 1) * sizes.panelTabGap;
  }

  // Total height of one tab pill (font lineHeight + 2*padY). Mirrors the
  // value paintTabButton returns at paint time.
  private tabPillHeight(): number {
    return getFont(fonts.body).lineHeight + sizes.panelTabPadY * 2;
  }

  // Width contributed by one row's content (no panel padding). Used to
  // size the panel wide enough for the widest row across all tabs.
  private rowContentW(r: PanelRow, kbKeyColW: Map<PanelSection, number>, section: PanelSection): number {
    if (r.kind === 'toggle') {
      return sizes.checkbox + sizes.checkboxLabelGap + measurePixelText(r.label);
    }
    if (r.kind === 'action') {
      return measurePixelText(r.label) + PILL_PAD_X * 2;
    }
    if (r.kind === 'keybinding') {
      // key column aligned across the whole section, then gap, then desc
      const keyColW = kbKeyColW.get(section) ?? 0;
      return keyColW + sizes.kbKeyDescGap + measurePixelText(r.desc);
    }
    // radio — N pills of equal width (sized to the longest option label)
    // plus (N-1) gaps. All pills in a row render at the uniform width.
    const pillW = this.radioPillWidth(r.options);
    return r.options.length * pillW + (r.options.length - 1) * sizes.radioPillGap;
  }

  // Width of each pill in a radio row. Sized to the longest label among
  // the row's options + standard padding. Same uniform-width rationale as
  // tab pills — the row reads as a segmented control.
  private radioPillWidth(options: RadioOption[]): number {
    let maxLabelW = 0;
    for (const o of options) {
      const w = measurePixelText(o.label);
      if (w > maxLabelW) maxLabelW = w;
    }
    return maxLabelW + sizes.panelTabPadX * 2;
  }

  // Height of a radio row — same as a tab pill.
  private radioRowHeight(): number {
    return getFont(fonts.body).lineHeight + sizes.panelTabPadY * 2;
  }

  // Vertical space a row occupies, including its pad. measure() sums these
  // to size the panel and paintInto() advances its cursor by the same value,
  // so the two passes can't drift. The action pill's own height
  // (bodyLineH + 2*PILL_PAD_Y) is reproduced from the painter constant rather
  // than read back from paintPillButton's return, so measure() needs no paint.
  private rowHeight(r: PanelRow, bodyLineH: number): number {
    switch (r.kind) {
      case 'toggle':     return bodyLineH + sizes.panelRowPadY * 2;
      case 'action':     return bodyLineH + PILL_PAD_Y * 2 + sizes.panelRowPadY * 2;
      case 'keybinding': return bodyLineH + sizes.kbRowPadY * 2;
      case 'radio':      return this.radioRowHeight() + sizes.panelRowPadY * 2;
    }
  }

  // For each section that contains keybinding rows, compute the max key
  // text width — used both at measure time (to size the panel) and at
  // paint time (to align the desc column across the section).
  private buildKbKeyColumnWidths(): Map<PanelSection, number> {
    const m = new Map<PanelSection, number>();
    for (const tab of this.spec.tabs) {
      for (const section of tab.sections) {
        let maxKey = 0;
        for (const r of section.rows) {
          if (r.kind === 'keybinding') {
            const w = measurePixelText(r.key);
            if (w > maxKey) maxKey = w;
          }
        }
        if (maxKey > 0) m.set(section, maxKey);
      }
    }
    return m;
  }

  protected measure(): { w: number; h: number } {
    const titleLineH = getFont(fonts.panelTitle).lineHeight;
    const bodyLineH  = getFont(fonts.body).lineHeight;
    const titleW = this.spec.title ? measurePixelText(this.spec.title, fonts.panelTitle) : 0;

    const kbKeyColW = this.buildKbKeyColumnWidths();

    // Width is the max of any tab's contents — measured across ALL tabs so
    // switching tabs never resizes the panel.
    let maxRowContentW = 0;
    for (const tab of this.spec.tabs) {
      for (const section of tab.sections) {
        if (section.header) {
          const headerW = measurePixelText(section.header);
          if (headerW > maxRowContentW) maxRowContentW = headerW;
        }
        for (const r of section.rows) {
          const w = this.rowContentW(r, kbKeyColW, section);
          if (w > maxRowContentW) maxRowContentW = w;
        }
      }
    }

    const titleLineMinW = this.spec.title
      ? sizes.padX + titleW + sizes.nameToCloseGap + sizes.closeBox
      : 0;
    const tabStripMinW = this.tabStripWidth() + sizes.padX * 2;
    const W = Math.max(titleLineMinW, tabStripMinW, sizes.padX * 2 + maxRowContentW);

    let H = sizes.padY;
    if (this.spec.title) {
      H += titleLineH + sizes.panelTitleGap + sizes.panelTitleToSection;
    }
    if (this.spec.tabs.length > 0) {
      H += this.tabPillHeight() + sizes.panelTabContentGap;
    }
    // Height is per-active-tab — only the active tab's rows render in the
    // body, and the panel grows/shrinks vertically as tabs switch.
    const activeTab = this.spec.tabs.find(t => t.id === this.spec.activeTabId);
    if (activeTab) {
      for (let si = 0; si < activeTab.sections.length; si++) {
        if (si > 0) H += sizes.panelSectionGapBefore;
        const section = activeTab.sections[si];
        if (section.header) {
          H += bodyLineH + sizes.panelSectionGapAfter;
        }
        for (const r of section.rows) {
          H += this.rowHeight(r, bodyLineH);
        }
      }
    }
    H += sizes.padY;

    return { w: W, h: H };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    paintSurface(g, 0, 0, w, h);

    const titleLineH = getFont(fonts.panelTitle).lineHeight;
    const bodyLineH  = getFont(fonts.body).lineHeight;
    const rowZones: RowZone[] = [];
    const radioZones: RadioZone[] = [];
    const tabZones: TabZone[] = [];
    const kbKeyColW = this.buildKbKeyColumnWidths();

    let cursorY = sizes.padY;
    if (this.spec.title) {
      drawPixelText(g, this.spec.title, sizes.padX, cursorY, colors.starName, fonts.panelTitle);
      cursorY += titleLineH + sizes.panelTitleGap + sizes.panelTitleToSection;
    }

    // Tab strip
    if (this.spec.tabs.length > 0) {
      const pillW = this.tabPillWidth();
      let tabX = sizes.padX;
      for (const tab of this.spec.tabs) {
        const isActive = tab.id === this.spec.activeTabId;
        const isHover  = tab.id === this.hoveredTabId;
        const { h: tabH } = paintSegmentedPill(g, tabX, cursorY, tab.label, {
          selected: isActive,
          hover:    isHover && !isActive,  // hover swap is for inactive tabs only
          width:    pillW,
        });
        tabZones.push({ id: tab.id, x: tabX, y: cursorY, w: pillW, h: tabH });
        tabX += pillW + sizes.panelTabGap;
      }
      cursorY += this.tabPillHeight() + sizes.panelTabContentGap;
    }

    const activeTab = this.spec.tabs.find(t => t.id === this.spec.activeTabId);
    if (activeTab) {
      for (let si = 0; si < activeTab.sections.length; si++) {
        if (si > 0) cursorY += sizes.panelSectionGapBefore;
        const section = activeTab.sections[si];
        if (section.header) {
          drawPixelText(g, section.header, sizes.padX, cursorY, colors.textKey);
          cursorY += bodyLineH + sizes.panelSectionGapAfter;
        }

        for (const r of section.rows) {
          const isHover = r.kind !== 'keybinding' && r.id === this.hoveredRowId;
          const rowH = this.rowHeight(r, bodyLineH);
          if (r.kind === 'toggle') {
            const rowTop = cursorY;
            const labelY = rowTop + sizes.panelRowPadY;
            const checkboxX = sizes.padX;
            const checkboxY = labelY + Math.floor((bodyLineH - sizes.checkbox) / 2);

            paintCheckbox(g, checkboxX, checkboxY, { on: r.on });

            const labelX = checkboxX + sizes.checkbox + sizes.checkboxLabelGap;
            drawPixelText(
              g, r.label, labelX, labelY,
              isHover ? colors.textBodyHover : colors.textBody,
            );

            rowZones.push({ id: r.id, kind: 'toggle', y: rowTop, h: rowH });
            cursorY += rowH;
          } else if (r.kind === 'action') {
            const rowTop = cursorY;
            paintPillButton(
              g, sizes.padX, rowTop + sizes.panelRowPadY, r.label,
              { hover: isHover },
            );
            rowZones.push({ id: r.id, kind: 'action', y: rowTop, h: rowH });
            cursorY += rowH;
          } else if (r.kind === 'keybinding') {
            // keybinding — read-only, no zone, no hover. Key in starName
            // (yellow), desc in textBody. Desc column aligns across the
            // whole section so multiple keybinding rows form a clean grid.
            const rowTop = cursorY;
            const labelY = rowTop + sizes.kbRowPadY;
            const keyX = sizes.padX;
            const keyColW = kbKeyColW.get(section) ?? 0;
            const descX = keyX + keyColW + sizes.kbKeyDescGap;
            drawPixelText(g, r.key, keyX, labelY, colors.starName);
            drawPixelText(g, r.desc, descX, labelY, colors.textBody);
            cursorY += rowH;
          } else {
            // radio — N pills laid out left-to-right at uniform width.
            // Disabled+selected stays highlighted (pref preserved) but
            // rendered with disabled coloring; the row's hit-test path
            // skips disabled pills via the RadioZone.disabled flag.
            const rowTop = cursorY;
            const pillTop = rowTop + sizes.panelRowPadY;
            const pillW = this.radioPillWidth(r.options);
            const pillH = this.radioRowHeight();
            let pillX = sizes.padX;
            for (const opt of r.options) {
              const isSelected = opt.value === r.selected;
              const isDisabled = !!opt.disabled;
              const hoverKey = `${r.id}:${opt.value}`;
              const isHoverPill = hoverKey === this.hoveredRadioKey && !isDisabled;
              paintSegmentedPill(g, pillX, pillTop, opt.label, {
                selected: isSelected,
                hover: isHoverPill,
                disabled: isDisabled,
                width: pillW,
              });
              radioZones.push({
                rowId: r.id, value: opt.value,
                x: pillX, y: pillTop, w: pillW, h: pillH,
                disabled: isDisabled,
              });
              pillX += pillW + sizes.radioPillGap;
            }
            cursorY += rowH;
          }
        }
      }
    }

    this.rowZones = rowZones;
    this.radioZones = radioZones;
    this.tabZones = tabZones;
  }
}
