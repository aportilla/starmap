// Body Filler — derives empty body fields from anchors + physics + small
// seeded PRNGs. Reads tuning knobs from procgen-priors.mjs. Pure functions;
// build-catalog.mjs wires the result into the JSON output.
//
// Each body's empties are tracked in `_unknowns` during CSV parse (cells
// that were literally blank, not 'n/a'). The Filler only fills fields in
// that set; 'n/a' cells stay null forever. `_unknowns` is stripped before
// JSON emit so the runtime sees a clean `T | null` shape.
//
// Per-field seeding: hash32(body.id + ':' + field + ':' + PROCGEN_VERSION).
// Bumping PROCGEN_VERSION reseeds the whole galaxy without changing CSV ids.
//
// ─── fillBody pipeline (run in this order) ───────────────────────────
//
// Each pass reads settled state from earlier passes, so order matters.
// `worldClass` is derived LAST — it's a pure label off final physical
// state, never an input to physics.
//
//   1.  Kepler round-trip       periodDays ↔ semiMajorAu via P² = a³/M
//   2.  radiusEarth             Otegi piecewise (catalog rows only)
//   3.  Bulk composition        bulk{Water,Metal,Volatile}Fraction
//                               from four-zone formation gate
//   4.  Orbital flavor          eccentricity (mixture), inclination,
//                               axialTilt, orbitalPhase
//   5.  Interior + rotation     tectonicActivity (mass-driven),
//                               rotationPeriodHours (+ tidal lock),
//                               magneticFieldGauss (mass-cap × dynamo)
//   6.  surfacePressureBar      outgassing × atm-retention ×
//                               pressure-history mixture
//   7.  T ↔ albedo ↔ cover      Two-pass iteration. Pass A uses the
//                               pressure-proxy greenhouse, Pass B
//                               refines with per-gas potency once atm
//                               composition is known.
//                               Sub-steps inside each pass:
//                                 surfaceLiquidWaterCover (T ∈ [273, Tboil(P)])
//                                 surfaceIceCover         (cold-trap OR polar-cap)
//   8.  surfaceAge              tect^exp × noise + tidal lift for
//                               eccentric moons of giants
//   9.  Pre-atm biotic          bioticCarbonAqueous (drives biotic O₂
//                               lift in step 10), bioticSubsurfaceAqueous.
//                               Both run pre-atm because they don't read
//                               atm composition.
//   10. atm1..atm3 + fractions  Regime dispatch on (radius, T, P, bulkWater)
//                               into primary / cold_outgassed /
//                               thick_outgassed / wet_outgassed /
//                               dry_outgassed. Top-3 species with Jeans-
//                               escape filter + continuous biotic O₂ lift.
//   11. cloud + haze            cloudDecksFor walks CONDENSABLES (per-
//                               species condensation gates); hazeFor
//                               walks aerosol species + dust gate.
//   12. worldClass              worldClassFor — pure label off settled
//                               state. Terrestrial cascade splits
//                               frozen bodies into `ice` (water-ice
//                               dominant) vs `carbon` (methane-frost
//                               dominant) per bulkVolatile vs bulkWater.
//   13. Resources               Two notable mineral deposits drawn per
//                               body from a context-weighted occurrence
//                               table (RESOURCE_OCCURRENCE); the other
//                               four resource fields stay 0. See
//                               resourcesFor for the draw + abundance.
//   14. Post-atm biotic         bioticAerial (Sagan floaters on gas
//                               giants), bioticCryogenic (Titan-class),
//                               bioticSilicate (hot rocky), bioticSulfur
//                               (Io / Venus cloud). Then the three
//                               biosphere display fields resolve via
//                               one of two paths: CSV-authored (the
//                               row populated `biosphere_archetype` +
//                               `biosphere_complexity` — used as-is),
//                               or procgen-derived (both cells blank
//                               — argmax over the six scalars + per-
//                               archetype complexity thresholds).
//                               surfaceImpact is always derived from
//                               productivity × per-body coupling.
//                               See procgen-priors.mjs biosphere
//                               section for the full model.
//
// Moons traverse the same passes as planets. Tidal heating only enters
// via the step-8 surface-age lift for eccentric moons of giants; every
// other input is shared between planets and moons.

import { hash32, mulberry32, sampleNormal, sampleTruncated, sampleLogTruncated, sampleMixture, drawWeightedDeposits } from './prng.mjs';
import { GAS_POTENCY } from './gas-potency.mjs';
import {
  PROCGEN_VERSION,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
  sampleBulkFraction,
  CLOUD_DECK,
  HAZE_GATES,
  DUST_GATE,
  PAR_BY_CLASS,
  BIOSPHERE_PRODUCTIVITY,
  BULK_WATER_FRACTION_BY_ZONE,
  BULK_METAL_FRACTION_BY_ZONE,
  BULK_VOLATILE_FRACTION_BY_ZONE,
  ALBEDO_COMPONENTS,
  CLOUD_BY_GAS,
  GREENHOUSE,
  GREENHOUSE_POTENCY_BY_GAS,
  TECTONIC_BASE,
  SURFACE_AGE_FROM_TECTONIC,
  SURFACE_AGE_TIDAL_LIFT,
  ROTATION_INIT_HOURS,
  TIDAL_LOCK_RANGE,
  TEMP_SWING,
  MAGNETIC_FIELD,
  ATMOSPHERE_GASES_BY_REGIME,
  ATMOSPHERE_REGIME_THRESHOLDS,
  ATMOSPHERE_MIN_PRESSURE_BAR,
  GAS_MOLECULAR_WEIGHT_AMU,
  ATMOSPHERIC_RETENTION,
  OUTGASSING,
  PRESSURE_HISTORY_MULTIPLIER,
  TRIPLE_POINT_BAR,
  BOILING_POINT_ANCHORS,
  SURFACE_WATER_SAT,
  SURFACE_ICE_SAT,
  POLAR_CAP,
  COLD_TRAP,
  WATER_COVER_NOISE,
  ICE_COVER_NOISE,
  WORLD_CLASS_THRESHOLDS,
  CONDENSABLES,
  COMPLEXITY_THRESHOLDS,
  ARCHETYPE_COUPLING_PRIOR,
  LIFE_SURFACE_CONTRIBUTION,
  MICROBIAL_SURFACE_CONTRIBUTION,
  BIOSPHERE_ARCHETYPES,
  BIOSPHERE_COMPLEXITY,
  RESOURCE_OCCURRENCE,
  RESOURCE_KEYS,
  OTEGI_MR,
} from './procgen-priors.mjs';

const VALID_ARCHETYPES = new Set(BIOSPHERE_ARCHETYPES);
const VALID_COMPLEXITY = new Set(BIOSPHERE_COMPLEXITY);
import { insolation, jeansEscapeRatio, tidalLockProxy, meanMetallicityForClass, meanAgeForClass, frostLineTrio, keplerPeriodDays, deriveSemiMajorAu, EARTH_PER_SOLAR_MASS, SIGMA_SB, SOLAR_CONSTANT } from './astrophysics.mjs';

function fieldPrng(body, field) {
  return mulberry32(hash32(`${body.id}:${field}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Physics helpers
// =============================================================================

// Mean molecular weight (amu) of the representative atmospheric
// species used in the Jeans-escape ratio. N2 is the canonical anchor
// — it dominates Earth, Titan, and Triton retained atmospheres. Lighter
// species (H2, He) escape more easily; heavier (CO2) retain longer.
// One-species model is the agreed-on simplification for Phase 2.
const RETENTION_SPECIES_AMU = 28;

function smoothstep(a, b, x) {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

// Bare equilibrium temperature (K) — Stefan-Boltzmann with a fixed
// generic albedo. Used by atmosphericRetention to break the
// chicken-and-egg with avgSurfaceTempFor (which depends on
// surfacePressureBar via the greenhouse factor). The generic 0.3
// albedo is close enough for retention purposes — the sigmoid is
// gentle on a ±20 K input shift.
function equilibriumTempK(S, bondAlbedo = 0.3) {
  if (S == null) return null;
  return Math.pow((S * SOLAR_CONSTANT * (1 - bondAlbedo)) / (4 * SIGMA_SB), 0.25);
}

// =============================================================================
// Mass → Radius
// =============================================================================

// Piecewise mass-radius relation. Real distributions have scatter from
// composition (water vs. silicate vs. iron-rich); these power laws hit
// the mean of the observed cloud well enough that downstream worldClass
// classification lands in the right bucket for catalog rows missing
// radiusEarth.
//
//   M < 2 M⊕      → R = M^0.279         Otegi 2020 rocky line
//   2 ≤ M < 130   → R = 0.808 · M^0.589  Otegi 2020 volatile-rich / ice line
//   M ≥ 130       → R ≈ 11 R⊕            gas-giant plateau (degeneracy pressure)
//
// At 1 M_jup ≈ 318 M⊕ real Jupiter is ~11.2 R⊕; the plateau persists up
// to ~80 M_jup before brown-dwarf compression bends the curve back down.
// We don't model brown dwarfs as planets, so the flat plateau is fine.
export function radiusFromMass(massEarth) {
  if (massEarth == null || massEarth <= 0) return null;
  const m = massEarth;
  if (m < OTEGI_MR.rockyMaxMass)  return Number(Math.pow(m, OTEGI_MR.rockyExp).toFixed(3));
  if (m < OTEGI_MR.subNepMaxMass) return Number((OTEGI_MR.subNepCoeff * Math.pow(m, OTEGI_MR.subNepExp)).toFixed(3));
  return OTEGI_MR.giantRadius;
}

// The shared orbital-flavor draw: eccentricity (mixture), inclination and
// axial tilt (truncated normals), and a uniform orbital phase, each with the
// catalog's field rounding baked in. Three call sites feed it their own PRNGs
// — architect planets, architect moons, and the Filler backfill — so the draw
// shape and rounding live once. Each field reads an independent stream, so the
// order they're drawn here is immaterial; the caller owns stream identity.
export function sampleOrbitalFlavor({ eccPrng, incPrng, tiltPrng, phasePrng }) {
  return {
    eccentricity: Number(sampleMixture(eccPrng, ECCENTRICITY).toFixed(4)),
    inclinationDeg: Number(sampleTruncated(incPrng, INCLINATION_DEG).toFixed(2)),
    axialTiltDeg: Number(sampleTruncated(tiltPrng, AXIAL_TILT_DEG).toFixed(2)),
    orbitalPhaseDeg: Number((phasePrng() * 360).toFixed(2)),
  };
}

// =============================================================================
// World-class derivation — pure label off settled physical state (Phase 4)
// =============================================================================

// `worldClass` is a label derived from settled physical state — radius,
// temperature, surface cover, bulk composition, atmosphere. NOTHING in
// the physics pipeline reads it as an input. It's consumed only by
// renderer-side palettes and UI labels. A class change shifts which
// label shows; never what the planet IS.
//
// The 14-label taxonomy carves the (mass × radius × T × P × water × ice
// × bulkWater × bulkMetal × atm) hypercube into visually + gameplay
// distinct cells. Each branch is a priority-ordered physical gate;
// the first match wins.
//
// Returns null when inputs are missing; callers leave the field null.
export function worldClassFor(body, S) {
  const r = body.radiusEarth;
  if (r == null) return null;
  const T = body.avgSurfaceTempK;
  const water = body.waterFraction ?? 0;
  const ice = body.iceFraction ?? 0;
  const bulkMetal = body.bulkMetalFraction ?? 0;
  const bulkWater = body.bulkWaterFraction ?? 0;
  const mass = body.massEarth ?? 0;
  const tect = body.tectonicActivity ?? 0;
  const W = WORLD_CLASS_THRESHOLDS;

  // ─── Gaseous bracket (radius ≥ gasDwarfRadius) ───
  if (r >= W.gasDwarfRadius) {
    // Hycean takes priority across the entire gaseous bracket: cold +
    // water-rich + H2 atm. K2-18b-class. Above r=Neptune the bulk
    // composition is enough to override the ice_giant label.
    if (T != null && T < W.hyceanTempCeilingK &&
        bulkWater >= W.hyceanBulkWaterMin &&
        body.atm1 === 'H2') {
      return 'hycean';
    }
    // Helium: He-dominant AND H2 absent from top-3 (post-H-stripping
    // survivor — real helium planets need H2 fully gone, not just
    // outweighed in the random draw).
    if (body.atm1 === 'He' && body.atm2 !== 'H2' && body.atm3 !== 'H2') {
      return 'helium';
    }
    // Default size-based gaseous taxonomy.
    if (r >= W.jupiterRadius) return 'gas_giant';
    if (r >= W.neptuneRadius) {
      if (T != null && T <= W.iceGiantTempCeilingK) return 'ice_giant';
      return 'gas_dwarf';
    }
    return 'gas_dwarf';
  }

  // ─── Terrestrial bracket (radius < gasDwarfRadius) ───
  if (T == null) return null;
  // Lava: sustained molten surface
  if (T >= W.lavaTempFloorK) return 'lava';
  // Chthonian: stripped giant core — checked BEFORE magma_ocean because
  // chthonian IS a hot iron-rich body; the specific stripped-giant
  // signature (close-in + massive + metal-dominant) wins over the
  // generic "hot+active" magma_ocean label.
  if (S != null && S >= W.chthonianInsolationMin &&
      mass >= W.chthonianMassMin &&
      bulkMetal >= W.chthonianMetalMin) {
    return 'chthonian';
  }
  // Magma ocean: hot + active interior, not yet fully molten
  if (T >= W.magmaOceanTempFloorK && tect >= W.magmaOceanTectMin) return 'magma_ocean';
  // Iron: metal-dominant interior (Mercury-class super-iron)
  if (bulkMetal >= W.ironMetalMin) return 'iron';
  // Carbon: methane/volatile-dominated frozen body — checked BEFORE
  // ice because a body with high iceFraction and bulkVolatile >
  // bulkWater is a methane/N2-frost world (Pluto/Triton/Eris), not a
  // water-ice shell. Same surface-cover gate, different bulk inventory.
  const bulkVolatile = body.bulkVolatileFraction ?? 0;
  if (ice >= W.iceIceMin && water < W.iceWaterCeiling &&
      bulkVolatile > bulkWater &&
      bulkVolatile >= W.carbonBulkVolatileMin) {
    return 'carbon';
  }
  // Ice: surface ice dominant, water-ice-dominated bulk (Callisto/
  // Ganymede/Europa-shell).
  if (ice >= W.iceIceMin && water < W.iceWaterCeiling) return 'ice';
  // Ocean: surface liquid water dominant (Europa/Ganymede/Earth)
  if (water >= W.oceanWaterFloor) return 'ocean';
  // Solid giant: large rocky terrestrial
  if (mass >= W.solidGiantMassMin && r >= W.solidGiantRadiusMin) return 'solid_giant';
  // Desert: both water + ice low
  if (water < W.desertWaterCeiling && ice < W.desertIceCeiling) return 'desert';
  // Default: ordinary rocky terrestrial
  return 'rocky';
}

// =============================================================================
// Surface character (temperature, pressure)
// =============================================================================

// Triangular-bell temperature gate around a condensation window — 1.0
// inside [lo, hi], ramping smoothly to 0 outside via a 30K skirt.
// Captures "this gas forms clouds in this T range".
function tempCondenseFactor(T, lo, hi) {
  if (T == null) return 0;
  const upRamp   = smoothstep(lo - 30, lo, T);
  const downRamp = 1 - smoothstep(hi, hi + 30, T);
  return Math.max(0, Math.min(1, upRamp * downRamp));
}

// Pass A cloud bump — bulkWater proxy. Used as the initial estimate
// before atm composition is computed. Captures Earth-class H2O clouds
// in the temperate band; misses everything else (Titan tholin, Venus
// H2SO4, Mars dust). Pass B refines via CLOUD_BY_GAS once atm settles.
function cloudBumpFromBulkWater(body) {
  const bulk = body.bulkWaterFraction ?? 0;
  const T = body.avgSurfaceTempK;
  if (bulk <= 0 || T == null) return 0;
  const bulkFactor = Math.min(1, bulk / ALBEDO_COMPONENTS.cloudSatBulkWater);
  const tempFactor = tempCondenseFactor(T, ALBEDO_COMPONENTS.cloudTempMin, ALBEDO_COMPONENTS.cloudTempMax);
  return bulkFactor * tempFactor * ALBEDO_COMPONENTS.cloudBoost;
}

// Pass B cloud bump — per-gas potency × partial pressure × T-window,
// summed across atm1/2/3. The cloud condensate species, when distinct
// from atm species, has its visible cover counted via cloudCoverage
// (not here).
function cloudBumpFromComposition(body) {
  const P = body.surfacePressureBar ?? 0;
  const T = body.avgSurfaceTempK;
  if (P <= 0 || T == null) return 0;
  let bump = 0;
  const addContribution = (gas, frac) => {
    if (!gas || frac == null || frac <= 0) return;
    const cloud = CLOUD_BY_GAS[gas];
    if (!cloud) return;
    const tFactor = tempCondenseFactor(T, cloud.condenseLow, cloud.condenseHigh);
    if (tFactor <= 0) return;
    const partial = P * frac;
    const pFactor = Math.min(1, partial / cloud.pSat);
    bump += cloud.maxBump * tFactor * pFactor;
  };
  for (const [gasField, fracField] of [
    ['atm1', 'atm1Frac'],
    ['atm2', 'atm2Frac'],
    ['atm3', 'atm3Frac'],
  ]) {
    const gas = body[gasField];
    if (gas) {
      addContribution(gas, body[fracField]);
    }
  }
  // Cap total cloud bump — even a fully overcast Venus-class atm
  // can't push surface-blend albedo past clean-snow territory.
  return Math.min(bump, ALBEDO_COMPONENTS.cloudBumpMax);
}

// Bond albedo — surface cover blend + cloud bump. Cover blend is always
// composition-derived (waterFraction × ocean + iceFraction × ice + land
// × rocky). The cloud bump dispatches on atm-presence: composition
// path when atm1/2/3 are known (Pass B), bulkWater proxy otherwise
// (Pass A initial estimate).
//
// Curated Sol bodies bypass this entirely (their albedo input to the
// temp pass comes from CSV via their curated avgSurfaceTempK chain).
// Procgen analogs land in the right zip code: Earth ~0.32, Mars ~0.22,
// Venus-analog ~0.6-0.7. Titan-class is a known overshoot — clean-ice
// albedo (0.85) doesn't represent the tholin-coated reality.
function bondAlbedoFor(body) {
  const water = body.waterFraction ?? 0;
  const ice   = body.iceFraction ?? 0;
  const land  = Math.max(0, 1 - water - ice);
  const A_surface = water * ALBEDO_COMPONENTS.water +
                    ice   * ALBEDO_COMPONENTS.ice +
                    land  * ALBEDO_COMPONENTS.land;
  const bump = body.atm1
    ? cloudBumpFromComposition(body)
    : cloudBumpFromBulkWater(body);
  return Math.max(0, Math.min(1, A_surface + bump));
}

// Pass A greenhouse — pressure proxy. Composition-agnostic estimate
// used before atm species are computed.
function greenhouseKFromPressure(surfacePressureBar) {
  const P = surfacePressureBar ?? 0;
  if (P <= 0) return 0;
  return GREENHOUSE.baseK * Math.pow(P, GREENHOUSE.exponent);
}

// Pass B greenhouse — partial-pressure × per-gas potency sum across
// the body's atm1/2/3.
//
// Transparent species (N2/O2/Ar/H2/He) have kMax=0 — they sum to zero
// no matter the pressure. This is the load-bearing improvement over
// the pressure proxy: Titan's 1.45 bar N2-dominant atm now produces
// the ~12K it should, not the ~41K the proxy would assign.
function greenhouseKFromComposition(body) {
  const P = body.surfacePressureBar ?? 0;
  if (P <= 0) return 0;
  let K = 0;
  const addContribution = (gas, frac) => {
    if (!gas || frac == null || frac <= 0) return;
    const potency = GREENHOUSE_POTENCY_BY_GAS[gas];
    if (!potency || potency.kMax === 0) return;
    const partial = P * frac;
    if (partial <= 0) return;
    // Cap partial pressure at the saturation point — past pSat, the
    // atmosphere is already optically thick in this gas's IR bands, so
    // additional gas stops adding greenhouse.
    const effPartial = Math.min(partial, potency.pSat);
    K += potency.kMax * Math.pow(effPartial, potency.exp);
  };
  for (const [gasField, fracField] of [
    ['atm1', 'atm1Frac'],
    ['atm2', 'atm2Frac'],
    ['atm3', 'atm3Frac'],
  ]) {
    const gas = body[gasField];
    if (gas) {
      addContribution(gas, body[fracField]);
    }
  }
  return K;
}

// Stefan-Boltzmann equilibrium temperature plus a pre-computed greenhouse
// offset. Takes greenhouseK and Bond albedo as parameters so the outer
// two-pass refinement (pressure-proxy → composition-aware) can swap one
// for the other without recomputing T_eq. Gaseous bodies (radius >=
// gasDwarfRadius) return bare T_eq — no surface, no greenhouse term.
function avgSurfaceTempFromAlbedo(radiusEarth, S, bondAlbedo, greenhouseK) {
  if (S == null) return null;
  const tEq = equilibriumTempK(S, bondAlbedo);
  if (radiusEarth != null && radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) {
    return Math.round(tEq);  // gaseous body — cloud-top equilibrium
  }
  return Math.round(tEq + (greenhouseK ?? 0));
}

// Atmospheric retention scalar (0..1) — long-term fraction of an atm
// the body holds against Jeans escape + stellar-wind stripping over
// ~Gyr timescales. Two multiplicative gates:
//
//   1. Jeans escape: v_escape / v_thermal(N2 at equilibrium-T).
//      Ratios < ~6 lose everything; > ~13 hold fully. Smoothstep
//      between — the canonical "Jeans parameter" sigmoid.
//   2. Magnetic shielding: bodies with no internal dynamo (Mars, Venus)
//      bleed atm to stellar wind even when Jeans alone would hold.
//      A residual `magneticFloor` keeps the multiplier non-zero so
//      thick-atmosphere outliers like Venus stay possible.
//
// Tuning anchors live in ATMOSPHERIC_RETENTION (procgen-priors.mjs).
function atmosphericRetention(massEarth, radiusEarth, magneticFieldGauss, equilibriumT) {
  if (massEarth == null || radiusEarth == null || equilibriumT == null) return null;
  if (massEarth <= 0 || radiusEarth <= 0) return 0;
  const ratio = jeansEscapeRatio(massEarth, radiusEarth, equilibriumT, RETENTION_SPECIES_AMU);
  const jeans = smoothstep(ATMOSPHERIC_RETENTION.jeansLow, ATMOSPHERIC_RETENTION.jeansHigh, ratio);
  const B = magneticFieldGauss ?? 0;
  const shield = ATMOSPHERIC_RETENTION.magneticFloor +
    (1 - ATMOSPHERIC_RETENTION.magneticFloor) *
    smoothstep(ATMOSPHERIC_RETENTION.magneticLow, ATMOSPHERIC_RETENTION.magneticHigh, B);
  return jeans * shield;
}

// Volatile inventory available to outgas, in bar-equivalent. Linear in
// body mass × effective-volatiles. bulkWaterFraction captures the H2O
// content; volatileFloor backstops it with the universal CO2/N2/etc.
// inventory every rocky body has from accretion (so Venus, bone-dry
// by H2O, still has a thick volatile reservoir to outgas).
function outgassingPotentialBar(massEarth, bulkWaterFraction) {
  if (massEarth == null) return 0;
  const eff = Math.max(bulkWaterFraction ?? 0, OUTGASSING.volatileFloor);
  return OUTGASSING.outgassingScale * massEarth * eff;
}

// Final surface pressure = retention × outgassing-potential ×
// history-multiplier. The history multiplier is a bistable mixture
// (90% near 1.0, 10% in a heavy "runaway" tail to 5000×) that captures
// the Earth-vs-Venus bifurcation: a small fraction of bodies preserve
// a thick greenhouse atm (Venus, hot sub-Neptune secondaries) where
// physics alone can't tell them apart from a moderate-pressure sibling.
// See PRESSURE_HISTORY_MULTIPLIER in procgen-priors.mjs.
function surfacePressureFor(body, S) {
  if (body.massEarth == null || body.radiusEarth == null || S == null) return null;
  // Gaseous bodies have no surface, so no surface pressure — gate on the
  // radius-derived gaseous test, keeping pressure independent of worldClass.
  if (isGaseousBody(body)) return null;
  const tEq = equilibriumTempK(S);
  const retention = atmosphericRetention(body.massEarth, body.radiusEarth, body.magneticFieldGauss, tEq);
  if (retention == null) return null;
  const outgassing = outgassingPotentialBar(body.massEarth, body.bulkWaterFraction);
  const mult = sampleMixture(fieldPrng(body, 'pressureHistory'), PRESSURE_HISTORY_MULTIPLIER);
  const pressure = outgassing * retention * mult;
  return Number(pressure.toFixed(4));
}

// =============================================================================
// Surface composition — water / ice cover derivation (Phase 3)
// =============================================================================

// Boiling-point of water at pressure P (bar). Log-linear interpolation
// between the three BOILING_POINT_ANCHORS — exact at the triple point,
// STP, and the 100-bar deep-atmosphere anchor; ±5K accuracy in between
// (well under the noise the cover formula introduces). Returns null
// below the triple point — no liquid is thermodynamically possible.
function boilingPointK(P_bar) {
  if (P_bar == null || P_bar < TRIPLE_POINT_BAR) return null;
  const a = BOILING_POINT_ANCHORS;
  for (let i = 0; i < a.length - 1; i++) {
    if (P_bar < a[i + 1].p) {
      const t = (Math.log(P_bar) - Math.log(a[i].p)) /
                (Math.log(a[i + 1].p) - Math.log(a[i].p));
      return a[i].t + t * (a[i + 1].t - a[i].t);
    }
  }
  return a[a.length - 1].t;
}

// Formation-zone bulk-composition samplers, shared by both procgen layers
// (the Architect's per-slot draws and the Filler's catalog-row backfill).
// Each keys the same four-zone gate (formationAu vs the host's frost-line
// trio) off its own BULK_*_FRACTION_BY_ZONE table. The caller supplies the
// seeded `prng` so each layer keeps its own seeding scheme — the Architect
// passes a slot/moon prng, the Filler passes fieldPrng(body, 'bulk_*').
//
//   water    — H₂O mass fraction; outer-zone bodies carry their water budget
//   metal    — refractory metals condense first inside H2O, dilute outward
//   volatile — non-water condensables (NH3, CH4, CO/CO2, N2); dominant past CH4
export function sampleBulkWaterFraction(prng, formationAu, frostLinesAu) {
  return sampleBulkFraction(prng, formationAu, frostLinesAu, BULK_WATER_FRACTION_BY_ZONE);
}

export function sampleBulkMetalFraction(prng, formationAu, frostLinesAu) {
  return sampleBulkFraction(prng, formationAu, frostLinesAu, BULK_METAL_FRACTION_BY_ZONE);
}

export function sampleBulkVolatileFraction(prng, formationAu, frostLinesAu) {
  return sampleBulkFraction(prng, formationAu, frostLinesAu, BULK_VOLATILE_FRACTION_BY_ZONE);
}

// Fraction of surface covered by liquid water. Three gates compose:
//   1. bulkWater > 0           — must have water to cover anything
//   2. P ≥ TRIPLE_POINT_BAR    — liquid impossible at sub-triple-point
//   3. T ∈ [273, boilingPoint(P)]  — temperate enough to stay liquid
// All gates pass → cover saturates at SURFACE_WATER_SAT bulkWater. Earth
// (bulkWater 0.00023) reaches ~70% cover because the absolute water
// inventory spreads thin; Hycean (bulkWater 0.1) saturates to 1.0.
// `noiseMult` is a per-body multiplier drawn once and shared across both
// passes of the two-pass T/ice iteration.
function surfaceLiquidWaterCover(bulkWater, T_mean, surfacePressureBar, noiseMult) {
  if (!bulkWater || bulkWater <= 0) return 0;
  if (surfacePressureBar == null || surfacePressureBar < TRIPLE_POINT_BAR) return 0;
  if (T_mean == null || T_mean < 273) return 0;
  const tBoil = boilingPointK(surfacePressureBar);
  if (tBoil != null && T_mean > tBoil) return 0;
  const raw = Math.min(1, bulkWater / SURFACE_WATER_SAT);
  return Number(Math.max(0, Math.min(1, raw * noiseMult)).toFixed(3));
}

// Fraction of surface covered by water ice. Two regimes:
//   - cold-trap (T_mean < 273): global freezing, any pressure.
//     coldFactor ramps from 0 at 273K to 1 at COLD_TRAP.freezeFullK.
//     Cover scales with sqrt(bulkWater × scale) so a tiny bulkWater
//     still produces visible ice (Mars's polar regions don't go to 0
//     just because there's not much water).
//   - polar cap (T_mean > 273, T_pole < 273, P ≥ triple point): small
//     caps. capWeight ramps with (273 - T_pole).
// Warm-and-airless bodies (Mercury, Luna) get 0 ice cover because both
// regime gates fail — the bug Phase 3 is designed to close.
function surfaceIceCover(bulkWater, T_mean, T_pole, surfacePressureBar, noiseMult) {
  if (!bulkWater || bulkWater <= 0) return 0;
  if (T_mean == null) return 0;

  // Cold-trap: global freezing. coldFactor ramps 0→1 as T drops from
  // freezeStartK (273) down to freezeFullK (173); below that everything
  // that can freeze has frozen.
  if (T_mean < 273) {
    const coldFactor = 1 - smoothstep(COLD_TRAP.freezeFullK, COLD_TRAP.freezeStartK, T_mean);
    const bulkAmp = Math.min(1, Math.sqrt(bulkWater / SURFACE_ICE_SAT));
    return Number(Math.max(0, Math.min(1, bulkAmp * coldFactor * noiseMult)).toFixed(3));
  }

  // Polar cap: warm body, frozen poles, atm thick enough to keep cap stable.
  if (T_pole == null || T_pole >= 273) return 0;
  if (T_mean >= POLAR_CAP.meanTempMaxK) return 0;
  if (surfacePressureBar == null || surfacePressureBar < TRIPLE_POINT_BAR) return 0;
  const capWeight = Math.min(1, (273 - T_pole) / POLAR_CAP.poleFullDeltaK);
  const bulkBoost = Math.sqrt(Math.min(1, bulkWater / SURFACE_WATER_SAT));
  const cover = POLAR_CAP.baseFraction * capWeight * bulkBoost * noiseMult;
  return Number(Math.max(0, Math.min(POLAR_CAP.maxCoverFraction, cover)).toFixed(3));
}

// =============================================================================
// Surface age
// =============================================================================

// 0..1 scalar — fraction of the surface that is geologically young.
// Derived from `tectonicActivity` (active body resurfaces, quiet body
// accumulates old crust) with a tidal-heating lift for eccentric moons
// of giants (Io, Enceladus). Returns null for bodies with no solid
// surface (radius >= gasDwarfRadius).
function surfaceAgeFor(body, hostBody) {
  if (body.radiusEarth == null) return null;
  if (isGaseousBody(body)) return null;
  if (body.tectonicActivity == null) return null;
  const noise = sampleTruncated(fieldPrng(body, 'surfaceAge'), SURFACE_AGE_FROM_TECTONIC.noise);
  let age = Math.pow(body.tectonicActivity, SURFACE_AGE_FROM_TECTONIC.exponent) * noise;
  // Tidal-heating lift for eccentric moons of gaseous hosts. Host
  // gaseousness is read from the radius-derived test, independent of
  // worldClass.
  const hostIsGaseous = hostBody != null && isGaseousBody(hostBody);
  if (body.kind === 'moon' && hostIsGaseous && body.eccentricity != null) {
    const e = body.eccentricity;
    const { eThreshold, eMaxNormalize, liftAmount } = SURFACE_AGE_TIDAL_LIFT;
    if (e > eThreshold) {
      const normalized = Math.min(1, (e - eThreshold) / (eMaxNormalize - eThreshold));
      age = age + (1 - age) * liftAmount * normalized;
    }
  }
  return Number(Math.max(0, Math.min(1, age)).toFixed(3));
}

// =============================================================================
// Tectonic activity — mass-driven (Phase 4, class-free)
// =============================================================================

// tect = baseSample × sqrt(mass). Bigger bodies retain radiogenic heat
// longer and sustain longer-lived dynamos / surface renewal. Mass is the
// dominant physical input; no class lookup.
function tectonicActivityFor(body) {
  if (body.massEarth == null) return null;
  const base = sampleTruncated(fieldPrng(body, 'tectonicActivity'), TECTONIC_BASE);
  const massScale = Math.sqrt(Math.max(body.massEarth, 0.05));
  return Number(Math.max(0, Math.min(1, base * massScale)).toFixed(3));
}

// =============================================================================
// Rotation period — universal log-normal + tidal locking (Phase 4, class-free)
// =============================================================================

// Free-rotation draw from a single log-normal-ish prior. Close-in bodies
// probabilistically lock to their orbital period. No class lookup — all
// bodies share the prior; tidal-lock proxy is the physics that distinguishes
// short-period worlds from free-spinners.
function rotationPeriodHoursFor(body, periodDays, lockProxy) {
  const prng = fieldPrng(body, 'rotationPeriodHours');
  // Probabilistic tidal lock: log-interpolate the lock probability
  // between PROXY_LOCKED (≈ always) and PROXY_FREE (≈ never).
  if (lockProxy != null && periodDays != null) {
    const { proxyLocked, proxyFree } = TIDAL_LOCK_RANGE;
    let pLock;
    if (lockProxy <= proxyLocked) pLock = 1;
    else if (lockProxy >= proxyFree) pLock = 0;
    else {
      const t = (Math.log(lockProxy) - Math.log(proxyLocked)) /
                (Math.log(proxyFree)   - Math.log(proxyLocked));
      pLock = 1 - t;
    }
    if (prng() < pLock) {
      return Number((periodDays * 24).toFixed(2));
    }
  }
  return Number(sampleTruncated(prng, ROTATION_INIT_HOURS).toFixed(2));
}

// =============================================================================
// Magnetic field — mass-cap × dynamo × noise (Phase 4, class-free)
// =============================================================================

// field = cap × dynamo × noise, where:
//   cap   = capBase × mass^capExponent      # bigger body → bigger cap
//   dynamo = tect × sqrt(24/rot)            # active core, fast spin
// Gaseous bodies (radius >= gasDwarfRadius) get a boost since their
// fields are driven by deep metallic-hydrogen convection rather than
// core dynamos.
function magneticFieldGaussFor(body) {
  if (body.massEarth == null) return null;
  const cap = MAGNETIC_FIELD.capBase * Math.pow(body.massEarth, MAGNETIC_FIELD.capExponent);
  const noise = sampleTruncated(fieldPrng(body, 'magneticFieldGauss'), MAGNETIC_FIELD.noise);
  // Gaseous body — deep convective dynamo, not core-driven
  if (isGaseousBody(body)) {
    return Number((cap * MAGNETIC_FIELD.giantBoost * noise).toFixed(4));
  }
  // Terrestrial — gate on tectonic + rotation
  const tect = body.tectonicActivity ?? 0.3;
  const rot = body.rotationPeriodHours ?? 24;
  const dynamo = tect * Math.sqrt(24 / Math.max(rot, 4));
  return Number(Math.max(0, cap * dynamo * noise).toFixed(4));
}

// =============================================================================
// Surface temperature swing — thermal-inertia derived (Phase 4, class-free)
// =============================================================================

// swing = SWING_BASE / inertia × tiltFactor × eccFactor × noise, where
// inertia accumulates from atm pressure (log) and ocean cover (linear).
// Thick atm + oceans → small swing (Earth ±50K seasonal); airless dry
// body → wild swing (Mercury ±300K). Class isn't an input.
function surfaceTempRangeFor(body) {
  if (body.avgSurfaceTempK == null) return { min: null, max: null };
  const P = body.surfacePressureBar ?? 0;
  const water = body.waterFraction ?? 0;
  const atmContrib = P > 0 ? Math.log10(P + 0.001) * TEMP_SWING.atmTerm : Math.log10(0.001) * TEMP_SWING.atmTerm;
  const inertia = Math.max(TEMP_SWING.inertiaMin, 1 + atmContrib + water * TEMP_SWING.oceanTerm);
  const noise = sampleTruncated(fieldPrng(body, 'tempSwing'), TEMP_SWING.noise);
  const baseSwing = TEMP_SWING.swingBase / inertia;
  const tiltDeg = body.axialTiltDeg ?? 20;
  const tiltFactor = 1 + Math.min(Math.abs(tiltDeg), 90) / 90;
  const ecc = body.eccentricity ?? 0.05;
  const eccFactor = 1 + ecc * 2;
  const swing = Math.min(2.5, baseSwing * tiltFactor * eccFactor * noise);
  const half = swing / 2;
  return {
    min: Math.round(body.avgSurfaceTempK * (1 - half)),
    max: Math.round(body.avgSurfaceTempK * (1 + half)),
  };
}

// =============================================================================
// Atmosphere composition — physics-keyed regime dispatch (no class input)
// =============================================================================

// Per-gas Jeans-retention check. Reuses the smoothstep gates from the
// ATMOSPHERIC_RETENTION prior (calibrated against N2). Returns a 0..1
// retention scalar for the gas — light gases on small bodies return ~0
// and the dispatch zeros their weight.
function gasRetentionFraction(massEarth, radiusEarth, equilibriumT, gas) {
  const amu = GAS_MOLECULAR_WEIGHT_AMU[gas];
  if (amu == null || amu <= 0) return 1;
  if (massEarth == null || radiusEarth == null || equilibriumT == null) return 1;
  if (massEarth <= 0 || radiusEarth <= 0) return 0;
  const ratio = jeansEscapeRatio(massEarth, radiusEarth, equilibriumT, amu);
  return smoothstep(ATMOSPHERIC_RETENTION.jeansLow, ATMOSPHERIC_RETENTION.jeansHigh, ratio);
}

// Atm regime dispatch — purely physics-keyed (no class input).
//   primary         radius ≥ gasDwarfRadius (gaseous body retains H/He)
//   cold_outgassed  T < coldTempMaxK (Titan/Triton class)
//   thick_outgassed P ≥ thickPressureBar (Venus-class runaway)
//   wet_outgassed   bulkWater ≥ wetBulkWaterMin (Earth-class)
//   dry_outgassed   fallback (Mars-class)
// Returns null for sub-trace pressure (airless).
function atmosphereRegimeFor(body) {
  if (body.surfacePressureBar != null && body.surfacePressureBar < ATMOSPHERE_MIN_PRESSURE_BAR) {
    return null;
  }
  if (isGaseousBody(body)) {
    return 'primary';
  }
  if (body.avgSurfaceTempK != null && body.avgSurfaceTempK < ATMOSPHERE_REGIME_THRESHOLDS.coldTempMaxK) {
    return 'cold_outgassed';
  }
  if (body.surfacePressureBar != null && body.surfacePressureBar >= ATMOSPHERE_REGIME_THRESHOLDS.thickPressureBar) {
    return 'thick_outgassed';
  }
  if ((body.bulkWaterFraction ?? 0) >= ATMOSPHERE_REGIME_THRESHOLDS.wetBulkWaterMin) {
    return 'wet_outgassed';
  }
  return 'dry_outgassed';
}

// Pick the top 3 gases for the body's atm regime, after per-gas Jeans
// escape filtering and biotic O2 lift. Returns 3 entries (or null for
// trailing slots when fewer gases qualify).
function atmosphereFor(body, S) {
  const regime = atmosphereRegimeFor(body);
  if (regime == null) return [null, null, null];
  const table = ATMOSPHERE_GASES_BY_REGIME[regime];
  if (!table) return [null, null, null];
  const prng = fieldPrng(body, 'atmosphere');
  // Equilibrium-T used for Jeans escape filter (composition-agnostic
  // bare T_eq, same as in surfacePressureFor).
  const tEq = equilibriumTempK(S);
  const weights = {};
  for (const [gas, w] of Object.entries(table)) {
    if (w <= 0) continue;
    // Per-gas Jeans retention — light gases on small bodies effectively
    // zero out. For terrestrials, H2/He won't survive over Gyr.
    const retain = gasRetentionFraction(body.massEarth, body.radiusEarth, tEq, gas);
    if (retain <= 0.01) continue;
    // Per-gas seeded perturbation (×0.5 to ×1.5) so two same-regime
    // worlds don't end up with identical mixes.
    weights[gas] = w * retain * (0.5 + prng());
  }
  // Biotic O2 lift — continuous on productivity[carbon_aqueous]. Earth
  // at productivity=0.85 gets weights.O2 ≈ 0.05 × (1 + 0.85 × 70) ≈ 3,
  // which puts O2 at ~30% top-1 share against N2's 8 (close enough to
  // Earth's 21% measured). A microbial-tier world at productivity=0.30
  // gets a partial lift to weights.O2 ≈ 1.1 (the "Great Oxidation
  // transition" regime where O2 is rising but not dominant). Sterile
  // worlds (productivity ≈ 0) keep the trace photolysis O2 floor.
  const carbProd = body.bioticCarbonAqueous ?? 0;
  if (carbProd > 0 && weights.O2 != null) {
    weights.O2 *= 1 + carbProd * BIOSPHERE_PRODUCTIVITY.o2LiftFactor;
  }
  // Pick top 3 (or however many are non-zero) by weight via repeated
  // weighted-random draw without replacement.
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const keys = Object.keys(weights);
    if (!keys.length) break;
    let total = 0;
    for (const k of keys) total += weights[k];
    let r = prng() * total;
    let chosen = keys[keys.length - 1];
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) { chosen = k; break; }
    }
    picked.push([chosen, weights[chosen]]);
    delete weights[chosen];
  }
  // Renormalize the picked weights to sum to 1.
  let total = 0;
  for (const [, w] of picked) total += w;
  const out = [];
  for (const [gas, w] of picked) {
    out.push({ gas, frac: Number((w / total).toFixed(3)) });
  }
  while (out.length < 3) out.push(null);
  return out;
}

// Surface opacity — 1 when the body has a solid surface the renderer
// should paint underneath the cloud + haze stack (terrestrials), 0
// when the bulk atm column shows through cloud rents instead (gas /
// ice giants / hycean / helium / gas_dwarf). Intermediate values are
// possible later (partial gas-giant rents) but for now this is
// binary, driven by world class.
function surfaceOpacityFor(body) {
  return isGaseousBody(body) ? 0 : 1;
}

// Per-body cloud-deck emission via per-species condensation gates —
// Iterates
// CONDENSABLES; for each species checks the body's T against the
// species' condensation window AND runs the species' precursor gate.
// Every species whose product strength > CLOUD_DECK.strengthThreshold
// emits a deck. Coverage is derived from strength + a sparse-cirrus mode
// gate (see coverageFor below). Wind speed is a per-altitude proxy
// (gas giants run cloud-top jets ~5–10x faster than terrestrials).
//
// No regime classification: Jupiter, Saturn, Uranus, Neptune,
// Earth, Mars, Venus, Titan, Triton, and any procgen body all run
// the same loop. Which decks emerge falls out of the body's actual
// T + atm + waterFraction + bulkWaterFraction. Coverage / wind / strength
// tuning lives in CLOUD_DECK (procgen-priors).

// The single "is this body gaseous" predicate. Radius-keyed so the physics
// passes (pressure, age, atmosphere regime, magnetic, opacity) can ask it
// before worldClass exists. The biosphere passes — which run after
// classification — share it too: worldClassFor routes every r ≥ gasDwarfRadius
// body into a gaseous class and nothing below it, so the radius test and the
// gaseous-class label are equivalent for any classified body. One predicate,
// no margin where the two could drift.
function isGaseousBody(body) {
  return body.radiusEarth != null && body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;
}

// Coverage derivation. Two modes blend smoothly:
//   • Full-cover: bulk atm column carries no strong color signal in
//     this gas → deck IS the planet's visible color. Coverage scales
//     near-linearly with strength.
//   • Sparse-cirrus: this gas is BOTH a strong absorber (potency ≥
//     CLOUD_DECK.strongAbsorberPotency) AND present in the atm at
//     appreciable fraction. The column already paints the planet's bulk
//     color (CH4 cyan on Neptune); the deck reads as scattered bright
//     cells on top. Coverage caps low even at peak strength.
//
// Restricting sparse mode to strong absorbers (CH4 potency 6, SO2
// potency 8) keeps NH3 on a gas giant in full-cover mode even when
// procgen seeds NH3 into the atm record — NH3 doesn't tint a thick
// column the way CH4 does, so it shouldn't behave like Neptune's
// cirrus.
function coverageFor(_body, _gas, strength, atmFrac, gasPotency) {
  const strongAbsorber = gasPotency >= CLOUD_DECK.strongAbsorberPotency;
  const absorptionSignal = atmFrac * gasPotency;
  const sparse = strongAbsorber ? smoothstep(CLOUD_DECK.sparseSignal[0], CLOUD_DECK.sparseSignal[1], absorptionSignal) : 0;
  const fullCover = strength * CLOUD_DECK.coverageFullMax;
  const sparseCover = strength * CLOUD_DECK.coverageSparseMax;
  return fullCover + (sparseCover - fullCover) * sparse;
}

// Peak zonal wind at this deck's altitude. Gaseous bodies run an
// order of magnitude faster than terrestrials at cloud-top; deeper
// decks see slower winds via the linear altitude factor. Curated Sol
// giants override via body_layers.csv (Saturn 450, Neptune 600).
function windAtAltitude(body, altitudeNorm) {
  const base = isGaseousBody(body) ? CLOUD_DECK.windBaseGaseousMS : CLOUD_DECK.windBaseTerrestrialMS;
  return base * (0.5 + altitudeNorm);
}

function cloudDecksFor(body, _S) {
  if (body.surfacePressureBar != null && body.surfacePressureBar < ATMOSPHERE_MIN_PRESSURE_BAR) {
    return [];
  }
  const T = body.avgSurfaceTempK;
  if (T == null) return [];

  // Context shared with each species' precursor gate. Bundling
  // helpers here keeps CONDENSABLES rows declarative.
  const ctx = {
    isGaseous: isGaseousBody(body),
    atmFrac: (gas) => atmFracOf(body, gas),
    smoothstep,
  };

  const out = [];
  for (const c of CONDENSABLES) {
    // Effective T at this species' altitude. On gaseous bodies, the
    // atm column has a positive T gradient with depth (~adiabatic),
    // so deeper-altitude species see a warmer effective T than the
    // body's cloud-top reference. Terrestrials skip this — their
    // condensation happens near the surface where surface T applies.
    const altOffset = ctx.isGaseous ? (c.altitudeTempOffsetK ?? 0) : 0;
    const effectiveT = T + altOffset;
    const tempGate = tempCondenseFactor(effectiveT, c.condenseTempK[0], c.condenseTempK[1]);
    if (tempGate <= 0) continue;
    const precursor = c.precursor(body, ctx);
    if (precursor <= 0) continue;
    const strength = tempGate * precursor;
    if (strength < CLOUD_DECK.strengthThreshold) continue;

    const atmFrac = atmFracOf(body, c.gas);
    const gasPotency = GAS_POTENCY[c.gas] ?? 0;
    const coverage = coverageFor(body, c.gas, strength, atmFrac, gasPotency);
    if (coverage < CLOUD_DECK.strengthThreshold) continue;

    out.push({
      gas: c.gas,
      coverage: Number(coverage.toFixed(3)),
      windSpeedMS: Math.round(windAtAltitude(body, c.altitudeNorm)),
      altitudeNorm: Number(c.altitudeNorm.toFixed(3)),
    });
  }
  // Same back-to-front composite order the renderer expects.
  out.sort((a, b) => a.altitudeNorm - b.altitudeNorm);
  return out;
}

// True if the body has any cloud deck whose condensate is `gas`.
// Used by chemistry gates that require a specific cloud-deck
// precursor (NH4SH and CHROMOPHORE need NH3 ice).
function hasCloudDeck(body, gas) {
  const layers = body.cloudLayers;
  if (!layers || layers.length === 0) return false;
  for (const l of layers) if (l.gas === gas) return true;
  return false;
}

// Molar fraction of `gas` in body.atm1/atm2/atm3, or 0 when absent.
// Helper for haze-species formation gates that depend on a precursor
// gas being present in the atmosphere.
function atmFracOf(body, gas) {
  if (body.atm1 === gas) return body.atm1Frac ?? 0;
  if (body.atm2 === gas) return body.atm2Frac ?? 0;
  if (body.atm3 === gas) return body.atm3Frac ?? 0;
  return 0;
}

// Per-haze-species formation strength from body physics. Returns a 0..1
// contribution scalar — no regime intermediary, each species gates on
// its own physical preconditions. Each species' gates produce a
// continuous distribution from 0 to its anchored peak; the peak
// coefficient is set so a calibration-anchor body (Titan, Jupiter,
// Venus, etc.) matches its observed haze opacity. Pile-up at the peak
// is avoided by making at least one gate a true peaked function
// (Gaussian-like or smoothstep×inverse-smoothstep) rather than a
// monotonic step — bodies on either side of the optimal regime ramp
// continuously, so the histogram fills out instead of clustering at
// the coefficient ceiling.
//
// Calibration anchors (Sol bodies + literature targets):
//   Titan       T=94K,  P=1.5 bar, N2+CH4 atm  → THOLIN ~0.85
//   Jupiter     T=165K, gaseous, NH3 cloud     → NH4SH ~0.70
//   Saturn      T=134K, gaseous, NH3 cloud     → CHROMOPHORE ~0.60
//   Venus       T=735K, P=92 bar               → H2SO4 ~0.70
//   Io          T~400K, P=trace, SO2 atm, dry  → SULFUR ~0.55
//   GJ 1214 b   T~600K, gaseous, sub-Neptune   → SALT ~0.60
//   Hot Jupiter T>1500K, gaseous               → SILICATE ~0.50
//   Mars        T=210K, P=0.006 bar, dry       → none (DUST is a
//                                                 separate channel)
//   Earth       T=288K, P=1 bar, wet           → none
//
// Procgen owns the chemistry. Each branch outputs an explicit reaction
// product species — THOLIN (not CH4), NH4SH (not NH3) — so the
// renderer paints exactly what the data says without inferring
// chemistry from precursor names.
// Per-species formation gates — return raw 0..1 strength based on
// chemistry physics (T, P, precursor fractions, world class). Pre-
// potency, pre-scale: the unified haze blend in `hazeFor` is the only
// thing that combines these with the global category multipliers.
// Per-species visibility weight lives in GAS_POTENCY (gas-potency.mjs),
// so no anchor coefficient appears here.
function hazeContribution(gas, body) {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar;
  const isGaseous = isGaseousBody(body);
  const spec = HAZE_GATES[gas];

  switch (gas) {
    case 'THOLIN': {
      // CnHmN photolysis polymers — Titan-class orange-brown haze.
      // Needs N2 + CH4 precursors AND host-star UV. Temperature is a
      // proxy for UV flux (T set by insolation), so the gate is peaked
      // around Titan's regime (~95K, moderate UV at Saturn distance):
      // colder bodies (Triton/Pluto class) receive too little UV to
      // drive polymerization; warmer bodies (>130K) lose CH4 to thermal
      // escape and sublimation faster than aerosols can form.
      if (isGaseous) return 0;
      if (T == null) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      if (tempGate === 0) return 0;
      const ch4Frac = atmFracOf(body, 'CH4');
      const n2Frac  = atmFracOf(body, 'N2');
      // ch4Gate saturates near Titan's ~2.8% CH4 — IRL Titan is the
      // canonical fully-saturated THOLIN case, so the bottleneck is UV
      // flux (captured by tempGate as a T proxy) rather than precursor
      // supply. Bodies with sub-Titan CH4 still ramp in via the lower
      // edge.
      const ch4Gate = smoothstep(spec.ch4[0], spec.ch4[1], ch4Frac);
      const n2Gate  = smoothstep(spec.n2[0], spec.n2[1], n2Frac);
      return tempGate * ch4Gate * n2Gate;
    }
    case 'NH4SH': {
      // Ammonium hydrosulfide cloud-top chemistry — Jovian belt brown.
      // Peak at Jupiter's cloud top (~165K) where NH3 + H2S → NH4SH
      // condensate runs fastest. Requires an NH3 cloud deck (the
      // precursor) somewhere in the body's layered atmosphere.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      if (!hasCloudDeck(body, 'NH3')) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      return tempGate;
    }
    case 'CHROMOPHORE': {
      // PH3-photolysis red pigment — Jovian Great Red Spot / Saturn
      // polar haze. Peaks at cooler cloud tops (~125K) where NH3+H2S
      // is too slow for NH4SH dominance.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      if (!hasCloudDeck(body, 'NH3')) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      return tempGate;
    }
    case 'SALT': {
      // KCl + ZnS condensate haze — warm sub-Neptune / gas dwarf
      // regime. GJ 1214 b anchor at ~600K cloud tops.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      return tempGate;
    }
    case 'H2SO4': {
      // Sulfuric acid sulfate haze — Venus-class. Needs hot CO2 + high
      // pressure. Above ~1000K H2SO4 dissociates back to SO3 + H2O.
      if (isGaseous) return 0;
      if (T == null || P == null) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      const pressGate = smoothstep(spec.press[0], spec.press[1], P);
      return tempGate * pressGate;
    }
    case 'SULFUR': {
      // S8 elemental sulfur aerosol — Io-class volcanic. Thin SO2
      // columns where UV reaches the surface; dry-surface gate.
      if (isGaseous) return 0;
      if (T == null || P == null) return 0;
      const so2Frac = atmFracOf(body, 'SO2');
      const so2Gate = smoothstep(spec.so2[0], spec.so2[1], so2Frac);
      if (so2Gate === 0) return 0;
      const tempGate = smoothstep(spec.tempRise[0], spec.tempRise[1], T) * (1 - smoothstep(spec.tempFall[0], spec.tempFall[1], T));
      const pressGate = 1 - smoothstep(spec.pressFall[0], spec.pressFall[1], P);
      const waterFrac = body.waterFraction ?? 0;
      const dryGate = 1 - smoothstep(spec.dryFall[0], spec.dryFall[1], waterFrac);
      return tempGate * so2Gate * pressGate * dryGate;
    }
    case 'SILICATE': {
      // Refractive Mg-Si-O cloud particles dredged from deep layers at
      // extreme insolation. Hot gas-giant / hot sub-Neptune only.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      return smoothstep(spec.tempRise[0], spec.tempRise[1], T);
    }
    default:
      return 0;
  }
}

const HAZE_AEROSOL_SPECIES = ['THOLIN', 'NH4SH', 'CHROMOPHORE', 'SALT', 'H2SO4', 'SULFUR', 'SILICATE'];

// Lifted mineral dust gate. Terrestrial only, dry surface, thin
// atmosphere, moderate T (not frozen, not boiled). Returns raw 0..1
// strength; the renderer applies the universal dust scale.
function dustStrengthFor(body) {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar;
  if (isGaseousBody(body)) return 0;
  if (T == null || P == null) return 0;
  // Dust suspends in any non-zero atmosphere — mineral grains entrain
  // at any pressure including Mars's 0.006 bar. Upper cap (maxPressureBar):
  // thicker air becomes too dense to keep dust airborne.
  if (P <= 0 || P > DUST_GATE.maxPressureBar) return 0;
  const waterFrac = body.waterFraction ?? 0;
  const dryGate = 1 - smoothstep(DUST_GATE.dryFall[0], DUST_GATE.dryFall[1], waterFrac);
  const pressGate = 1 - smoothstep(DUST_GATE.pressFall[0], DUST_GATE.pressFall[1], P);
  const tempGate = smoothstep(DUST_GATE.tempRise[0], DUST_GATE.tempRise[1], T) * (1 - smoothstep(DUST_GATE.tempFall[0], DUST_GATE.tempFall[1], T));
  return Number((dryGate * pressGate * tempGate).toFixed(3));
}

// Unified haze derivation — every atmospheric contributor (bulk atm
// gases, formation-gated aerosol products, lifted dust, Rayleigh
// scattering) feeds one weighted sum, soft-capped to 0..1. Color is
// derived at render time in disc-palette by walking the same
// contributor list with the species' GAS_COLOR / SCATTERING_COLOR /
// dust-from-resources hues.
//
// Per-species post-gate strengths land on the body as `hazeAerosols`
// and `dustStrength`, so the runtime palette stage doesn't need to
// re-run the chemistry gates.
function hazeFor(body) {
  const aerosols = {};
  for (const species of HAZE_AEROSOL_SPECIES) {
    const s = hazeContribution(species, body);
    if (s > 0) aerosols[species] = Number(s.toFixed(3));
  }
  const dust = dustStrengthFor(body);
  return { aerosols, dust };
}

// =============================================================================
// Resources — context-weighted probabilistic occurrence
// =============================================================================

// Bulk silicate-rock fraction on the resource 0..10 scale. Silicate rock is
// ubiquitous — it's whatever isn't metal core or water/ice — so biosphere
// SUBSTRATE reads use this physical bulk estimate rather than the resource
// grid. The grid now records notable mineral DEPOSITS (two per body), not
// bulk composition, so a world that didn't roll a silicate deposit still has
// silicate rock for life to build on.
function bulkSilicate10(body) {
  const m = body.bulkMetalFraction ?? 0.32;
  const w = body.bulkWaterFraction ?? 0;
  return 10 * Math.max(0, 1 - m - w);
}

// Pick a body's two notable mineral deposits + their abundances. Rather than
// derive six bulk-composition scalars, draw TWO resource types from a
// context-weighted table (see RESOURCE_OCCURRENCE in procgen-priors): each
// resource's `base` weight is multiplied by whichever context-axis
// multipliers this body trips, then two distinct resources are drawn
// weighted-without-replacement (any pair can co-occur). Abundance rides the
// same weight — a strong contextual fit yields a richer deposit, and the
// primary (first) draw gets a bonus — so one table drives presence and
// richness together. The other four resources are 0.
function resourcesFor(body, hostStar, hostBody) {
  if (body.massEarth == null) return null;

  const O = RESOURCE_OCCURRENCE;
  const C = O.context;

  // ── Local physical context → the boolean axes the weights key off. The
  // axes are the physics re-expressed as odds (hot/inner → metals, cold/icy
  // → volatiles, metal-rich host → rare-earths + U/Th, tidal moon / giant →
  // exotics).
  const T = body.avgSurfaceTempK;
  const cls = hostStar?.cls;
  const metallicity = cls ? meanMetallicityForClass(cls) : 0;
  const stellarAge = hostStar?.ageGyr ?? (cls ? meanAgeForClass(cls) : 5);
  const isGaseous = isGaseousBody(body);
  const hostIsGaseous = hostBody != null && isGaseousBody(hostBody);
  const ctx = {
    hot:           T != null && T >= C.hotK,
    cold:          T != null && T <= C.coldK,
    gaseous:       isGaseous,
    tidalMoon:     body.kind === 'moon' && hostIsGaseous && (body.surfaceAge ?? 0) > 0.5,
    metalRichBulk: (body.bulkMetalFraction ?? 0.32) >= C.metalRichBulk,
    metalRichHost: metallicity >= C.metalRichHostDex,
    metalPoorHost: metallicity <= C.metalPoorHostDex,
    youngHost:     stellarAge <= C.youngHostGyr,
    icy:           (body.iceFraction ?? 0) >= C.icyFrac || (body.waterFraction ?? 0) >= C.wateryFrac,
  };

  // ── Effective occurrence weight per resource = base × Π(active axes).
  const weights = {};
  for (const res of RESOURCE_KEYS) {
    const spec = O[res];
    let w = spec.base;
    for (const axis of Object.keys(ctx)) {
      if (ctx[axis] && spec[axis] != null) w *= spec[axis];
    }
    weights[res] = w;
  }

  // ── Draw two deposits + dynamic abundance (shared with the belt model).
  return drawWeightedDeposits(
    RESOURCE_KEYS, weights, O.abundance,
    (name) => fieldPrng(body, `res_occ_${name}`),
  );
}

// =============================================================================
// Biosphere — physics-keyed habitat dispatch (no class input)
// =============================================================================


// ── Biotic productivity ─────────────────────────────────────────────
// Per-archetype continuous productivity scalars in [0..1], derived as
// a product of soft-gated factors from the body's physical state. No
// dice rolls — productivity emerges from physics. Each archetype's
// formula combines: substrate availability, energy source, temperature
// window, chemistry, stellar/age compatibility.
//
// Multiple archetypes can be non-zero simultaneously (Titan: surface
// cryogenic AND a possible subsurface aqueous reservoir). Archetypes
// physically impossible for the body (aerial on terrestrial,
// carbon_aqueous on gas giant) return null instead of 0 so downstream
// consumers can distinguish "this archetype can't exist here" from
// "this archetype could but doesn't fire here."
//
// The biosphereArchetype / biosphereComplexity / biosphereSurfaceImpact
// fields are derived from these scalars (argmax + per-archetype
// thresholds + per-body coupling sample), so they're pure display
// classifications — nothing in the procgen pipeline rolls a separate
// biosphere outcome.

// Bell curve gate — peaks at `center`, falls to 0 at `center ± halfwidth`.
// Quadratic falloff. Used by productivity factors that want a "best at
// this value, falls off either direction" shape (T windows, ice-shell
// thickness band) rather than a monotonic threshold.
function bellGate(x, center, halfwidth) {
  if (halfwidth <= 0) return x === center ? 1 : 0;
  const t = (x - center) / halfwidth;
  if (t <= -1 || t >= 1) return 0;
  return 1 - t * t;
}

// Body surface gravity in Earth-g. Used by the carbon_aqueous column-
// mass-equivalent factor where the same P at lower g yields a thicker
// effective column. Defensive null returns 1.0 (Earth-g proxy).
function bodyGravityEarth(body) {
  if (body.massEarth == null || body.radiusEarth == null) return 1;
  if (body.radiusEarth === 0) return 1;
  return body.massEarth / (body.radiusEarth * body.radiusEarth);
}

// The set of worldClasses with a solid/liquid surface a surface biosphere
// can inhabit. Genuinely label-specific: it separates a *classified*
// terrestrial body from one still awaiting classification (worldClass null),
// a distinction no physical predicate captures — so unlike "is gaseous"
// (single-sourced through isGaseousBody) this stays keyed on the label.
// Every gaseous worldClass sits in the r ≥ gasDwarfRadius bracket, so its
// complement here is exactly the non-null terrestrial classes.
const TERRESTRIAL_SOLID_CLASSES = new Set([
  'rocky', 'desert', 'ocean', 'ice', 'carbon', 'iron', 'lava',
  'magma_ocean', 'chthonian', 'solid_giant',
]);

// Pre-atm productivity — carbon_aqueous + subsurface_aqueous. Neither
// archetype depends on atmospheric composition, so both can fire
// before the atmosphere is sampled. carbon_aqueous productivity then
// drives biotic O2 atmospheric lift (clean acyclic dependency: bio
// productivity → atm composition).
function productivityPreAtm(body, hostStar, hostBody) {
  const T = body.avgSurfaceTempK;
  const Tmin = body.surfaceTempMinK;
  const Tmax = body.surfaceTempMaxK;
  const water = body.waterFraction ?? 0;
  const ice = body.iceFraction ?? 0;
  const bulkVol = body.bulkVolatileFraction ?? 0;
  const P = body.surfacePressureBar ?? 0;
  const g = bodyGravityEarth(body);
  const colMass = P > 0 ? Math.log10(P / g + 1) : 0;
  const B = body.magneticFieldGauss ?? 0;
  const r = body.radiusEarth ?? 0;
  const e = body.eccentricity ?? 0;
  const age = hostStar?.ageGyr ?? 5.0;
  const cls = hostStar?.cls ?? null;
  const isGaseous = isGaseousBody(body);

  const aw = BIOSPHERE_PRODUCTIVITY.ageWindow;
  const ageWindowCarbon     = smoothstep(aw.carbonAqueous.rise[0], aw.carbonAqueous.rise[1], age) * (1 - smoothstep(aw.carbonAqueous.fall[0], aw.carbonAqueous.fall[1], age));
  const ageWindowSubsurface = smoothstep(aw.subsurfaceAqueous.rise[0], aw.subsurfaceAqueous.rise[1], age);

  // ── carbon_aqueous (Earth-standard, water + carbon + photosynthesis) ──
  // The N2_buffer factor was dropped: Earth's 78% N2 is BIOTIC-co-evolved,
  // not a precondition — gating on it conflates cause and effect. The
  // surviving factors capture the underlying physical preconditions:
  // liquid water, temperate T, low variability, atmospheric column,
  // magnetic shielding, stellar PAR, stellar age.
  let bioticCarbonAqueous;
  if (isGaseous) {
    bioticCarbonAqueous = null;
  } else if (T == null) {
    bioticCarbonAqueous = 0;
  } else {
    const k = BIOSPHERE_PRODUCTIVITY.carbonAqueous;
    const water_window = smoothstep(k.waterWindow[0], k.waterWindow[1], water);
    const T_temperate = T < k.tempFreezeFloorK ? 0 : bellGate(T, k.tempBell.center, k.tempBell.halfwidth);
    const T_variability = (Tmin != null && Tmax != null && T > 0)
      ? 1 - smoothstep(k.variability[0], k.variability[1], (Tmax - Tmin) / T)
      : 1;
    const atm_column = smoothstep(k.atmColumn[0], k.atmColumn[1], colMass);
    const shielding = smoothstep(k.shielding[0], k.shielding[1], B * Math.log10(P + 1));
    const stellar_PAR = cls ? (PAR_BY_CLASS[cls] ?? 0) : 0;
    bioticCarbonAqueous = water_window * T_temperate * T_variability
                          * atm_column * shielding
                          * stellar_PAR * ageWindowCarbon;
  }

  // ── subsurface_aqueous (Europa/Enceladus, chemosynthesis at vents) ──
  let bioticSubsurfaceAqueous;
  if (isGaseous) {
    bioticSubsurfaceAqueous = null;
  } else if (T == null) {
    bioticSubsurfaceAqueous = 0;
  } else {
    const k = BIOSPHERE_PRODUCTIVITY.subsurfaceAqueous;
    const bulk_water = smoothstep(k.bulkWater[0], k.bulkWater[1], bulkVol);
    const ice_shell = bellGate(ice, k.iceShell.center, k.iceShell.halfwidth);
    const cold_surface = smoothstep(k.coldSurface[0], k.coldSurface[1], k.coldSurfaceRefK - T);
    const size_floor = smoothstep(k.sizeFloor[0], k.sizeFloor[1], r);
    const hostMassEarth = hostBody?.massEarth ?? 0;
    const a = body.semiMajorAu ?? 0;
    const tidalProxy = (e > 0 && hostMassEarth > 0 && a > 0)
      ? e * (hostMassEarth / EARTH_PER_SOLAR_MASS) / Math.pow(a, 3)
      : 0;
    const tidal_score = smoothstep(k.tidalScore[0], k.tidalScore[1], tidalProxy);
    const radio_score = smoothstep(k.radioScore[0], k.radioScore[1], body.resRadioactives ?? 0);
    const tidal_or_radiogenic = Math.max(tidal_score, radio_score);
    bioticSubsurfaceAqueous = bulk_water * ice_shell * cold_surface
                              * size_floor * tidal_or_radiogenic
                              * ageWindowSubsurface;
  }

  return { bioticCarbonAqueous, bioticSubsurfaceAqueous };
}

// Post-atm productivity — aerial / cryogenic / silicate / sulfur all
// read atmospheric composition (CH4, N2, NH3, SO2, H2S, H2SO4, …) and
// in cryogenic's case the haze aerosol output (THOLIN). Runs after
// haze in the Filler pipeline.
function productivityPostAtm(body, hostStar) {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar ?? 0;
  const g = bodyGravityEarth(body);
  const colMass = P > 0 ? Math.log10(P / g + 1) : 0;
  const tect = body.tectonicActivity ?? 0;
  const age = hostStar?.ageGyr ?? 5.0;
  // Shares astrophysics.insolation so the biosphere insolation input
  // matches the M-dwarf luminosity break used everywhere else (a raw
  // M^4 here would over-darken low-mass hosts). Null → 0 keeps the
  // downstream smoothstep windows well-defined.
  const insol = insolation(hostStar?.mass, body.semiMajorAu) ?? 0;
  const isGaseous = isGaseousBody(body);
  const isTerrestrialSolid = body.worldClass != null && TERRESTRIAL_SOLID_CLASSES.has(body.worldClass);

  const aw = BIOSPHERE_PRODUCTIVITY.ageWindow;
  const ageWindowAerial    = smoothstep(aw.aerial.rise[0], aw.aerial.rise[1], age);
  const ageWindowCryogenic = smoothstep(aw.cryogenic.rise[0], aw.cryogenic.rise[1], age);
  const ageWindowSilicate  = smoothstep(aw.silicate.rise[0], aw.silicate.rise[1], age);
  const ageWindowSulfur    = smoothstep(aw.sulfur.rise[0], aw.sulfur.rise[1], age);

  // ── aerial (Sagan-Salpeter floaters in gas-giant clouds) ──
  let bioticAerial;
  if (!isGaseous) {
    bioticAerial = null;
  } else if (T == null) {
    bioticAerial = 0;
  } else {
    // Bulk T proxy for cloud-deck T — gas giants don't carry per-deck T
    // explicitly, but the body's representative T sits in the visible
    // cloud-deck region by construction (atm-column derivation).
    const k = BIOSPHERE_PRODUCTIVITY.aerial;
    const T_cloud = bellGate(T, k.tempBell.center, k.tempBell.halfwidth);
    const ch4 = atmFracOf(body, 'CH4');
    const nh3 = atmFracOf(body, 'NH3');
    const h2o = atmFracOf(body, 'H2O');
    // Gas giants carry no surfacePressureBar (no surface to anchor
    // against) so the shared `colMass` is 0 here. Sub a cloud-top
    // reference pressure (~1 bar) so the precursor gate has a column-
    // thickness signal to weight against atm composition.
    const cloudDeckColMass = Math.log10(k.cloudTopPressureBar / g + 1);
    const organic_precursors = smoothstep(k.organicPrecursors[0], k.organicPrecursors[1], (ch4 + nh3 + h2o) * cloudDeckColMass);
    const windMs = (body.cloudLayers ?? []).reduce(
      (m, l) => Math.max(m, l.windSpeedMS ?? 0), 0
    );
    const circulation = 1 - smoothstep(k.circulation[0], k.circulation[1], windMs);
    const insol_window = smoothstep(k.insolRise[0], k.insolRise[1], insol) * (1 - smoothstep(k.insolFall[0], k.insolFall[1], insol));
    bioticAerial = T_cloud * organic_precursors * circulation
                   * insol_window * ageWindowAerial;
  }

  // ── cryogenic (Titan-class, hydrocarbon-cycle chemistry) ──
  let bioticCryogenic;
  if (isGaseous || !isTerrestrialSolid) {
    bioticCryogenic = null;
  } else if (T == null) {
    bioticCryogenic = 0;
  } else {
    const k = BIOSPHERE_PRODUCTIVITY.cryogenic;
    const cold_T = bellGate(T, k.tempBell.center, k.tempBell.halfwidth);
    const ch4 = atmFracOf(body, 'CH4');
    const hydrocarbon_atm = smoothstep(k.hydrocarbonAtm[0], k.hydrocarbonAtm[1], ch4 * P);
    const n2 = atmFracOf(body, 'N2');
    const n2_solvent = smoothstep(k.n2Solvent[0], k.n2Solvent[1], n2 * P);
    const tholin = body.hazeAerosols?.THOLIN ?? 0;
    const tholin_substrate = smoothstep(k.tholinSubstrate[0], k.tholinSubstrate[1], tholin);
    const uv_input = smoothstep(k.uvInput[0], k.uvInput[1], insol);
    bioticCryogenic = cold_T * hydrocarbon_atm * n2_solvent
                      * tholin_substrate * uv_input * ageWindowCryogenic;
  }

  // ── silicate (high-T mineral cycling, Si-based hypothetical) ──
  let bioticSilicate;
  if (isGaseous) {
    bioticSilicate = null;
  } else if (T == null) {
    bioticSilicate = 0;
  } else {
    const k = BIOSPHERE_PRODUCTIVITY.silicate;
    const hot_T = bellGate(T, k.tempBell.center, k.tempBell.halfwidth);
    const silicate_substrate = smoothstep(k.silicateSubstrate[0], k.silicateSubstrate[1], bulkSilicate10(body));
    const tectonic_activity = smoothstep(k.tectonic[0], k.tectonic[1], tect);
    const so2 = atmFracOf(body, 'SO2');
    const h2so4 = atmFracOf(body, 'H2SO4');
    const s2 = atmFracOf(body, 'S2');
    const volatile_solvent = smoothstep(k.volatileSolvent[0], k.volatileSolvent[1], (so2 + h2so4 + s2) * P);
    const radioactives = body.resRadioactives ?? 0;
    const energy = Math.max(smoothstep(k.insolEnergy[0], k.insolEnergy[1], insol), smoothstep(k.radioEnergy[0], k.radioEnergy[1], radioactives));
    bioticSilicate = hot_T * silicate_substrate * tectonic_activity
                     * volatile_solvent * energy * ageWindowSilicate;
  }

  // ── sulfur (Venus-cloud / Io-class sulfur-cycle) ──
  let bioticSulfur;
  if (isGaseous) {
    bioticSulfur = null;
  } else if (T == null) {
    bioticSulfur = 0;
  } else {
    const k = BIOSPHERE_PRODUCTIVITY.sulfur;
    const warm_T = bellGate(T, k.tempBell.center, k.tempBell.halfwidth);
    const so2 = atmFracOf(body, 'SO2');
    const h2s = atmFracOf(body, 'H2S');
    const h2so4 = atmFracOf(body, 'H2SO4');
    const sulfur_atm = smoothstep(k.sulfurAtm[0], k.sulfurAtm[1], (so2 + h2s + h2so4) * P);
    const active_volcanism = smoothstep(k.volcanism[0], k.volcanism[1], tect);
    const sulfur_substrate = smoothstep(k.substrate[0], k.substrate[1], (body.resRadioactives ?? 0) + bulkSilicate10(body));
    bioticSulfur = warm_T * sulfur_atm * active_volcanism
                   * sulfur_substrate * ageWindowSulfur;
  }

  return { bioticAerial, bioticCryogenic, bioticSilicate, bioticSulfur };
}

// Argmax over the per-archetype productivity scalars. Returns the
// dominant archetype + its productivity, or `{ archetype: null, prod: 0 }`
// when every entry is null/zero. Pure helper shared by the complexity
// + coupling derivations below.
function dominantArchetype(productivity) {
  let bestArch = null;
  let bestProd = 0;
  for (const [arch, prod] of Object.entries(productivity)) {
    if (prod == null || prod <= bestProd) continue;
    bestArch = arch;
    bestProd = prod;
  }
  return { archetype: bestArch, prod: bestProd };
}

// Productivity → complexity bucket via per-archetype thresholds.
// Steeper thresholds mean the archetype climbs the complexity ladder
// more reluctantly; every archetype CAN reach `complex` in principle,
// but only with high productivity. Thresholds are exclusive at the
// lower bound, matching the prior labelsFromProductivity convention
// (productivity == threshold falls into the lower bucket).
function complexityFromProductivity(productivity, archetype) {
  if (archetype == null || productivity == null) return 'none';
  const [prebiotic, microbial, complex] = COMPLEXITY_THRESHOLDS[archetype];
  if      (productivity <  prebiotic) return 'none';
  else if (productivity <  microbial) return 'prebiotic';
  else if (productivity <  complex)   return 'microbial';
  else                                return 'complex';
}

// Sample a log-normal deviate from a {median, sigma} spec. Median is
// the linear-space geometric mean; sigma is the log-space standard
// deviation. Lives here rather than in prng.mjs because the coupling
// pipeline is the only caller — sampleLogTruncated upstream takes a
// different spec shape (mean / sd / clamp bounds) and would muddy
// this call site.
function sampleLognormal(prng, spec) {
  return Math.exp(sampleNormal(prng, Math.log(spec.median), spec.sigma));
}

// Per-body surface coupling derivation. Composes substrate jitter
// (archetype base × log-normal multiplicative noise) with an always-on
// additive life contribution at the microbial / complex tiers. The
// fat tail of the log-normal life contribution is where the "Enceladus
// plume" through "telescopes poking out of the ice" range lives —
// no discrete breakthrough event, just the natural distribution tail.
// Returns the coupling scalar in [0..1].
function surfaceCouplingForBody(body, archetype, complexity) {
  if (archetype == null) return 0;
  const prng = fieldPrng(body, 'surface_coupling');
  const { base, sigma: substrateSigma } = ARCHETYPE_COUPLING_PRIOR[archetype];
  // Substrate jitter — log-normal multiplier on archetype base. Mean
  // log = 0 so the expected linear-space multiplier is e^(σ²/2),
  // skewing slightly above 1 (acceptable; the audit verifies the
  // distribution matches the calibration anchors).
  let coupling = base * Math.exp(sampleNormal(prng, 0, substrateSigma));
  if (complexity === 'complex') {
    coupling += sampleLognormal(prng, LIFE_SURFACE_CONTRIBUTION[archetype]);
  } else if (complexity === 'microbial' && MICROBIAL_SURFACE_CONTRIBUTION) {
    const spec = MICROBIAL_SURFACE_CONTRIBUTION[archetype];
    if (spec) coupling += sampleLognormal(prng, spec);
  }
  return Math.max(0, Math.min(1, coupling));
}

// Resolve the three biosphere display fields from the per-archetype
// productivity scalars. Two CSV-driven paths share one impact computation:
//   1. CSV-authored — biosphereArchetype + biosphereComplexity are NOT in
//      `unknowns` (cell was 'n/a' → sterile, or a literal value → use as
//      authored). Both must travel together; a half-authored pair throws.
//   2. Procgen-derived — both ARE in `unknowns` (empty cells): argmax over
//      the productivity scalars + per-archetype complexity threshold.
// surfaceImpact is always derived (never authored) so the per-body coupling
// jitter applies uniformly. `authoredArchetype` / `authoredComplexity` are
// the raw values from the body's CSV row (null when absent / 'n/a').
function resolveBiosphere(body, productivityByArch, unknowns, authoredArchetype, authoredComplexity) {
  const archIsAuthored = !unknowns.has('biosphereArchetype');
  const cmplxIsAuthored = !unknowns.has('biosphereComplexity');
  let resolvedArch = null;
  let resolvedCmplx = 'none';
  if (archIsAuthored || cmplxIsAuthored) {
    // CSV-authored path. Both fields should travel together — an archetype
    // without a complexity (or vice versa) is malformed; reject rather than
    // silently filling in.
    if (archIsAuthored !== cmplxIsAuthored) {
      throw new Error(`${body.id}: biosphere_archetype and biosphere_complexity must both be authored or both blank`);
    }
    // Validate authored values against the enum sets. Null is legitimate
    // (the 'n/a' cell semantic — body is sterile).
    if (authoredArchetype !== null && !VALID_ARCHETYPES.has(authoredArchetype)) {
      throw new Error(`${body.id}: invalid biosphere_archetype=${authoredArchetype}`);
    }
    if (authoredComplexity !== null && !VALID_COMPLEXITY.has(authoredComplexity)) {
      throw new Error(`${body.id}: invalid biosphere_complexity=${authoredComplexity}`);
    }
    // n/a in either cell means sterile — both must be present for life to
    // register. (Avoids a half-authored "complex with no archetype" or
    // "carbon_aqueous with no complexity" sneaking through.)
    if (authoredArchetype === null || authoredComplexity === null || authoredComplexity === 'none') {
      resolvedArch = null;
      resolvedCmplx = 'none';
    } else {
      resolvedArch = authoredArchetype;
      resolvedCmplx = authoredComplexity;
    }
  } else {
    // Procgen-derived path — argmax + bucket.
    const { archetype, prod } = dominantArchetype(productivityByArch);
    const complexity = complexityFromProductivity(prod, archetype);
    resolvedArch = complexity === 'none' ? null : archetype;
    resolvedCmplx = complexity;
  }
  if (resolvedCmplx === 'none') {
    return { biosphereArchetype: null, biosphereComplexity: 'none', biosphereSurfaceImpact: 0 };
  }
  const coupling = surfaceCouplingForBody(body, resolvedArch, resolvedCmplx);
  const archProd = productivityByArch[resolvedArch] ?? 0;
  return {
    biosphereArchetype: resolvedArch,
    biosphereComplexity: resolvedCmplx,
    biosphereSurfaceImpact: Math.max(0, Math.min(1, archProd * coupling)),
  };
}

// =============================================================================
// Filler entry point
// =============================================================================

// Returns a new bodies array with empties filled where possible. `_unknowns`
// is stripped from each body in the process. Bodies whose anchors don't
// support filling (missing mass/radius/host) keep their nulls.
export function fillBodies(bodies, stars) {
  return bodies.map(b => fillBody(b, bodies, stars));
}

// One cover→albedo→temp→cover iteration for a given greenhouse offset.
// `prevWater`/`prevIce` seed the albedo's cloud/ice contribution so the
// caller can run it twice (cold start, then refined by pass 1's cover).
// Reads the body's settled physics off `ctx.working`; returns all-null
// when T can't be resolved (missing radius or insolation).
function runTempIcePass(ctx, prevWater, prevIce, greenhouseK) {
  const { working, S, surfacePressureBar, bulkWaterFraction, waterNoise, iceNoise } = ctx;
  const stateForAlbedo = {
    ...working,
    waterFraction: prevWater,
    iceFraction:   prevIce,
    // T not yet known; bondAlbedoFor's cloud gate uses T — pass null
    // first pass, refined T on second.
    avgSurfaceTempK: null,
  };
  // First T-pass without cloud temperature gate
  let A = bondAlbedoFor(stateForAlbedo);
  let T = avgSurfaceTempFromAlbedo(working.radiusEarth, S, A, greenhouseK);
  if (T == null) return { T: null, Tmin: null, Tmax: null, ice: null, water: null };
  // Recompute albedo with T available so the cloud-temperate gate fires
  A = bondAlbedoFor({ ...stateForAlbedo, avgSurfaceTempK: T });
  T = avgSurfaceTempFromAlbedo(working.radiusEarth, S, A, greenhouseK);
  if (T == null) return { T: null, Tmin: null, Tmax: null, ice: null, water: null };
  const { min: Tmin, max: Tmax } = surfaceTempRangeFor({
    ...working,
    avgSurfaceTempK: T,
    waterFraction: prevWater,
    surfacePressureBar,
  });
  const water = surfaceLiquidWaterCover(bulkWaterFraction, T, surfacePressureBar, waterNoise);
  const ice   = surfaceIceCover(bulkWaterFraction, T, Tmin, surfacePressureBar, iceNoise);
  return { T, Tmin, Tmax, ice, water };
}

function fillBody(b, allBodies, stars) {
  // Resolve host + the mass that drives Kepler's third law for this body:
  //   planet → host star (solar masses)
  //   moon   → parent planet (Earth masses; convert to solar)
  let hostStar = null;
  let hostMassSolar = null;
  let hostBody = null;
  if (b.kind === 'planet') {
    if (b.hostStarIdx != null) {
      hostStar = stars[b.hostStarIdx];
      hostMassSolar = hostStar.mass;
    }
  } else if (b.kind === 'moon') {
    if (b.hostBodyIdx != null) {
      hostBody = allBodies[b.hostBodyIdx] ?? null;
      if (hostBody) {
        if (hostBody.hostStarIdx != null) {
          hostStar = stars[hostBody.hostStarIdx];
        }
        if (hostBody.massEarth != null) {
          hostMassSolar = hostBody.massEarth / EARTH_PER_SOLAR_MASS;
        }
      }
    }
  }

  const unknowns = new Set(b._unknowns ?? []);

  // Track filled values starting from the body's current state. Each
  // generator reads its dependencies from a working copy that includes
  // previously-filled values; that's how downstream rules pick up upstream
  // results within the same pass.
  //
  // ⚠ This destructure and the return object at the end of fillBody are the
  // canonical Body field list. Nothing enforces it, but three other lists
  // must stay in lockstep when a field is added/removed/renamed:
  //   • makeBody                 (procgen-architect.mjs) — the architect's body factory
  //   • BODY_NUMERIC_FIELDS /
  //     BODY_STRING_FIELDS       (build-catalog.mjs) — JSON (de)serialization typing
  let {
    radiusEarth, worldClass, bulkWaterFraction, bulkMetalFraction, bulkVolatileFraction,
    waterFraction, iceFraction, surfaceAge,
    avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
    tectonicActivity, rotationPeriodHours, magneticFieldGauss,
    surfacePressureBar,
    atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac,
    cloudLayers, surfaceOpacity,
    hazeAerosols, dustStrength,
    resMetals, resSilicates, resVolatiles, resRareEarths, resRadioactives, resExotics,
    bioticCarbonAqueous, bioticSubsurfaceAqueous, bioticAerial,
    bioticCryogenic, bioticSilicate, bioticSulfur,
    biosphereArchetype, biosphereComplexity, biosphereSurfaceImpact,
    periodDays, semiMajorAu, eccentricity, inclinationDeg,
    axialTiltDeg, orbitalPhaseDeg,
  } = b;

  // Kepler relation — periodDays ↔ semiMajorAu round-trip. Must run
  // before insolation S is captured below: catalog rows that carry
  // periodDays but no semi_major_au need the derived semiMajorAu to
  // feed S, otherwise S=null cascades through temp/pressure/worldClass
  // and the body renders as a featureless gray disc.
  if (unknowns.has('periodDays') && semiMajorAu != null) {
    const p = keplerPeriodDays(semiMajorAu, hostMassSolar);
    if (p != null) periodDays = Number(p.toFixed(3));
  }
  if (unknowns.has('semiMajorAu') && periodDays != null) {
    const a = deriveSemiMajorAu(periodDays, hostMassSolar);
    if (a != null) semiMajorAu = a;
  }

  // Insolation always traces up to the host star, so a moon inherits its
  // parent planet's stellar flux.
  const aFromStar = b.kind === 'moon'
    ? (hostBody ? hostBody.semiMajorAu : null)
    : semiMajorAu;
  const S = hostStar ? insolation(hostStar.mass, aFromStar) : null;
  // Composition (bulkWater / bulkMetal / bulkVolatile) reads insolation
  // at the body's formation location, not its current orbit — a hot
  // Jupiter that migrated from past the frost line keeps its outer-zone
  // water budget. For in-situ formation (formationAu null or equal to
  // semiMajorAu), Sform === S. Moons inherit formation context from
  // their host planet.
  const aFormation = b.kind === 'planet'
    ? (b.formationAu ?? aFromStar)
    : (b.kind === 'moon' && hostBody)
      ? (hostBody.formationAu ?? aFromStar)
      : aFromStar;
  const Sform = hostStar ? insolation(hostStar.mass, aFormation) : null;
  // Frost-line trio for the four-zone bulk-composition gate. Deterministic
  // from host star mass — no PRNG draw, computed once per body. Null when
  // the host star is missing; bulk* fillers fall through to null.
  const frostLinesAu = hostStar ? frostLineTrio(hostStar.mass) : null;
  const lockProxy = (b.kind === 'planet' && hostStar)
    ? tidalLockProxy(hostStar.mass, semiMajorAu)
    : (b.kind === 'moon' ? tidalLockProxy(hostMassSolar, semiMajorAu) : null);

  if (unknowns.has('radiusEarth')) {
    const r = radiusFromMass(b.massEarth);
    if (r != null) radiusEarth = r;
  }

  let working = { ...b, radiusEarth, periodDays, semiMajorAu };

  // Bulk composition fill for catalog rows the Architect didn't touch.
  // Symmetric with the Architect's per-body draws; all three read the
  // four-zone formation gate (aFormation vs the host star's frost-line
  // trio). Fall through to null when host star or formationAu unknown.
  if (unknowns.has('bulkWaterFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkWaterFraction = sampleBulkWaterFraction(fieldPrng(working, 'bulk_water'), aFormation, frostLinesAu);
    }
  }
  if (unknowns.has('bulkMetalFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkMetalFraction = sampleBulkMetalFraction(fieldPrng(working, 'bulk_metal'), aFormation, frostLinesAu);
    }
  }
  if (unknowns.has('bulkVolatileFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkVolatileFraction = sampleBulkVolatileFraction(fieldPrng(working, 'bulk_volatile'), aFormation, frostLinesAu);
    }
  }
  working = { ...working, bulkWaterFraction, bulkMetalFraction, bulkVolatileFraction };

  // Orbital flavor early so tilt + eccentricity are available when temp
  // range and surface age run later. The four fields ride independent
  // per-field PRNG streams, so drawing the full set and assigning only the
  // unknown ones is identical to drawing each in isolation — a discarded
  // draw can't perturb a sibling stream.
  const orbital = sampleOrbitalFlavor({
    eccPrng: fieldPrng(b, 'eccentricity'),
    incPrng: fieldPrng(b, 'inclinationDeg'),
    tiltPrng: fieldPrng(b, 'axialTiltDeg'),
    phasePrng: fieldPrng(b, 'orbitalPhaseDeg'),
  });
  if (unknowns.has('eccentricity'))    eccentricity = orbital.eccentricity;
  if (unknowns.has('inclinationDeg'))  inclinationDeg = orbital.inclinationDeg;
  if (unknowns.has('axialTiltDeg'))    axialTiltDeg = orbital.axialTiltDeg;
  if (unknowns.has('orbitalPhaseDeg')) orbitalPhaseDeg = orbital.orbitalPhaseDeg;
  working = { ...working, eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg };

  // Class-free physical scalar chain: tectonics → rotation → magnetic.
  // Each reads from physics (mass, period, lock proxy) not from class.
  if (unknowns.has('tectonicActivity')) {
    tectonicActivity = tectonicActivityFor(working);
  }
  working = { ...working, tectonicActivity };

  if (unknowns.has('rotationPeriodHours')) {
    rotationPeriodHours = rotationPeriodHoursFor(working, periodDays, lockProxy);
  }
  working = { ...working, rotationPeriodHours };

  if (unknowns.has('magneticFieldGauss')) {
    magneticFieldGauss = magneticFieldGaussFor(working);
  }
  working = { ...working, magneticFieldGauss };

  // Pressure depends on retention (Jeans escape using bare T_eq) and
  // outgassing potential — no class input.
  if (unknowns.has('surfacePressureBar')) {
    const p = surfacePressureFor(working, S);
    if (p != null) surfacePressureBar = p;
  }
  working = { ...working, surfacePressureBar };

  // Two-pass iteration on temperature ↔ albedo ↔ ice/water cover.
  // Pass 1: no prior cover → albedo from land alone → high T_eq → coarse cover.
  // Pass 2: pass-1 cover lifts albedo → refined T → final cover.
  // Cover noise multipliers drawn once, shared across passes (only the
  // deterministic gates refine, not the stochastic noise).
  const iceNoise   = sampleTruncated(fieldPrng(b, 'iceCover'),   ICE_COVER_NOISE);
  const waterNoise = sampleTruncated(fieldPrng(b, 'waterCover'), WATER_COVER_NOISE);

  // Run the two-pass settle for one greenhouse offset against the current
  // `working`, then commit the resolved temp/cover fields into the unknowns
  // and `working`. Pass A (pressure proxy) and Pass B (composition-aware)
  // share this body so the five-field commit lives in one place.
  const applyTempPass = (greenhouseK) => {
    const ctx = { working, S, surfacePressureBar, bulkWaterFraction, waterNoise, iceNoise };
    const p1 = runTempIcePass(ctx, 0, 0, greenhouseK);
    const p2 = runTempIcePass(ctx, p1.water ?? 0, p1.ice ?? 0, greenhouseK);
    if (unknowns.has('avgSurfaceTempK') && p2.T != null) avgSurfaceTempK = p2.T;
    if (unknowns.has('surfaceTempMinK') && p2.Tmin != null) surfaceTempMinK = p2.Tmin;
    if (unknowns.has('surfaceTempMaxK') && p2.Tmax != null) surfaceTempMaxK = p2.Tmax;
    if (unknowns.has('iceFraction')   && p2.ice   != null) iceFraction   = p2.ice;
    if (unknowns.has('waterFraction') && p2.water != null) waterFraction = p2.water;
    working = {
      ...working,
      avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
      iceFraction, waterFraction,
    };
  };

  // ─── Pass A: pressure-proxy greenhouse ───
  // Initial estimate — atm composition isn't known yet, so we use the
  // pressure proxy. This settles T/water/ice enough to derive class and
  // dispatch atm species; Pass B will refine using the resulting
  // composition.
  const greenhouseA = greenhouseKFromPressure(surfacePressureBar);
  applyTempPass(greenhouseA);

  // Surface age — derived from tectonic activity + tidal lift for
  // eccentric moons of gaseous hosts.
  if (unknowns.has('surfaceAge')) {
    surfaceAge = surfaceAgeFor(working, hostBody);
  }
  working = { ...working, surfaceAge };

  // Pre-atm biotic productivity — carbon_aqueous + subsurface_aqueous.
  // Neither depends on atmospheric composition. Runs before atm so the
  // atm step can read productivity[carbon_aqueous] for biotic O2 lift
  // (clean acyclic dependency: bio productivity → atm composition).
  if (unknowns.has('bioticCarbonAqueous') || unknowns.has('bioticSubsurfaceAqueous')) {
    const p = productivityPreAtm(working, hostStar, hostBody);
    if (unknowns.has('bioticCarbonAqueous'))     bioticCarbonAqueous     = p.bioticCarbonAqueous;
    if (unknowns.has('bioticSubsurfaceAqueous')) bioticSubsurfaceAqueous = p.bioticSubsurfaceAqueous;
  }
  working = { ...working, bioticCarbonAqueous, bioticSubsurfaceAqueous };

  // Atmosphere — regime-keyed top-3 gas dispatch with biosphere O2 lift.
  if (unknowns.has('atm1') || unknowns.has('atm2') || unknowns.has('atm3')) {
    const [a1, a2, a3] = atmosphereFor(working, S);
    if (unknowns.has('atm1')) { atm1 = a1?.gas ?? null; atm1Frac = a1?.frac ?? null; }
    if (unknowns.has('atm2')) { atm2 = a2?.gas ?? null; atm2Frac = a2?.frac ?? null; }
    if (unknowns.has('atm3')) { atm3 = a3?.gas ?? null; atm3Frac = a3?.frac ?? null; }
  }
  working = { ...working, atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac };

  // ─── Pass B: composition-aware greenhouse refinement ───
  // Pass A used the pressure-proxy greenhouse to settle T/water/ice.
  // Now that atm composition is known, refine greenhouse from per-
  // gas potencies and re-run the T↔ice loop. Skipped when the proxy
  // is already within 1K of the composition value (most bodies).
  // Cloud + haze emission run AFTER Pass B so they see the final T
  // (cloud condensation windows are tight; a 20 K refinement can
  // flip which species fires).
  if (working.surfacePressureBar != null && working.surfacePressureBar > 0) {
    const greenhouseB = greenhouseKFromComposition(working);
    if (Math.abs(greenhouseB - greenhouseA) > 1) {
      applyTempPass(greenhouseB);
    }
  }

  // Cloud layers — up to MAX_CLOUD_LAYERS stratified decks. Per-species
  // condensation gates (cloudDecksFor) iterate CONDENSABLES: each
  // species' temp window × precursor gate produces a strength; coverage
  // is then derived from strength + a sparse-cirrus mode gate keyed
  // off the species' contribution to atm column color. Curated bodies
  // that authored decks in body_layers.csv skip this and keep the CSV
  // values. Surface opacity is co-derived here so the renderer always
  // has a scalar to drive composition (gas giants = 0, terrestrials = 1).
  if (unknowns.has('cloudLayers')) {
    cloudLayers = cloudDecksFor(working, S);
  }
  surfaceOpacity = surfaceOpacityFor(working);
  working = { ...working, cloudLayers, surfaceOpacity };

  // Unified haze derivation — emits per-species aerosol formation
  // strengths + dust strength. Reads cloudLayers (above) for the
  // NH4SH / CHROMOPHORE chemistry gates that require an NH3 deck.
  // Final opacity + color are blended at render time (disc-palette)
  // from this contributor list plus the body's atm + pressure.
  {
    const h = hazeFor(working);
    hazeAerosols = h.aerosols;
    dustStrength = h.dust;
  }
  working = { ...working, hazeAerosols, dustStrength };

  // ─── DERIVE worldClass ─── pure label off settled physical state.
  // Runs LAST so it reads the final refined T (post Pass B) plus the
  // settled atm composition (hycean/helium branches inspect atm1).
  // Nothing in the physics pipeline reads it — it's display-only.
  if (unknowns.has('worldClass')) {
    const w = worldClassFor(working, S);
    if (w != null) worldClass = w;
  }
  working = { ...working, worldClass };

  // Resources — two context-weighted deposits drawn per body (the other
  // four fields stay 0). See resourcesFor.
  if (
    unknowns.has('resMetals') || unknowns.has('resSilicates') || unknowns.has('resVolatiles') ||
    unknowns.has('resRareEarths') || unknowns.has('resRadioactives') || unknowns.has('resExotics')
  ) {
    const r = resourcesFor(working, hostStar, hostBody);
    if (r) {
      if (unknowns.has('resMetals'))       resMetals = r.resMetals;
      if (unknowns.has('resSilicates'))    resSilicates = r.resSilicates;
      if (unknowns.has('resVolatiles'))    resVolatiles = r.resVolatiles;
      if (unknowns.has('resRareEarths'))   resRareEarths = r.resRareEarths;
      if (unknowns.has('resRadioactives')) resRadioactives = r.resRadioactives;
      if (unknowns.has('resExotics'))      resExotics = r.resExotics;
    }
  }
  working = {
    ...working,
    resMetals, resSilicates, resVolatiles,
    resRareEarths, resRadioactives, resExotics,
  };

  // Post-atm biotic productivity — aerial / cryogenic / silicate /
  // sulfur. Reads worldClass (for the gaseous / terrestrial-solid
  // gates) and atm composition + haze aerosols + resource grid
  // (silicate substrate, sulfur substrate). Must run AFTER worldClass
  // and resources are settled — both feed gating factors here.
  if (
    unknowns.has('bioticAerial')   || unknowns.has('bioticCryogenic') ||
    unknowns.has('bioticSilicate') || unknowns.has('bioticSulfur')
  ) {
    const p = productivityPostAtm(working, hostStar);
    if (unknowns.has('bioticAerial'))    bioticAerial    = p.bioticAerial;
    if (unknowns.has('bioticCryogenic')) bioticCryogenic = p.bioticCryogenic;
    if (unknowns.has('bioticSilicate'))  bioticSilicate  = p.bioticSilicate;
    if (unknowns.has('bioticSulfur'))    bioticSulfur    = p.bioticSulfur;
  }

  // Derive the three biosphere display fields from the productivity
  // scalars (see resolveBiosphere + the procgen-priors.mjs biosphere
  // section for the model):
  //   archetype       — argmax over the six scalars
  //   complexity      — per-archetype thresholds bucket the dominant
  //                     productivity; encodes probabilistic headwinds
  //   surfaceImpact   — productivity × per-body surface coupling
  //                     (substrate jitter + life-tier additive
  //                     contribution); decouples "is alive" from
  //                     "looks alive" so a complex subsurface biosphere
  //                     reads as a sealed Europa rather than a Gaian.
  {
    const productivityByArch = {
      carbon_aqueous:     bioticCarbonAqueous,
      subsurface_aqueous: bioticSubsurfaceAqueous,
      aerial:             bioticAerial,
      cryogenic:          bioticCryogenic,
      silicate:           bioticSilicate,
      sulfur:             bioticSulfur,
    };
    ({ biosphereArchetype, biosphereComplexity, biosphereSurfaceImpact } =
      resolveBiosphere(b, productivityByArch, unknowns, biosphereArchetype, biosphereComplexity));
  }

  // Strip _unknowns; runtime sees only the public Body shape.
  const { _unknowns, ...rest } = b;
  return {
    ...rest,
    radiusEarth, worldClass, bulkWaterFraction, bulkMetalFraction, bulkVolatileFraction,
    waterFraction, iceFraction, surfaceAge,
    avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
    tectonicActivity, rotationPeriodHours, magneticFieldGauss,
    surfacePressureBar,
    atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac,
    cloudLayers, surfaceOpacity,
    hazeAerosols, dustStrength,
    resMetals, resSilicates, resVolatiles, resRareEarths, resRadioactives, resExotics,
    bioticCarbonAqueous, bioticSubsurfaceAqueous, bioticAerial,
    bioticCryogenic, bioticSilicate, bioticSulfur,
    biosphereArchetype, biosphereComplexity, biosphereSurfaceImpact,
    periodDays, semiMajorAu,
    eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg,
  };
}
