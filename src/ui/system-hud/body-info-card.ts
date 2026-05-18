// BodyInfoCard — transient on-hover tooltip for the system view. One
// instance lives on SystemHud; SystemScene calls setTarget() each
// pointer move with the picker's result (star, planet, moon, or null).
//
// Visually mirrors the galaxy-view InfoCard family — paintSurface bg,
// yellow title in EspySans 15, Monaco 11 key/value body rows — but
// drops the multi-member nesting and the close-X. Tooltips are
// ephemeral; dismissal is the cursor leaving the disc.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BODIES, STARS, type BiosphereArchetype, type BiosphereTier, type Body, type ResourceKey, type WorldClass } from '../../data/stars';
import type { DiagramPick } from '../../scene/system-diagram';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

// Pretty labels for enum-valued fields. Defined here (rather than on the
// data layer) because they're a presentation concern; if the catalog ever
// adds a new world-class, TS will flag the missing entry here.
const WORLD_CLASS_LABEL: Record<WorldClass, string> = {
  rocky:     'Rocky',
  ocean:     'Ocean',
  ice:       'Ice',
  desert:    'Desert',
  lava:      'Lava',
  gas_dwarf: 'Gas Dwarf',
  gas_giant: 'Gas Giant',
  ice_giant: 'Ice Giant',
};

const BIOSPHERE_ARCHETYPE_LABEL: Record<BiosphereArchetype, string> = {
  carbon_aqueous:     'Aqueous',
  subsurface_aqueous: 'Subsurface',
  aerial:             'Aerial',
  cryogenic:          'Cryogenic',
  silicate:           'Silicate',
  sulfur:             'Sulfur',
};
const BIOSPHERE_TIER_LABEL: Record<Exclude<BiosphereTier, 'none'>, string> = {
  prebiotic: 'Prebiotic',
  microbial: 'Microbial',
  complex:   'Complex',
  gaian:     'Gaian',
};

// Display label per resource. Used by dominantResourceLabels to render
// the body's top-N resources as a single comma-separated value, so the
// info card reads as "what's mineable here" instead of a flat six-row
// numeric grid.
const RESOURCE_LABEL: Record<ResourceKey, string> = {
  resMetals:       'metals',
  resSilicates:    'silicates',
  resVolatiles:    'volatiles',
  resRareEarths:   'rare earths',
  resRadioactives: 'radio',
  resExotics:      'exotics',
};
const RESOURCE_FIELDS: readonly ResourceKey[] = [
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
];

// Top `count` resource labels by raw value, descending. Empty array when
// the body carries no resource signal at all. Mirrors the ordering used
// by dominantResources() in data/stars.ts but skips the color step —
// the panel only needs names.
function dominantResourceLabels(b: Body, count = 3): string[] {
  return RESOURCE_FIELDS
    .map(f => ({ label: RESOURCE_LABEL[f], value: b[f] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, c) => c.value - a.value)
    .slice(0, count)
    .map(e => e.label);
}

// Round fraction (0..1) to a percent string at a precision that keeps
// trace-level differences readable. ≥10% → integer (98%), 0.1–10% →
// one decimal (3.3%, 0.5%), <0.1% → two decimals (0.03%) — so a
// Jupiter NH3 chromophore at 0.026% renders distinctly from Saturn's
// 0.01% rather than both collapsing to "0%".
function formatGasFrac(frac: number): string {
  const pct = frac * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

// Top `count` atmospheric gases by molar fraction, formatted as
// "name pct" so a player extractor can compare bulk reservoirs across
// worlds — Uranus's 2.3% CH4 vs Jupiter's 0.3% CH4 reads at a glance.
// Reads atm1/atm2/atm3 directly (CSV-authored, already ordered by
// fraction descending). Empty when the body has no atmosphere data.
function dominantGasLabels(b: Body, count = 3): string[] {
  const pairs: Array<[string, number | null]> = [
    [b.atm1 ?? '', b.atm1Frac],
    [b.atm2 ?? '', b.atm2Frac],
    [b.atm3 ?? '', b.atm3Frac],
  ];
  return pairs
    .filter(([name]) => name !== '')
    .slice(0, count)
    .map(([name, frac]) => frac !== null ? `${name} ${formatGasFrac(frac)}` : name);
}

// Chromophore (condensed-phase aerosol / cloud-deck species) as a
// "name pct" string, or null when the body has no chromophore. Kept
// distinct from the gas row because the chromophore drives the visible
// cloud/haze chemistry — Jupiter's brown NH3 belts, Titan's tholin
// haze — independent of bulk-gas mining yields.
function chromophoreLabel(b: Body): string | null {
  if (b.chromophoreGas === null) return null;
  if (b.chromophoreFrac === null) return b.chromophoreGas;
  return `${b.chromophoreGas} ${formatGasFrac(b.chromophoreFrac)}`;
}

interface BodyRow { key: string; val: string }

// Trailing-space padding pads short keys to align the value column.
// Monaco 11 is monospace so character count == column count. Width is
// the longest key in any kind's row set; over-padding short keys is
// cheaper than measuring + per-row indent math.
const KEY_PAD = 10;
function k(label: string): string {
  return label.length >= KEY_PAD ? label : label + ' '.repeat(KEY_PAD - label.length);
}

function rowsForStar(starIdx: number): BodyRow[] {
  const s = STARS[starIdx];
  const rows: BodyRow[] = [
    { key: k('class'),  val: s.rawClass },
    { key: k('mass'),   val: `${s.mass.toFixed(2)} Msun` },
    { key: k('radius'), val: `${s.radiusSolar.toFixed(2)} Rsun` },
  ];
  // Sol's distance is 0 ly by definition; skip the row rather than show
  // "0.00 ly" which reads as a placeholder.
  if (s.distLy > 0) rows.push({ key: k('distance'), val: `${s.distLy.toFixed(2)} ly` });
  return rows;
}

function rowsForBody(bodyIdx: number): BodyRow[] {
  const b = BODIES[bodyIdx];
  if (b.kind === 'belt') return rowsForBelt(b);
  if (b.kind === 'ring') return rowsForRing(b);
  const rows: BodyRow[] = [];
  if (b.worldClass !== null) rows.push({ key: k('class'),    val: WORLD_CLASS_LABEL[b.worldClass] });
  if (b.avgSurfaceTempK !== null) rows.push({ key: k('temp'), val: `${Math.round(b.avgSurfaceTempK)} K` });
  if (b.surfacePressureBar !== null) rows.push({ key: k('pressure'), val: `${b.surfacePressureBar.toFixed(2)} bar` });
  // Biosphere 'none' is the null-equivalent — skip; a planet with bacteria
  // is what we want to surface, not a barren rock. When life exists, show
  // both axes so the player sees what kind ("Aerial Microbial", etc.).
  if (b.biosphereTier !== null && b.biosphereTier !== 'none' && b.biosphereArchetype !== null) {
    const archLabel = BIOSPHERE_ARCHETYPE_LABEL[b.biosphereArchetype];
    const tierLabel = BIOSPHERE_TIER_LABEL[b.biosphereTier];
    rows.push({ key: k('life'), val: `${archLabel} ${tierLabel}` });
  }
  const gases = dominantGasLabels(b);
  if (gases.length > 0) rows.push({ key: k('gas'), val: gases.join(', ') });
  const chromo = chromophoreLabel(b);
  if (chromo !== null) rows.push({ key: k('clouds'), val: chromo });
  // Gas/ice giants have no accessible surface — the procgen resource
  // grid still carries numbers (atmospheric trace species etc.) but
  // nothing's mineable in a "land a rig" sense, so suppress the row to
  // keep player-relevant data forward. Moons of giants stay solid and
  // still surface their resources.
  if (!hasInaccessibleSurface(b)) {
    const resources = dominantResourceLabels(b);
    if (resources.length > 0) rows.push({ key: k('resources'), val: resources.join(', ') });
  }
  return rows;
}

function hasInaccessibleSurface(b: Body): boolean {
  return b.worldClass === 'gas_giant'
      || b.worldClass === 'ice_giant'
      || b.worldClass === 'gas_dwarf';
}

// Belt rows surface the band's extent, anchoring metadata, and the top
// few mineable resources — collapsed from the full six-grid to the 2-3
// dominant species so the panel reads as "what's worth scooping here"
// rather than a numeric profile.
function rowsForBelt(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.innerAu !== null && b.outerAu !== null) {
    rows.push({ key: k('extent'), val: `${b.innerAu.toFixed(2)}–${b.outerAu.toFixed(2)} AU` });
  }
  // Largest body in km — surfaces the parent-body anchor that gives
  // 'discrete' populations their gameplay handle (sortie to Ceres-class
  // rather than sweep-harvest).
  if (b.largestBodyKm !== null) rows.push({ key: k('largest'), val: `${b.largestBodyKm.toFixed(0)} km` });
  // Dynamical shepherd: the gas/ice giant whose resonances stabilize
  // this belt. Only set on asteroid + ice belts in giant-bearing
  // systems; debris fields and giantless belts have no shepherd.
  if (b.shepherdBodyIdx !== null) {
    rows.push({ key: k('shepherd'), val: BODIES[b.shepherdBodyIdx].name });
  }
  const resources = dominantResourceLabels(b);
  if (resources.length > 0) rows.push({ key: k('resources'), val: resources.join(', ') });
  return rows;
}

// Ring rows: extent in planetary radii (so "1.1–2.3 R_p" reads against
// the host planet's size) plus the top few dominant resources. The
// underlying six-resource grid still drives the renderer's icy/dusty
// lerp — the panel just doesn't surface the long form.
function rowsForRing(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.innerPlanetRadii !== null && b.outerPlanetRadii !== null) {
    rows.push({ key: k('extent'), val: `${b.innerPlanetRadii.toFixed(2)}–${b.outerPlanetRadii.toFixed(2)} R_p` });
  }
  const resources = dominantResourceLabels(b);
  if (resources.length > 0) rows.push({ key: k('resources'), val: resources.join(', ') });
  return rows;
}

// Parent line for moons and rings: "Moon of <p>" or "Ring of <p>".
// Skipped for planets and belts (whose host is the system's star,
// already named in the HUD title across the top of the screen).
function parentLineFor(bodyIdx: number): string | null {
  const b = BODIES[bodyIdx];
  if (b.hostBodyIdx === null) return null;
  if (b.kind === 'moon') return `Moon of ${BODIES[b.hostBodyIdx].name}`;
  if (b.kind === 'ring') return `Ring of ${BODIES[b.hostBodyIdx].name}`;
  return null;
}

function titleFor(pick: DiagramPick): string {
  if (pick.kind === 'star') return STARS[pick.starIdx].name;
  return BODIES[pick.bodyIdx].name;
}

export class BodyInfoCard extends BasePanel {
  // Track current target so successive setTarget() calls with the same
  // pick are a no-op — the cursor moves continuously within a disc, but
  // we only need to rebuild the canvas when the picked body changes.
  private current: DiagramPick | null = null;

  setTarget(pick: DiagramPick): void {
    if (picksMatch(pick, this.current)) return;
    this.current = pick;
    this.rebuild();
  }

  // Reset without hiding the mesh — caller toggles visibility. After a
  // clear, the next setTarget always triggers a rebuild.
  clearTarget(): void {
    this.current = null;
  }

  protected measure(): { w: number; h: number } {
    if (!this.current) return { w: 0, h: 0 };
    const title = titleFor(this.current);
    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;
    const titleW = measurePixelText(title, fonts.cardName);

    let maxBodyW = 0;
    let bodyLines = 0;

    const parentLine = this.current.kind !== 'star' ? parentLineFor(this.current.bodyIdx) : null;
    if (parentLine) {
      const w = measurePixelText(parentLine);
      if (w > maxBodyW) maxBodyW = w;
      bodyLines++;
    }

    const rows = this.current.kind === 'star'
      ? rowsForStar(this.current.starIdx)
      : rowsForBody(this.current.bodyIdx);
    for (const r of rows) {
      const w = measurePixelText(r.key) + measurePixelText(r.val);
      if (w > maxBodyW) maxBodyW = w;
    }
    bodyLines += rows.length;

    const w = Math.max(
      sizes.padX * 2 + titleW,
      sizes.padX * 2 + maxBodyW,
    );
    const h = sizes.padY * 2 + titleLineH + sizes.cardNameGap + bodyLineH * bodyLines;
    return { w, h };
  }

  protected paintInto(g: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.current) return;
    paintSurface(g, 0, 0, w, h);

    const titleLineH = getFont(fonts.cardName).lineHeight;
    const bodyLineH = getFont(fonts.body).lineHeight;

    drawPixelText(g, titleFor(this.current), sizes.padX, sizes.padY, colors.starName, fonts.cardName);

    let cursorY = sizes.padY + titleLineH + sizes.cardNameGap;

    const parentLine = this.current.kind !== 'star' ? parentLineFor(this.current.bodyIdx) : null;
    if (parentLine) {
      drawPixelText(g, parentLine, sizes.padX, cursorY, colors.textKey);
      cursorY += bodyLineH;
    }

    const rows = this.current.kind === 'star'
      ? rowsForStar(this.current.starIdx)
      : rowsForBody(this.current.bodyIdx);
    for (const r of rows) {
      drawPixelText(g, r.key, sizes.padX, cursorY, colors.textKey);
      drawPixelText(g, r.val, sizes.padX + measurePixelText(r.key), cursorY, colors.textBody);
      cursorY += bodyLineH;
    }
  }
}

// Local equivalent of system-diagram.ts's picksEqual — duplicated here
// to avoid a circular dependency on a runtime export from the scene
// module just for one tiny pure helper.
function picksMatch(a: DiagramPick | null, b: DiagramPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'star' && b.kind === 'star') return a.starIdx === b.starIdx;
  if (a.kind !== 'star' && b.kind !== 'star') return a.bodyIdx === b.bodyIdx;
  return false;
}
