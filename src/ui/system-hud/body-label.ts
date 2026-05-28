// Composed, descriptive world labels for the body info card.
//
// `worldClass` is the FUNCTIONAL taxonomy — it drives rendering
// (WORLD_CLASS_COLOR, surfaceOpacity, the lava sub-pass, etc.). This module
// is the PRESENTATION layer on top: it composes a richer, more specific
// player-facing label from the body's full parameter set, so two bodies
// that share a `worldClass` but differ physically read distinctly —
// "Verdant Ocean World" vs "Frozen Ocean Moon" are both `ocean`, "Hot
// Jupiter" vs "Gas Giant" are both `gas_giant`.
//
// The label is a small "mad lib": `[state] [material] [core-noun]`, capped
// at a 3-token budget so it stays a glanceable chip rather than a sentence.
//   - core-noun: the base type, refined from worldClass + a few physical
//     dials (a hot gas_giant is a "Hot Jupiter"; a large rocky is a
//     "Super-Earth"; a cool magma_ocean is a "Volcanic World"). Kind-aware
//     ("Lava Moon" vs "Lava World").
//   - state: the single most salient state, by descending salience — life,
//     then surface activity, greenhouse, temperature band, atmosphere
//     texture, ancient cratering. Each is SUPPRESSED when the core already
//     implies that axis (no "Frozen Ice World", no "Volcanic Lava World").
//   - material: a composition adjective ("Ferrous", "Sulfurous") folded in
//     only when the token budget has room (state takes precedence).
//
// Everything is derived from already-stored Body fields, so this is a pure
// runtime function — no catalog rebuild, no stored label. Thresholds are
// presentation choices (when does a world "read as" scorched / temperate /
// volcanic), intentionally coarser than the physics that produced the
// numbers; tune them here freely without touching the simulation.

import { type AtmGas, type Body } from '../../data/stars';

// Axes a core noun already conveys, so a state modifier on the same axis is
// redundant and gets skipped.
type Material = 'gas' | 'rock' | 'iron' | 'ice' | 'water' | 'methane';
interface Core {
  noun: string;
  hot?: boolean;       // core already reads as hot — skip hot temp adjectives
  cold?: boolean;      // core already reads as cold — skip cold temp adjectives
  volcanic?: boolean;  // core already reads as molten/active — skip "Volcanic"
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

// "Moon" for moons, "World" for planets — used by the kind-aware cores and
// the rocky/desert fallback.
function worldNoun(b: Body): string {
  return isMoon(b) ? 'Moon' : 'World';
}

// Surface free of water + ice — gates the silicate-volcanism modifier so a
// wet/icy body's activity reads as cryovolcanic (or nothing), not "Volcanic".
function isDrySurface(b: Body): boolean {
  return (b.waterFraction ?? 0) < 0.1 && (b.iceFraction ?? 0) < 0.3;
}

// Base type noun + the axes it already implies. Some classes refine into
// established, more evocative terms when a physical dial crosses a line.
function coreFor(b: Body): Core {
  const T = b.avgSurfaceTempK;
  const w = worldNoun(b);
  switch (b.worldClass) {
    case 'gas_giant':
      // "Hot Jupiter" is the established term for a close-in scorching
      // giant — far more evocative than "Scorched Gas Giant".
      if (T !== null && T >= 700) return { noun: 'Hot Jupiter', hot: true, material: 'gas' };
      return { noun: 'Gas Giant', material: 'gas' };
    case 'ice_giant':   return { noun: 'Ice Giant', cold: true, material: 'gas' };
    case 'gas_dwarf':   return { noun: 'Sub-Neptune', material: 'gas' };
    case 'helium':      return { noun: 'Helium Giant', material: 'gas' };
    case 'hycean':      return { noun: 'Hycean World', material: 'water' };
    case 'ocean':       return { noun: `Ocean ${w}`, material: 'water' };
    case 'ice':         return { noun: `Ice ${w}`, cold: true, material: 'ice' };
    case 'carbon':      return { noun: `Methane-Frost ${w}`, cold: true, material: 'methane' };
    case 'iron':        return { noun: `Iron ${w}`, material: 'iron' };
    case 'lava':        return { noun: `Lava ${w}`, hot: true, volcanic: true, material: 'rock' };
    case 'magma_ocean':
      // Only a genuinely hot one is an exposed magma ocean; a cooler
      // `magma_ocean`-classed body is a crusted, volcanically active world
      // (see the lava-render discussion — at 800 K the surface is mostly
      // solid crust with molten veins, not an open ocean of lava).
      if (T !== null && T >= 1100) return { noun: 'Magma Ocean', hot: true, volcanic: true, material: 'rock' };
      return { noun: `Volcanic ${w}`, volcanic: true, material: 'rock' };
    case 'chthonian':   return { noun: 'Chthonian Core', hot: true, material: 'iron' };
    case 'desert':      return { noun: `Desert ${w}`, material: 'rock' };
    case 'solid_giant': return { noun: 'Super-Earth', material: 'rock' };
    case 'rocky':       return { noun: `Rocky ${w}`, material: 'rock' };
    default:            return { noun: 'Uncharted World' };
  }
}

// The single most salient state adjective, in descending salience. Returns
// the first that fires; null when the body is unremarkable on every axis.
function stateModifier(b: Body, core: Core): string | null {
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  const gas = core.material === 'gas';

  // 1. Life — the headline trait. The dedicated "life" row elaborates
  //    archetype/complexity/impact; this is the at-a-glance flag.
  if (b.biosphereComplexity === 'complex' && (b.biosphereSurfaceImpact ?? 0) >= 0.5) return 'Verdant';
  if (b.biosphereComplexity === 'complex' || b.biosphereComplexity === 'microbial') return 'Living';

  // 2. Surface activity.
  //    Tidal heating on a moon shows up as a perpetually-refreshed surface
  //    (Io, Europa, Triton) — high surfaceAge is the tell.
  if (isMoon(b) && (b.surfaceAge ?? 0) >= 0.85) return 'Tidally-Heated';
  //    Cryovolcanism: a young icy/watery surface that isn't a moon (planets
  //    or moons the tidal branch missed).
  if ((core.material === 'ice' || core.material === 'methane' || core.material === 'water')
      && core.cold && (b.surfaceAge ?? 0) >= 0.7) return 'Cryovolcanic';
  //    Silicate volcanism on a hot, active, dry body the core didn't
  //    already mark molten.
  if (!core.volcanic && isDrySurface(b)
      && (b.tectonicActivity ?? 0) >= 0.55 && (b.surfaceAge ?? 0) >= 0.6
      && T !== null && T >= 400) return 'Volcanic';

  // 3. Runaway greenhouse — a thick, hot atmosphere over a dry surface
  //    (Venus). Distinct enough to outrank the generic temperature band.
  //    Skipped on cores already marked hot (a lava world's heat is its own,
  //    not a greenhouse — "Greenhouse Lava World" reads wrong).
  if (!core.hot && core.material === 'rock' && P !== null && P >= 5
      && T !== null && T >= 340 && (b.waterFraction ?? 0) < 0.05) return 'Greenhouse';

  // 4. Extreme heat outranks everything below — a 600 K+ surface is the
  //    dominant fact about the body. (Skipped if the core is already hot.)
  if (!core.hot && T !== null && T >= 600) return 'Scorched';

  // 5. Distinctive atmosphere texture — a thick organic smog (Titan) or a
  //    dust-choked sky is a stronger signature than the mild temperature
  //    bands below, so it outranks them (but not extreme heat above).
  if (b.hazeAerosols && (b.hazeAerosols['THOLIN'] ?? 0) >= 0.3) return 'Smog-Shrouded';
  if ((b.dustStrength ?? 0) >= 0.5) return 'Dust-Choked';

  // 6. Milder temperature bands — skipped on the axis the core already
  //    implies; cold adjectives skipped on gas cores (a 120 K Jupiter isn't
  //    "frozen", it's just a gas giant).
  if (T !== null) {
    if (!core.hot && T >= 330) return 'Torrid';
    // Temperate only reads as notable where there's surface liquid (or the
    // core is itself a water world) — an airless 290 K rock isn't "temperate".
    if (T >= 250 && T < 330 && ((b.waterFraction ?? 0) > 0 || core.material === 'water')) return 'Temperate';
    if (!core.cold && !gas && T < 90) return 'Frigid';
    if (!core.cold && !gas && T < 220) return 'Frozen';
  }

  // 7. Airless rocky body — notable absence of an atmosphere (Luna-class).
  if (core.material === 'rock' && (P === null || P < 0.001)) return 'Airless';

  // 8. Ancient, heavily-cratered surface (Mercury, Callisto, Luna). Skipped
  //    on molten/volcanic cores — a perpetually-refreshed surface (the same
  //    low surfaceAge a lava world reads at) isn't cratered, it's repaved.
  if (!core.hot && !core.volcanic && (b.surfaceAge ?? 1) <= 0.12) return 'Cratered';

  return null;
}

// A composition adjective adjacent to the noun, when distinctive and not
// already carried by the core's material.
function materialQualifier(b: Body, core: Core): string | null {
  // Iron-dominant rocky surface (not an iron/chthonian core, which already
  // says it). resMetals leads and is genuinely high.
  if (core.material !== 'iron'
      && (b.resMetals ?? 0) >= 6 && (b.resMetals ?? 0) >= (b.resSilicates ?? 0)) return 'Ferrous';
  // Sulfur-dominated surface or sulfur-cycle volcanism (Io-class).
  if (atmFrac(b, 'SO2') >= 0.3 || (b.bioticSulfur ?? 0) >= 0.3) return 'Sulfurous';
  return null;
}

function tokenCount(parts: readonly string[]): number {
  // Hyphenated compounds ("Tidally-Heated", "Methane-Frost") count as one.
  return parts.reduce((n, p) => n + p.split(' ').length, 0);
}

// Compose the full label: [state] [material] core-noun, within a 3-token
// budget (state wins over material when both can't fit).
export function composeWorldLabel(b: Body): string {
  const core = coreFor(b);
  if (b.worldClass === null) return core.noun;

  const state = stateModifier(b, core);
  const material = materialQualifier(b, core);

  // A bare "Rocky"/"Desert"-style prefix reads worse than letting an
  // adjective carry the character — "Greenhouse World", not "Greenhouse
  // Rocky World". Drop the generic "Rocky" prefix (only) when something
  // more specific is going in front of it.
  let noun = core.noun;
  if (b.worldClass === 'rocky' && (state || material)) noun = worldNoun(b);

  const parts: string[] = [];
  if (state) parts.push(state);
  if (material && tokenCount([...parts, material, noun]) <= 3) parts.push(material);
  parts.push(noun);
  return parts.join(' ');
}
