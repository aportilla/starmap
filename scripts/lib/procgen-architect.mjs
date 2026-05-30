// System Architect — top-down sampling of planetary systems. Two entry
// points: generateSystem(star) for stars with zero catalog planets, and
// generateOverlay(star, catalogPlanets) for catalog-anchored stars that
// need outer-only siblings filled in. Both emit body records with
// anchors set (semiMajorAu, formationAu, mass, radius, bulk composition,
// orbital flavor) and the rest left in _unknowns for the Filler
// (procgen.mjs) to derive.
//
// Determinism via per-(star, slot, field) seeds; PROCGEN_VERSION mixed
// in so bumping it reseeds the whole galaxy without changing CSV ids.
//
// ─── Per-planet mass chain (buildPlanetCore) ────────────────────────
//
// No type-keyed mass tables — mass falls out of disk physics:
//
//   Σ(a) = MMSN_NORMALIZATION × M_star × a^(-1.5)  with per-frost-line
//          jumps from SNOW_LINE_BOOSTS at H2O / NH3 / CH4 lines
//   M_iso(a) = (8π a² Σ)^1.5 / √(3 M_star)              isolation mass
//   core mass = M_iso × ACCRETION_EFFICIENCY[zone]      inner: heavy-
//                                                      tailed mergers;
//                                                      outer: modest
//   if   core ≥ CRITICAL_CORE_MASS_EARTH
//   AND  formation past H2O frost line
//   AND  DISK_GAS_LIFETIME_MYR > TIME_TO_RUNAWAY_MYR
//     envelope = core × ENVELOPE_FRACTION             runaway gas accretion
//   else envelope = 0
//   total mass = core + envelope
//   radius = Otegi(total) × exp(N(0, RADIUS_SCATTER_LOG))
//
// Mass and radius stay physically coupled — no impossible-density bodies
// from independent draws.
//
// ─── System architecture ────────────────────────────────────────────
//
// Planet count: PLANET_COUNT_BY_CLASS truncated normal, with cluster
// clamps (COMPANION_PLANET_SUPPRESSION for binary-stability,
// MAX_PLANETS_PER_CLUSTER for gameplay legibility). Orbits walk outward
// through log-normal period-ratio spacing from ORBITAL_GEOMETRY_BY_CLASS.
// Bulk composition (water / metal / volatile) from the four-zone
// formation gate (zoneForFormationAu split by H2O / NH3 / CH4 frost
// lines) so outer-zone bodies carry their water-rich budget through
// any later migration.
//
// ─── Type-II migration (migratePass) ────────────────────────────────
//
// Per-system roll at MIGRATION_RATE on the innermost gas giant with
// formation past the H2O line. Landing fraction draws from a bistable
// mixture MIGRATION_FRACTION:
//   primary mode   — hot-Jupiter end-state (small fraction of formationAu)
//   secondary mode — stalled warm-Jupiter (larger fraction)
// Sweep filter removes companions between (semiMajorAu, formationAu)
// — bodies that were in the migrator's path get cleared, bodies inside
// the final orbit or outside the formation orbit survive. So a stalled
// warm-Jupiter doesn't strip inner HZ rockies the way a full hot-Jupiter
// sweep does.
//
// ─── Moons (generateMoons) ──────────────────────────────────────────
//
// Count ~ Binomial(MOON_COUNT_MAX, p) with
//   p = min(MOON_PROBABILITY_CAP, hill_au × MOON_PROBABILITY_PER_HILL)
// Binomial is naturally bounded at MOON_COUNT_MAX with a smooth 0..MAX
// shape — no Poisson-clip pile-up at the cap. Migration-strip emerges
// from physics: a hot Jupiter's shrunk Hill sphere maps to p ≈ 0 and
// binomial rolls 0 moons. Mass from MOON_MASS_LOG_EARTH (median
// Ganymede-class, right tail to super-Earth) clipped to
// host × MOON_MAX_HOST_MASS_RATIO for orbital stability.
// bulkWaterFraction carries a MOON_CPD_WATER_FLOOR baseline modeling
// circumplanetary-disk pebble-drift water delivery — moons of in-situ
// HZ giants can still be water-rich even when their host's local
// formation zone is dry.
//
// ─── Rings (generateRing) ───────────────────────────────────────────
//
// 0-or-1 per planet with probability R² × RING_DISRUPTION_RATE — the
// Roche-disruption cross-section. Concentrates rings on gas giants
// (Jupiter ~30%, Saturn ~21%), with the occasional ringed super-Earth
// in the tail (~1%). A ring is one smeared disrupted body, so it draws a
// SINGLE dominant resource (drawWeightedDeposits count=1) from RING_RESOURCE_ICY
// / RING_RESOURCE_ROCKY occurrence weights keyed on whether the host formed
// past the H2O frost line, or — rarely, host-mass-gated via RING_DIFFERENTIATION
// — RING_RESOURCE_DIFFERENTIATED (a shredded large differentiated moon, the only
// strategic-bearing ring). Extent from RING_EXTENT in planet-radius units.
//
// ─── Belts (generateBelts, generateFloorBelt) ──────────────────────
//
// Per-star independent rolls per BELT_CONTEXTS entry (warm, cold) via
// BELT_OCCURRENCE_BY_CLASS, with BELT_GIANT_ADJACENCY anchoring warm
// bands inward of the innermost shepherd and cold bands past the
// outermost (Sol's Main Belt at 0.4–0.7× Jupiter's a; Kuiper Belt at
// 1.3–1.85× Neptune's). Shepherd qualification is mass-gated at
// SHEPHERD_MIN_MASS_EARTH (super-Earth-class and up — compact systems
// resonance-anchor on super-Earths the way Sol does on Jupiter).
// Shepherdless systems eat the GIANTLESS_BELT_PENALTY[cls] multiplier
// and fall back to a system-edge band; per-class so WD and BD (whose
// belts are tidally-disrupted-planet rubble and scaled-down
// protoplanetary discs respectively, neither shepherding-dependent)
// bypass the penalty entirely. Belt size character emerges from
// shepherding: shepherded belts pull largestBodyKm from the parent-body
// range (BELT_LARGEST_BODY_KM.{warm,cold}.shepherded — Ceres / Pluto
// class), free-float belts pull from the dust-cascade range (tens of
// km max). Belt composition is a two-deposit occurrence draw
// (BELT_RESOURCE_OCCURRENCE, the same mechanism planets use); a belt whose
// largest body is big enough to have differentiated can roll an M-type
// metal/strategic character (BELT_DIFFERENTIATION) — the real C/S/M asteroid
// taxonomy. Rings draw a single resource (above). Either way composition lives
// in the resource grid rather than a discrete class enum, so renderers and
// gameplay both read mining yields from the same data.
//
// generateFloorBelt runs as a post-pass from build-catalog.mjs: any
// non-curated star that finished the architect + overlay phases with
// both zero planets and zero belts gets one trace cold free-float
// belt so the "no fully empty systems" gameplay invariant holds.

import { hash32, mulberry32, sampleNormal, sampleTruncated, sampleLogTruncated, samplePhysical, sampleMixture, sampleBinomial, drawWeightedDeposits } from './prng.mjs';
import { frostLineTrio, moonRadiusFromMass, solidSurfaceDensity, isolationMass, hillRadiusAu, keplerPeriodDays, EARTH_PER_SOLAR_MASS } from './astrophysics.mjs';
import { radiusFromMass, sampleOrbitalFlavor, sampleBulkWaterFraction, sampleBulkMetalFraction, sampleBulkVolatileFraction } from './procgen.mjs';
import {
  PROCGEN_VERSION,
  PLANET_COUNT_BY_CLASS,
  COMPANION_PLANET_SUPPRESSION,
  ORBITAL_GEOMETRY_BY_CLASS,
  SNOW_LINE_BOOSTS,
  MMSN_NORMALIZATION,
  DISK_GAS_LIFETIME_MYR,
  ACCRETION_EFFICIENCY,
  CRITICAL_CORE_MASS_EARTH,
  ENVELOPE_FRACTION,
  TIME_TO_RUNAWAY_MYR,
  MIGRATION_RATE,
  MIGRATION_FRACTION,
  MIGRATION_MIN_MASS_EARTH,
  MIN_HOT_JUPITER_AU,
  RADIUS_SCATTER_LOG,
  MOON_PROBABILITY_PER_HILL,
  MOON_PROBABILITY_CAP,
  MOON_COUNT_MAX,
  MOON_CPD_WATER_FLOOR,
  MOON_MASS_LOG_EARTH,
  MOON_MAX_HOST_MASS_RATIO,
  BELT_OCCURRENCE_BY_CLASS,
  BELT_PLACEMENT,
  BELT_RESOURCE_OCCURRENCE,
  BELT_DIFFERENTIATION,
  BELT_LARGEST_BODY_KM,
  BELT_GIANT_ADJACENCY,
  GIANTLESS_BELT_PENALTY,
  SHEPHERD_MIN_MASS_EARTH,
  RING_DISRUPTION_RATE,
  RING_EXTENT,
  RING_RESOURCE_ICY,
  RING_RESOURCE_ROCKY,
  RING_DIFFERENTIATION,
  RING_RESOURCE_DIFFERENTIATED,
  RING_ABUNDANCE,
  RESOURCE_KEYS,
  OTEGI_MR,
} from './procgen-priors.mjs';

// =============================================================================
// Sampling helpers
// =============================================================================


// Reserved negative slot indices for slotPrng draws that aren't tied to
// a specific orbital slot. Centralized so a new system-level draw claims
// a fresh index here instead of silently colliding with an existing one.
// `system` (-1) is shared across per-star draws (disk gas lifetime,
// planet count) — the salt keeps those independent.
const SYSTEM_SLOT = {
  system: -1,
  prune: -2,
  migration: -3,
};

// Per-(star, slot, salt) PRNG. Non-negative slots index orbital
// positions; SYSTEM_SLOT.* covers draws not tied to a specific slot.
function slotPrng(starId, slotIdx, salt) {
  return mulberry32(hash32(`${starId}:${slotIdx}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, moon, salt) PRNG. Seeded off planet.id rather than the
// architect's (starId, slot) tuple so the same generator works for both
// architect-built planets and catalog rows being moon-backfilled — the
// planet's id is the only stable handle that exists in both cases.
function moonPrng(planetId, mIdx, salt) {
  return mulberry32(hash32(`${planetId}:moon${mIdx}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, salt) PRNG for partial-anchor backfill — synthesizing
// mass / radius for catalog rows that arrived with a host star + period
// but no measured mass (transit-only or direct-imaging detections that
// the catalog can't constrain). Seeded off planet.id like moonPrng so
// the draw is stable across builds and independent of the architect's
// per-star slot seeds, which never reached these rows.
function partialPrng(planetId, salt) {
  return mulberry32(hash32(`${planetId}:partial:${salt}:${PROCGEN_VERSION}`));
}

// Per-(star, context, salt) PRNG. Belts are system-level structural
// features — at most one per BELT_CONTEXTS entry (warm, cold) per star —
// so the slot key is the context name rather than an index.
function beltPrng(starId, context, salt) {
  return mulberry32(hash32(`${starId}:belt:${context}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, salt) PRNG for ring sampling. Like moonPrng, keyed off
// the planet id so both architect-built and backfilled-catalog rings
// share the same seeding scheme.
function ringPrng(planetId, salt) {
  return mulberry32(hash32(`${planetId}:ring:${salt}:${PROCGEN_VERSION}`));
}

// Linear-ramp probability: 0 at/below `lo`, `maxProb` at/above `hi`, lerped
// between. Shared by the belt + ring differentiation gates (size / host-mass
// thresholds → odds the body's parent material differentiated).
function rampProb(x, lo, hi, maxProb) {
  if (x == null || hi <= lo) return 0;
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * maxProb;
}

// =============================================================================
// Per-slot sampling
// =============================================================================

// Per-star disk context — frost-line trio in AU + sampled disk gas lifetime.
// Computed once per call to generateSystem / generateOverlay and threaded
// into buildPlanetAtOrbit so every slot reads the same disk state. The gas
// lifetime is the single stochastic draw at this layer; frost-line positions
// are deterministic functions of stellar luminosity.
//
// Returns null on missing inputs; every real catalog star has mass + class,
// so this guard is defensive against future stripped-down callers — not a
// hot path.
function buildStarDiskContext(star) {
  if (star == null || star.mass == null) return null;
  const cls = star.cls;
  const gasSpec = DISK_GAS_LIFETIME_MYR[cls] ?? DISK_GAS_LIFETIME_MYR.G;
  const gasPrng = slotPrng(star.id, SYSTEM_SLOT.system, 'disk_gas_lifetime');
  const diskGasLifetimeMyr = sampleTruncated(gasPrng, gasSpec);
  return {
    frostLines: frostLineTrio(star.mass),
    diskGasLifetimeMyr,
  };
}

// IAU planet designation: 0→'b', 1→'c', … 'a' is reserved for the star.
// Caps at 25 planets ('z'); the priors clamp planet count well below this.
function planetLetterAt(idx) {
  return String.fromCharCode('b'.charCodeAt(0) + Math.min(idx, 24));
}

// Roman numeral 1..15. Used for procgen moon display names; ids use 'm1'
// etc. for slug-friendliness. Caps at XV — moon counts clamp to 15.
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];

// =============================================================================
// Body shape — fields the Architect doesn't set, listed for _unknowns
// =============================================================================

// The Filler will derive these from anchors + physics. Listing here so the
// Architect's output declares its dependencies cleanly to the next layer.
const FILLER_TARGET_FIELDS = [
  'worldClass', 'avgSurfaceTempK', 'surfaceTempMinK', 'surfaceTempMaxK',
  'waterFraction', 'iceFraction', 'surfaceAge',
  'magneticFieldGauss', 'tectonicActivity',
  'surfacePressureBar',
  'atm1', 'atm1Frac', 'atm2', 'atm2Frac', 'atm3', 'atm3Frac',
  'cloudLayers', 'surfaceOpacity',
  'hazeAerosols', 'dustStrength',
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
  'bioticCarbonAqueous', 'bioticSubsurfaceAqueous', 'bioticAerial',
  'bioticCryogenic', 'bioticSilicate', 'bioticSulfur',
  'biosphereArchetype', 'biosphereComplexity',
  'rotationPeriodHours',
];

// Build a body record with anchors set + every Filler-target field as null
// + `_unknowns` listing those targets. Belts and rings pass `_unknowns: []`
// in props to short-circuit the Filler (their structural fields are baked
// at architect time from belt/ring priors, not derived from physics).
function makeBody(props) {
  const base = {
    hostStarIdx: null,
    hostBodyIdx: null,
    worldClass: null,
    formationAu: null,
    bulkWaterFraction: null,
    bulkMetalFraction: null,
    bulkVolatileFraction: null,
    largestBodyKm: null,
    // shepherdId is the architect's deferred form of shepherdBodyIdx —
    // it stores the giant's *string id* because the Body's array
    // position isn't known until attachBodies runs. build-catalog
    // resolves shepherdId → shepherdBodyIdx and strips this field.
    shepherdId: null,
    shepherdBodyIdx: null,
    avgSurfaceTempK: null, surfaceTempMinK: null, surfaceTempMaxK: null,
    waterFraction: null, iceFraction: null, surfaceAge: null,
    magneticFieldGauss: null, tectonicActivity: null,
    surfacePressureBar: null,
    atm1: null, atm1Frac: null, atm2: null, atm2Frac: null, atm3: null, atm3Frac: null,
    cloudLayers: null, surfaceOpacity: null,
    hazeAerosols: null, dustStrength: null,
    resMetals: null, resSilicates: null, resVolatiles: null,
    resRareEarths: null, resRadioactives: null, resExotics: null,
    bioticCarbonAqueous: null, bioticSubsurfaceAqueous: null, bioticAerial: null,
    bioticCryogenic: null, bioticSilicate: null, bioticSulfur: null,
    biosphereArchetype: null, biosphereComplexity: null,
    rotationPeriodHours: null,
    innerAu: null, outerAu: null, innerPlanetRadii: null, outerPlanetRadii: null,
    moons: [],
    ring: null,
    _unknowns: [...FILLER_TARGET_FIELDS],
  };
  return { ...base, ...props };
}

// =============================================================================
// Moons
// =============================================================================

// Generate 0..N moons for one planet. Moon orbital distances spread out
// from the planet in AU at planetary scales (Galilean ~0.003 AU). Mass
// distribution is log-uniform from sub-Enceladus (10^-5 M⊕) to about
// 0.025 M⊕ (Titan-Ganymede range). Radius approximated from mass via a
// rocky-mean-density relation (ρ ≈ 3 g/cm³). Exported so the Filler can
// reuse it when backfilling moons for catalog planets that arrived with
// none — observed exoplanets rarely have moon coverage, but every body
// should be explorable for the game.
//
// Moons inherit their host's formation zone for bulk-composition sampling
// — they accreted in the same circumplanetary disk slice. `hostFormationAu`
// + `frostLinesAu` are passed through; defaults to null so the backfill
// path can pass them in without breaking older callers.
//
// Count is Binomial(MOON_COUNT_MAX, p) with p saturating in R_H, where R_H is
// the host's Hill radius in AU (see hillRadiusAu in astrophysics.mjs).
// Capacity scales with Hill volume: a Jupiter-class at 5 AU gets ~4
// moons, an Earth-class at 1 AU gets ~0, a hot Jupiter at 0.05 AU gets ~0.
// The migration-strip behavior emerges naturally from the shrunk Hill
// sphere.
export function generateMoons(planet, star, hostFormationAu = null, frostLinesAu = null) {
  if (planet.massEarth == null || planet.semiMajorAu == null) return [];
  if (!star || star.mass == null) return [];
  const hillAu = hillRadiusAu(planet.semiMajorAu, planet.massEarth, star.mass);
  if (hillAu == null || hillAu <= 0) return [];
  const countPrng = moonPrng(planet.id, -1, 'count');
  // Sample N ~ Binomial(MOON_COUNT_MAX, p) where p scales linearly with
  // Hill-sphere radius (hillAu × MOON_PROBABILITY_PER_HILL) and saturates
  // at MOON_PROBABILITY_CAP. Binomial is naturally bounded at
  // MOON_COUNT_MAX so the distribution shape is smooth across 0..MAX —
  // no post-hoc prune, no pile-up at the cap (which is what Poisson +
  // clamp produces when λ saturates). The linear-in-Hill slope keeps the
  // small-Hill bodies (rocky inners, migration-stripped hot Jupiters)
  // near zero moons and pushes the wide-Hill gas giants toward the cap,
  // so the gas-giant-vs-rocky moon contrast emerges from physics rather
  // than a class switch — see the same anchors documented at
  // MOON_PROBABILITY_PER_HILL in procgen-priors.mjs.
  const p = Math.min(MOON_PROBABILITY_CAP, hillAu * MOON_PROBABILITY_PER_HILL);
  const N = sampleBinomial(countPrng, MOON_COUNT_MAX, p);
  if (N === 0) return [];

  const moons = [];
  for (let mIdx = 0; mIdx < N; mIdx++) {
    const massPrng = moonPrng(planet.id, mIdx, 'mass');
    const orbitPrng = moonPrng(planet.id, mIdx, 'orbit');
    const phasePrng = moonPrng(planet.id, mIdx, 'phase');
    const eccPrng = moonPrng(planet.id, mIdx, 'ecc');
    const incPrng = moonPrng(planet.id, mIdx, 'inc');
    const tiltPrng = moonPrng(planet.id, mIdx, 'tilt');
    const orbital = sampleOrbitalFlavor({ eccPrng, incPrng, tiltPrng, phasePrng });
    const bulkWaterPrng = moonPrng(planet.id, mIdx, 'bulk_water');
    const bulkMetalPrng = moonPrng(planet.id, mIdx, 'bulk_metal');
    const bulkVolatilePrng = moonPrng(planet.id, mIdx, 'bulk_volatile');

    // Mass: truncated log-normal centered on Europa-class with a tail
    // extending to Earth-mass+. Each moon's upper bound is further capped
    // by the host's Hill-sphere-style stability ratio so an Earth-mass
    // moon can only form around a Saturn+ host. See MOON_MASS_LOG_EARTH
    // and MOON_MAX_HOST_MASS_RATIO in procgen-priors.mjs for the
    // distribution shape and the cap rationale.
    const hostCapLog = Math.log10(Math.max(planet.massEarth * MOON_MAX_HOST_MASS_RATIO, 1e-5));
    const massSpec = {
      mean: MOON_MASS_LOG_EARTH.mean,
      sd:   MOON_MASS_LOG_EARTH.sd,
      min:  MOON_MASS_LOG_EARTH.min,
      max:  Math.min(MOON_MASS_LOG_EARTH.max, hostCapLog),
    };
    const massEarth = Math.pow(10, sampleTruncated(massPrng, massSpec));
    const radiusEarth = moonRadiusFromMass(massEarth);

    // Orbital distance: starts inside Roche-ish, spreads out with each slot
    // by ~factor 1.6. Galilean spacing is ~1.4–1.8x consecutive.
    const baseA = 0.002;
    const semiMajorAu = baseA * Math.pow(1.6, mIdx) * (0.8 + orbitPrng() * 0.4);
    // Moon-around-planet: the Kepler host mass is the planet's mass in
    // solar units (massEarth / EARTH_PER_SOLAR_MASS) — far below any
    // star-mass floor, so no floor is applied here.
    const periodDays = keplerPeriodDays(semiMajorAu, planet.massEarth / EARTH_PER_SOLAR_MASS);

    moons.push(makeBody({
      id: `${planet.id}-m${mIdx + 1}`,
      hostId: planet.id,
      kind: 'moon',
      formalName: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      name: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      source: 'procgen',
      semiMajorAu: Number(semiMajorAu.toFixed(5)),
      eccentricity: orbital.eccentricity,
      inclinationDeg: orbital.inclinationDeg,
      periodDays: Number(periodDays.toFixed(3)),
      orbitalPhaseDeg: orbital.orbitalPhaseDeg,
      axialTiltDeg: orbital.axialTiltDeg,
      massEarth: Number(massEarth.toFixed(4)),
      radiusEarth: Number(radiusEarth.toFixed(4)),
      // CPD pebble-drift floor: any procgen moon's bulkWater is at
      // least MOON_CPD_WATER_FLOOR regardless of host formation zone.
      // See the floor prior's docstring for the Galilean-CPD rationale.
      bulkWaterFraction: Number(Math.max(
        sampleBulkWaterFraction(bulkWaterPrng, hostFormationAu, frostLinesAu),
        MOON_CPD_WATER_FLOOR,
      ).toFixed(5)),
      bulkMetalFraction: sampleBulkMetalFraction(bulkMetalPrng, hostFormationAu, frostLinesAu),
      bulkVolatileFraction: sampleBulkVolatileFraction(bulkVolatilePrng, hostFormationAu, frostLinesAu),
    }));
  }

  // Binomial draw above already bounded N to MOON_COUNT_MAX, so no
  // prune step is needed. moons are returned in slot order (mIdx=0..N-1)
  // which corresponds to semi-major-axis order (mIdx drives the
  // geometric a-spacing).
  return moons;
}

// =============================================================================
// Belts
// =============================================================================

// Descriptive belt name keyed off the band's center distance:
// e.g. "Inner Belt", "Outer Debris Field". Used for procgen rows where
// there's no curated colloquial name. Bands at < 1 AU are "Hot",
// 1–5 AU "Inner", 5–20 AU "Middle", 20–100 AU "Outer", >100 AU "Distant".
function describeBeltLocation(centerAu) {
  if (centerAu < 1)   return 'Hot';
  if (centerAu < 5)   return 'Inner';
  if (centerAu < 20)  return 'Middle';
  if (centerAu < 100) return 'Outer';
  return 'Distant';
}

// Composition adjective derived from the dominant resource axis:
// volatiles → "Icy", rocky resources → "Rocky". Used in belt names
// so a glance at "Sol Outer Icy Belt" reads what's in it.
function describeBeltComposition(resources) {
  const v = resources.resVolatiles ?? 0;
  const rocky = (resources.resMetals ?? 0) + (resources.resSilicates ?? 0) + (resources.resRareEarths ?? 0);
  return v > rocky ? 'Icy' : 'Rocky';
}

// Identify the shepherd candidates in a placed-planet list (innermost +
// outermost). Mass gates membership at SHEPHERD_MIN_MASS_EARTH; in
// compact systems even a super-Earth dominates the resonance structure
// the way Sol's Jupiter does for the Main Belt. Returns null fields
// when no candidates exist, signaling generateBelts to apply the
// per-class giantless penalty path (or bypass it for WD / BD).
function findGiants(placedPlanets) {
  const giants = placedPlanets
    .filter(p => p.kind === 'planet' && p.massEarth != null && p.massEarth >= SHEPHERD_MIN_MASS_EARTH && p.semiMajorAu != null)
    .sort((a, b) => a.semiMajorAu - b.semiMajorAu);
  return {
    innermost: giants[0] ?? null,
    outermost: giants[giants.length - 1] ?? null,
  };
}

// Generate 0..2 belts for one star, one roll per BELT_CONTEXTS entry
// (warm, cold). Returns Body[] ready to concatenate with the planet
// stream. `placedPlanets` is the list of planets already laid down for
// this system (architect + catalog combined for the overlay path) —
// belts use it to anchor adjacent to the system's shepherd candidates
// and record a shepherd. Without one the occurrence is multiplied by
// GIANTLESS_BELT_PENALTY[cls][context] before the roll, and placement
// falls back to BELT_PLACEMENT's system-edge-scaled band. WD and BD
// classes have penalty 1.0 (no penalty) since their belts aren't
// primordial-shepherded. Shepherded belts get a larger-parent-body
// size draw; free-float belts get a dust-cascade-scale size draw —
// see BELT_LARGEST_BODY_KM.
//
// Driven from generateSystem and generateOverlay — the two in-module
// entry points that lay down the planet stream this anchors against.
// Build one belt Body from already-resolved placement. The per-context
// roll/penalty/shepherd-anchoring logic lives in the callers; this is the
// body-construction the normal and floor paths share — mass draw, resource
// occurrence, largestBodyKm draw, naming. `saltPrefix` (''/'floor_') keys
// the seed salts so each caller reproduces its own deterministic draws;
// `massScale` (1 for normal, 0.5 for the trace floor belt) scales the
// log-uniform mass span. `hasShepherd` selects the largestBodyKm range.
function buildBeltBody({ star, context, hasShepherd, innerAu, outerAu, shepherdId, saltPrefix = '', massScale = 1 }) {
  const placement = BELT_PLACEMENT[context];
  const centerAu = (innerAu + outerAu) / 2;

  // Mass: log-uniform between placement.mass.min and .max (× massScale on
  // the span — the floor belt squeezes into the lower half).
  const massPrng = beltPrng(star.id, context, saltPrefix + 'mass');
  const logMin = Math.log10(placement.mass.min);
  const logMax = Math.log10(placement.mass.max);
  const massEarth = Math.pow(10, logMin + massPrng() * (logMax - logMin) * massScale);

  // largestBodyKm: log-uniform within the shepherding-conditional
  // range. Shepherded belts pull from the parent-body scale (Ceres/
  // Pluto class); free-float belts pull from the dust-cascade scale
  // (tens of km max). Captures the real bimodality of belt
  // populations without exposing a discrete enum. Computed before the
  // resource draw because it gates differentiation.
  const kmRange = BELT_LARGEST_BODY_KM[context][hasShepherd ? 'shepherded' : 'freeFloat'];
  const sizePrng = beltPrng(star.id, context, saltPrefix + 'largest');
  const logKmMin = Math.log10(kmRange.min);
  const logKmMax = Math.log10(kmRange.max);
  const largestBodyKm = Math.pow(10, logKmMin + sizePrng() * (logKmMax - logKmMin));

  // Differentiation (the M-type axis): a big parent body (Vesta/Ceres-class)
  // melted, separated an iron core + crustal heavies, and — once shattered —
  // exposes them. Roll gated on largestBodyKm; if it differentiated, tilt the
  // context occurrence weights toward metals + strategics (volatiles bake off).
  // Dust-cascade belts (tiny largestBodyKm) never differentiate → stay
  // primitive, weights untouched, byte-identical to the pre-differentiation draw.
  const diffPrng = beltPrng(star.id, context, saltPrefix + 'diff');
  const differentiated = diffPrng() < rampProb(
    largestBodyKm, BELT_DIFFERENTIATION.kmFloor, BELT_DIFFERENTIATION.kmFull, BELT_DIFFERENTIATION.maxProb);
  let beltWeights = BELT_RESOURCE_OCCURRENCE[context];
  if (differentiated) {
    beltWeights = { ...beltWeights };
    for (const [k, m] of Object.entries(BELT_DIFFERENTIATION.multipliers)) {
      if (beltWeights[k] != null) beltWeights[k] *= m;
    }
  }

  // Resources: two-deposit occurrence draw (shared with planets/moons).
  // Carries composition signal — the renderer reads it back to lerp
  // chunk color between rocky-tan and icy-cyan via bodyIcyness.
  const resources = drawWeightedDeposits(
    RESOURCE_KEYS,
    beltWeights,
    BELT_RESOURCE_OCCURRENCE.abundance,
    (name) => beltPrng(star.id, context, `${saltPrefix}res_occ_${name}`),
  );

  const composition = describeBeltComposition(resources);
  const formal = `${star.name} ${describeBeltLocation(centerAu)} ${composition} Belt`;
  return makeBody({
    id: `${star.id}-belt-${context}`,
    hostId: star.id,
    kind: 'belt',
    formalName: formal,
    name: formal,
    source: 'procgen',
    largestBodyKm: Number(largestBodyKm.toFixed(1)),
    shepherdId,
    semiMajorAu: Number(centerAu.toFixed(3)),
    innerAu: Number(innerAu.toFixed(3)),
    outerAu: Number(outerAu.toFixed(3)),
    massEarth: Number(massEarth.toFixed(5)),
    ...resources,
    _unknowns: [],
  });
}

function generateBelts(star, placedPlanets = []) {
  const cls = star.cls;
  const occurrence = BELT_OCCURRENCE_BY_CLASS[cls];
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  if (!occurrence || !geom) return [];

  const { innermost: innerGiant, outermost: outerGiant } = findGiants(placedPlanets);

  const belts = [];
  for (const context of Object.keys(occurrence)) {
    // Shepherd availability gates both the occurrence rate (no
    // shepherd → giantless penalty) and the largestBodyKm draw
    // (shepherded → parent-body scale; free-float → dust-cascade scale).
    const shepherd = context === 'warm' ? innerGiant : outerGiant;
    const hasShepherd = !!shepherd;
    const penalty = hasShepherd ? 1.0 : GIANTLESS_BELT_PENALTY[cls][context];
    const effectiveRate = occurrence[context] * penalty;

    const rollPrng = beltPrng(star.id, context, 'occur');
    if (rollPrng() >= effectiveRate) continue;

    // Placement: anchored to the shepherd when one exists, otherwise
    // a fallback band keyed to the system's outer edge.
    const placement = BELT_PLACEMENT[context];
    let innerAu, outerAu, shepherdId;
    if (hasShepherd) {
      const adj = BELT_GIANT_ADJACENCY[context];
      innerAu = shepherd.semiMajorAu * adj.innerFrac;
      outerAu = shepherd.semiMajorAu * adj.outerFrac;
      shepherdId = shepherd.id;
    } else {
      innerAu = geom.outerEdgeAu * placement.innerFrac;
      outerAu = geom.outerEdgeAu * placement.outerFrac;
      shepherdId = null;
    }

    belts.push(buildBeltBody({ star, context, hasShepherd, innerAu, outerAu, shepherdId }));
  }
  return belts;
}

// Universal content-floor belt for systems that rolled both zero planets
// and zero belts. Guarantees the gameplay invariant that no system is
// fully empty — every star has at least one cold remnant disc the player
// can mine. Physical framing: planet formation rarely sweeps a disc
// clean down to vacuum; a trace residual band of cold, volatile-rich
// dust + km-scale parent bodies is the default end-state of every
// protoplanetary disc that doesn't get aggressively cleared by a
// migrating giant. Always free-float (no shepherd by definition — the
// system has no qualifying planet) and small-mass: this is "trace
// debris," not a Sol-Main-Belt-class strategic target.
//
// Called from build-catalog.mjs after the architect + overlay passes
// determine which stars ended up empty. Deterministic via the star id.
export function generateFloorBelt(star) {
  const cls = star.cls;
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  if (!geom) return null;

  // Always free-float by definition (the system has no qualifying planet),
  // placed on the cold system-edge band. The 'floor_' salt prefix keeps
  // its draws independent of the normal cold-belt path, and massScale 0.5
  // squeezes mass into the lower half so it reads as trace debris.
  const placement = BELT_PLACEMENT.cold;
  const innerAu = geom.outerEdgeAu * placement.innerFrac;
  const outerAu = geom.outerEdgeAu * placement.outerFrac;

  return buildBeltBody({
    star,
    context: 'cold',
    hasShepherd: false,
    innerAu,
    outerAu,
    shepherdId: null,
    saltPrefix: 'floor_',
    massScale: 0.5,
  });
}

// =============================================================================
// Rings
// =============================================================================

// Generate 0 or 1 ring for one planet. Exported so the build-catalog
// backfill can run rings over catalog planets that arrived without one
// (same posture as moon backfill — the bias model assumes the catalog
// is silent on rings, not authoritative).
//
// Occurrence probability scales as R_p² × RING_DISRUPTION_RATE — the
// Roche-zone cross-section. Composition gates on whether the host
// formed past the H2O frost line: icy CPD feed → water-ice rings;
// inside the line → rocky/silicate debris rings. Falls back to rocky
// when frostLinesAu isn't available (backfill paths without disk
// context).
export function generateRing(planet, hostFormationAu = null, frostLinesAu = null) {
  if (planet.radiusEarth == null || planet.radiusEarth <= 0) return null;
  const pRing = planet.radiusEarth * planet.radiusEarth * RING_DISRUPTION_RATE;
  const rollPrng = ringPrng(planet.id, 'occur');
  if (rollPrng() >= pRing) return null;

  const innerPrng = ringPrng(planet.id, 'inner');
  const outerPrng = ringPrng(planet.id, 'outer');
  let inner = sampleTruncated(innerPrng, RING_EXTENT.inner);
  let outer = sampleTruncated(outerPrng, RING_EXTENT.outer);
  // If the outer sample lands below the inner, swap (cleaner than
  // re-rolling, preserves determinism).
  if (outer < inner) { const t = inner; inner = outer; outer = t; }

  // Composition gated on host formation zone. A hot Jupiter that formed
  // past H2O frost retains its icy ring inheritance despite the current
  // hot orbit — same Phase D convention as bulkWaterFraction.
  const formAu = hostFormationAu ?? planet.formationAu ?? planet.semiMajorAu;
  const h2oAu = frostLinesAu?.H2O ?? Infinity;
  const isIcy = formAu != null && formAu > h2oAu;

  // Differentiation (the shredded-moon case): with low, host-mass-gated odds a
  // ring is the debris of a tidally-disrupted large differentiated moon —
  // metal-rich, strategic-bearing — rather than a pristine icy/rocky shard.
  const differentiated = ringPrng(planet.id, 'diff')() < rampProb(
    planet.massEarth, RING_DIFFERENTIATION.massFloorEarth, RING_DIFFERENTIATION.massFullEarth, RING_DIFFERENTIATION.maxProb);

  // A ring is one smeared body → a SINGLE dominant resource (count=1), drawn
  // from the context occurrence weights. The other five fields stay 0.
  const ringWeights = differentiated ? RING_RESOURCE_DIFFERENTIATED
    : isIcy ? RING_RESOURCE_ICY : RING_RESOURCE_ROCKY;
  const resources = drawWeightedDeposits(
    RESOURCE_KEYS,
    ringWeights,
    RING_ABUNDANCE,
    (name) => ringPrng(planet.id, `res_occ_${name}`),
    1,
  );

  const formal = `${planet.formalName} Ring`;
  return makeBody({
    id: `${planet.id}-ring`,
    hostId: planet.id,
    kind: 'ring',
    formalName: formal,
    name: formal,
    source: 'procgen',
    innerPlanetRadii: Number(inner.toFixed(3)),
    outerPlanetRadii: Number(outer.toFixed(3)),
    ...resources,
    _unknowns: [],
  });
}

// =============================================================================
// Entry point
// =============================================================================

// Generate the planets + moons + belts for one star. Returns [] when
// the stellar class isn't in the priors. N=0 systems still flow through —
// they emit no planets but their belt rolls still fire, so a debris-
// disk-only star is representable (BD/WD with min=0 hit this branch
// regularly).
//
// `clusterRole` (primary/secondary/tertiary_plus) suppresses the sampled
// planet count for tight-binary companions; defaults to 'primary' (no
// suppression) so callers that don't know the role get unchanged behavior.
//
// `clusterPlanetBudget` is the gameplay-level remaining-budget cap for the
// cluster this star belongs to (see MAX_PLANETS_PER_CLUSTER). Primary-first
// allocation: the caller passes the full budget to the primary, subtracts
// the primary's actual planet count, and passes the remainder to each
// companion in turn. Defaults to Infinity for callers without cluster
// context (no extra clamp).
// Hard safety bound on the orbital walk's length. The walk normally
// stops at `outerEdgeAu`, but a degenerate sequence of low-tail
// spacing draws could in principle stall a step at AU ratio ≈ 1 and
// run forever. 30 slots is well past any class's natural physical
// count (G walks ~10–12, M ~15–20).
const MAX_ORBITAL_SLOTS = 30;

export function generateSystem(star, clusterRole = 'primary', clusterPlanetBudget = Infinity) {
  const cls = star.cls;
  const countSpec = PLANET_COUNT_BY_CLASS[cls];
  if (!countSpec) return [];

  // Target post-prune planet count K — the gameplay-range filter. The
  // realistic walk below builds the full physics inventory; this K
  // sets how many of those survive into the player-visible system.
  // Cluster role suppression still applies (tight binaries are barren).
  const countPrng = slotPrng(star.id, SYSTEM_SLOT.system, 'planet_count');
  const rawK = sampleTruncated(countPrng, countSpec, true);
  const suppression = COMPANION_PLANET_SUPPRESSION[clusterRole] ?? 1.0;
  const K = Math.max(0, Math.min(clusterPlanetBudget, countSpec.max, Math.round(rawK * suppression)));

  // Walk orbits from the inner edge to the outer edge under the realistic
  // spacing prior — no count cap. The orbital walk is pure physics: the
  // natural planet count emerges from log(outerEdge / innerEdge) /
  // log(spacingRatio^(2/3)). For most classes that's ~10–20 candidates.
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  const orbits = [];
  const firstPrng = slotPrng(star.id, 0, 'first_a');
  let a = geom.innerEdgeAu * (1.0 + firstPrng() * 1.0);
  for (let i = 0; i < MAX_ORBITAL_SLOTS; i++) {
    if (a > geom.outerEdgeAu) break;
    orbits.push(a);
    const ratioPrng = slotPrng(star.id, i + 1, 'spacing');
    const periodRatio = Math.exp(sampleNormal(ratioPrng, Math.log(geom.spacingRatio.mean), geom.spacingRatio.sd));
    a *= Math.pow(periodRatio, 2 / 3);
  }
  // The cap only harms output when it truncated the walk below the
  // player-visible target K — i.e. K wanted more orbits than the walk
  // could supply before exhausting MAX_ORBITAL_SLOTS. Tight-spacing
  // classes (notably BD) routinely fill all 30 candidate slots while
  // still inside outerEdgeAu, but K prunes those extras away, so a bare
  // cap-hit is benign and not worth a warning. Warn only on the genuine
  // inventory-truncation case so a future tuning regression surfaces
  // instead of silently capping the visible planet count.
  if (a <= geom.outerEdgeAu && K > orbits.length) {
    console.warn(`procgen-architect: ${star.id} (${cls}) hit MAX_ORBITAL_SLOTS=${MAX_ORBITAL_SLOTS}; walk supplied ${orbits.length} orbits but K=${K} — visible planet count truncated`);
  }

  const diskCtx = buildStarDiskContext(star);
  // Build planets at every realistic orbit, then run migration. Pruning
  // happens after migration because migration is physics (a real
  // migrator sweeps the inner system) and the gameplay prune should
  // operate on the post-physics inventory.
  const rawPlanets = [];
  for (let i = 0; i < orbits.length; i++) {
    const p = buildPlanetCore(star, i, orbits[i], planetLetterAt(i), '', diskCtx);
    if (p) rawPlanets.push(p);
  }
  const migrated = migratePass(rawPlanets, star);

  // Gameplay-range filter: keep K planets, chosen uniformly at random.
  // Random (not "trim outer", not "trim small") is load-bearing — any
  // mass-or-orbit-biased prune would shift the galaxy-wide body-type
  // frequency. Uniform random keeps the realistic mix exactly; only
  // absolute counts drop.
  const planets = pruneToK(migrated, K, star.id);

  // Reletter survivors by orbital order so display names stay
  // contiguous (b, c, d, …) after pruning. Sampling PRNG seeds inside
  // buildPlanetCore are keyed off the original slot index, so this is
  // a display-only rename — physical attributes don't re-roll.
  for (let i = 0; i < planets.length; i++) {
    const letter = planetLetterAt(i);
    planets[i].id = `${star.id}-${letter}`;
    planets[i].name = `${star.name} ${letter}`;
    planets[i].formalName = `${star.name} ${letter}`;
  }

  const bodies = [];
  for (const p of planets) {
    bodies.push(p);
    bodies.push(...attachMoonsAndRing(p, star, diskCtx));
  }
  // Belts roll independently of the planet stream, but their placement
  // depends on it — asteroid/ice belts anchor against the system's
  // giants. Pass in the planets we just built so generateBelts can find
  // them. A zero-planet system still rolls belts (debris-disk-only
  // configurations are valid) — they just take the giantless path.
  bodies.push(...generateBelts(star, planets));
  return bodies;
}

// Fisher-Yates partial shuffle to pick K planets uniformly at random,
// returned in semi-major-axis order. Deterministic via per-star PRNG so
// the same star reduces to the same kept set across builds.
function pruneToK(planets, K, starId) {
  if (planets.length <= K) return planets;
  if (K <= 0) return [];
  const prng = slotPrng(starId, SYSTEM_SLOT.prune, 'prune');
  const arr = planets.slice();
  // Partial shuffle of the last K slots: swap arr[i] with a random
  // index in [0..i]. After K swaps, arr.slice(-K) is a uniform K-subset.
  for (let i = arr.length - 1; i >= arr.length - K; i--) {
    const j = Math.floor(prng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(-K).sort((a, b) => a.semiMajorAu - b.semiMajorAu);
}

// Disk-physics mass→radius chain, shared by the top-down planet builder
// and the partial-anchor synthesizer so a tuning change to the accretion /
// envelope / radius model can't silently diverge between the two paths.
//
// Continuous mass pipeline:
//   isolation mass (zone physics) → core mass (× accretion efficiency)
//   → gas-envelope decision (mass + frost-line + disk-gas gates)
//   → total mass → radius
//
// `prngFor(salt)` supplies a seeded PRNG per draw, so each caller owns its
// own seeding (slot-based for the architect, body-id-based for partials).
// Returns the raw {massEarth, radiusEarth} (callers round to taste), or
// null when the formation zone yields no viable isolation mass.
function massRadiusFromDiskPhysics(star, formationAu, diskCtx, prngFor) {
  const Σ = solidSurfaceDensity(
    star.mass, formationAu, diskCtx.frostLines, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS,
  );
  const mIso = isolationMass(formationAu, star.mass, Σ);
  if (mIso == null || mIso <= 0) return null;

  const accZone = formationAu < diskCtx.frostLines.H2O ? 'inner' : 'outer';
  const coreMass = mIso * samplePhysical(prngFor('accretion'), ACCRETION_EFFICIENCY[accZone]);

  // Gas envelope fires only when all three gates pass: the core can
  // contract H2 fast enough (≥ critical mass), it sits past the water
  // frost line so volatile ice feeds the envelope, and the disk still
  // has gas left when runaway is reached.
  let envelopeMass = 0;
  const canRunaway =
    coreMass >= CRITICAL_CORE_MASS_EARTH &&
    formationAu > diskCtx.frostLines.H2O &&
    diskCtx.diskGasLifetimeMyr > TIME_TO_RUNAWAY_MYR;
  if (canRunaway) {
    const envRatio = sampleLogTruncated(prngFor('envelope'), ENVELOPE_FRACTION);
    envelopeMass = coreMass * envRatio;
  }
  const massEarth = coreMass + envelopeMass;

  // Radius from the Otegi mass-radius relation plus a single composition-
  // agnostic log-scatter. The piecewise mean (rocky line below 2 M⊕, ice
  // line below 130, gas plateau above) already encodes the bulk of
  // density variety; remaining scatter is the per-body composition noise.
  const meanRadius = radiusFromMass(massEarth) ?? 1.0;
  const noisyRadius = meanRadius * Math.exp(sampleNormal(prngFor('radius'), 0, RADIUS_SCATTER_LOG));
  const radiusEarth = Math.max(0.1, Math.min(30, noisyRadius));

  return { massEarth, radiusEarth };
}

// Build one planet body at its formation orbit. Physics-driven mass
// pipeline → radius → flavor. Returns the planet only (no moons / ring) —
// the orchestrator runs the migration pass before attaching satellites,
// since a migrated giant sweeps the inner system and we don't want to
// build moons for planets that get removed.
//
// `formationAu` is where the body accreted. Initially it also serves as
// semiMajorAu (in-situ formation); the migration pass may later move
// semiMajorAu inward for hot Jupiters. Bulk water/metal sample on the
// insolation at formationAu — a migrated giant keeps its outer-zone
// composition.
//
// `diskCtx` is the per-star context from buildStarDiskContext(star) —
// frost-line trio in AU + sampled disk gas lifetime. Both call sites
// pass it; null fallback exists only for defensive coding.
function buildPlanetCore(star, slotIdx, formationAu, letter, saltPrefix = '', diskCtx = null) {
  if (diskCtx == null) return null;

  const dp = massRadiusFromDiskPhysics(
    star, formationAu, diskCtx,
    (salt) => slotPrng(star.id, slotIdx, saltPrefix + salt),
  );
  if (dp == null) return null;
  const { massEarth, radiusEarth } = dp;

  const eccPrng = slotPrng(star.id, slotIdx, saltPrefix + 'eccentricity');
  const incPrng = slotPrng(star.id, slotIdx, saltPrefix + 'inclination');
  const tiltPrng = slotPrng(star.id, slotIdx, saltPrefix + 'axial_tilt');
  const phasePrng = slotPrng(star.id, slotIdx, saltPrefix + 'orbital_phase');
  const orbital = sampleOrbitalFlavor({ eccPrng, incPrng, tiltPrng, phasePrng });
  const bulkWaterPrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_water');
  const bulkWaterFraction = sampleBulkWaterFraction(bulkWaterPrng, formationAu, diskCtx.frostLines);
  const bulkMetalPrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_metal');
  const bulkMetalFraction = sampleBulkMetalFraction(bulkMetalPrng, formationAu, diskCtx.frostLines);
  const bulkVolatilePrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_volatile');
  const bulkVolatileFraction = sampleBulkVolatileFraction(bulkVolatilePrng, formationAu, diskCtx.frostLines);

  // Computed against semiMajorAu (which currently equals formationAu); the
  // migration pass recomputes period for any body whose semiMajorAu moves.
  // The 0.01 floor guards against a degenerate near-zero star mass.
  const periodDays = keplerPeriodDays(formationAu, Math.max(star.mass, 0.01));

  return makeBody({
    id: `${star.id}-${letter}`,
    hostId: star.id,
    kind: 'planet',
    formalName: `${star.name} ${letter}`,
    name: `${star.name} ${letter}`,
    source: 'procgen',
    semiMajorAu: Number(formationAu.toFixed(4)),
    formationAu: Number(formationAu.toFixed(4)),
    eccentricity: orbital.eccentricity,
    inclinationDeg: orbital.inclinationDeg,
    periodDays: Number(periodDays.toFixed(2)),
    orbitalPhaseDeg: orbital.orbitalPhaseDeg,
    axialTiltDeg: orbital.axialTiltDeg,
    massEarth: Number(massEarth.toFixed(3)),
    radiusEarth: Number(radiusEarth.toFixed(3)),
    bulkWaterFraction,
    bulkMetalFraction,
    bulkVolatileFraction,
  });
}

// =============================================================================
// Partial-anchor synthesis
// =============================================================================

// Public per-star disk context for callers outside the architect (e.g.
// build-catalog's partial-anchor backfill, which needs the same
// diskCtx that the architect would have used had the star gone through
// generateSystem / generateOverlay).
export const starDiskContext = buildStarDiskContext;

// Radius-space branch boundaries of the inverse Otegi relation: the
// rockyMaxMass and subNepMaxMass thresholds pushed through the forward
// relation, so the inverse selects the same branch the forward one would.
// Both directions read the same OTEGI_MR coefficients (procgen-priors.mjs),
// so the branches can't drift. Hoisted so they're computed once, not per
// massFromRadius call.
const MR_ROCKY_MAX_RADIUS = Math.pow(OTEGI_MR.rockyMaxMass, OTEGI_MR.rockyExp);                          // ≈ 1.213
const MR_SUBNEP_MAX_RADIUS = OTEGI_MR.subNepCoeff * Math.pow(OTEGI_MR.subNepMaxMass, OTEGI_MR.subNepExp); // ≈ 14.88

// Inverse Otegi mass-radius — the forward relation `radiusFromMass`
// is monotonic per branch, so for catalog rows that arrived with a
// measured radius but no mass column (transit detections), we can
// recover a deterministic best-fit mass:
//   r < 1.213           — rocky branch:    r = m^0.279
//   1.213 ≤ r < ~14.9   — sub-Neptune:     r = 0.808 · m^0.589
//   r ≥ 14.9            — gas plateau:     r = 11.0 (ambiguous)
// The gas plateau is one-to-many; an `id`-seeded log-uniform draw
// over a Jupiter-class mass range fills in. None of the affected
// catalog rows today reach the plateau (the four transit-only rows
// sit at r ∈ {0.6, 1.0}), but the branch keeps the function total.
export function massFromRadius(radius, planetId) {
  if (radius == null || radius <= 0) return null;
  const r = radius;
  if (r < MR_ROCKY_MAX_RADIUS) {
    return Number(Math.pow(r, 1 / OTEGI_MR.rockyExp).toFixed(3));
  }
  if (r < MR_SUBNEP_MAX_RADIUS) {
    return Number(Math.pow(r / OTEGI_MR.subNepCoeff, 1 / OTEGI_MR.subNepExp).toFixed(3));
  }
  // Gas plateau: log-uniform between 130 M⊕ (Saturn-ish) and 3000 M⊕
  // (~10 M_J, near the deuterium burning limit). Salted so the draw
  // is stable per body across builds.
  const prng = partialPrng(planetId, 'gasMass');
  const logM = Math.log(OTEGI_MR.subNepMaxMass) + prng() * (Math.log(3000) - Math.log(OTEGI_MR.subNepMaxMass));
  return Number(Math.exp(logM).toFixed(3));
}

// Synthesize mass + radius for a catalog row that arrived without one
// or both. Two modes:
//   - radius set, mass null: invert M-R via massFromRadius (deterministic,
//     no scatter — the radius itself already pins the body's bulk).
//   - both null: run the architect's disk-physics chain (isolation mass
//     × accretion efficiency × envelope decision) at the body's existing
//     formation orbit, then derive radius forward via Otegi + log-scatter
//     — same posture as buildPlanetCore for procgen siblings, just
//     reseeded so the draws don't collide with architect slot seeds.
//
// Returns null when inputs are missing (no host star, no disk context,
// no semi-major axis even after Kepler derivation). Caller is responsible
// for grafting the returned scalars onto the body and stripping the
// corresponding fields from `_unknowns` so the Filler doesn't overwrite
// the scattered radius with a plain `radiusFromMass(mass)` value.
export function synthesizePartialAnchor(star, body, diskCtx) {
  if (star == null || body == null || diskCtx == null) return null;
  if (body.massEarth != null) return null;
  const formationAu = body.formationAu ?? body.semiMajorAu;
  if (formationAu == null) return null;

  // Mode 1: invert Otegi for transit-only rows (radius known).
  if (body.radiusEarth != null) {
    const m = massFromRadius(body.radiusEarth, body.id);
    if (m == null) return null;
    return { massEarth: m, radiusEarth: body.radiusEarth };
  }

  // Mode 2: full disk-physics synthesis for direct-imaging rows
  // (neither mass nor radius known).
  const dp = massRadiusFromDiskPhysics(
    star, formationAu, diskCtx,
    (salt) => partialPrng(body.id, salt),
  );
  if (dp == null) return null;

  return {
    massEarth: Number(dp.massEarth.toFixed(3)),
    radiusEarth: Number(dp.radiusEarth.toFixed(3)),
  };
}

// Attach moons + (optional) ring to a planet that survived migration.
// Moons inherit the host planet's formation zone for bulk composition —
// a migrated hot Jupiter's moons still carry their outer-zone water,
// volatiles, and metal budget despite the system's hot current orbit.
function attachMoonsAndRing(planet, star, diskCtx) {
  const hostFormationAu = planet.formationAu ?? planet.semiMajorAu;
  const frostLinesAu = diskCtx ? diskCtx.frostLines : null;
  const out = [...generateMoons(planet, star, hostFormationAu, frostLinesAu)];
  const ring = generateRing(planet, hostFormationAu, frostLinesAu);
  if (ring) out.push(ring);
  return out;
}

// Type II disk migration pass. Iterates the planet list, rolls each
// qualifying gas giant (mass ≥ MIGRATION_MIN_MASS_EARTH, formed past
// the H2O frost line) for inward migration. A migrating body's
// semiMajorAu moves to formationAu × MIGRATION_FRACTION (floored at
// MIN_HOT_JUPITER_AU); the body's formationAu stays put. Inner-zone
// companions are swept (Type II migration drags the gas disk and
// gravitationally clears the path).
//
// Mutates planets in place (semiMajorAu, periodDays) and returns the
// surviving list (swept planets removed). Idempotent under stable PRNG
// seeding — re-running with the same disk context produces the same
// migration outcomes.
function migratePass(planets, star, saltPrefix = '') {
  if (planets.length === 0) return planets;
  // Eligibility: massive bodies (cleared the migration mass floor) that
  // formed past the H2O frost line (gas giants accrete their envelope in
  // the icy outer disk — an inside-the-line body that cleared the mass
  // floor is a rocky super-Earth, not a Type-II migrator). The floor
  // models disk-coupling strength, formationAu is the orbital anchor.
  const frostH2O = frostLineTrio(star.mass)?.H2O ?? 0;
  const eligible = planets.filter(p =>
    p.massEarth >= MIGRATION_MIN_MASS_EARTH &&
    p.formationAu != null &&
    p.formationAu > frostH2O);
  if (eligible.length === 0) return planets;

  // One migrator per system, ever. Two-giant hot chains are dynamically
  // unstable on Gyr timescales — observed hot-Jupiter systems almost
  // always have a solo migrator. Earlier per-body rolls produced
  // cascading migration that swept every inner system into a
  // giants-only configuration; that's the variety-killer to avoid.
  //
  // The innermost eligible giant is the migrator candidate: it sits
  // closest to the disk's inner edge and is the most disk-torque-coupled,
  // and its formationAu sets the smallest possible sweep floor so the
  // surviving outer system stays maximally intact.
  const migrator = eligible.reduce((a, b) =>
    a.formationAu < b.formationAu ? a : b);

  const prng = slotPrng(star.id, SYSTEM_SLOT.migration, saltPrefix + 'migration');
  if (prng() >= MIGRATION_RATE) return planets;

  const newA = Math.max(
    MIN_HOT_JUPITER_AU,
    migrator.formationAu * sampleMixture(prng, MIGRATION_FRACTION),
  );
  migrator.semiMajorAu = Number(newA.toFixed(4));
  migrator.periodDays = Number(
    keplerPeriodDays(newA, Math.max(star.mass, 0.01)).toFixed(2),
  );

  // Sweep planets that were in the migrator's path. Type II migration
  // drags the gas disk between the migrator's start (formationAu) and
  // end (semiMajorAu) orbits, clearing companions along the way.
  // Bodies INSIDE the final orbit survive (they were never in the
  // path); bodies OUTSIDE the formation orbit survive (the migrator
  // moved inward, away from them). The swept band is the open
  // interval (semiMajorAu, formationAu). For hot-Jupiter end-states
  // this is essentially the inner system; for stalled warm-Jupiter
  // end-states only the outer-disk band gets cleared, leaving the
  // inner HZ rockies intact so warm-Jupiter + Earth-twin coexistence
  // is possible (the Sol-Jupiter analog at warm orbit).
  return planets.filter(p =>
    p === migrator ||
    p.semiMajorAu <= migrator.semiMajorAu ||
    p.semiMajorAu >= migrator.formationAu);
}

// Partial-system overlay. For stars that already host one or more catalog
// planets, sample a target planet count from PLANET_COUNT_BY_CLASS and
// add procgen siblings at orbits beyond the outermost catalog anchor
// until the count is met. Outer-only because RV / transit detection is
// biased toward short-period planets — the "missing" siblings sit further
// out, not interleaved with what was observed. Also rolls system-level
// belts that generateSystem would have produced if it had run here; the
// catalog provides per-planet anchors but doesn't enumerate belts, so
// they're as detection-biased as the outer planets are. Curated systems
// (Sol) bypass this in the caller — their CSV is authoritative.
//
// `catalogPlanets` is the array of catalog Body objects on this star (in
// CSV order); their `semiMajorAu` anchors the outer walk. Returns a flat
// array of new bodies (planets + moons + rings + belts).
//
// `clusterPlanetBudget` matches generateSystem's semantics — the remaining
// cluster-level budget after earlier members have been processed. The
// budget bounds the target N; catalog anchors past the budget are kept
// (we never prune observed planets), so `toAdd` can still be 0 even when
// existing > budget.
export function generateOverlay(star, catalogPlanets, clusterRole = 'primary', clusterPlanetBudget = Infinity) {
  const cls = star.cls;
  const countSpec = PLANET_COUNT_BY_CLASS[cls];
  const geom = ORBITAL_GEOMETRY_BY_CLASS[cls];
  if (!countSpec || !geom) return [];

  const out = [];

  // Target planet count from the same prior the architect uses, with the
  // same cluster-role suppression. Independent seed so a star moving
  // between the architect and overlay code paths (would only happen if
  // curation status changed) doesn't reuse a draw.
  const countPrng = slotPrng(star.id, -1, 'overlay_planet_count');
  const rawN = sampleTruncated(countPrng, countSpec, true);
  const suppression = COMPANION_PLANET_SUPPRESSION[clusterRole] ?? 1.0;
  const N = Math.max(0, Math.min(clusterPlanetBudget, countSpec.max, Math.round(rawN * suppression)));
  const existing = catalogPlanets.length;
  const toAdd = Math.max(0, N - existing);

  const diskCtx = buildStarDiskContext(star);
  if (toAdd > 0) {
    let outermost = -Infinity;
    for (const p of catalogPlanets) {
      if (p.semiMajorAu != null && p.semiMajorAu > outermost) outermost = p.semiMajorAu;
    }
    // Without a usable anchor the outer walk has nowhere to start. Skip
    // the planet additions; system-level belts still roll below since
    // they don't depend on existing orbits.
    if (Number.isFinite(outermost) && outermost < geom.outerEdgeAu) {
      // Letters: continue past whatever the catalog already uses. The
      // catalog convention is `${star.id}-${letter}`; we skip any that
      // are already taken so the overlay never collides with the
      // observed system's IAU labels.
      const usedLetters = new Set();
      const prefix = star.id + '-';
      for (const p of catalogPlanets) {
        if (p.id.startsWith(prefix)) usedLetters.add(p.id.slice(prefix.length));
      }
      let letterCursor = existing;
      const allocLetter = () => {
        while (true) {
          const letter = planetLetterAt(letterCursor++);
          if (!usedLetters.has(letter)) {
            usedLetters.add(letter);
            return letter;
          }
        }
      };

      let a = outermost;
      for (let i = 0; i < toAdd; i++) {
        const slotIdx = existing + i;
        const ratioPrng = slotPrng(star.id, slotIdx, 'overlay_spacing');
        const periodRatio = Math.exp(sampleNormal(ratioPrng, Math.log(geom.spacingRatio.mean), geom.spacingRatio.sd));
        a *= Math.pow(periodRatio, 2 / 3);
        if (a > geom.outerEdgeAu) break;
        // No migration on overlay path — catalog anchors fix observed
        // positions, and overlay siblings are outer-only additions that
        // wouldn't have time to migrate anyway.
        const p = buildPlanetCore(star, slotIdx, a, allocLetter(), 'overlay_', diskCtx);
        if (p) {
          out.push(p);
          out.push(...attachMoonsAndRing(p, star, diskCtx));
        }
      }
    }
  }

  // System-level belts. generateSystem fires these for architect-eligible
  // stars; catalog-anchored stars went through this path instead, so the
  // overlay carries the same responsibility. Combine catalog planets +
  // procgen siblings so giant detection sees the full picture (a system
  // whose only giant is a catalog row shouldn't read as giantless).
  const allPlanets = [
    ...catalogPlanets,
    ...out.filter(b => b.kind === 'planet'),
  ];
  out.push(...generateBelts(star, allPlanets));

  return out;
}
