// BodyInfoCard — transient on-hover tooltip for the system view. One
// instance lives on SystemHud; SystemScene calls setTarget() each
// pointer move with the picker's result (star, planet, moon, or null).
//
// Visually mirrors the galaxy-view InfoCard family — paintSurface bg,
// yellow title in EspySans 15, Monaco 11 key/value body rows — but
// drops the multi-member nesting and the close-X. Tooltips are
// ephemeral; dismissal is the cursor leaving the disc.

import { drawPixelText, getFont, measurePixelText } from '../../data/pixel-font';
import { BODIES, STARS, type BiosphereArchetype, type BiosphereComplexity, type BiosphereImpactLevel, type Body, type ResourceKey, type WorldClass } from '../../data/stars';
import type { DiagramPick } from '../../scene/system-diagram';
import { BasePanel } from '../base-panel';
import { paintSurface } from '../painter';
import { colors, fonts, sizes } from '../theme';

// Pretty labels for enum-valued fields. Defined here (rather than on the
// data layer) because they're a presentation concern; if the catalog ever
// adds a new world-class, TS will flag the missing entry here.
const WORLD_CLASS_LABEL: Record<WorldClass, string> = {
  // Terrestrial
  rocky:       'Rocky',
  solid_giant: 'Solid Giant',
  desert:      'Desert',
  ocean:       'Ocean',
  ice:         'Ice',
  carbon:      'Carbon',
  iron:        'Iron',
  lava:        'Lava',
  magma_ocean: 'Magma Ocean',
  chthonian:   'Chthonian',
  // Gaseous
  gas_dwarf:   'Gas Dwarf',
  hycean:      'Hycean',
  helium:      'Helium',
  ice_giant:   'Ice Giant',
  gas_giant:   'Gas Giant',
};

const BIOSPHERE_ARCHETYPE_LABEL: Record<BiosphereArchetype, string> = {
  carbon_aqueous:     'Aqueous',
  subsurface_aqueous: 'Subsurface',
  aerial:             'Aerial',
  cryogenic:          'Cryogenic',
  silicate:           'Silicate',
  sulfur:             'Sulfur',
};
const BIOSPHERE_COMPLEXITY_LABEL: Record<Exclude<BiosphereComplexity, 'none'>, string> = {
  prebiotic: 'Prebiotic',
  microbial: 'Microbial',
  complex:   'Complex',
};

// Surface impact bucket suffix. Mirrors IMPACT_BUCKET_THRESHOLDS in
// procgen-priors.mjs (`< 0.05` none / `0.05–0.20` trace / `0.20–0.50`
// modifying / `>= 0.50` dominant). The 'none' impact level never paints
// — it's only included for type completeness — because complex life
// always contributes additive surface coupling per
// LIFE_SURFACE_CONTRIBUTION, so anything that clears the complexity
// 'none' gate carries a non-zero impact.
const BIOSPHERE_IMPACT_LABEL: Record<Exclude<BiosphereImpactLevel, 'none'>, string> = {
  trace:     'trace signature',
  modifying: 'modifying surface',
  dominant:  'dominant biosphere',
};

function impactBucket(impact: number): BiosphereImpactLevel {
  if (impact <  0.05) return 'none';
  if (impact <  0.20) return 'trace';
  if (impact <  0.50) return 'modifying';
  return 'dominant';
}

// Display label per resource. Each surviving top-N resource becomes its
// own row in the info card, keyed by the label and valued by the body's
// abundance — so a player reads "metals 80% / silicates 40%" as "rich
// in iron, modest in rock" rather than scanning a comma-joined name list
// that hides whether the world is barren or saturated.
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

// Top `count` resources by raw value, descending, each with the body's
// absolute abundance ∈ [0..1] (value/10). Empty array when the body
// carries no resource signal at all. Mirrors `dominantResources` in
// data/stars.ts but uses display labels instead of Color objects since
// the panel only needs names + numbers.
function dominantResourceEntries(b: Body, count = 2): Array<{ label: string; abundance: number }> {
  return RESOURCE_FIELDS
    .map(f => ({ label: RESOURCE_LABEL[f], value: b[f] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, c) => c.value - a.value)
    .slice(0, count)
    .map(e => ({ label: e.label, abundance: Math.min(1, e.value / 10) }));
}

// Format an abundance ∈ (0..1] as 1-5 asterisks for the info card. Reads
// as a quick rating rather than a hard percentage — "***" lands faster
// than "60%" when the player is scanning multiple bodies for what's
// worth mining. `ceil` so every nonzero abundance shows at least one
// star (a present-but-trace resource still earns a tick), and the
// quintile bucketing matches roughly how the surface renderer's grey
// lerp reads: 1★ ≈ barren, 5★ ≈ fully saturated archetype.
function formatAbundance(a: number): string {
  const stars = Math.max(1, Math.min(5, Math.ceil(a * 5)));
  return '*'.repeat(stars);
}

// Round fraction (0..1) to a percent string at a precision that keeps
// trace-level differences readable. ≥10% → integer (98%), 0.1–10% →
// one decimal (3.3%, 0.5%), <0.1% → two decimals (0.03%) — so a
// Jupiter NH3 cloud chemistry renders distinctly from Saturn's
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
function dominantGasLabels(b: Body, count = 2): string[] {
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
  // Complexity 'none' is the null-equivalent — skip; a planet with
  // bacteria is what we want to surface, not a barren rock. When life
  // exists, the row carries archetype + complexity + impact bucket so
  // the player sees what kind, how structured, and how visibly it
  // alters the body ("Complex Subsurface · trace signature" reads as
  // a sealed Europa; "Complex Aqueous · dominant biosphere" reads as
  // Earth). One row to keep card density tight.
  if (
    b.biosphereComplexity !== null && b.biosphereComplexity !== 'none' &&
    b.biosphereArchetype  !== null && b.biosphereSurfaceImpact !== null
  ) {
    const archLabel    = BIOSPHERE_ARCHETYPE_LABEL[b.biosphereArchetype];
    const complexLabel = BIOSPHERE_COMPLEXITY_LABEL[b.biosphereComplexity];
    const bucket       = impactBucket(b.biosphereSurfaceImpact);
    const impactLabel  = bucket === 'none' ? null : BIOSPHERE_IMPACT_LABEL[bucket];
    const val = impactLabel === null
      ? `${complexLabel} ${archLabel}`
      : `${complexLabel} ${archLabel} · ${impactLabel}`;
    rows.push({ key: k('life'), val });
  }
  const gases = dominantGasLabels(b);
  if (gases.length > 0) rows.push({ key: k('gas'), val: gases.join(', ') });
  // Gas/ice giants have no accessible surface — the procgen resource
  // grid still carries numbers (atmospheric trace species etc.) but
  // nothing's mineable in a "land a rig" sense, so suppress the row to
  // keep player-relevant data forward. Moons of giants stay solid and
  // still surface their resources.
  if (!hasInaccessibleSurface(b)) {
    for (const e of dominantResourceEntries(b)) {
      rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
    }
  }
  return rows;
}

function hasInaccessibleSurface(b: Body): boolean {
  // Gaseous-bracket bodies have no accessible surface.
  const wc = b.worldClass;
  return wc === 'gas_giant' || wc === 'ice_giant' || wc === 'gas_dwarf'
      || wc === 'hycean'    || wc === 'helium';
}

// Belt rows surface the band's extent, anchoring metadata, and the top
// two mineable resources with their abundances — one row per resource
// so a Kuiper-style "high volatiles, trace metals" reads as a pair of
// percentages rather than a flat name list.
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
  for (const e of dominantResourceEntries(b)) {
    rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
  }
  return rows;
}

// Ring rows: extent in planetary radii (so "1.1–2.3 R_p" reads against
// the host planet's size) plus the top two dominant resources with
// their abundances. The underlying six-resource grid still drives the
// renderer's icy/dusty lerp — the panel just doesn't surface the long
// form.
function rowsForRing(b: Body): BodyRow[] {
  const rows: BodyRow[] = [];
  if (b.innerPlanetRadii !== null && b.outerPlanetRadii !== null) {
    rows.push({ key: k('extent'), val: `${b.innerPlanetRadii.toFixed(2)}–${b.outerPlanetRadii.toFixed(2)} R_p` });
  }
  for (const e of dominantResourceEntries(b)) {
    rows.push({ key: k(e.label), val: formatAbundance(e.abundance) });
  }
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
