// System Architect — top-down sampling of planetary systems for stars
// with no catalog bodies. Reads priors from procgen-priors.mjs; emits
// new body records (planets + their moons) ready to concatenate with
// the catalog-sourced rows before attachBodies + fillBodies.
//
// One pure entry point: generateSystem(star) → Body[]. Determinism via
// per-(star, slot, field) seeds; PROCGEN_VERSION mixed in so bumping it
// reseeds the whole galaxy.
//
// v1 fills anchors (semiMajorAu, massEarth, radiusEarth, periodDays) plus
// flavor (eccentricity, inclination, axial tilt, orbital phase). Surface
// character, atmosphere, resources, biosphere are left as `_unknowns`
// for the Filler (procgen.mjs) to derive.

import { hash32, mulberry32, sampleNormal, sampleTruncated, sampleLogTruncated, samplePhysical, sampleMixture, samplePoisson } from './prng.mjs';
import { insolation, frostLineAU, solidSurfaceDensity, isolationMass, hillRadiusAu } from './astrophysics.mjs';
import { radiusFromMass } from './procgen.mjs';
import {
  PROCGEN_VERSION,
  PLANET_COUNT_BY_CLASS,
  COMPANION_PLANET_SUPPRESSION,
  ORBITAL_GEOMETRY_BY_CLASS,
  SNOW_LINE_TEMPERATURES,
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
  MOON_CAPACITY_SCALE,
  MOON_COUNT_MAX,
  MOON_MASS_LOG_EARTH,
  MOON_MAX_HOST_MASS_RATIO,
  zoneForFormationAu,
  BULK_WATER_FRACTION_BY_ZONE,
  BULK_METAL_FRACTION_BY_ZONE,
  BULK_VOLATILE_FRACTION_BY_ZONE,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
  BELT_OCCURRENCE_BY_CLASS,
  BELT_PLACEMENT,
  BELT_RESOURCE_PRIORS,
  BELT_LARGEST_BODY_KM,
  BELT_GIANT_ADJACENCY,
  GIANTLESS_BELT_PENALTY,
  SHEPHERD_MIN_MASS_EARTH,
  RING_DISRUPTION_RATE,
  RING_EXTENT,
  RING_RESOURCE_ICY,
  RING_RESOURCE_ROCKY,
} from './procgen-priors.mjs';

// =============================================================================
// Sampling helpers
// =============================================================================

// Per-(star, slot, salt) PRNG. slot=-1 reserved for system-level draws
// (planet count, etc.) that aren't tied to a specific orbital slot.
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

// Sample a body's bulkWaterFraction (0..1 H₂O mass fraction) keyed on
// the formation zone — which snow lines the body accreted past. Threads
// formationAu + frostLinesAu rather than current insolation, so a
// migrated hot Jupiter still draws its outer-zone water budget.
// Sub-Mercury-or-airless bodies still draw the floor of their zone —
// composition is set at formation and persists, even if surface state
// later reads as "dry."
function sampleBulkWaterFraction(prng, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(prng, BULK_WATER_FRACTION_BY_ZONE[zone]).toFixed(5));
}

// Refractory metals condense first in the protoplanetary disk; bodies
// forming inside_H2O draw from a metal-rich distribution, each further
// zone dilutes metal fraction as more volatiles join the solid budget.
// Independent per-body draw — moons sample independently, same posture
// as bulkWater.
function sampleBulkMetalFraction(prng, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(prng, BULK_METAL_FRACTION_BY_ZONE[zone]).toFixed(5));
}

// Non-water condensable volatile inventory (NH3, CH4, CO/CO2, N2,
// organics). Climbs past each successive snow line: inside_H2O has only
// the refractory-trapped fraction; past CH4 it dominates. Feeds
// atmosphere regime decisions and methane-world variety.
function sampleBulkVolatileFraction(prng, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(prng, BULK_VOLATILE_FRACTION_BY_ZONE[zone]).toFixed(5));
}

// Per-(star, context, salt) PRNG. Belts are system-level structural
// features — one per context (discrete_warm, discrete_cold,
// collisional_warm, collisional_cold) per star at most — so the slot
// key is the context name rather than an index.
function beltPrng(starId, context, salt) {
  return mulberry32(hash32(`${starId}:belt:${context}:${salt}:${PROCGEN_VERSION}`));
}

// Per-(planet, salt) PRNG for ring sampling. Like moonPrng, keyed off
// the planet id so both architect-built and backfilled-catalog rings
// share the same seeding scheme.
function ringPrng(planetId, salt) {
  return mulberry32(hash32(`${planetId}:ring:${salt}:${PROCGEN_VERSION}`));
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
// Returns null on missing inputs — callers fall back to legacy behavior
// would-be, but every real catalog star has mass + class so this is
// defensive against future stripped-down callers, not a hot path.
function buildStarDiskContext(star) {
  if (star == null || star.mass == null) return null;
  const cls = star.cls;
  const gasSpec = DISK_GAS_LIFETIME_MYR[cls] ?? DISK_GAS_LIFETIME_MYR.G;
  const gasPrng = slotPrng(star.id, -1, 'disk_gas_lifetime');
  const diskGasLifetimeMyr = sampleTruncated(gasPrng, gasSpec);
  return {
    frostLines: {
      H2O: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.H2O),
      NH3: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.NH3),
      CH4: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.CH4),
    },
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
  'chromophoreGas', 'chromophoreFrac',
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
  'biosphereArchetype', 'biosphereTier',
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
    chromophoreGas: null, chromophoreFrac: null,
    resMetals: null, resSilicates: null, resVolatiles: null,
    resRareEarths: null, resRadioactives: null, resExotics: null,
    biosphereArchetype: null, biosphereTier: null,
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
// Count is Poisson(λ) with λ = R_H × MOON_CAPACITY_SCALE, where R_H is
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
  const lambda = hillAu * MOON_CAPACITY_SCALE;
  const countPrng = moonPrng(planet.id, -1, 'count');
  const N = Math.min(MOON_COUNT_MAX, samplePoisson(countPrng, lambda));
  if (N === 0) return [];

  const moons = [];
  for (let mIdx = 0; mIdx < N; mIdx++) {
    const massPrng = moonPrng(planet.id, mIdx, 'mass');
    const orbitPrng = moonPrng(planet.id, mIdx, 'orbit');
    const phasePrng = moonPrng(planet.id, mIdx, 'phase');
    const eccPrng = moonPrng(planet.id, mIdx, 'ecc');
    const incPrng = moonPrng(planet.id, mIdx, 'inc');
    const tiltPrng = moonPrng(planet.id, mIdx, 'tilt');
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
    const radiusEarth = Math.pow(massEarth * 5.5 / 3.0, 1 / 3);  // ρ≈3 g/cm³ vs Earth's 5.5

    // Orbital distance: starts inside Roche-ish, spreads out with each slot
    // by ~factor 1.6. Galilean spacing is ~1.4–1.8x consecutive.
    const baseA = 0.002;
    const semiMajorAu = baseA * Math.pow(1.6, mIdx) * (0.8 + orbitPrng() * 0.4);
    // Kepler in days, Earth-mass planet at 1 AU around Sol = 365.25 days
    // (P² = a³ / M_host_solar). Convert to moon-around-planet: M_host is
    // the planet's mass in solar units (massEarth / 333000).
    const periodDays = 365.25 * Math.sqrt(Math.pow(semiMajorAu, 3) / (planet.massEarth / 333000));

    moons.push(makeBody({
      id: `${planet.id}-m${mIdx + 1}`,
      hostId: planet.id,
      kind: 'moon',
      formalName: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      name: `${planet.formalName} ${ROMAN[mIdx] ?? `M${mIdx + 1}`}`,
      source: 'procgen',
      semiMajorAu: Number(semiMajorAu.toFixed(5)),
      eccentricity: Number(sampleMixture(eccPrng, ECCENTRICITY).toFixed(4)),
      inclinationDeg: Number(sampleTruncated(incPrng, INCLINATION_DEG).toFixed(2)),
      periodDays: Number(periodDays.toFixed(3)),
      orbitalPhaseDeg: Number((phasePrng() * 360).toFixed(2)),
      axialTiltDeg: Number(sampleTruncated(tiltPrng, AXIAL_TILT_DEG).toFixed(2)),
      massEarth: Number(massEarth.toFixed(4)),
      radiusEarth: Number(radiusEarth.toFixed(4)),
      bulkWaterFraction: sampleBulkWaterFraction(bulkWaterPrng, hostFormationAu, frostLinesAu),
      bulkMetalFraction: sampleBulkMetalFraction(bulkMetalPrng, hostFormationAu, frostLinesAu),
      bulkVolatileFraction: sampleBulkVolatileFraction(bulkVolatilePrng, hostFormationAu, frostLinesAu),
    }));
  }
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

// Identify the giant(s) in a placed-planet list (innermost + outermost).
// Mass gates membership at SHEPHERD_MIN_MASS_EARTH; sub-Neptune mass is
// enough to anchor a belt's resonances even without a Jupiter-equivalent.
// Returns null fields when no giants exist, signaling generateBelts to
// apply the giantless penalty path.
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
// belts use it to anchor adjacent to the system's giants and record a
// shepherd. Without a giant the occurrence is multiplied by
// GIANTLESS_BELT_PENALTY[context] before the roll, and placement falls
// back to BELT_PLACEMENT's system-edge-scaled band. Shepherded belts
// get a larger-parent-body size draw; free-float belts get a dust-
// cascade-scale size draw — see BELT_LARGEST_BODY_KM.
//
// Exported so the catalog backfill in build-catalog.mjs could add belts
// to partially-observed catalog stars later (v1 only emits during
// generateSystem and generateOverlay).
export function generateBelts(star, placedPlanets = []) {
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
    const penalty = hasShepherd ? 1.0 : GIANTLESS_BELT_PENALTY[context];
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
    const centerAu = (innerAu + outerAu) / 2;

    // Mass: log-uniform between placement.mass.min and .max.
    const massPrng = beltPrng(star.id, context, 'mass');
    const logMin = Math.log10(placement.mass.min);
    const logMax = Math.log10(placement.mass.max);
    const massEarth = Math.pow(10, logMin + massPrng() * (logMax - logMin));

    // Resources: per-field truncated normal from BELT_RESOURCE_PRIORS.
    // Carries composition signal — the renderer reads it back to lerp
    // chunk color between rocky-tan and icy-cyan.
    const resPriors = BELT_RESOURCE_PRIORS[context];
    const resources = {};
    for (const field of Object.keys(resPriors)) {
      const prng = beltPrng(star.id, context, `res_${field}`);
      resources[field] = Math.round(sampleTruncated(prng, resPriors[field]));
    }

    // largestBodyKm: log-uniform within the shepherding-conditional
    // range. Shepherded belts pull from the parent-body scale (Ceres/
    // Pluto class); free-float belts pull from the dust-cascade scale
    // (tens of km max). Captures the real bimodality of belt
    // populations without exposing a discrete enum.
    const kmRange = BELT_LARGEST_BODY_KM[context][hasShepherd ? 'shepherded' : 'freeFloat'];
    const sizePrng = beltPrng(star.id, context, 'largest');
    const logKmMin = Math.log10(kmRange.min);
    const logKmMax = Math.log10(kmRange.max);
    const largestBodyKm = Math.pow(10, logKmMin + sizePrng() * (logKmMax - logKmMin));

    const composition = describeBeltComposition(resources);
    const formal = `${star.name} ${describeBeltLocation(centerAu)} ${composition} Belt`;
    belts.push(makeBody({
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
    }));
  }
  return belts;
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
  const resPriors = isIcy ? RING_RESOURCE_ICY : RING_RESOURCE_ROCKY;
  const resources = {};
  for (const field of Object.keys(resPriors)) {
    const fSpec = resPriors[field];
    if (fSpec.max === 0 || (fSpec.mean === 0 && fSpec.sd === 0)) {
      resources[field] = 0;
      continue;
    }
    const rp = ringPrng(planet.id, `res:${field}`);
    resources[field] = Math.round(sampleTruncated(rp, fSpec));
  }

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
  const countPrng = slotPrng(star.id, -1, 'planet_count');
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
  const prng = slotPrng(starId, -2, 'prune');
  const arr = planets.slice();
  // Partial shuffle of the last K slots: swap arr[i] with a random
  // index in [0..i]. After K swaps, arr.slice(-K) is a uniform K-subset.
  for (let i = arr.length - 1; i >= arr.length - K; i--) {
    const j = Math.floor(prng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(-K).sort((a, b) => a.semiMajorAu - b.semiMajorAu);
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
  const S = insolation(star.mass, formationAu);

  // Continuous mass pipeline:
  //   isolation mass (zone physics) → core mass (× accretion efficiency)
  //   → gas-envelope decision (mass + frost-line + disk-gas gates)
  //   → total mass → radius
  const Σ = solidSurfaceDensity(
    star.mass, formationAu, diskCtx.frostLines, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS,
  );
  const mIso = isolationMass(formationAu, star.mass, Σ);
  if (mIso == null || mIso <= 0) return null;

  const accPrng = slotPrng(star.id, slotIdx, saltPrefix + 'accretion');
  const accZone = formationAu < diskCtx.frostLines.H2O ? 'inner' : 'outer';
  const coreMass = mIso * samplePhysical(accPrng, ACCRETION_EFFICIENCY[accZone]);

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
    const envPrng = slotPrng(star.id, slotIdx, saltPrefix + 'envelope');
    const envRatio = sampleLogTruncated(envPrng, ENVELOPE_FRACTION);
    envelopeMass = coreMass * envRatio;
  }
  const massEarth = coreMass + envelopeMass;

  // Radius from the Otegi mass-radius relation plus a single composition-
  // agnostic log-scatter. The piecewise mean (rocky line below 2 M⊕, ice
  // line below 130, gas plateau above) already encodes the bulk of
  // density variety; remaining scatter is the per-body composition noise.
  const radiusPrng = slotPrng(star.id, slotIdx, saltPrefix + 'radius');
  const meanRadius = radiusFromMass(massEarth) ?? 1.0;
  const noisyRadius = meanRadius * Math.exp(sampleNormal(radiusPrng, 0, RADIUS_SCATTER_LOG));
  const radiusEarth = Math.max(0.1, Math.min(30, noisyRadius));

  const eccPrng = slotPrng(star.id, slotIdx, saltPrefix + 'eccentricity');
  const incPrng = slotPrng(star.id, slotIdx, saltPrefix + 'inclination');
  const tiltPrng = slotPrng(star.id, slotIdx, saltPrefix + 'axial_tilt');
  const phasePrng = slotPrng(star.id, slotIdx, saltPrefix + 'orbital_phase');
  const bulkWaterPrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_water');
  const bulkWaterFraction = sampleBulkWaterFraction(bulkWaterPrng, formationAu, diskCtx.frostLines);
  const bulkMetalPrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_metal');
  const bulkMetalFraction = sampleBulkMetalFraction(bulkMetalPrng, formationAu, diskCtx.frostLines);
  const bulkVolatilePrng = slotPrng(star.id, slotIdx, saltPrefix + 'bulk_volatile');
  const bulkVolatileFraction = sampleBulkVolatileFraction(bulkVolatilePrng, formationAu, diskCtx.frostLines);

  // Kepler: P² = a³ / M_host_solar. Computed against semiMajorAu (which
  // currently equals formationAu); the migration pass recomputes period
  // for any body whose semiMajorAu moves.
  const periodDays = 365.25 * Math.sqrt(Math.pow(formationAu, 3) / Math.max(star.mass, 0.01));

  return makeBody({
    id: `${star.id}-${letter}`,
    hostId: star.id,
    kind: 'planet',
    formalName: `${star.name} ${letter}`,
    name: `${star.name} ${letter}`,
    source: 'procgen',
    semiMajorAu: Number(formationAu.toFixed(4)),
    formationAu: Number(formationAu.toFixed(4)),
    eccentricity: Number(sampleMixture(eccPrng, ECCENTRICITY).toFixed(4)),
    inclinationDeg: Number(sampleTruncated(incPrng, INCLINATION_DEG).toFixed(2)),
    periodDays: Number(periodDays.toFixed(2)),
    orbitalPhaseDeg: Number((phasePrng() * 360).toFixed(2)),
    axialTiltDeg: Number(sampleTruncated(tiltPrng, AXIAL_TILT_DEG).toFixed(2)),
    massEarth: Number(massEarth.toFixed(3)),
    radiusEarth: Number(radiusEarth.toFixed(3)),
    bulkWaterFraction,
    bulkMetalFraction,
    bulkVolatileFraction,
  });
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
  // carry a formation orbit. Both gates are required — the floor models
  // disk-coupling strength, formationAu is the orbital anchor.
  const eligible = planets.filter(p =>
    p.massEarth >= MIGRATION_MIN_MASS_EARTH && p.formationAu != null);
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

  const prng = slotPrng(star.id, -3, saltPrefix + 'migration');
  if (prng() >= MIGRATION_RATE) return planets;

  const newA = Math.max(
    MIN_HOT_JUPITER_AU,
    migrator.formationAu * sampleTruncated(prng, MIGRATION_FRACTION),
  );
  migrator.semiMajorAu = Number(newA.toFixed(4));
  migrator.periodDays = Number(
    (365.25 * Math.sqrt(Math.pow(newA, 3) / Math.max(star.mass, 0.01))).toFixed(2),
  );

  // Sweep planets whose current orbit sits inside the migrator's
  // formation distance. The migrator itself is kept.
  return planets.filter(p => p === migrator || p.semiMajorAu >= migrator.formationAu);
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
