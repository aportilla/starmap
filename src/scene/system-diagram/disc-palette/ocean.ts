// =============================================================================
// Ocean color — physically-parameterized per-body derivation
// =============================================================================
//
// Real surface-liquid color emerges from six mostly-orthogonal pathways.
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
//                        surface liquid. The species is READ from the
//                        already-persisted `surfaceLiquidSpecies` (water
//                        / hydrocarbon / ammonia_water / ammonia /
//                        nitrogen / sulfur) — the renderer no longer
//                        re-derives it from T + chemistry.
//   2. cdomAbsorb      — pull toward humic tannin brown-yellow, scaled
//                        by biotic decay supply and concentration. Only
//                        an aqueous-sea pathway (water / ammonia_water);
//                        a hydrocarbon / nitrogen / sulfur sea skips it.
//   3. pigmentScatter  — pull toward a weighted blend of surface-photic
//                        pigments: chlorophyll green (weighted by
//                        bioticCarbonAqueous) + carotenoid/halophile pink
//                        (weighted by salinity — brine drives the tint).
//                        Aqueous-only.
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
// Supercritical CO2 is intentionally NOT a species here: on a Venus-type
// world that "ocean" is the atmosphere, not a standing surface liquid,
// so procgen never tags it as surfaceLiquidSpecies and the renderer has
// nothing to paint.
//
// Suppressed (returns OCEAN_FALLBACK_COLOR — the H2O baseline) when
// surfaceLiquidFraction == 0 or the body has no surface — those bodies
// won't paint ocean cells anyway, but the field stays deterministic so
// the shader path stays uniform.

import { Color } from 'three';
import { Body, CLASS_COLOR, STARS, SurfaceLiquidSpecies } from '../../../data/stars';
import { hostStarIdxOf, lerpColor } from '../color-science';
import { clamp01, dustColorFor, WHITE_COLOR } from './shared';

// ─── Pathway 1: solvent intrinsic absorption ───────────────────────────────
//
// "Deep clear column" colors — what a kilometer of the pure substance
// looks like under neutral illumination with no sky or suspended matter.
// Values are eyeballed off Cassini / lab spectra; tune to taste.
//
// H2O       — Earth's blue-water column: red strongly absorbed, blue
//             transmitted. The Pacific deep. The OCEAN_FALLBACK baseline.
// CH4       — Titan's hydrocarbon lakes (Ligeia / Kraken Mare). Weak
//             red absorption; dissolved organics from atmospheric
//             photolysis pull the baseline amber-brown.
// NH3_H2O   — Ammonia-water eutectic. Sits at the warm end of the cold
//             regime (Triton interior, hypothetical sub-Europan).
// NH3       — Pure ammonia (rarely the primary, very cold worlds with
//             negligible H2O). Slight yellow from N-H absorption.
// NITROGEN  — Liquid N2 (Triton-cold surface seas). Nearly colorless;
//             a faint cold blue-grey from weak scattering.
// SULFUR    — Molten / liquid elemental sulfur (Io-style hot lakes).
//             Amber yellow-orange.
const SOLVENT_COLOR_H2O      = new Color(0.16, 0.34, 0.55);
const SOLVENT_COLOR_CH4      = new Color(0.28, 0.20, 0.10);
const SOLVENT_COLOR_NH3_H2O  = new Color(0.30, 0.40, 0.50);
const SOLVENT_COLOR_NH3      = new Color(0.46, 0.42, 0.32);
const SOLVENT_COLOR_NITROGEN = new Color(0.42, 0.48, 0.55);  // liquid N2 — faint cold blue-grey
const SOLVENT_COLOR_SULFUR   = new Color(0.60, 0.42, 0.12);  // molten sulfur — amber yellow-orange

// How far a hydrocarbon sea's base is pulled toward tholin brown when the
// body carries photolysis aerosols (Titan-style organic haze raining out).
const CH4_THOLIN_TINT  = new Color(0.34, 0.22, 0.12);  // settled tholin organics
const CH4_THOLIN_PULL  = 0.5;

// Read the persisted dominant surface-liquid species straight into its base
// color — no re-derivation. `null` only reaches here as a defensive path
// (the suppression gate already returns early on zero liquid cover), so it
// falls back to the H2O baseline rather than throwing.
function solventBaseColorFor(species: SurfaceLiquidSpecies | null, body: Body): Color {
  switch (species) {
    case 'water':         return SOLVENT_COLOR_H2O.clone();
    case 'hydrocarbon': {
      // The CH4 base already encodes dissolved organics; deepen it toward
      // tholin when photolysis aerosols are present.
      const tholin = body.hazeAerosols?.THOLIN ?? 0;
      return tholin > 0
        ? lerpColor(SOLVENT_COLOR_CH4.clone(), CH4_THOLIN_TINT, Math.min(1, tholin) * CH4_THOLIN_PULL)
        : SOLVENT_COLOR_CH4.clone();
    }
    case 'ammonia_water': return SOLVENT_COLOR_NH3_H2O.clone();
    case 'ammonia':       return SOLVENT_COLOR_NH3.clone();
    case 'nitrogen':      return SOLVENT_COLOR_NITROGEN.clone();
    case 'sulfur':        return SOLVENT_COLOR_SULFUR.clone();
    default:              return SOLVENT_COLOR_H2O.clone();
  }
}

// CDOM (pathway 2) and the carotenoid/halophile half of pigment scatter
// (pathway 3) are water-chemistry phenomena — humic decay products and
// brine-loving pigments — so they only apply to aqueous seas.
function isAqueousSpecies(species: SurfaceLiquidSpecies | null): boolean {
  return species === 'water' || species === 'ammonia_water';
}

// ─── Pathway 6: stellar SED tint ───────────────────────────────────────────
//
// What wavelengths reach the surface to be reflected. Read off the host
// star's CLASS_COLOR (already blackbody-approximated). Pulled toward
// white so the tint nudges rather than dominates — a Vega-class A star
// shouldn't paint every ocean cyan, and an M-dwarf shouldn't paint
// every ocean black. The pull factor preserves SED variety while
// keeping ocean color readable as "ocean" across all hosts.
const STELLAR_TINT_PULL_TO_WHITE = 0.55;

function hostStarOf(body: Body): { cls: string } | null {
  const starIdx = hostStarIdxOf(body);
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

// ─── Pathway 5: sky reflection (Fresnel + diffuse) ─────────────────────────
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

// ─── Pathway 2: CDOM (colored dissolved organic matter) ────────────────────
//
// Tea-staining from biotic decay products — humic + fulvic acids
// absorb in blue + UV and leave brown-yellow. Earth's coastal /
// blackwater rivers get half their color from this. The pathway has
// a quadratic-ish dependence on biotic productivity (more life = more
// decay supply) gated by liquid volume (CDOM concentrates per liter,
// so a small sea is more stained than a large one for equal
// productivity).
const CDOM_TINT_COLOR = new Color(0.62, 0.45, 0.20);  // humic tannin brown-yellow
const CDOM_STRENGTH_SCALE = 0.35;
// How strongly liquid volume dilutes CDOM concentration: an ocean world
// (lf=1) lands at 1 − this, a paleo-shore world (lf~0.3) stays near full.
const CDOM_DILUTION_BY_LIQUID = 0.7;

function cdomTintFor(body: Body): { color: Color; amount: number } {
  const bca = body.bioticCarbonAqueous ?? 0;
  const lf  = body.surfaceLiquidFraction ?? 0;
  // Concentration ∝ productivity / liquid_volume — ocean worlds (lf ~ 1)
  // dilute, paleo-shore worlds (lf ~ 0.3) concentrate.
  const dilution = 1 - lf * CDOM_DILUTION_BY_LIQUID;
  const amount = Math.min(1, bca * dilution * CDOM_STRENGTH_SCALE);
  return { color: CDOM_TINT_COLOR.clone(), amount };
}

// ─── Pathway 3: photosynthetic pigment scatter ─────────────────────────────
//
// What pigment chemistry the surface biosphere settled on, weighted by
// relative productivity. Each pigment family scatters a characteristic
// reflection color back through the water column. Only surface-photic
// channels feed this pathway — subsurface aqueous productivity lives
// under an ice shell where it can't paint surface color, so it's
// deliberately excluded.
//
// CHLOROPHYLL — green (Earth-style phytoplankton; chlorophyll-a absorbs
//   in blue and red, reflects green). Weighted by bioticCarbonAqueous.
// CAROTENOID  — pink-orange (halophile carotenoids in extreme brines,
//   Dead Sea / Don Juan Pond hues). Weighted by salinity: a brine's
//   solute load is what selects for the halophile pigment, so the tint
//   tracks salinity rather than any biotic-productivity dial.
//
// Mixing is a weighted average across the two pigments; the amount scalar
// carries concentration so a low-productivity / low-brine world still
// reads as faintly pigmented rather than zero. Carotenoid/halophile is a
// water-chemistry phenomenon, so this pathway is aqueous-only.
const PIGMENT_CHLOROPHYLL = new Color(0.20, 0.50, 0.25);
const PIGMENT_CAROTENOID  = new Color(0.65, 0.30, 0.35);
const PIGMENT_STRENGTH_SCALE = 0.45;

function pigmentTintFor(body: Body): { color: Color; amount: number } {
  const bca = body.bioticCarbonAqueous ?? 0;  // chlorophyll path
  const sal = body.salinity            ?? 0;  // carotenoid / halophile path
  const total = bca + sal;
  if (total <= 0) return { color: WHITE_COLOR, amount: 0 };
  // Pre-divide blend (weights normalized before the sum), kept inline rather
  // than routed through weightedColorBlend, which normalizes post-divide — the
  // two differ in IEEE-754 rounding order and this is the actively-tuned form.
  const wCa = bca / total;
  const wCb = sal / total;
  const blended = new Color(
    PIGMENT_CHLOROPHYLL.r * wCa + PIGMENT_CAROTENOID.r * wCb,
    PIGMENT_CHLOROPHYLL.g * wCa + PIGMENT_CAROTENOID.g * wCb,
    PIGMENT_CHLOROPHYLL.b * wCa + PIGMENT_CAROTENOID.b * wCb,
  );
  // Concentration scales with the larger single driver — saturates rather
  // than summing, since pigment and brine still compete for the same photons.
  const amount = Math.min(1, Math.max(bca, sal) * PIGMENT_STRENGTH_SCALE);
  return { color: blended, amount };
}

// ─── Pathway 4: mineral suspended sediment ─────────────────────────────────
//
// Eroded surface mineralogy plumes into shallow liquid. Color comes
// from the body's resource grid (same source as `dustColorFor`'s
// blend) so the ocean's turbid-shoreline tint matches the dust-storm
// haze tint that drifts over the same coastlines. Strength scales
// with `surfaceAge` (geologically young surfaces shed more fresh
// sediment) and the inverse of `surfaceLiquidFraction` (high coast/volume
// ratio concentrates sediment). Capped because at saturation real
// suspended-sediment plumes go opaque and we want the deep ocean
// underneath to still show through.
const SEDIMENT_STRENGTH_SCALE = 0.30;
// Coastline density ∝ 1/lf: BASELINE is the turbidity an ocean-world still
// carries, PER_INV_LF scales the 1/lf term, LF_FLOOR clamps the blowup at
// tiny liquid fractions, and COAST_MAX caps shallow worlds from over-
// concentrating.
const SEDIMENT_COAST_BASELINE = 0.35;
const SEDIMENT_COAST_PER_INV_LF = 0.5;
const SEDIMENT_LF_FLOOR = 0.2;
const SEDIMENT_COAST_MAX = 1.5;

function sedimentTintFor(body: Body): { color: Color; amount: number } {
  const lf = body.surfaceLiquidFraction ?? 0;
  if (lf <= 0) return { color: WHITE_COLOR, amount: 0 };
  const color = dustColorFor(body);
  const coastFactor = Math.min(
    SEDIMENT_COAST_MAX,
    SEDIMENT_COAST_BASELINE + SEDIMENT_COAST_PER_INV_LF / Math.max(SEDIMENT_LF_FLOOR, lf),
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

// `haze` is the body's already-computed hazeBlendFor result, threaded in so
// the build path doesn't walk the haze contributor list twice (buildDiscPalette
// needs the same blend for its own hazeOpacity/hazeColor outputs).
export function oceanColorFor(
  body: Body,
  haze: { color: Color; opacity: number },
): readonly [number, number, number] {
  if ((body.surfaceLiquidFraction ?? 0) <= 0) return OCEAN_FALLBACK_COLOR;

  // 1. Solvent base — read straight from the persisted species.
  const species = body.surfaceLiquidSpecies;
  let col = solventBaseColorFor(species, body);

  // CDOM and the pigment scatter are water-chemistry pathways — a
  // hydrocarbon / nitrogen / sulfur sea leans on its solvent base + sky
  // + stellar tint instead, so gate both to aqueous species.
  const aqueous = isAqueousSpecies(species);

  // 2. CDOM yellow-substance absorption (aqueous only).
  if (aqueous) {
    const cdom = cdomTintFor(body);
    col = lerpColor(col, cdom.color, cdom.amount);
  }

  // 3. Photosynthetic pigment + halophile carotenoid scatter (aqueous only).
  if (aqueous) {
    const pig = pigmentTintFor(body);
    col = lerpColor(col, pig.color, pig.amount);
  }

  // 4. Mineral suspended sediment.
  const sed = sedimentTintFor(body);
  col = lerpColor(col, sed.color, sed.amount);

  // 5. Sky reflection on top — Fresnel-gated additive. Uses the body's
  // unified haze blend as a stand-in for sky color; falls back to a
  // neutral grey for bodies with no atmosphere data so the Fresnel
  // term doesn't multiply against zero.
  const sky = haze.opacity > 0 ? haze.color : new Color(0.5, 0.5, 0.5);
  col = lerpColor(col, sky, OCEAN_FRESNEL);

  // 6. Stellar SED tint applied last (multiplicative through the
  // entire stack — what light is even reaching the ocean).
  const stellar = stellarLightTintFor(body);
  col.r = clamp01(col.r * stellar.r);
  col.g = clamp01(col.g * stellar.g);
  col.b = clamp01(col.b * stellar.b);

  return [col.r, col.g, col.b];
}
