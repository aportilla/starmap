#!/usr/bin/env node
//
// Audit catalog.generated.json for exotic / iconic body archetypes.
//
// Companion to audit-procgen.mjs, but with a different framing:
//   - audit-procgen.mjs asks "do procgen rates match the priors?"
//     (calibration concern; cares about stat noise vs prior).
//   - audit-variety.mjs asks "how often does each iconic archetype
//     show up, and what's the rarest cool thing players will find?"
//     (game-feel concern; cares about whether the procgen surface area
//     is producing the recognizable SF tropes — ocean moons, ringed
//     habitables, hot Jupiters, Endor-class life-bearing moons of
//     gas giants, etc.)
//
// Read-only. Emits named exemplars per archetype so a designer can
// jump straight to a hover-card in the system view to inspect.
//
// Use: `node scripts/audit-variety.mjs` after `npm run build:catalog`.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insolation } from './lib/astrophysics.mjs';
import { classifyBody } from './lib/body-archetype.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');
const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const { stars, bodies, clusters } = cat;

const CURATED_HOSTS = new Set(['sol']);

// --- helpers -----------------------------------------------------------------

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

function pct(n, d, decimals = 2) {
  if (!d) return '   —   ';
  return (n / d * 100).toFixed(decimals).padStart(5 + decimals) + '%';
}

function insolationFor(body) {
  if (body.semiMajorAu == null) return null;
  const star = body.hostStarIdx != null ? stars[body.hostStarIdx] : null;
  // moons inherit host planet's insolation
  if (!star && body.hostBodyIdx != null) {
    const host = bodies[body.hostBodyIdx];
    if (host?.hostStarIdx != null) {
      const s = stars[host.hostStarIdx];
      if (s?.mass != null && host.semiMajorAu != null) return insolation(s.mass, host.semiMajorAu);
    }
    return null;
  }
  if (!star || star.mass == null) return null;
  return insolation(star.mass, body.semiMajorAu);
}

// classifyBody's archetype enum is richer than the old worldClass set, so a
// gate that meant "any gaseous envelope world" maps onto several archetypes.
// Old {gas_giant, ice_giant, gas_dwarf, hycean, helium} → these (gas_giant
// splits into gas_giant/hot_jupiter; gas_dwarf became sub_neptune).
const GASEOUS_ARCHETYPES = new Set([
  'gas_giant', 'hot_jupiter', 'ice_giant', 'sub_neptune', 'hycean', 'helium',
]);
// Hosts a moon system can hang off: the old {gas_giant, ice_giant, gas_dwarf,
// solid_giant} → gaseous giants plus super_earth (the old solid_giant).
const GIANT_HOST_ARCHETYPES = new Set([
  'gas_giant', 'hot_jupiter', 'ice_giant', 'sub_neptune', 'super_earth',
]);

function arch(b) {
  return classifyBody(b);
}

function hostStarOf(body) {
  if (body.hostStarIdx != null) return stars[body.hostStarIdx];
  if (body.hostBodyIdx != null) {
    const host = bodies[body.hostBodyIdx];
    if (host?.hostStarIdx != null) return stars[host.hostStarIdx];
  }
  return null;
}

function hostPlanetOf(moon) {
  if (moon.kind !== 'moon' || moon.hostBodyIdx == null) return null;
  return bodies[moon.hostBodyIdx];
}

function isCurated(body) {
  if (body.source !== 'procgen') return true;
  if (CURATED_HOSTS.has(body.hostId)) return true;
  const star = hostStarOf(body);
  if (star && CURATED_HOSTS.has(star.id)) return true;
  return false;
}

// Show one or three example body IDs as a compact tail.
function examples(arr, n = 3) {
  if (!arr.length) return '—';
  const picks = arr.slice(0, n).map(b => b.id || b.formalName || '?');
  return picks.join(', ') + (arr.length > n ? ` (+${arr.length - n} more)` : '');
}

// `arr` is an array of bodies; takes the first `n` with the deepest
// signal in `key(b)` (largest by default) so the surfaced examples
// favor the iconic cases (biggest, hottest, etc.).
function topExamples(arr, key, n = 3) {
  return examples([...arr].sort((a, b) => (key(b) ?? 0) - (key(a) ?? 0)), n);
}

function header(title) {
  console.log();
  console.log('=== ' + title + ' ===');
}

// Render an archetype row: label | count | rate (vs denominator) | examples
function row(label, matches, denominator, exampleStr) {
  const n = matches.length;
  const rate = denominator ? pct(n, denominator) : '       ';
  console.log(
    '  ' + pad(label, 40) +
    ' | ' + pad(n, 5, true) +
    ' | ' + rate +
    '   ' + exampleStr,
  );
}

// --- 0. Quick overview ------------------------------------------------------

const planets = bodies.filter(b => b.kind === 'planet');
const moons   = bodies.filter(b => b.kind === 'moon');
const belts   = bodies.filter(b => b.kind === 'belt');
const rings   = bodies.filter(b => b.kind === 'ring');
const procgenPlanets = planets.filter(b => !isCurated(b));
const procgenMoons   = moons.filter(b => !isCurated(b));
const allTerrestrialish = [...procgenPlanets, ...procgenMoons]
  .filter(b => !GASEOUS_ARCHETYPES.has(arch(b)));

console.log('VARIETY AUDIT — what cool things is procgen surfacing?');
console.log('catalog: ' + CATALOG_PATH);
console.log();
console.log('  stars:   ' + stars.length);
console.log('  planets: ' + planets.length + '  (procgen ' + procgenPlanets.length + ')');
console.log('  moons:   ' + moons.length   + '  (procgen ' + procgenMoons.length + ')');
console.log('  belts:   ' + belts.length);
console.log('  rings:   ' + rings.length);

// ============================================================================
// 1. Iconic body archetypes — the SF tropes a player should see often enough.
// ============================================================================

header('Iconic body archetypes');
console.log('  archetype                                | count | rate    examples');
console.log('  -----------------------------------------+-------+-------  --------');

// --- Habitability layer ---

// Carbon-aqueous habitable (Earth-class). Loose definition: terrestrial
// bracket + 250K < T < 320K + P >= 0.1 bar. The classifier produces
// 'ocean'/'gaian' archetypes even when T runs hot with a steam atmosphere,
// so we don't trust the archetype alone; gate on T+P.
const habitableEarthish = procgenPlanets.filter(b => {
  if (GASEOUS_ARCHETYPES.has(arch(b))) return false;
  if (b.radiusEarth == null || b.radiusEarth > 2) return false;
  const T = b.avgSurfaceTempK;
  const P = b.surfacePressureBar;
  return T != null && T > 250 && T < 320 && P != null && P >= 0.1 && P < 50
      && (b.waterFraction ?? 0) > 0.1;
});
row('Earth-like habitables (T 250-320K, P 0.1-50bar)', habitableEarthish,
    procgenPlanets.length, topExamples(habitableEarthish, b => b.massEarth));

// Hycean — its own archetype.
const hyceans = procgenPlanets.filter(b => arch(b) === 'hycean');
row('Hycean worlds (H2 atm, water-rich)', hyceans,
    procgenPlanets.length, topExamples(hyceans, b => b.massEarth));

// Gaian — living temperate water ocean (Earth). A first-class archetype
// promoted out of the old 'ocean' worldClass by complex biosphere + temp band.
const gaians = procgenPlanets.filter(b => arch(b) === 'gaian');
row('Gaian worlds (living temperate ocean)', gaians,
    procgenPlanets.length, topExamples(gaians, b => b.massEarth));

// Surface ocean (the 'ocean' archetype — a full water ocean that isn't living
// or temperate enough to read Gaian. Temperature is loose; many lean hot).
const oceanClass = procgenPlanets.filter(b => arch(b) === 'ocean');
const oceanTemperate = oceanClass.filter(b => (b.avgSurfaceTempK ?? 0) < 330);
row('Ocean worlds (any T)', oceanClass,
    procgenPlanets.length, topExamples(oceanClass, b => b.massEarth));
row('  └── temperate (T < 330K)', oceanTemperate,
    procgenPlanets.length, topExamples(oceanTemperate, b => b.massEarth));

// Exotic-solvent seas — iconic archetypes promoted out of the base classes
// by their surface-liquid species. Each is a recognizable SF/solar-system
// trope the player can hunt for.
const ammoniaSeas = procgenPlanets.filter(b => arch(b) === 'ammonia_sea');
row('Ammonia-sea worlds', ammoniaSeas,
    procgenPlanets.length, topExamples(ammoniaSeas, b => b.massEarth));
const glacialSeas = procgenPlanets.filter(b => arch(b) === 'glacial_sea');
row('Glacial-sea worlds (liquid N2, Triton-warm)', glacialSeas,
    procgenPlanets.length, topExamples(glacialSeas, b => b.massEarth));
const subglacial = [...procgenPlanets, ...procgenMoons].filter(b => arch(b) === 'subglacial_ocean');
row('Subglacial-ocean worlds (Europa, frozen surface)', subglacial,
    procgenPlanets.length + procgenMoons.length, topExamples(subglacial, b => b.bulkWaterFraction));

// Ocean moons of gas giants (Europa-class — subsurface + ice shell).
// Use bulkWater (≥0.3) + cold T (<200K) + ice cover OR moon-of-giant
// heuristic.
const oceanMoonsEuropa = procgenMoons.filter(m => {
  const host = hostPlanetOf(m);
  if (!host) return false;
  const isHostGiant = GIANT_HOST_ARCHETYPES.has(arch(host));
  return isHostGiant
      && (m.bulkWaterFraction ?? 0) >= 0.2
      && (m.avgSurfaceTempK ?? 999) < 200
      && (m.iceFraction ?? 0) > 0.3;
});
row('Europa-class ice-shell ocean moons', oceanMoonsEuropa,
    procgenMoons.length, topExamples(oceanMoonsEuropa, m => m.bulkWaterFraction));

// Habitable moons of gas giants — three colonizable flavors:
//   - Pandora: warm + surface ocean.   T 273-340, water > 0.1, P ≥ 0.05.
//   - Hoth:    cold + bulk water + atm. T 220-273, bulkW > 0.005, P ≥ 0.05.
//              Frozen surface; subsurface liquid likely; atm enables
//              domed colonies and life-bearing geology.
//   - Pandora-cryo (Europa-with-atm): substantial atm + thriving
//              subsurface biosphere. P ≥ 0.5 bar (half-Earth+, real
//              colony-grade), bioticSubsurfaceAqueous ≥ 0.7 (complex
//              or gaian tier, not just trace life). Any T — these are
//              typically deep-cold moons of cold-zone giants whose CPD
//              delivered enough water for sustained subsurface life.
//              Tighter than "any subsurface life signal" so the
//              archetype reads as iconic-discoverable (~25/galaxy)
//              rather than dominant.
// All three are colonizable per Heller-Pudritz exomoon-habitability
// criteria; only the strict Earth-twin definition excludes the latter two.
const habitableMoonsOfGiants = procgenMoons.filter(m => {
  const host = hostPlanetOf(m);
  if (!host) return false;
  if (!GIANT_HOST_ARCHETYPES.has(arch(host))) return false;
  if (m.radiusEarth == null || m.radiusEarth < 0.3) return false;
  const P = m.surfacePressureBar;
  if (P == null || P < 0.05) return false;
  const T = m.avgSurfaceTempK;
  const water = m.waterFraction ?? 0;
  const bulkW = m.bulkWaterFraction ?? 0;
  const subAq = m.bioticSubsurfaceAqueous ?? 0;
  // Pandora — warm + surface ocean
  if (T != null && T >= 273 && T < 340 && water > 0.1) return true;
  // Hoth — cold + bulk water reservoir
  if (T != null && T >= 220 && T < 273 && bulkW > 0.005) return true;
  // Pandora-cryo — substantial atm + thriving subsurface biosphere
  if (P >= 0.5 && subAq >= 0.7) return true;
  return false;
});
row('Habitable moons of giants (Endor-class)', habitableMoonsOfGiants,
    procgenMoons.length, topExamples(habitableMoonsOfGiants, m => m.massEarth));

// --- Surface character ---

// Super-Earth — m≥3 M⊕, terrestrial bracket.
const superEarths = procgenPlanets.filter(b =>
  (b.massEarth ?? 0) >= 3 && (b.radiusEarth ?? 0) < 3 &&
  !GASEOUS_ARCHETYPES.has(arch(b)));
row('Super-Earths (m≥3 M⊕, R<3 R⊕)', superEarths,
    procgenPlanets.length, topExamples(superEarths, b => b.massEarth));

// Mega-Earth — m≥5 and a rocky/ocean-ish solid archetype (Kepler-10c-class).
// Old worldClass {rocky, ocean, desert, iron, solid_giant} expands across the
// iconic ocean promotions (gaian/ammonia_sea/glacial_sea) + super_earth.
const MEGA_EARTH_ARCHETYPES = new Set([
  'rocky', 'ocean', 'gaian', 'ammonia_sea', 'glacial_sea', 'desert', 'iron', 'super_earth',
]);
const megaEarths = procgenPlanets.filter(b =>
  (b.massEarth ?? 0) >= 5 && MEGA_EARTH_ARCHETYPES.has(arch(b)));
row('Mega-Earths (m≥5, rocky/ocean class)', megaEarths,
    procgenPlanets.length, topExamples(megaEarths, b => b.massEarth));

// Iron / Mercury-class.
const ironWorlds = procgenPlanets.filter(b => arch(b) === 'iron');
row('Iron worlds (Mercury-class)', ironWorlds,
    procgenPlanets.length, topExamples(ironWorlds, b => b.massEarth));

// Lava / molten surface.
const lavaWorlds = procgenPlanets.filter(b => arch(b) === 'lava');
row('Lava worlds (surface > 1000K)', lavaWorlds,
    procgenPlanets.length, topExamples(lavaWorlds, b => b.avgSurfaceTempK));

// Magma ocean — partial melt. Old magma_ocean worldClass split into the
// exposed-melt 'magma_ocean' + crusted 'volcanic' archetypes.
const magmaWorlds = procgenPlanets.filter(b => arch(b) === 'magma_ocean');
row('Magma-ocean worlds (exposed melt)', magmaWorlds,
    procgenPlanets.length, topExamples(magmaWorlds, b => b.avgSurfaceTempK));
const volcanicWorlds = procgenPlanets.filter(b => arch(b) === 'volcanic');
row('Volcanic worlds (crusted, active)', volcanicWorlds,
    procgenPlanets.length, topExamples(volcanicWorlds, b => b.avgSurfaceTempK));

// Brimstone — molten-sulfur seas (Io-class). A first-class archetype now,
// promoted out of the old desert/magma_ocean buckets by sulfur surface liquid.
const brimstone = procgenPlanets.filter(b => arch(b) === 'brimstone');
row('Brimstone worlds (molten-sulfur seas, Io-class)', brimstone,
    procgenPlanets.length, topExamples(brimstone, b => b.avgSurfaceTempK));

// Chthonian — stripped giant core, now its own archetype.
const chthonian = procgenPlanets.filter(b => arch(b) === 'chthonian');
row('Chthonian worlds (stripped giant core)', chthonian,
    procgenPlanets.length, topExamples(chthonian, b => b.massEarth));

// Tholin — hydrocarbon lakes / thick organic smog (Titan). A first-class
// archetype promoted by hydrocarbon surface liquid or thick THOLIN haze.
const tholin = [...procgenPlanets, ...procgenMoons].filter(b => arch(b) === 'tholin');
row('Tholin worlds (hydrocarbon lakes, Titan-class)', tholin,
    procgenPlanets.length + procgenMoons.length, topExamples(tholin, b => b.surfacePressureBar));

// Frostbound — volatile-ice-dominated (Pluto/Triton/Eris). The old 'carbon'
// worldClass survives under this flavour name.
const frostbound = procgenPlanets.filter(b => arch(b) === 'frostbound');
row('Frostbound worlds (Pluto/Triton-class)', frostbound,
    procgenPlanets.length, topExamples(frostbound, b => b.massEarth));

// Glacial — globally frozen water-ice (Callisto-class). Old 'ice' worldClass
// maps to {glacial, subglacial_ocean}; subglacial is reported above.
const glacialWorlds = procgenPlanets.filter(b => arch(b) === 'glacial');
row('Glacial worlds (Callisto-class water ice)', glacialWorlds,
    procgenPlanets.length, topExamples(glacialWorlds, b => b.massEarth));

// Helium-dominant (post-stripped sub-Neptune).
const heliumWorlds = procgenPlanets.filter(b => arch(b) === 'helium' || (b.atm1 === 'He' && (b.atm1Frac ?? 0) > 0.5));
row('Helium-dominant atmospheres', heliumWorlds,
    procgenPlanets.length, topExamples(heliumWorlds, b => b.massEarth));

// --- Gas-giant subtypes ---
//
// "gas giant" here means the Jupiter-radius bracket regardless of temperature,
// so it spans both the gas_giant and hot_jupiter archetypes (the classifier
// promotes T≥700K gas giants to hot_jupiter). The S-band split below is the
// independent insolation cut the report cares about.
const GAS_GIANT_ARCHETYPES = new Set(['gas_giant', 'hot_jupiter']);

// Hot Jupiter — gas giant + S > 100.
const hotJupiters = procgenPlanets.filter(b => {
  if (!GAS_GIANT_ARCHETYPES.has(arch(b))) return false;
  const S = insolationFor(b);
  return S != null && S >= 100;
});
row('Hot Jupiters (gas giant, S ≥ 100)', hotJupiters,
    procgenPlanets.length, topExamples(hotJupiters, b => b.massEarth));

// Warm Jupiter — gas giant + 10 < S < 100.
const warmJupiters = procgenPlanets.filter(b => {
  if (!GAS_GIANT_ARCHETYPES.has(arch(b))) return false;
  const S = insolationFor(b);
  return S != null && S >= 1 && S < 100;
});
row('Warm Jupiters (S 1-100)', warmJupiters,
    procgenPlanets.length, topExamples(warmJupiters, b => b.massEarth));

// Cold Jupiter — Sol-Jupiter analog.
const coldJupiters = procgenPlanets.filter(b => {
  if (!GAS_GIANT_ARCHETYPES.has(arch(b))) return false;
  const S = insolationFor(b);
  return S != null && S < 0.1;
});
row('Cold Jupiters (gas giant, S < 0.1)', coldJupiters,
    procgenPlanets.length, topExamples(coldJupiters, b => b.massEarth));

// Ice giants — Uranus/Neptune analogs.
const iceGiants = procgenPlanets.filter(b => arch(b) === 'ice_giant');
row('Ice giants (Uranus/Neptune-class)', iceGiants,
    procgenPlanets.length, topExamples(iceGiants, b => b.massEarth));

// ============================================================================
// 2. Ringed bodies — the "gas giant" of visual flair
// ============================================================================

header('Rings');
console.log('  context                                  | count | rate    examples');
console.log('  -----------------------------------------+-------+-------  --------');

// Ringed gas giants.
const ringedHostPlanets = rings.filter(r => !isCurated(r))
  .map(r => bodies[r.hostBodyIdx])
  .filter(Boolean);
const ringedGasGiants = ringedHostPlanets.filter(p => GAS_GIANT_ARCHETYPES.has(arch(p)));
row('Ringed gas giants', ringedGasGiants,
    procgenPlanets.filter(b => GAS_GIANT_ARCHETYPES.has(arch(b))).length,
    topExamples(ringedGasGiants, p => p.radiusEarth));

// Ringed ice giants.
const ringedIceGiants = ringedHostPlanets.filter(p => arch(p) === 'ice_giant');
row('Ringed ice giants', ringedIceGiants,
    procgenPlanets.filter(b => arch(b) === 'ice_giant').length,
    topExamples(ringedIceGiants, p => p.radiusEarth));

// Ringed terrestrials.
const ringedTerrestrials = ringedHostPlanets.filter(p =>
  !GASEOUS_ARCHETYPES.has(arch(p)));
row('Ringed terrestrials (any class)', ringedTerrestrials,
    procgenPlanets.length, topExamples(ringedTerrestrials, p => p.radiusEarth));

// Ringed HABITABLE worlds — the iconic SF beat.
const ringedHabitables = ringedHostPlanets.filter(p => {
  if (GASEOUS_ARCHETYPES.has(arch(p))) return false;
  if ((p.radiusEarth ?? 0) > 2) return false;
  const T = p.avgSurfaceTempK, P = p.surfacePressureBar;
  return T != null && T > 250 && T < 320 && P != null && P >= 0.1 && P < 50
      && (p.waterFraction ?? 0) > 0.1;
});
row('Ringed habitable worlds (SF trope)', ringedHabitables,
    procgenPlanets.length, topExamples(ringedHabitables, p => p.massEarth));

// Ringed super-Earths.
const ringedSuperEarths = ringedHostPlanets.filter(p => (p.massEarth ?? 0) >= 3 && (p.radiusEarth ?? 0) < 3);
row('Ringed super-Earths (m≥3)', ringedSuperEarths,
    procgenPlanets.length, topExamples(ringedSuperEarths, p => p.massEarth));

// ============================================================================
// 3. Moons — moon-system architecture
// ============================================================================

header('Moon systems');

// Big moons (R ≥ 0.3 — Mars-class+).
const bigMoons = procgenMoons.filter(m => (m.radiusEarth ?? 0) >= 0.3);
row('Big moons (R ≥ 0.3 — Mars-class+)', bigMoons,
    procgenMoons.length, topExamples(bigMoons, m => m.radiusEarth));

// Planet-class moons (R ≥ 0.5 — Mercury-class+).
const planetClassMoons = procgenMoons.filter(m => (m.radiusEarth ?? 0) >= 0.5);
row('Planet-class moons (R ≥ 0.5)', planetClassMoons,
    procgenMoons.length, topExamples(planetClassMoons, m => m.radiusEarth));

// Moons with thick atmospheres (P ≥ 0.5 bar — Titan-class).
const thickAtmMoons = procgenMoons.filter(m => (m.surfacePressureBar ?? 0) >= 0.5);
row('Moons with thick atms (P ≥ 0.5 bar)', thickAtmMoons,
    procgenMoons.length, topExamples(thickAtmMoons, m => m.surfacePressureBar));

// Hot tidally-heated moons (T > 250K + e > 0.005 + host is giant) — Io-class.
const tidalHotMoons = procgenMoons.filter(m => {
  const host = hostPlanetOf(m);
  if (!host) return false;
  const ha = arch(host);
  if (!GAS_GIANT_ARCHETYPES.has(ha) && ha !== 'ice_giant') return false;
  return (m.eccentricity ?? 0) > 0.01 && (m.avgSurfaceTempK ?? 0) > 200
      && (m.tectonicActivity ?? 0) > 0.5;
});
row('Tidally-active moons (Io-class)', tidalHotMoons,
    procgenMoons.length, topExamples(tidalHotMoons, m => m.tectonicActivity));

// ============================================================================
// 4. Orbital extremes — eccentric, tilted, etc.
// ============================================================================

header('Orbital character');

// Eccentric (e > 0.4).
const eccentric = procgenPlanets.filter(b => (b.eccentricity ?? 0) > 0.4);
row('Eccentric planets (e > 0.4)', eccentric,
    procgenPlanets.length, topExamples(eccentric, b => b.eccentricity));

// Extreme axial tilt (Uranus-class).
const extremeTilt = procgenPlanets.filter(b => (b.axialTiltDeg ?? 0) > 60);
row('Extreme axial tilt (>60°, Uranus-class)', extremeTilt,
    procgenPlanets.length, topExamples(extremeTilt, b => b.axialTiltDeg));

// Retrograde (>90°).
const retrograde = procgenPlanets.filter(b => (b.axialTiltDeg ?? 0) > 90);
row('  └── retrograde (>90°)', retrograde,
    procgenPlanets.length, topExamples(retrograde, b => b.axialTiltDeg));

// Very-cold-orbit gas giant (extreme cold).
const deepColdGiants = procgenPlanets.filter(b => {
  const a = arch(b);
  if (!GAS_GIANT_ARCHETYPES.has(a) && a !== 'ice_giant') return false;
  const S = insolationFor(b);
  return S != null && S < 0.001;
});
row('Deep-cold giants (S < 0.001)', deepColdGiants,
    procgenPlanets.length, topExamples(deepColdGiants, b => -insolationFor(b)));

// ============================================================================
// 5. Biosphere — but only if anything is actually getting life
// ============================================================================

header('Biosphere');
const FIELDS = {
  carbon_aqueous:     'bioticCarbonAqueous',
  subsurface_aqueous: 'bioticSubsurfaceAqueous',
  aerial:             'bioticAerial',
  cryogenic:          'bioticCryogenic',
  silicate:           'bioticSilicate',
  sulfur:             'bioticSulfur',
};
const bioBodies = [...procgenPlanets, ...procgenMoons];
console.log('  archetype           |  n>0       n>0.3   n>0.5     median.>0      examples (highest)');
console.log('  --------------------+--------------------------     ---------     ------');
for (const [archetype, field] of Object.entries(FIELDS)) {
  const positive = bioBodies.filter(b => (b[field] ?? 0) > 0);
  const above3   = bioBodies.filter(b => (b[field] ?? 0) > 0.3);
  const above5   = bioBodies.filter(b => (b[field] ?? 0) > 0.5);
  const sorted   = positive.sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0));
  const median   = positive.length ? positive[positive.length >> 1][field].toFixed(3) : '—';
  console.log(
    '  ' + pad(archetype, 19) +
    ' | ' + pad(positive.length, 5, true) +
    '    ' + pad(above3.length, 4, true) +
    '    ' + pad(above5.length, 4, true) +
    '       ' + pad(median, 6, true) +
    '       ' + topExamples(sorted, b => b[field] ?? 0, 3),
  );
}

// Multi-archetype life (e.g. Titan = subsurface + cryogenic).
const multiArch = bioBodies.filter(b => {
  let n = 0;
  for (const f of Object.values(FIELDS)) if ((b[f] ?? 0) > 0.3) n++;
  return n >= 2;
});
console.log('  multi-archetype (≥2 fields > 0.3): ' + multiArch.length +
            (multiArch.length ? '   examples: ' + topExamples(multiArch, b => b.bioticCarbonAqueous ?? 0) : ''));

// ============================================================================
// 6. System / cluster archetypes — what kinds of SYSTEMS exist
// ============================================================================

header('System archetypes (per cluster)');

// For each cluster, compute: total planets, has gas giant, has habitable
// (Earth-like), has hot Jupiter, has ice giant, has belts.
const clusterStats = clusters.map(cl => {
  const memberIdxs = cl.members;
  const memberStars = memberIdxs.map(i => stars[i]);
  const memberPlanetIdxs = memberStars.flatMap(s => s.planets);
  const memberBeltIdxs   = memberStars.flatMap(s => s.belts);
  const planets = memberPlanetIdxs.map(i => bodies[i]);
  const planetMoons = planets.flatMap(p => (p.moons || []).map(i => bodies[i]));
  const belts = memberBeltIdxs.map(i => bodies[i]);
  return {
    cluster: cl,
    primary: memberStars[0],
    planetCount: planets.length,
    moonCount: planetMoons.length,
    beltCount: belts.length,
    hasGasGiant: planets.some(p => GAS_GIANT_ARCHETYPES.has(arch(p))),
    hasIceGiant: planets.some(p => arch(p) === 'ice_giant'),
    hasHotJupiter: planets.some(p => {
      if (!GAS_GIANT_ARCHETYPES.has(arch(p))) return false;
      const S = insolationFor(p); return S != null && S >= 100;
    }),
    hasHabitable: planets.some(p => {
      if (GASEOUS_ARCHETYPES.has(arch(p))) return false;
      if ((p.radiusEarth ?? 0) > 2) return false;
      const T = p.avgSurfaceTempK, P = p.surfacePressureBar;
      return T != null && T > 250 && T < 320 && P != null && P >= 0.1 && P < 50
          && (p.waterFraction ?? 0) > 0.1;
    }),
    hasHabitableMoon: planetMoons.some(m => {
      const host = bodies[m.hostBodyIdx];
      if (!host || !GIANT_HOST_ARCHETYPES.has(arch(host))) return false;
      if ((m.radiusEarth ?? 0) < 0.3) return false;
      const P = m.surfacePressureBar;
      if (P == null || P < 0.05) return false;
      const T = m.avgSurfaceTempK;
      const water = m.waterFraction ?? 0;
      const bulkW = m.bulkWaterFraction ?? 0;
      const subAq = m.bioticSubsurfaceAqueous ?? 0;
      if (T != null && T >= 273 && T < 340 && water > 0.1) return true;
      if (T != null && T >= 220 && T < 273 && bulkW > 0.005) return true;
      if (P >= 0.5 && subAq >= 0.7) return true;
      return false;
    }),
    hasMultipleHab: (() => {
      let n = 0;
      for (const p of planets) {
        const T = p.avgSurfaceTempK, P = p.surfacePressureBar;
        if (T != null && T > 250 && T < 320 && P != null && P >= 0.1 && P < 50
            && (p.waterFraction ?? 0) > 0.1 && (p.radiusEarth ?? 0) <= 2) n++;
      }
      return n >= 2;
    })(),
    hasMultiBelt: belts.length >= 2,
    barren: planets.length === 0,
  };
});

const totalClusters = clusterStats.length;
console.log('  archetype                                | count | rate    primary examples (id)');
console.log('  -----------------------------------------+-------+-------  --------');

function clusterRow(label, filter, key = (c) => c.planetCount) {
  const matches = clusterStats.filter(filter);
  const exs = [...matches].sort((a, b) => (key(b) ?? 0) - (key(a) ?? 0))
    .slice(0, 3).map(c => c.primary?.id || '?').join(', ');
  console.log(
    '  ' + pad(label, 40) +
    ' | ' + pad(matches.length, 5, true) +
    ' | ' + pct(matches.length, totalClusters) +
    '   ' + exs,
  );
}

clusterRow('Sol analog (gas giant + habitable + belt)',
  c => c.hasGasGiant && c.hasHabitable && c.beltCount > 0);
clusterRow('Has any habitable world',           c => c.hasHabitable || c.hasHabitableMoon);
clusterRow('Has habitable moon of giant',       c => c.hasHabitableMoon);
clusterRow('Has multiple habitable worlds',     c => c.hasMultipleHab);
clusterRow('Has hot Jupiter',                   c => c.hasHotJupiter);
clusterRow('Has any gas giant',                 c => c.hasGasGiant);
clusterRow('Has only terrestrial planets',      c => c.planetCount > 0 && !c.hasGasGiant && !c.hasIceGiant);
clusterRow('Has 2+ belts',                      c => c.hasMultiBelt);
clusterRow('Barren (no planets)',               c => c.barren);
clusterRow('Rich systems (≥6 planets)',         c => c.planetCount >= 6);

// ============================================================================
// 7. Tuning flags — auto-derive a short punch list
// ============================================================================

header('Tuning flags');
const flags = [];

// Habitable rate (any cluster with a habitable target).
const habClusters = clusterStats.filter(c => c.hasHabitable || c.hasHabitableMoon).length;
if (habClusters / totalClusters < 0.15) {
  flags.push(`Habitable worlds are sparse — only ${habClusters}/${totalClusters} ` +
             `(${(habClusters/totalClusters*100).toFixed(1)}%) clusters carry one.\n      ` +
             `Tune: ATMOSPHERE_REGIME_THRESHOLDS.wetBulkWaterMin, BULK_WATER_FRACTION_BY_ZONE.inside_H2O.mean, GREENHOUSE potency to relax temperate gates.`);
}

// Ringed habitable rate.
if (ringedHabitables.length < 5) {
  flags.push(`Ringed habitable worlds: ${ringedHabitables.length}. The iconic SF beat barely fires.\n      ` +
             `Tune: bump RING_DISRUPTION_RATE — currently P ∝ R² so super-Earths sit at ~0.2-0.9% ring rate.`);
}

// Endor-class.
if (habitableMoonsOfGiants.length < 5) {
  flags.push(`Habitable moons of gas giants (Endor-class): ${habitableMoonsOfGiants.length}.\n      ` +
             `Tune: MOON_MASS_LOG_EARTH upper tail + atm-retention shielding from host magnetosphere (currently uncoupled).`);
}

// Bio-archetype coverage.
let zeroArchs = 0;
for (const [, f] of Object.entries(FIELDS)) {
  if (bioBodies.filter(b => (b[f] ?? 0) > 0).length === 0) zeroArchs++;
}
if (zeroArchs === 6) {
  flags.push(`No procgen body in the galaxy has ANY biotic productivity > 0.\n      ` +
             `Tune: every productivity formula in procgen.mjs (productivityPreAtm / productivityPostAtm) — likely a gate is multiplying by 0.`);
} else if (zeroArchs > 0) {
  flags.push(`${zeroArchs}/6 biotic archetypes never fire — at least one productivity gate is broken.`);
}

// Archetype concentration — flag if any single archetype dominates >40%.
// The richer enum spreads bodies across more buckets, so a single archetype
// clearing 40% is a sharper "the classifier is collapsing" signal than the
// old worldClass concentration was.
const classCount = {};
for (const b of [...procgenPlanets, ...procgenMoons]) {
  const a = arch(b);
  classCount[a] = (classCount[a] || 0) + 1;
}
const totalClassed = Object.values(classCount).reduce((a, b) => a + b, 0);
const dominant = Object.entries(classCount).sort((a, b) => b[1] - a[1])[0];
if (dominant && dominant[1] / totalClassed > 0.40) {
  flags.push(`archetype distribution skewed — "${dominant[0]}" is ${(dominant[1]/totalClassed*100).toFixed(1)}% of all classed bodies.\n      ` +
             `Cold-trap gate is firing too eagerly; check ICE_TEMP_GLOBAL_K / iceFraction gates and ARCHETYPE_THRESHOLDS.iceIceMin.`);
}

// Super-Earth + ring overlap.
if (ringedSuperEarths.length < 3) {
  flags.push(`Ringed super-Earths: ${ringedSuperEarths.length}. The "settle here, look at the sky" beat is on a thin thread.`);
}

if (!flags.length) {
  console.log('  No automated flags fired.');
} else {
  for (let i = 0; i < flags.length; i++) {
    console.log(`  ${i+1}. ${flags[i]}`);
  }
}

console.log();
