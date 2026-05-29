// =============================================================================
// Ocean color — physically-parameterized per-body derivation
// =============================================================================
//
// Real surface-liquid color emerges from five mostly-orthogonal pathways.
// Each pathway is a continuous function of an existing body dial, so two
// close analogs (slightly different bioticCarbonAqueous, slightly
// different metals/silicates ratio) yield visibly distinct but family-
// resembling oceans without any archetype branching.
//
// Composition is sequential pull-toward-tint operations rather than
// strict Beer-Lambert math — each pathway lerps the running color toward
// its characteristic tint by a strength scalar derived from the relevant
// body dial. Operating order, bottom of the stack upward:
//
//   1. solventBase     — start: intrinsic absorption of the dominant
//                        surface liquid (H2O / CH4 / NH3 / NH3-H2O /
//                        supercritical CO2; picked from T + chemistry).
//   2. cdomAbsorb      — pull toward humic tannin brown-yellow, scaled
//                        by biotic decay supply and concentration.
//   3. pigmentScatter  — pull toward a weighted blend of surface-photic
//                        pigments (chlorophyll green + carotenoid pink),
//                        weighted by relative biotic archetype
//                        productivity.
//   4. sedimentScatter — pull toward suspended-mineral color (same
//                        resource-grid blend `dustColorFor` produces),
//                        scaled by surfaceAge × coastline density.
//   5. skyReflect      — pull toward the body's haze blend by a fixed
//                        Fresnel-style weight (OCEAN_FRESNEL), encoding
//                        sky reflection off the surface.
//   6. stellarTint     — multiply the running color by host-star
//                        CLASS_COLOR (pulled partly to white) so M-dwarf
//                        oceans go darker and A-dwarf oceans go cyan-
//                        boosted without dominating the result.
//
// Suppressed (returns OCEAN_FALLBACK_COLOR — the H2O baseline) when
// waterFrac == 0 or the body has no surface — those bodies won't paint
// ocean cells anyway, but the field stays deterministic so the shader
// path stays uniform.

import { Color } from 'three';
import { BODIES, Body, CLASS_COLOR, STARS } from '../../../data/stars';
import { lerpColor } from '../body-palette';
import { hazeBlendFor } from './atmosphere';
import { atmFracOf, clamp01, dustColorFor, WHITE_COLOR } from './shared';

// ─── Pathway 3: solvent intrinsic absorption ───────────────────────────────
//
// "Deep clear column" colors — what a kilometer of the pure substance
// looks like under neutral illumination with no sky or suspended matter.
// Values are eyeballed off Cassini / lab spectra; tune to taste.
//
// H2O      — Earth's blue-water column: red strongly absorbed, blue
//            transmitted. The Pacific deep. Current hard-coded baseline.
// CH4      — Titan's hydrocarbon lakes (Ligeia / Kraken Mare). Weak
//            red absorption; dissolved organics from atmospheric
//            photolysis pull the baseline amber-brown.
// NH3_H2O  — Ammonia-water eutectic. Sits at the warm end of the cold
//            regime (Triton interior, hypothetical sub-Europan).
// NH3      — Pure ammonia (rarely the primary, very cold worlds with
//            negligible H2O). Slight yellow from N-H absorption.
// CO2_SC   — Supercritical CO2 (T > 304 K AND P > 73 bar). Near-clear
//            with a faint warm tint — Venus's deep atmosphere proxy.
const SOLVENT_COLOR_H2O      = new Color(0.16, 0.34, 0.55);
const SOLVENT_COLOR_CH4      = new Color(0.28, 0.20, 0.10);
const SOLVENT_COLOR_NH3_H2O  = new Color(0.30, 0.40, 0.50);
const SOLVENT_COLOR_NH3      = new Color(0.46, 0.42, 0.32);
const SOLVENT_COLOR_CO2_SC   = new Color(0.42, 0.38, 0.32);

type SolventSpecies = 'H2O' | 'CH4' | 'NH3_H2O' | 'NH3' | 'CO2_SC';

// Pick the dominant surface-liquid species from temperature × chemistry.
// Real bodies are mixtures; we resolve to one species for the base color
// and let downstream pathways (pigment / sediment / CDOM) modulate.
//
// Branch priority:
//   - hot + dense atm → supercritical CO2 (Venus regime)
//   - warm (>~250 K)  → H2O (Earth / Mars-paleo regime)
//   - cold w/ CH4 in atm → CH4 (Titan regime)
//   - cryogenic w/ NH3 inventory → NH3_H2O or NH3 by H2O presence
//   - else            → H2O default (the most defensible fallback)
function pickPrimarySolvent(body: Body): SolventSpecies {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar;
  if (T !== null && P !== null && T > 304 && P > 73) return 'CO2_SC';
  if (T === null || T >= 250) return 'H2O';
  // Cold regimes — check what's in the volatile inventory. Atm species
  // are the strongest signal that the corresponding liquid could exist
  // at surface (vapor pressure equilibrium).
  const atmHasCH4 = atmFracOf(body, 'CH4') > 0.005;
  const atmHasNH3 = atmFracOf(body, 'NH3') > 0.005;
  if (T < 120 && atmHasCH4) return 'CH4';
  if (T < 200 && atmHasNH3) {
    return (body.waterFraction ?? 0) > 0.05 ? 'NH3_H2O' : 'NH3';
  }
  return 'H2O';
}

function solventBaseColorFor(species: SolventSpecies): Color {
  switch (species) {
    case 'H2O':     return SOLVENT_COLOR_H2O.clone();
    case 'CH4':     return SOLVENT_COLOR_CH4.clone();
    case 'NH3_H2O': return SOLVENT_COLOR_NH3_H2O.clone();
    case 'NH3':     return SOLVENT_COLOR_NH3.clone();
    case 'CO2_SC':  return SOLVENT_COLOR_CO2_SC.clone();
  }
}

// ─── Pathway 1: stellar SED tint ───────────────────────────────────────────
//
// What wavelengths reach the surface to be reflected. Read off the host
// star's CLASS_COLOR (already blackbody-approximated). Pulled toward
// white so the tint nudges rather than dominates — a Vega-class A star
// shouldn't paint every ocean cyan, and an M-dwarf shouldn't paint
// every ocean black. The pull factor preserves SED variety while
// keeping ocean color readable as "ocean" across all hosts.
const STELLAR_TINT_PULL_TO_WHITE = 0.55;

function hostStarOf(body: Body): { cls: string } | null {
  let starIdx: number | null = null;
  if (body.kind === 'planet' && body.hostStarIdx !== null) {
    starIdx = body.hostStarIdx;
  } else if (body.kind === 'moon' && body.hostBodyIdx !== null) {
    const host = BODIES[body.hostBodyIdx];
    if (host !== undefined && host.hostStarIdx !== null) starIdx = host.hostStarIdx;
  }
  if (starIdx === null) return null;
  const star = STARS[starIdx];
  return star ? { cls: star.cls } : null;
}

function stellarLightTintFor(body: Body): Color {
  const host = hostStarOf(body);
  if (host === null) return WHITE_COLOR;
  const raw = CLASS_COLOR[host.cls as keyof typeof CLASS_COLOR];
  if (!raw) return WHITE_COLOR;
  return lerpColor(raw.clone(), WHITE_COLOR, STELLAR_TINT_PULL_TO_WHITE);
}

// ─── Pathway 2: sky reflection (Fresnel + diffuse) ─────────────────────────
//
// Ocean surface reflects what sits above it. We don't have a separate
// sky model — the body's already-derived `hazeColor` is the right
// proxy: it's the weighted blend of Rayleigh scattering + bulk gas
// absorption + aerosols + dust that the haze pass paints over the
// disc. A thick-N2 sky lands cyan-grey there; a Mars-thin CO2 + dust
// sky lands pink-tan; a Venusian sulphate sky lands cream-orange.
//
// The Fresnel coefficient governs how much of the ocean's final color
// is "what's above" vs "what's below." For near-normal viewing of
// water this is ~0.02 (very dark water reflects sky weakly at high
// sun angle) climbing toward 1.0 at grazing angles. Orbital rendering
// is near-normal, but the orbital eye sees a hemisphere's worth of
// angles compressed onto a disc, so we pick a single representative
// value tuned to read as "ocean reflecting sky" without overwhelming
// the solvent base.
const OCEAN_FRESNEL = 0.18;

// ─── Pathway 4: CDOM (colored dissolved organic matter) ────────────────────
//
// Tea-staining from biotic decay products — humic + fulvic acids
// absorb in blue + UV and leave brown-yellow. Earth's coastal /
// blackwater rivers get half their color from this. The pathway has
// a quadratic-ish dependence on biotic productivity (more life = more
// decay supply) gated by water fraction (CDOM concentrates per liter,
// so a small ocean is more stained than a large one for equal
// productivity).
const CDOM_TINT_COLOR = new Color(0.62, 0.45, 0.20);  // humic tannin brown-yellow
const CDOM_STRENGTH_SCALE = 0.35;
// How strongly ocean volume dilutes CDOM concentration: an ocean world
// (wf=1) lands at 1 − this, a paleo-shore world (wf~0.3) stays near full.
const CDOM_DILUTION_BY_WATER = 0.7;

function cdomTintFor(body: Body): { color: Color; amount: number } {
  const bca = body.bioticCarbonAqueous ?? 0;
  const wf  = body.waterFraction ?? 0;
  // Concentration ∝ productivity / water_volume — ocean worlds (wf ~ 1)
  // dilute, paleo-shore worlds (wf ~ 0.3) concentrate.
  const dilution = 1 - wf * CDOM_DILUTION_BY_WATER;
  const amount = Math.min(1, bca * dilution * CDOM_STRENGTH_SCALE);
  return { color: CDOM_TINT_COLOR.clone(), amount };
}

// ─── Pathway 5: photosynthetic pigment scatter ─────────────────────────────
//
// What pigment chemistry the surface biosphere settled on, weighted by
// relative productivity. Each pigment family scatters a characteristic
// reflection color back through the water column. Only surface-photic
// channels feed this pathway — subsurface aqueous productivity lives
// under an ice shell where it can't paint surface color, so it's
// deliberately excluded.
//
// CHLOROPHYLL — green (Earth-style phytoplankton; chlorophyll-a absorbs
//   in blue and red, reflects green).
// CAROTENOID  — pink-orange (halophile carotenoids in extreme brines,
//   Dead Sea / Don Juan Pond hues; the sulfur-biotic channel feeds this
//   slot since aqueous sulfur biology in brine settings produces
//   carotenoid analogs).
//
// Mixing is a weighted average across the two pigments by relative
// productivity; the amount scalar carries concentration so a low-
// productivity world still reads as faintly pigmented rather than zero.
const PIGMENT_CHLOROPHYLL = new Color(0.20, 0.50, 0.25);
const PIGMENT_CAROTENOID  = new Color(0.65, 0.30, 0.35);
const PIGMENT_STRENGTH_SCALE = 0.45;

function pigmentTintFor(body: Body): { color: Color; amount: number } {
  const bca = body.bioticCarbonAqueous ?? 0;  // chlorophyll path
  const bsu = body.bioticSulfur        ?? 0;  // carotenoid path
  const total = bca + bsu;
  if (total <= 0) return { color: WHITE_COLOR, amount: 0 };
  const wCa = bca / total;
  const wCb = bsu / total;
  const blended = new Color(
    PIGMENT_CHLOROPHYLL.r * wCa + PIGMENT_CAROTENOID.r * wCb,
    PIGMENT_CHLOROPHYLL.g * wCa + PIGMENT_CAROTENOID.g * wCb,
    PIGMENT_CHLOROPHYLL.b * wCa + PIGMENT_CAROTENOID.b * wCb,
  );
  // Concentration scales with the larger single-pigment productivity —
  // saturates rather than summing, since multi-pigment communities
  // still compete for the same photons.
  const amount = Math.min(1, Math.max(bca, bsu) * PIGMENT_STRENGTH_SCALE);
  return { color: blended, amount };
}

// ─── Pathway 6: mineral suspended sediment ─────────────────────────────────
//
// Eroded surface mineralogy plumes into shallow water. Color comes
// from the body's resource grid (same source as `dustColorFor`'s
// blend) so the ocean's turbid-shoreline tint matches the dust-storm
// haze tint that drifts over the same coastlines. Strength scales
// with `surfaceAge` (geologically young surfaces shed more fresh
// sediment) and the inverse of `waterFraction` (high coast/volume
// ratio concentrates sediment). Capped because at saturation real
// suspended-sediment plumes go opaque and we want the deep ocean
// underneath to still show through.
const SEDIMENT_STRENGTH_SCALE = 0.30;
// Coastline density ∝ 1/wf: BASELINE is the turbidity an ocean-world still
// carries, PER_INV_WF scales the 1/wf term, WF_FLOOR clamps the blowup at
// tiny water fractions, and COAST_MAX caps shallow worlds from over-
// concentrating.
const SEDIMENT_COAST_BASELINE = 0.35;
const SEDIMENT_COAST_PER_INV_WF = 0.5;
const SEDIMENT_WF_FLOOR = 0.2;
const SEDIMENT_COAST_MAX = 1.5;

function sedimentTintFor(body: Body): { color: Color; amount: number } {
  const wf = body.waterFraction ?? 0;
  if (wf <= 0) return { color: WHITE_COLOR, amount: 0 };
  const color = dustColorFor(body);
  const coastFactor = Math.min(
    SEDIMENT_COAST_MAX,
    SEDIMENT_COAST_BASELINE + SEDIMENT_COAST_PER_INV_WF / Math.max(SEDIMENT_WF_FLOOR, wf),
  );
  const ageFactor   = body.surfaceAge ?? 0.5;  // young = more sediment
  const amount = Math.min(0.6, coastFactor * ageFactor * SEDIMENT_STRENGTH_SCALE);
  return { color, amount };
}

// ─── Composer ──────────────────────────────────────────────────────────────
//
// Apply the stack. `tint(c, t, amount)` lerps c → t by `amount`; this
// is the multiplicative-absorption analog the comment block above
// describes (each absorption pathway pulls the running color toward
// its characteristic tint by a strength scalar).
export const OCEAN_FALLBACK_COLOR: readonly [number, number, number] =
  [SOLVENT_COLOR_H2O.r, SOLVENT_COLOR_H2O.g, SOLVENT_COLOR_H2O.b];

export function oceanColorFor(body: Body): readonly [number, number, number] {
  if ((body.waterFraction ?? 0) <= 0) return OCEAN_FALLBACK_COLOR;

  // 3. Solvent base.
  const species = pickPrimarySolvent(body);
  let col = solventBaseColorFor(species);

  // 4. CDOM yellow-substance absorption.
  const cdom = cdomTintFor(body);
  col = lerpColor(col, cdom.color, cdom.amount);

  // 5. Photosynthetic pigment scatter.
  const pig = pigmentTintFor(body);
  col = lerpColor(col, pig.color, pig.amount);

  // 6. Mineral suspended sediment.
  const sed = sedimentTintFor(body);
  col = lerpColor(col, sed.color, sed.amount);

  // 2. Sky reflection on top — Fresnel-gated additive. Uses the body's
  // unified haze blend as a stand-in for sky color; falls back to a
  // neutral grey for bodies with no atmosphere data so the Fresnel
  // term doesn't multiply against zero.
  const haze = hazeBlendFor(body);
  const sky = haze.opacity > 0 ? haze.color : new Color(0.5, 0.5, 0.5);
  col = lerpColor(col, sky, OCEAN_FRESNEL);

  // 1. Stellar SED tint applied last (multiplicative through the
  // entire stack — what light is even reaching the ocean).
  const stellar = stellarLightTintFor(body);
  col.r = clamp01(col.r * stellar.r);
  col.g = clamp01(col.g * stellar.g);
  col.b = clamp01(col.b * stellar.b);

  return [col.r, col.g, col.b];
}
