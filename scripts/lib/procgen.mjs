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
// Generator dependency chain (run in this order in fillBody):
//   radiusEarth ← massEarth
//   worldClass ← radiusEarth + insolation
//   waterFraction, iceFraction ← worldClass
//   tectonicActivity ← worldClass + massEarth
//   periodDays ↔ semiMajorAu (Kepler 3, bidirectional; needs host mass)
//   rotationPeriodHours ← worldClass + tidal-lock proxy + periodDays
//   magneticFieldGauss ← worldClass + tectonicActivity + rotationPeriodHours
//   surfacePressureBar ← worldClass + massEarth        (must precede avgSurfaceTempK)
//   avgSurfaceTempK ← worldClass + insolation + iceFraction + surfacePressureBar
//                     (Bond albedo derived locally — see effectiveBondAlbedo)
//   eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg ← seeded draws
//   surfaceAge ← worldClass + eccentricity + host worldClass (moons of giants
//                                                             get tidal lift)
//   surfaceTempMinK, surfaceTempMaxK ← avg + worldClass + axial tilt + eccentricity
//   biosphereArchetype, biosphereTier ← worldClass + insolation gate   (must precede atmosphere)
//   atm1..atm3 + fractions ← worldClass + surfacePressureBar + biosphere
//   resMetals..resExotics ← worldClass
//
// The Kepler step is bidirectional so RV-discovery catalog rows (period
// known, axis unknown) and transit-discovery rows (axis known, period
// unknown) both fill out symmetrically.

import { hash32, mulberry32, sampleTruncated, sampleLogTruncated, sampleMixture } from './prng.mjs';
import {
  PROCGEN_VERSION,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
  zoneForFormationAu,
  SNOW_LINE_TEMPERATURES,
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
  ATMOSPHERE_O2_BIOTIC_LIFT,
  ATMOSPHERE_MIN_PRESSURE_BAR,
  INSOLATION_COLD_MAX,
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
  CLOUD_REGIME_THRESHOLDS,
  CLOUD_BY_REGIME,
  BIOSPHERE_HABITATS,
} from './procgen-priors.mjs';
import { insolation, tidalLockProxy, meanMetallicityForClass, meanAgeForClass, frostLineAU } from './astrophysics.mjs';

function fieldPrng(body, field) {
  return mulberry32(hash32(`${body.id}:${field}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Physics helpers
// =============================================================================

const SIGMA_SB = 5.670374e-8;   // Stefan-Boltzmann constant (W/m²/K⁴)
const SOLAR_CONSTANT = 1361;    // Solar irradiance at 1 AU (W/m²)
const BOLTZMANN = 1.380649e-23; // Boltzmann constant (J/K)
const ATOMIC_MASS_UNIT = 1.66053906660e-27;  // amu in kg
const GRAV_CONSTANT = 6.6743e-11;            // m³/(kg·s²)
const EARTH_MASS_KG = 5.9722e24;
const EARTH_RADIUS_M = 6.371e6;

// Mean molecular weight (amu) of the representative atmospheric
// species used in the Jeans-escape ratio. N2 is the canonical anchor
// — it dominates Earth, Titan, and Triton retained atmospheres. Lighter
// species (H2, He) escape more easily; heavier (CO2) retain longer.
// One-species model is the agreed-on simplification for Phase 2.
const RETENTION_SPECIES_AMU = 28;

// Earth masses per solar mass. Used to convert planet mass to solar
// units for Kepler's third law applied to moons (whose "host" is their
// parent planet, not a star).
const EARTH_PER_SOLAR_MASS = 333000;

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
  if (m < 2)   return Number(Math.pow(m, 0.279).toFixed(3));
  if (m < 130) return Number((0.808 * Math.pow(m, 0.589)).toFixed(3));
  return 11.0;
}

// =============================================================================
// Kepler period ↔ semi-major axis
// =============================================================================

// Kepler's third law in solar units: P² (years) = a³ (AU) / M (solar).
// Day form: P_days = 365.25 · √(a³ / M).
function keplerPeriodDays(aAu, hostMassSolar) {
  if (aAu == null || hostMassSolar == null || hostMassSolar <= 0) return null;
  return Number((365.25 * Math.sqrt(Math.pow(aAu, 3) / hostMassSolar)).toFixed(3));
}

// Inverse: a = ((P_years)² · M)^(1/3).
function keplerSemiMajorAu(periodDays, hostMassSolar) {
  if (periodDays == null || hostMassSolar == null || hostMassSolar <= 0) return null;
  const pYears = periodDays / 365.25;
  return Number(Math.pow(pYears * pYears * hostMassSolar, 1 / 3).toFixed(5));
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
  // Ice: surface ice dominant, no liquid (Callisto/Triton)
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
  const atmGases = new Set();
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
      atmGases.add(gas);
      addContribution(gas, body[fracField]);
    }
  }
  // Cap total cloud bump — even a fully overcast Venus-class atm
  // can't push surface-blend albedo past clean-snow territory.
  return Math.min(bump, 0.6);
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
  const atmGases = new Set();
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
      atmGases.add(gas);
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
  const tEq = Math.pow((S * SOLAR_CONSTANT * (1 - bondAlbedo)) / (4 * SIGMA_SB), 0.25);
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
  const M = massEarth * EARTH_MASS_KG;
  const R = radiusEarth * EARTH_RADIUS_M;
  if (M <= 0 || R <= 0) return 0;
  const vEsc = Math.sqrt(2 * GRAV_CONSTANT * M / R);
  const vTh = Math.sqrt(3 * BOLTZMANN * equilibriumT / (RETENTION_SPECIES_AMU * ATOMIC_MASS_UNIT));
  const ratio = vEsc / vTh;
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
  // Gaseous bodies have no surface — radius gate replaces the old
  // worldClass check, decoupling pressure derivation from class.
  if (body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) return null;
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

// Fill bulkWaterFraction from the formation-zone prior for catalog rows
// that landed without an Architect-set value. Symmetric with the
// Architect's sampleBulkWaterFraction. Returns null when formationAu /
// frost lines are unknown.
function bulkWaterFractionFor(body, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(fieldPrng(body, 'bulk_water'), BULK_WATER_FRACTION_BY_ZONE[zone]).toFixed(5));
}

// Architect's companion bulk-metal sampler for catalog rows. Same
// four-zone gate as bulkWater — refractory metals condense first inside
// the H2O line, each successive snow line dilutes metal fraction as
// volatiles join the solid budget.
function bulkMetalFractionFor(body, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(fieldPrng(body, 'bulk_metal'), BULK_METAL_FRACTION_BY_ZONE[zone]).toFixed(5));
}

// Non-water condensable volatile inventory — same four-zone formation
// gate. Past CH4 line this becomes the dominant ice; inside H2O it's
// only the refractory-trapped CO2/N2 floor.
function bulkVolatileFractionFor(body, formationAu, frostLinesAu) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(fieldPrng(body, 'bulk_volatile'), BULK_VOLATILE_FRACTION_BY_ZONE[zone]).toFixed(5));
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
  if (body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) return null;
  if (body.tectonicActivity == null) return null;
  const noise = sampleTruncated(fieldPrng(body, 'surfaceAge'), SURFACE_AGE_FROM_TECTONIC.noise);
  let age = Math.pow(body.tectonicActivity, SURFACE_AGE_FROM_TECTONIC.exponent) * noise;
  // Tidal-heating lift for eccentric moons of gaseous hosts. Host gate
  // is now radius-based (was class-based) — same physical bodies, no
  // worldClass dependency.
  const hostIsGaseous = hostBody?.radiusEarth != null &&
    hostBody.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;
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
  if (body.radiusEarth != null && body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) {
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

// Per-gas mean molecular weight in atomic-mass-units. Used by the Jeans
// escape filter to zero out light-gas weights when the body's escape
// velocity / thermal velocity ratio is too low to retain that gas.
const GAS_MOLECULAR_WEIGHT_AMU = {
  H2:  2,
  He:  4,
  CH4: 16,
  NH3: 17,
  H2O: 18,
  CO:  28,
  N2:  28,
  O2:  32,
  Ar:  40,
  CO2: 44,
  SO2: 64,
};

// Per-gas Jeans-retention check. Reuses the smoothstep gates from the
// ATMOSPHERIC_RETENTION prior (calibrated against N2). Returns a 0..1
// retention scalar for the gas — light gases on small bodies return ~0
// and the dispatch zeros their weight.
function gasRetentionFraction(massEarth, radiusEarth, equilibriumT, gas) {
  const amu = GAS_MOLECULAR_WEIGHT_AMU[gas];
  if (amu == null || amu <= 0) return 1;
  if (massEarth == null || radiusEarth == null || equilibriumT == null) return 1;
  const M = massEarth * EARTH_MASS_KG;
  const R = radiusEarth * EARTH_RADIUS_M;
  if (M <= 0 || R <= 0) return 0;
  const vEsc = Math.sqrt(2 * GRAV_CONSTANT * M / R);
  const vTh = Math.sqrt(3 * BOLTZMANN * equilibriumT / (amu * ATOMIC_MASS_UNIT));
  const ratio = vEsc / vTh;
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
  if (body.radiusEarth != null && body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) {
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
  // Biotic O2 lift — only fires when the regime supports it (wet_outgassed
  // is where Earth-class biotic O2 lives). Keyed on biosphere archetype
  // (which is itself physics-derived in Phase 4.5).
  const lift = ATMOSPHERE_O2_BIOTIC_LIFT[body.biosphereArchetype]?.[body.biosphereTier];
  if (lift != null && weights.O2 != null) {
    weights.O2 *= lift;
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

// BIOSPHERE_TIERS order; used in regime gate matching.
const BIOSPHERE_TIER_ORDER = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];

// Cloud + haze regime dispatch — pure physics, no class input. Bucket
// the body's physical state into one of nine regimes; each regime
// resolves to a cloud + haze spec via CLOUD_BY_REGIME and HAZE_BY_REGIME.
// Distinct from `atmosphereRegimeFor` (above), which buckets atm-species
// dispatch via a different threshold set.
function cloudHazeRegimeFor(body, S) {
  if (body.surfacePressureBar != null && body.surfacePressureBar < ATMOSPHERE_MIN_PRESSURE_BAR) {
    return null;
  }
  const t = CLOUD_REGIME_THRESHOLDS;
  const T = body.avgSurfaceTempK;
  // Gaseous bracket (radius >= gasDwarfRadius)
  if (body.radiusEarth != null && body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) {
    if (T != null && T > t.hotGaseousTempK) return 'hot_gaseous';
    if (S != null && S < t.hyceanInsolationMax &&
        (body.bulkWaterFraction ?? 0) >= t.hyceanBulkWaterMin) return 'hycean';
    if (T != null && T < t.coldGaseousTempK) return 'cold_gaseous';
    return 'temperate_gaseous';
  }
  // Terrestrial bracket
  if (T != null && T < t.coldTerrestrialTempK) return 'cold_terrestrial';
  if ((T != null && T > t.volcanicTempK) ||
      (body.surfacePressureBar != null && body.surfacePressureBar > t.volcanicPressureBar)) {
    return 'volcanic';
  }
  // Biotic and wet branches gate the H2O cloud regime — biotic bodies
  // amplify the water cycle (atm is rich in transpiration H2O), wet
  // bodies have surface oceans → cloud decks.
  if (body.biosphereArchetype === 'carbon_aqueous') {
    const tierIdx = BIOSPHERE_TIER_ORDER.indexOf(body.biosphereTier ?? 'none');
    if (tierIdx >= BIOSPHERE_TIER_ORDER.indexOf('microbial')) return 'biotic_wet';
  }
  if ((body.waterFraction ?? 0) >= t.wetWaterFractionMin) return 'wet_terrestrial';
  return 'dust_terrestrial';
}

// Cloud layers — 0..3 stratified decks per body, sorted ascending by
// altitudeNorm. Each regime in CLOUD_BY_REGIME lists its decks
// (temperate_gaseous gets 3, volcanic gets 2, the rest get 1). Per
// deck: condensate gas + sampled coverage + windSpeedMS + altitudeNorm.
// Returns an empty array for bodies in airless / sub-threshold
// pressure regimes.
// Surface opacity — 1 when the body has a solid surface the renderer
// should paint underneath the cloud + haze stack (terrestrials), 0
// when the bulk atm column shows through cloud rents instead (gas /
// ice giants / hycean / helium / gas_dwarf). Intermediate values are
// possible later (partial gas-giant rents in PR 4) but for now this
// is binary, driven by world class.
function surfaceOpacityFor(body) {
  const r = body.radiusEarth;
  const isGaseous = r != null && r >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;
  return isGaseous ? 0 : 1;
}

function cloudLayersFor(body, S) {
  const regime = cloudHazeRegimeFor(body, S);
  if (regime == null) return [];
  const spec = CLOUD_BY_REGIME[regime];
  if (!spec) return [];
  const prng = fieldPrng(body, 'cloud');
  const out = [];
  for (const deck of spec.layers) {
    const coverage = sampleTruncated(prng, deck.coverage);
    out.push({
      gas: deck.gas,
      coverage: Number(coverage.toFixed(3)),
      windSpeedMS: deck.windSpeedMS,
      altitudeNorm: Number(deck.altitudeNorm.toFixed(3)),
    });
  }
  // Pre-sort by altitude so the shader can iterate decks in
  // composition order without re-sorting at upload time.
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
// Per-species visibility weight lives in GAS_POTENCY (see priors), so
// no anchor coefficient appears here.
function hazeContribution(gas, body) {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar;
  const r = body.radiusEarth;
  const isGaseous = r != null && r >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;

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
      const tempGate = smoothstep(40, 95, T) * (1 - smoothstep(95, 150, T));
      if (tempGate === 0) return 0;
      const ch4Frac = atmFracOf(body, 'CH4');
      const n2Frac  = atmFracOf(body, 'N2');
      const ch4Gate = smoothstep(0.001, 0.05, ch4Frac);
      const n2Gate  = smoothstep(0.1, 0.6, n2Frac);
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
      const tempGate = smoothstep(120, 165, T) * (1 - smoothstep(165, 225, T));
      return tempGate;
    }
    case 'CHROMOPHORE': {
      // PH3-photolysis red pigment — Jovian Great Red Spot / Saturn
      // polar haze. Peaks at cooler cloud tops (~125K) where NH3+H2S
      // is too slow for NH4SH dominance.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      if (!hasCloudDeck(body, 'NH3')) return 0;
      const tempGate = smoothstep(90, 125, T) * (1 - smoothstep(125, 180, T));
      return tempGate;
    }
    case 'SALT': {
      // KCl + ZnS condensate haze — warm sub-Neptune / gas dwarf
      // regime. GJ 1214 b anchor at ~600K cloud tops.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      const tempGate = smoothstep(250, 625, T) * (1 - smoothstep(625, 950, T));
      return tempGate;
    }
    case 'H2SO4': {
      // Sulfuric acid sulfate haze — Venus-class. Needs hot CO2 + high
      // pressure. Above ~1000K H2SO4 dissociates back to SO3 + H2O.
      if (isGaseous) return 0;
      if (T == null || P == null) return 0;
      const tempGate = smoothstep(500, 720, T) * (1 - smoothstep(720, 1100, T));
      const pressGate = smoothstep(5, 150, P);
      return tempGate * pressGate;
    }
    case 'SULFUR': {
      // S8 elemental sulfur aerosol — Io-class volcanic. Thin SO2
      // columns where UV reaches the surface; dry-surface gate.
      if (isGaseous) return 0;
      if (T == null || P == null) return 0;
      const so2Frac = atmFracOf(body, 'SO2');
      const so2Gate = smoothstep(0.01, 0.3, so2Frac);
      if (so2Gate === 0) return 0;
      const tempGate = smoothstep(250, 400, T) * (1 - smoothstep(400, 800, T));
      const pressGate = 1 - smoothstep(0.5, 5, P);
      const waterFrac = body.waterFraction ?? 0;
      const dryGate = 1 - smoothstep(0.0, 0.2, waterFrac);
      return tempGate * so2Gate * pressGate * dryGate;
    }
    case 'SILICATE': {
      // Refractive Mg-Si-O cloud particles dredged from deep layers at
      // extreme insolation. Hot gas-giant / hot sub-Neptune only.
      if (!isGaseous) return 0;
      if (T == null) return 0;
      return smoothstep(900, 1500, T);
    }
    default:
      return 0;
  }
}

const HAZE_AEROSOL_SPECIES = ['THOLIN', 'NH4SH', 'CHROMOPHORE', 'SALT', 'H2SO4', 'SULFUR', 'SILICATE'];

// Lifted mineral dust gate. Terrestrial only, dry surface, thin
// atmosphere, moderate T (not frozen, not boiled). Returns raw 0..1
// strength; the universal HAZE_DUST_SCALE applies in `hazeFor`.
function dustStrengthFor(body) {
  const T = body.avgSurfaceTempK;
  const P = body.surfacePressureBar;
  const r = body.radiusEarth;
  if (r != null && r >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius) return 0;
  if (T == null || P == null) return 0;
  // Dust suspends in any non-zero atmosphere — mineral grains entrain
  // at any pressure including Mars's 0.006 bar. Upper cap at 1 bar:
  // thicker air becomes too dense to keep dust airborne.
  if (P <= 0 || P > 1) return 0;
  const waterFrac = body.waterFraction ?? 0;
  const dryGate = 1 - smoothstep(0.0, 0.3, waterFrac);
  const pressGate = 1 - smoothstep(0.001, 1, P);
  const tempGate = smoothstep(150, 200, T) * (1 - smoothstep(300, 400, T));
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
// Resources — physics-derived (Phase 4.5)
// =============================================================================

// Volatile gases for resVolatiles accounting. O2 is excluded (it's a
// biotic biosignature, not a bulk-volatile resource).
const VOLATILE_GASES_SET = new Set(['CO2', 'CH4', 'H2O', 'NH3', 'CO', 'SO2']);

// Per-resource physics derivation. No class input — six scalars derived
// from primary attributes (mass, bulk composition) + downstream physics
// (atm composition, surface cover) + stellar context (metallicity, age).
//
// Calibration anchors (Sol curated values — Filler doesn't touch them,
// these are for procgen consistency):
//   Earth   M/S/V/R/Ra/E = 5/6/7/5/4/0   bulkMetal 0.32 / N2 atm
//   Mars    5/5/3/5/4/0                  bulkMetal 0.24 / CO2 atm
//   Mercury 8/4/1/5/3/0                  bulkMetal 0.70
//   Europa  3/4/9/3/2/6                  bulkMetal 0.10 / iceFraction 0.85
//   Jupiter 1/1/10/1/1/2                 bulkMetal 0.02 / gaseous
//
// Each scalar gets per-body seeded noise (truncated normal around 1.0).
function resourcesFor(body, hostStar, hostBody) {
  if (body.massEarth == null) return null;

  const bulkMetal = body.bulkMetalFraction ?? 0.32;  // Earth-default if unset
  const bulkWater = body.bulkWaterFraction ?? 0;
  const silicateFraction = Math.max(0, 1 - bulkMetal - bulkWater);

  // Stellar context — heavier metallicity → more rare-earths and U/Th;
  // older star → more decay of radioactives.
  const cls = hostStar?.cls;
  const metallicity = cls ? meanMetallicityForClass(cls) : 0;
  const stellarAge = cls ? meanAgeForClass(cls) : 5;
  const metallicityFactor = Math.exp(metallicity * 2);  // 0 dex → 1.0, +0.3 → 1.82, -0.5 → 0.37
  const ageDecayFactor = 1 / (1 + stellarAge / 4.5);    // U/Th half-decay anchor

  const isGaseous = body.radiusEarth != null &&
    body.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;

  // Surface + atm volatile accounting for terrestrial bodies.
  let atmVolFrac = 0;
  const atmGases = new Set();
  for (const [g, f] of [[body.atm1, body.atm1Frac], [body.atm2, body.atm2Frac], [body.atm3, body.atm3Frac]]) {
    if (g) {
      atmGases.add(g);
      if (VOLATILE_GASES_SET.has(g)) atmVolFrac += f ?? 0;
    }
  }
  const water = body.waterFraction ?? 0;
  const ice = body.iceFraction ?? 0;
  const surfaceVolFraction = Math.min(1, water + ice + atmVolFrac * 0.3);

  // Tidal-heated moon of a giant — Io/Europa-class produce unusual
  // chemistry → exotics lift. Mirrors the surface_age tidal-lift gate.
  const hostIsGaseous = hostBody?.radiusEarth != null &&
    hostBody.radiusEarth >= WORLD_CLASS_THRESHOLDS.gasDwarfRadius;
  const tidalExotic = (body.kind === 'moon' && hostIsGaseous && (body.surfaceAge ?? 0) > 0.5) ? 3 : 0;

  const noise = (field) => sampleTruncated(
    fieldPrng(body, `res_${field}`),
    { mean: 1, sd: 0.2, min: 0.5, max: 1.5 }
  );

  const clamp10 = (x) => Math.round(Math.max(0, Math.min(10, x)));

  return {
    // Metals scale with bulkMetalFraction. Mercury (0.70) → 11.2 → 10;
    // Earth (0.32) → 5.1; Mars (0.24) → 3.8; Europa (0.10) → 1.6;
    // Jupiter (0.02) → 0.32.
    resMetals: clamp10(16 * bulkMetal * noise('metals')),
    // Silicates from the leftover after metal + water. Earth (0.68) →
    // 6.8; Mercury (0.30) → 3.0; Europa (0.40) → 4.0.
    resSilicates: clamp10(10 * silicateFraction * noise('silicates')),
    // Volatiles — gaseous bodies are made of volatiles by definition
    // (H/He + CH4/NH3). Terrestrials get surface H2O + ice + atm
    // volatile-gas content scaled.
    resVolatiles: isGaseous
      ? clamp10((8 + bulkWater * 20) * noise('volatiles'))
      : clamp10(10 * surfaceVolFraction * noise('volatiles')),
    // Rare earths track stellar metallicity. Solar metallicity → 6;
    // metal-poor M-dwarf → ~2; metal-rich Pop I → ~10.
    resRareEarths: clamp10(6 * metallicityFactor * noise('rare_earths')),
    // Radioactives need metallicity (U/Th formed in supernovae of
    // enriched ISM) + age-decay. Older stars have depleted U/Th.
    resRadioactives: clamp10(8 * metallicityFactor * ageDecayFactor * noise('radioactives')),
    // Exotics — gaseous bodies have He-3 + deuterium; tidal-heated
    // moons have unusual chemistry; otherwise small base.
    resExotics: clamp10((isGaseous ? 2 : 0) + tidalExotic + 1 * noise('exotics')),
  };
}

// =============================================================================
// Biosphere — physics-keyed habitat dispatch (no class input)
// =============================================================================

// Returns true if the body's physical state matches all the habitat's
// gates. Each gate field is optional; only specified gates have to pass.
// Atmosphere-gas gates check all of (atm1, atm2, atm3).
function bodyMatchesHabitat(body, gates) {
  const T = body.avgSurfaceTempK;
  const water = body.waterFraction ?? 0;
  const ice = body.iceFraction ?? 0;
  const bulkWater = body.bulkWaterFraction ?? 0;
  const P = body.surfacePressureBar ?? 0;
  const R = body.radiusEarth ?? 0;
  const tect = body.tectonicActivity ?? 0;

  if (gates.tempMinK != null && (T == null || T < gates.tempMinK)) return false;
  if (gates.tempMaxK != null && (T == null || T > gates.tempMaxK)) return false;
  if (gates.waterMin != null && water < gates.waterMin) return false;
  if (gates.waterMax != null && water > gates.waterMax) return false;
  if (gates.iceMin != null && ice < gates.iceMin) return false;
  if (gates.iceMax != null && ice > gates.iceMax) return false;
  if (gates.bulkWaterMin != null && bulkWater < gates.bulkWaterMin) return false;
  if (gates.pressureMin != null && P < gates.pressureMin) return false;
  if (gates.radiusMin != null && R < gates.radiusMin) return false;
  if (gates.radiusMax != null && R > gates.radiusMax) return false;
  if (gates.tectonicMin != null && tect < gates.tectonicMin) return false;
  return true;
}

// Walk the habitat list; each habitat whose physical gates match the
// body fires an independent occurrence roll. Among hits, the highest-
// tier archetype wins (ties broken by habitat order — rarer/more-
// evocative habitats listed earlier in BIOSPHERE_HABITATS win ties).
function biosphereFor(body) {
  const TIER_ORDER = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];
  let best = { archetype: null, tier: 'none', tierIdx: 0 };
  for (const habitat of BIOSPHERE_HABITATS) {
    if (!bodyMatchesHabitat(body, habitat.gates)) continue;
    const prng = fieldPrng(body, `biosphere:${habitat.archetype}:${habitat.name}`);
    if (prng() >= habitat.occurrenceRate) continue;
    let total = 0;
    for (const w of Object.values(habitat.tierWeights)) total += w;
    let r = prng() * total;
    let chosenTier = 'microbial';
    for (const [tier, w] of Object.entries(habitat.tierWeights)) {
      r -= w;
      if (r <= 0) { chosenTier = tier; break; }
    }
    const tierIdx = TIER_ORDER.indexOf(chosenTier);
    if (tierIdx > best.tierIdx) {
      best = { archetype: habitat.archetype, tier: chosenTier, tierIdx };
    }
  }
  return { archetype: best.archetype, tier: best.tier };
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

function fillBody(b, allBodies, stars) {
  // Resolve host + the mass that drives Kepler's third law for this body:
  //   planet → host star (solar masses)
  //   moon   → parent planet (Earth masses; convert to solar)
  // Insolation always traces up to the host star, so a moon inherits its
  // parent planet's stellar flux.
  let hostStar = null;
  let aFromStar = null;
  let hostMassSolar = null;
  let hostBody = null;
  if (b.kind === 'planet') {
    if (b.hostStarIdx != null) {
      hostStar = stars[b.hostStarIdx];
      aFromStar = b.semiMajorAu;
      hostMassSolar = hostStar.mass;
    }
  } else if (b.kind === 'moon') {
    if (b.hostBodyIdx != null) {
      hostBody = allBodies[b.hostBodyIdx] ?? null;
      if (hostBody) {
        if (hostBody.hostStarIdx != null) {
          hostStar = stars[hostBody.hostStarIdx];
          aFromStar = hostBody.semiMajorAu;
        }
        if (hostBody.massEarth != null) {
          hostMassSolar = hostBody.massEarth / EARTH_PER_SOLAR_MASS;
        }
      }
    }
  }

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
  const frostLinesAu = hostStar ? {
    H2O: frostLineAU(hostStar.mass, SNOW_LINE_TEMPERATURES.H2O),
    NH3: frostLineAU(hostStar.mass, SNOW_LINE_TEMPERATURES.NH3),
    CH4: frostLineAU(hostStar.mass, SNOW_LINE_TEMPERATURES.CH4),
  } : null;
  const lockProxy = (b.kind === 'planet' && hostStar)
    ? tidalLockProxy(hostStar.mass, b.semiMajorAu)
    : (b.kind === 'moon' ? tidalLockProxy(hostMassSolar, b.semiMajorAu) : null);
  const unknowns = new Set(b._unknowns ?? []);

  // Track filled values starting from the body's current state. Each
  // generator reads its dependencies from a working copy that includes
  // previously-filled values; that's how downstream rules pick up upstream
  // results within the same pass.
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
    biosphereArchetype, biosphereTier,
    periodDays, semiMajorAu, eccentricity, inclinationDeg,
    axialTiltDeg, orbitalPhaseDeg,
  } = b;

  if (unknowns.has('radiusEarth')) {
    const r = radiusFromMass(b.massEarth);
    if (r != null) radiusEarth = r;
  }

  let working = { ...b, radiusEarth };

  // Bulk composition fill for catalog rows the Architect didn't touch.
  // Symmetric with the Architect's per-body draws; all three read the
  // four-zone formation gate (aFormation vs the host star's frost-line
  // trio). Fall through to null when host star or formationAu unknown.
  if (unknowns.has('bulkWaterFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkWaterFraction = bulkWaterFractionFor(working, aFormation, frostLinesAu);
    }
  }
  if (unknowns.has('bulkMetalFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkMetalFraction = bulkMetalFractionFor(working, aFormation, frostLinesAu);
    }
  }
  if (unknowns.has('bulkVolatileFraction')) {
    if (aFormation != null && frostLinesAu != null) {
      bulkVolatileFraction = bulkVolatileFractionFor(working, aFormation, frostLinesAu);
    }
  }
  working = { ...working, bulkWaterFraction, bulkMetalFraction, bulkVolatileFraction };

  // Orbital flavor early so tilt + eccentricity are available when temp
  // range and surface age run later.
  if (unknowns.has('eccentricity')) {
    eccentricity = Number(sampleMixture(fieldPrng(b, 'eccentricity'), ECCENTRICITY).toFixed(4));
  }
  if (unknowns.has('inclinationDeg')) {
    inclinationDeg = Number(sampleTruncated(fieldPrng(b, 'inclinationDeg'), INCLINATION_DEG).toFixed(2));
  }
  if (unknowns.has('axialTiltDeg')) {
    axialTiltDeg = Number(sampleTruncated(fieldPrng(b, 'axialTiltDeg'), AXIAL_TILT_DEG).toFixed(2));
  }
  if (unknowns.has('orbitalPhaseDeg')) {
    orbitalPhaseDeg = Number((fieldPrng(b, 'orbitalPhaseDeg')() * 360).toFixed(2));
  }
  working = { ...working, eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg };

  // Kepler relation — periodDays ↔ semiMajorAu round-trip.
  if (unknowns.has('periodDays') && semiMajorAu != null) {
    const p = keplerPeriodDays(semiMajorAu, hostMassSolar);
    if (p != null) periodDays = p;
  }
  if (unknowns.has('semiMajorAu') && periodDays != null) {
    const a = keplerSemiMajorAu(periodDays, hostMassSolar);
    if (a != null) semiMajorAu = a;
  }
  working = { ...working, periodDays, semiMajorAu };

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

  function runTempIcePass(waterPrev, icePrev, greenhouseK) {
    const stateForAlbedo = {
      ...working,
      waterFraction: waterPrev,
      iceFraction:   icePrev,
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
      waterFraction: waterPrev,
      surfacePressureBar,
    });
    const water = surfaceLiquidWaterCover(bulkWaterFraction, T, surfacePressureBar, waterNoise);
    const ice   = surfaceIceCover(bulkWaterFraction, T, Tmin, surfacePressureBar, iceNoise);
    return { T, Tmin, Tmax, ice, water };
  }

  // ─── Pass A: pressure-proxy greenhouse ───
  // Initial estimate — atm composition isn't known yet, so we use the
  // pressure proxy. This settles T/water/ice enough to derive class and
  // dispatch atm species; Pass B will refine using the resulting
  // composition.
  const greenhouseA = greenhouseKFromPressure(surfacePressureBar);
  const passA1 = runTempIcePass(0, 0, greenhouseA);
  const passA2 = runTempIcePass(passA1.water ?? 0, passA1.ice ?? 0, greenhouseA);

  if (unknowns.has('avgSurfaceTempK') && passA2.T != null) avgSurfaceTempK = passA2.T;
  if (unknowns.has('surfaceTempMinK') && passA2.Tmin != null) surfaceTempMinK = passA2.Tmin;
  if (unknowns.has('surfaceTempMaxK') && passA2.Tmax != null) surfaceTempMaxK = passA2.Tmax;
  if (unknowns.has('iceFraction')   && passA2.ice   != null) iceFraction   = passA2.ice;
  if (unknowns.has('waterFraction') && passA2.water != null) waterFraction = passA2.water;
  working = {
    ...working,
    avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
    iceFraction, waterFraction,
  };

  // Surface age — derived from tectonic activity + tidal lift for
  // eccentric moons of gaseous hosts.
  if (unknowns.has('surfaceAge')) {
    surfaceAge = surfaceAgeFor(working, hostBody);
  }
  working = { ...working, surfaceAge };

  // Biosphere — physics-gated habitats. Runs before atm so atm can read
  // biosphere for O2 lift on biotic worlds.
  if (unknowns.has('biosphereArchetype') || unknowns.has('biosphereTier')) {
    const { archetype, tier } = biosphereFor(working);
    if (unknowns.has('biosphereArchetype')) biosphereArchetype = archetype;
    if (unknowns.has('biosphereTier'))      biosphereTier = tier;
  }
  working = { ...working, biosphereArchetype, biosphereTier };

  // Atmosphere — regime-keyed top-3 gas dispatch with biosphere O2 lift.
  if (unknowns.has('atm1') || unknowns.has('atm2') || unknowns.has('atm3')) {
    const [a1, a2, a3] = atmosphereFor(working, S);
    if (unknowns.has('atm1')) { atm1 = a1?.gas ?? null; atm1Frac = a1?.frac ?? null; }
    if (unknowns.has('atm2')) { atm2 = a2?.gas ?? null; atm2Frac = a2?.frac ?? null; }
    if (unknowns.has('atm3')) { atm3 = a3?.gas ?? null; atm3Frac = a3?.frac ?? null; }
  }
  working = { ...working, atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac };

  // Cloud layers — up to 3 stratified decks. Regime dispatch
  // (cloudHazeRegimeFor) chooses the deck list; curated bodies that
  // authored decks in body_layers.csv skip this and keep the CSV
  // values. Surface opacity is co-derived here so the renderer always
  // has a scalar to drive composition (gas giants = 0, terrestrials = 1).
  if (unknowns.has('cloudLayers')) {
    cloudLayers = cloudLayersFor(working, S);
  }
  surfaceOpacity = surfaceOpacityFor(working);
  working = { ...working, cloudLayers, surfaceOpacity };

  // Unified haze derivation — emits per-species aerosol formation
  // strengths + dust strength. Final opacity + color are blended at
  // render time (disc-palette) from this contributor list plus the
  // body's atm gases + pressure. Always runs; no CSV override path.
  {
    const h = hazeFor(working);
    hazeAerosols = h.aerosols;
    dustStrength = h.dust;
  }
  working = { ...working, hazeAerosols, dustStrength };

  // ─── Pass B: composition-aware greenhouse refinement ───
  // Pass A used the pressure-proxy greenhouse to settle T/water/ice.
  // Now that atm composition is known, refine greenhouse from per-
  // gas potencies and re-run the T↔ice loop. Skipped when the proxy
  // is already within 1K of the composition value (most bodies).
  if (working.surfacePressureBar != null && working.surfacePressureBar > 0) {
    const greenhouseB = greenhouseKFromComposition(working);
    const deltaK = Math.abs(greenhouseB - greenhouseA);
    if (deltaK > 1) {
      const passB1 = runTempIcePass(0, 0, greenhouseB);
      const passB2 = runTempIcePass(passB1.water ?? 0, passB1.ice ?? 0, greenhouseB);
      if (unknowns.has('avgSurfaceTempK') && passB2.T != null) avgSurfaceTempK = passB2.T;
      if (unknowns.has('surfaceTempMinK') && passB2.Tmin != null) surfaceTempMinK = passB2.Tmin;
      if (unknowns.has('surfaceTempMaxK') && passB2.Tmax != null) surfaceTempMaxK = passB2.Tmax;
      if (unknowns.has('iceFraction')   && passB2.ice   != null) iceFraction   = passB2.ice;
      if (unknowns.has('waterFraction') && passB2.water != null) waterFraction = passB2.water;
      working = {
        ...working,
        avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
        iceFraction, waterFraction,
      };
    }
  }

  // ─── DERIVE worldClass ─── pure label off settled physical state.
  // Runs LAST so it reads the final refined T (post Pass B) plus the
  // settled atm composition (hycean/helium branches inspect atm1).
  // Nothing in the physics pipeline reads it — it's display-only.
  if (unknowns.has('worldClass')) {
    const w = worldClassFor(working, S);
    if (w != null) worldClass = w;
  }
  working = { ...working, worldClass };

  // Resources — six 0..10 scalars.
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
    biosphereArchetype, biosphereTier,
    periodDays, semiMajorAu,
    eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg,
  };
}
