// Composed, descriptive world labels for the body info card.
//
// The body's TYPE comes from `classifyBody` (scripts/lib/body-archetype.mjs)
// — a physics-derived archetype, the single source that replaced the stored
// `worldClass` category. This module is the PRESENTATION layer on top: it
// turns the archetype into an evocative core noun and layers the single most
// salient state + a composition adjective, so two bodies that share an
// archetype but differ physically read distinctly ("Verdant Gaian World" vs
// "Cratered Glacial Moon").
//
// The label is a small "mad lib": `[state] [material] core-noun`, capped at a
// 3-token budget so it stays a glanceable chip. The noun wins the budget,
// then state, then material — a 3-token iconic noun ("Subglacial Ocean Moon")
// stands alone; a short one ("Tholin Moon") leaves room for a state.
//
// Archetype → noun:
//   - iconic types the surface-liquid data unlocks read as named worlds
//     (Gaian, Tholin, Brimstone, Ammonia/Glacial Sea, Subglacial Ocean);
//   - the rest read as their evocative base (Glacial, Frostbound, Desert, …).
// State + material then key off physical fields directly (surface liquid
// species/cover, salinity, subsurface ocean, haze, biosphere, temperature).
// Reads that mean H2O ice specifically stay on `iceFraction`; "wet"/"liquid"
// reads use `surfaceLiquidFraction` (any solvent).
//
// Pure runtime function — no catalog rebuild, no stored label. Thresholds are
// presentation choices (when a world "reads as" scorched / temperate /
// briny), intentionally coarser than the physics; tune them here freely.

import { type AtmGas, type Body } from '../../data/stars';
import { classifyBody } from '../../../scripts/lib/body-archetype.mjs';

// Surface-liquid cover below which an exotic solvent is a state modifier
// ("Hydrocarbon-Lake"), not the world's defining feature. Mirrors the
// classifier's own floor so the noun (Brimstone/Tholin) and the lake
// modifier never both describe the same liquid.
const LAKE_COVER_FLOOR = 0.05;
// Solute load at which a standing liquid reads "Briny".
const BRINY_SALINITY = 0.6;

// Axes a core noun already conveys, so a state modifier on the same axis is
// redundant and gets skipped. 'methane' covers a hydrocarbon surface;
// each cryogenic-liquid species maps to a material so the redundant-axis
// skip logic stays meaningful across the non-water sea cores.
type Material = 'gas' | 'rock' | 'iron' | 'ice' | 'water' | 'methane' | 'ammonia' | 'nitrogen' | 'sulfur';
interface Core {
  noun: string;
  hot?: boolean;        // core already reads as hot — skip hot temp adjectives
  cold?: boolean;       // core already reads as cold — skip cold temp adjectives
  volcanic?: boolean;   // core already reads as molten/active — skip "Volcanic"
  temperate?: boolean;  // core is itself a temperate living world — skip "Temperate"/"Verdant"
  hazy?: boolean;       // core already implies organic smog — skip "Smog-Shrouded"
  generic?: boolean;    // bare "Rocky" — drop the prefix when a modifier carries character
  uncharted?: boolean;  // no classifiable physics — emit the noun alone
  material?: Material;
}

function atmFrac(b: Body, gas: AtmGas): number {
  if (b.atm1 === gas) return b.atm1Frac ?? 0;
  if (b.atm2 === gas) return b.atm2Frac ?? 0;
  if (b.atm3 === gas) return b.atm3Frac ?? 0;
  return 0;
}

function isMoon(b: Body): boolean {
  return b.kind === 'moon';
}

// "Moon" for moons, "World" for planets.
function worldNoun(b: Body): string {
  return isMoon(b) ? 'Moon' : 'World';
}

// Surface free of standing liquid (any species) + ice — gates the silicate-
// volcanism modifier so a wet/icy/hydrocarbon-lake body's activity reads as
// cryovolcanic (or nothing), not "Volcanic". iceFraction stays H2O ice;
// surfaceLiquidFraction generalizes "wet" past water alone.
function isDrySurface(b: Body): boolean {
  return (b.surfaceLiquidFraction ?? 0) < 0.1 && (b.iceFraction ?? 0) < 0.3;
}

// Archetype → evocative core noun + the axes it already implies. The
// archetype is the physics-derived type (classifyBody); this turns it into
// the player-facing noun and the redundant-axis flags the state layer reads.
function coreFor(b: Body): Core {
  const w = worldNoun(b);
  switch (classifyBody(b)) {
    // ─── gaseous ───
    case 'hot_jupiter':      return { noun: 'Hot Jupiter', hot: true, material: 'gas' };
    case 'gas_giant':        return { noun: 'Gas Giant', material: 'gas' };
    case 'ice_giant':        return { noun: 'Ice Giant', cold: true, material: 'gas' };
    case 'sub_neptune':      return { noun: 'Sub-Neptune', material: 'gas' };
    case 'hycean':           return { noun: 'Hycean World', material: 'water' };
    case 'helium':           return { noun: 'Helium Giant', material: 'gas' };
    // ─── iconic surface / subsurface liquid ───
    case 'gaian':            return { noun: `Gaian ${w}`, material: 'water', temperate: true };
    case 'tholin':           return { noun: `Tholin ${w}`, cold: true, hazy: true, material: 'methane' };
    case 'brimstone':        return { noun: `Brimstone ${w}`, hot: true, volcanic: true, material: 'sulfur' };
    case 'ammonia_sea':      return { noun: `Ammonia Sea ${w}`, cold: true, material: 'ammonia' };
    case 'glacial_sea':      return { noun: `Glacial Sea ${w}`, cold: true, material: 'nitrogen' };
    case 'subglacial_ocean': return { noun: `Subglacial Ocean ${w}`, cold: true, material: 'ice' };
    case 'ocean':            return { noun: `Ocean ${w}`, material: 'water' };
    // ─── terrestrial base ───
    case 'lava':             return { noun: `Lava ${w}`, hot: true, volcanic: true, material: 'rock' };
    case 'magma_ocean':      return { noun: 'Magma Ocean', hot: true, volcanic: true, material: 'rock' };
    case 'volcanic':         return { noun: `Volcanic ${w}`, volcanic: true, material: 'rock' };
    case 'chthonian':        return { noun: 'Chthonian Core', hot: true, material: 'iron' };
    case 'iron':             return { noun: `Iron ${w}`, material: 'iron' };
    case 'frostbound':       return { noun: `Frostbound ${w}`, cold: true, material: 'methane' };
    case 'glacial':          return { noun: `Glacial ${w}`, cold: true, material: 'ice' };
    case 'super_earth':      return { noun: 'Super-Earth', material: 'rock' };
    case 'desert':           return { noun: `Desert ${w}`, material: 'rock' };
    case 'rocky':            return { noun: `Rocky ${w}`, material: 'rock', generic: true };
    case 'unknown':          return { noun: 'Uncharted World', uncharted: true };
  }
}

// The single most salient state adjective, in descending salience. Returns
// the first that fires; null when the body is unremarkable on every axis.
function stateModifier(b: Body, core: Core): string | null {
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const gas = core.material === 'gas';
  const liquid = b.surfaceLiquidFraction ?? 0;

  // 1. Life — the headline trait (the dedicated "life" row elaborates it).
  if (b.biosphereComplexity === 'complex' && (b.biosphereSurfaceImpact ?? 0) >= 0.5 && !core.temperate) return 'Verdant';
  if (b.biosphereComplexity === 'complex' || b.biosphereComplexity === 'microbial') return 'Living';

  // 2. Surface activity.
  if (isMoon(b) && (b.surfaceAge ?? 0) >= 0.85) return 'Tidally-Heated';
  // Exotic surface lakes the core noun didn't already name. Hydrocarbon and
  // sulfur reach their own archetypes (Tholin/Brimstone) at this cover, so
  // only the ammonia/nitrogen films surface here, as a modifier on a cold
  // base (Glacial/Frostbound) below their full-sea threshold.
  if (liquid >= LAKE_COVER_FLOOR && !/Sea|Ocean|Tholin|Brimstone/.test(core.noun)) {
    switch (b.surfaceLiquidSpecies) {
      case 'ammonia_water':
      case 'ammonia':  return 'Ammonia-Lake';
      case 'nitrogen': return 'Nitrogen-Lake';
      case 'hydrocarbon': return 'Hydrocarbon-Lake';
      case 'sulfur':   return 'Sulfur-Pool';
      default: break;
    }
  }
  // Cryovolcanism: a young icy/watery surface (planets, or moons the tidal
  // branch missed).
  if ((core.material === 'ice' || core.material === 'methane' || core.material === 'water')
      && core.cold && (b.surfaceAge ?? 0) >= 0.7) return 'Cryovolcanic';
  // A buried ice-shell ocean on a body that doesn't already wear one (a
  // Tholin moon over a hidden sea — Titan); skipped where the core is itself
  // a (sub)glacial ocean or surface sea.
  if (b.subsurfaceOceanSpecies != null && liquid < LAKE_COVER_FLOOR
      && !/Sea|Ocean/.test(core.noun)) return 'Sealed-Ocean';
  // Silicate volcanism on a hot, active, dry body the core didn't already
  // mark molten.
  if (!core.volcanic && isDrySurface(b)
      && (b.tectonicActivity ?? 0) >= 0.55 && (b.surfaceAge ?? 0) >= 0.6
      && T !== null && T >= 400) return 'Volcanic';

  // 3. Runaway greenhouse — a thick, hot atmosphere over a dry surface (Venus).
  if (!core.hot && core.material === 'rock' && P !== null && P >= 5
      && T !== null && T >= 340 && liquid < 0.05) return 'Hothouse';

  // 4. Extreme heat outranks everything below.
  if (!core.hot && T !== null && T >= 600) return 'Scorched';

  // 5. Distinctive atmosphere texture — organic smog (Titan tholin) or a
  //    dust-choked sky. Skipped on cores that already imply smog.
  if (!core.hazy && b.hazeAerosols && (b.hazeAerosols['THOLIN'] ?? 0) >= 0.3) return 'Smog-Shrouded';
  if ((b.dustStrength ?? 0) >= 0.5) return 'Dust-Choked';

  // 6. Milder temperature bands — skipped on the axis the core implies.
  if (T !== null) {
    // Hot world with standing seas — near-boiling water reads "Steaming",
    // where "Torrid" (dry heat) would misname an ocean. Above 330 K the only
    // solvent that can still pool is water, so this fires on water worlds only.
    if (!core.hot && T >= 330 && liquid >= 0.1) return 'Steaming';
    if (!core.hot && T >= 330) return 'Torrid';
    // Temperate reads as notable only where there's surface liquid of any
    // species (or the core is a water world) — an airless 290 K rock isn't.
    if (!core.temperate && T >= 250 && T < 330 && (liquid > 0 || core.material === 'water')) return 'Temperate';
    if (!core.cold && !gas && T < 90) return 'Frigid';
    if (!core.cold && !gas && T < 220) return 'Frozen';
  }

  // 7. Airless rocky body (Luna-class).
  if (core.material === 'rock' && (P === null || P < 0.001)) return 'Airless';

  // 8. Ancient, heavily-cratered surface (Mercury, Callisto). Skipped on
  //    molten/volcanic cores — a repaved surface isn't cratered.
  if (!core.hot && !core.volcanic && (b.surfaceAge ?? 1) <= 0.12) return 'Cratered';

  return null;
}

// A composition adjective adjacent to the noun, when distinctive and not
// already carried by the core's material.
function materialQualifier(b: Body, core: Core): string | null {
  // A heavy solute load reads "Briny" — only where there's standing liquid.
  if ((b.surfaceLiquidFraction ?? 0) > 0 && (b.salinity ?? 0) >= BRINY_SALINITY) return 'Briny';
  // Iron-dominant rocky surface (not an iron/chthonian core).
  if (core.material !== 'iron'
      && (b.resMetals ?? 0) >= 6 && (b.resMetals ?? 0) >= (b.resSilicates ?? 0)) return 'Ferrous';
  // Sulfur-dominated surface or sulfur-cycle volcanism (not a Brimstone core).
  if (core.material !== 'sulfur'
      && (atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3)) return 'Sulfurous';
  return null;
}

function tokenCount(parts: readonly string[]): number {
  // Hyphenated compounds ("Tidally-Heated", "Subglacial Ocean") count by word;
  // a hyphen stays one token.
  return parts.reduce((n, p) => n + p.split(' ').length, 0);
}

// Compose the full label: [state] [material] core-noun, within a hard 3-token
// budget. The noun is mandatory and claims first; state outranks material for
// the remainder — so a 3-token iconic noun stands alone, a 2-token noun takes
// a state, and a 1-token noun can take both.
export function composeWorldLabel(b: Body): string {
  const core = coreFor(b);
  if (core.uncharted) return core.noun;

  const state = stateModifier(b, core);
  const material = materialQualifier(b, core);

  // A bare "Rocky" prefix reads worse than letting an adjective carry the
  // character — "Greenhouse World", not "Greenhouse Rocky World".
  let noun = core.noun;
  if (core.generic && (state || material)) noun = worldNoun(b);

  let budget = 3 - tokenCount([noun]);
  const parts: string[] = [];
  if (state && tokenCount([state]) <= budget) { parts.push(state); budget -= tokenCount([state]); }
  if (material && tokenCount([material]) <= budget) { parts.push(material); budget -= tokenCount([material]); }
  parts.push(noun);
  return parts.join(' ');
}
