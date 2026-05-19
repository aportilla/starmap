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

import { hash32, mulberry32, sampleTruncated, sampleMixture } from './prng.mjs';
import {
  PROCGEN_VERSION,
  ECCENTRICITY,
  INCLINATION_DEG,
  AXIAL_TILT_DEG,
  WATER_BUDGET_THRESHOLDS,
  WATER_FRACTION_BY_CLASS,
  ICE_FRACTION_BY_INSOLATION,
  ICE_FRACTION_INSOLATION_BUCKETS,
  ICE_FRACTION_CLASS_MUL,
  ALBEDO_BY_CLASS,
  SURFACE_AGE_BY_CLASS,
  SURFACE_AGE_TIDAL_LIFT,
  TECTONIC_ACTIVITY_BY_CLASS,
  ROTATION_PERIOD_HOURS_BY_CLASS,
  TIDAL_LOCK_RANGE,
  TEMP_SWING_FRAC_BY_CLASS,
  MAGNETIC_FIELD_GAUSS_BY_CLASS,
  MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS,
  GREENHOUSE_K_BY_CLASS,
  ATMOSPHERE_GASES_BY_CLASS,
  ATMOSPHERE_GASES_COLD_OVERLAY,
  ATMOSPHERE_O2_BIOTIC_LIFT,
  ATMOSPHERE_MIN_PRESSURE_BAR,
  INSOLATION_COLD_MAX,
  ICE_THICK_ATM_PROBABILITY,
  ICE_THICK_ATM_MIN_MASS_EARTH,
  ICE_THICK_ATM_PRESSURE_BAR,
  OCEAN_MIN_MASS_EARTH,
  CHROMOPHORE_BY_CLASS,
  PLANET_RESOURCE_PRIORS_BY_CLASS,
  BIOSPHERE_BY_CLASS,
  BIOSPHERE_GATE_INSOLATION,
} from './procgen-priors.mjs';
import { insolation, tidalLockProxy } from './astrophysics.mjs';

function fieldPrng(body, field) {
  return mulberry32(hash32(`${body.id}:${field}:${PROCGEN_VERSION}`));
}

// =============================================================================
// Physics helpers
// =============================================================================

const SIGMA_SB = 5.670374e-8;   // Stefan-Boltzmann constant (W/m²/K⁴)
const SOLAR_CONSTANT = 1361;    // Solar irradiance at 1 AU (W/m²)

// Earth masses per solar mass. Used to convert planet mass to solar
// units for Kepler's third law applied to moons (whose "host" is their
// parent planet, not a star).
const EARTH_PER_SOLAR_MASS = 333000;

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
// World-class taxonomy
// =============================================================================

// world_class is many-to-one from PLANET_TYPES (mass/radius taxonomy) onto
// the runtime surface-character enum. Mass/radius alone fixes the giant
// branches; terrestrial branches need insolation + a seeded water-budget
// proxy to choose rocky/ocean/desert/lava/ice.
//
// Returns null when anchors are missing — the Filler leaves the field null
// rather than guessing. Exported so the moon-backfill pass in
// build-catalog.mjs can derive a class inline without writing it to the
// body (the Filler does that authoritatively a step later).
export function worldClassFor(body, S) {
  const r = body.radiusEarth;
  if (r == null) return null;

  // Giants — pure mass/radius
  if (r >= 8) return 'gas_giant';
  if (r >= 3.5) {
    // Neptune-mass: warm version is gas_dwarf, cold is ice_giant.
    return (S != null && S > 0.1) ? 'gas_dwarf' : 'ice_giant';
  }
  if (r >= 2) return 'gas_dwarf';  // sub-Neptune

  // Terrestrial — gated on insolation.
  //
  // Lava is reserved for extreme insolation (sub-orbital roasting that
  // could plausibly liquefy the surface). Mercury (S≈6.7) and Venus
  // (S≈1.9) are both solid rocky, not lava — Io is lava but from tidal
  // heating, not stellar flux. v1 doesn't model tidal heating, so lava
  // worlds are rare and limited to brutally-close-in orbits.
  if (S == null) return null;
  if (S > 200) return 'lava';        // S=200 ≈ 0.07 AU around Sun-like
  if (S > 1.5) {
    // Hot rocky — Venus/Mercury class. Dry by default; occasional
    // water-bearing exceptions for hothouse worlds with retained volatiles.
    const r_w = fieldPrng(body, 'water_budget')();
    return r_w < WATER_BUDGET_THRESHOLDS.hot.desertMax ? 'desert' : 'rocky';
  }

  // Cold and temperate bands both use the seeded water budget to split
  // between rocky and ocean. Class is bulk composition (does this body
  // have a water mantle / dominant volatile budget?) — the surface state
  // (frozen vs liquid) emerges from insolation downstream via the
  // iceFraction prior and the cold-zone atmosphere overlay. Outer-cold
  // bodies still split between rocky (Callisto-like: silicate bulk) and
  // ocean (Europa-like: water-ice mantle); the difference is that ALL
  // cold worlds carry a high iceFraction regardless of which class they
  // land in.
  const r_w = fieldPrng(body, 'water_budget')();
  if (r_w < WATER_BUDGET_THRESHOLDS.temperate.rockyMax) return 'rocky';
  if (r_w < WATER_BUDGET_THRESHOLDS.temperate.oceanMax) {
    // Ocean classification requires sufficient mass to sustain the
    // atmospheric pressure needed to keep surface water liquid against
    // evaporation. Sub-Mars-mass would-be-oceans can't hold thick atms,
    // so their water exists as frozen surface ± subsurface ocean — bulk
    // composition is still "watery" but they fall back to rocky here
    // because the cold-zone iceFraction prior will dominate the surface
    // read either way.
    if ((body.massEarth ?? 0) < OCEAN_MIN_MASS_EARTH) return 'rocky';
    return 'ocean';
  }
  return 'desert';
}

// World-class → Architect planet type, for moon-count lookup against
// MOON_COUNT_BY_TYPE. Terrestrial worlds split by mass: super-earths
// (>3 M⊕) retain more moons than Earth-class. Exported for the moon
// backfill pass.
export function planetTypeFor(worldClass, massEarth, S) {
  if (worldClass === 'gas_giant') return 'jupiter';
  if (worldClass === 'ice_giant') return 'neptune';
  if (worldClass === 'gas_dwarf') return 'sub_neptune';
  // terrestrial bucket
  if (S != null && S > 100) return 'hot_rocky';
  if (massEarth != null && massEarth > 3) return 'super_earth';
  return 'rocky';
}

// =============================================================================
// Surface character (temperature, pressure)
// =============================================================================

// Greenhouse offset per worldClass lives in priors (GREENHOUSE_K_BY_CLASS)
// so it can carry a realistic/tune split. The per-class value at 1 bar
// gets multiplied here by pressureFactor = P_bar^0.3 so a Mars-thin desert
// (P=0.003) gets ~0.15× its nominal offset (≈+0.8 K, correct), Earth gets
// ×1.0 (+33 K, correct), and a Venus-class lava world at P=50 bar gets
// ×3.2 (+256 K — under Venus's real +500 K but ×8 closer than the
// constant-offset version). Exponent 0.3 sits between optically-thin
// linear scaling and the slow log saturation of thick atmospheres.

// Bond albedo input to the Stefan-Boltzmann temp pass. Sampled per-class
// and lifted toward ~1 by iceFraction (Enceladus 0.99 is essentially
// "max ice"). Local to its one consumer — the renderer derives body
// brightness from primary attributes (resources + water + ice + biome +
// haze), so the scalar never needs to leave this function.
function effectiveBondAlbedo(body) {
  const spec = ALBEDO_BY_CLASS[body.worldClass];
  if (spec == null) return 0.3;
  let a = sampleTruncated(fieldPrng(body, 'albedo'), spec);
  if (body.iceFraction != null && body.iceFraction > 0) {
    a = a * (1 - body.iceFraction) + 0.95 * body.iceFraction;
  }
  // Three-decimal quantize matches the precision that previously made it
  // back into the temp pass via the stored body.albedo column. Without it,
  // a few hundred bodies' avgSurfaceTempK round 1 K differently.
  return Number(Math.max(0, Math.min(1, a)).toFixed(3));
}

// Stefan-Boltzmann equilibrium temperature plus a worldClass greenhouse
// offset scaled by surface pressure. Gas giants return cloud-top
// equilibrium temp (no surface).
function avgSurfaceTempFor(body, S) {
  if (S == null || body.worldClass == null) return null;
  const A = effectiveBondAlbedo(body);
  const tEq = Math.pow((S * SOLAR_CONSTANT * (1 - A)) / (4 * SIGMA_SB), 0.25);
  const wc = body.worldClass;
  if (wc === 'gas_giant' || wc === 'gas_dwarf' || wc === 'ice_giant') {
    return Math.round(tEq);
  }
  const baseOffset = GREENHOUSE_K_BY_CLASS[wc] ?? 0;
  const P = body.surfacePressureBar;
  // Default pressure factor of 1.0 when no surfacePressureBar is set —
  // matches the pre-v4 constant-offset behavior for any class missing
  // from the pressure table (defensive fallback only; in practice every
  // terrestrial class has a pressure value by this point in the cascade).
  const pressureFactor = (P != null && P > 0) ? Math.pow(P, 0.3) : 1.0;
  return Math.round(tEq + baseOffset * pressureFactor);
}

// Baseline atmospheric pressure (bar) per world_class. Scaled by sqrt(mass)
// as a rough proxy for escape-velocity-driven retention (Earth=1, Mars
// ≈ 0.003 because of low mass, super-Earth at 5 M⊕ ≈ 2.2 bar baseline).
// Returns null for gaseous bodies — no defined surface. Cold-zone
// terrestrials fall to the desert-baseline value (0.01) by default;
// mass-eligible cold bodies get the Titan-class thick-atm retention
// roll layered on top — see below.
const PRESSURE_BAR_BY_CLASS = {
  rocky:   1.0,    // Earth
  ocean:   1.5,    // thicker on average — more volatiles, water vapor
  desert:  0.01,   // Mars-class trace
  lava:   50,      // Venus-class outgassed CO2 atmosphere
};

// Cold-zone (S < INSOLATION_COLD_MAX) override for the pressure baseline.
// Cold terrestrials default to airless regardless of bulk class — volatile
// outgassing is suppressed below the freezing point of water and most
// other condensables, so a Callisto-class cold rocky and a Europa-class
// cold ocean both read as ~0.001 bar before the Titan retention roll.
const PRESSURE_BAR_COLD_BASELINE = 0.001;

function surfacePressureFor(body, S) {
  if (body.worldClass == null) return null;
  const baseline = PRESSURE_BAR_BY_CLASS[body.worldClass];
  if (baseline == null) return null;  // gas/ice giants land here — no surface
  const m = body.massEarth ?? 1.0;
  const cold = S != null && S < INSOLATION_COLD_MAX;

  // Cold mass-eligible terrestrials get a Titan-class retention roll.
  // The cold baseline (0.001 bar) puts every cold terrestrial in the
  // airless category by default, but ~15% of Titan-mass-or-larger cold
  // bodies retain a thick atmosphere (Titan = 1.45 bar). The roll uses
  // an isolated 'thickAtm' seed so adding/removing it doesn't perturb
  // other fields. When it fires, the actual pressure draws from a
  // separate 'thickAtmPressure' seed.
  if (
    cold &&
    m >= ICE_THICK_ATM_MIN_MASS_EARTH &&
    fieldPrng(body, 'thickAtm')() < ICE_THICK_ATM_PROBABILITY
  ) {
    return Number(
      sampleTruncated(fieldPrng(body, 'thickAtmPressure'), ICE_THICK_ATM_PRESSURE_BAR).toFixed(3)
    );
  }

  const effective = cold ? PRESSURE_BAR_COLD_BASELINE : baseline;
  return Number((effective * Math.sqrt(Math.max(m, 0.001))).toFixed(3));
}

// =============================================================================
// Surface composition — water / ice fraction
// =============================================================================

// Per-class truncated-normal draws. Returns null for classes outside the
// table (gas/ice giants and gas dwarfs have no surface). Water and ice
// each draw independent PRNG streams so adding more generators later
// doesn't shift earlier values.
function waterFractionFor(body) {
  const spec = WATER_FRACTION_BY_CLASS[body.worldClass];
  if (spec == null) return null;
  if (spec.max === 0) return 0;
  return Number(sampleTruncated(fieldPrng(body, 'waterFraction'), spec).toFixed(3));
}

function iceFractionFor(body, S) {
  if (body.worldClass == null) return null;
  const mul = ICE_FRACTION_CLASS_MUL[body.worldClass];
  if (mul == null) return null;       // giants — no surface, no ice
  if (mul === 0) return 0;            // lava — always zero

  // Insolation drives the geometry (bucket); class drives the amplitude
  // (multiplier on the bucket's mean and max). A cold ocean and a cold
  // rocky both land in the cold bucket; the ocean's mul=1.2 pushes its
  // sample slightly higher to reflect more available water.
  let bucketName = 'cold';
  for (const [name, range] of Object.entries(ICE_FRACTION_INSOLATION_BUCKETS)) {
    if (S != null && S >= range.min && S < range.max) {
      bucketName = name;
      break;
    }
  }
  const bucket = ICE_FRACTION_BY_INSOLATION[bucketName];
  if (bucket == null) return null;
  const spec = {
    mean: Math.min(1, bucket.mean * mul),
    sd:   bucket.sd,
    min:  bucket.min,
    max:  Math.min(1, bucket.max * mul),
  };
  return Number(sampleTruncated(fieldPrng(body, 'iceFraction'), spec).toFixed(3));
}

// =============================================================================
// Surface age
// =============================================================================

// 0..1 scalar — fraction of the surface that is geologically young. 1.0 is
// perpetually refreshed (Io lava, Enceladus plumes, Earth plate tectonics);
// 0.0 is ancient unmodified (Mercury, Luna, Callisto). Class prior leans
// toward the "old" default; moons of giants with non-trivial eccentricity
// get a tidal-heating lift toward 1.0. Returns null for classes without
// a solid surface (gas/ice giants, gas dwarfs).
function surfaceAgeFor(body, hostBody) {
  const spec = SURFACE_AGE_BY_CLASS[body.worldClass];
  if (spec == null) return null;
  let age = sampleTruncated(fieldPrng(body, 'surfaceAge'), spec);
  const hostClass = hostBody?.worldClass;
  const hostIsGiant = hostClass === 'gas_giant' || hostClass === 'ice_giant' || hostClass === 'gas_dwarf';
  if (body.kind === 'moon' && hostIsGiant && body.eccentricity != null) {
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
// Tectonic activity
// =============================================================================

// Per-class draw multiplied by sqrt(mass / Earth) so a 5 M⊕ super-Earth at
// worldClass='rocky' reads as significantly more active than a Mars-mass
// world of the same class. Clamped to [0, 1].
function tectonicActivityFor(body) {
  const spec = TECTONIC_ACTIVITY_BY_CLASS[body.worldClass];
  if (spec == null) return null;
  const base = sampleTruncated(fieldPrng(body, 'tectonicActivity'), spec);
  const m = body.massEarth ?? 1.0;
  const massScale = Math.sqrt(Math.max(m, 0.05));
  return Number(Math.max(0, Math.min(1, base * massScale)).toFixed(3));
}

// =============================================================================
// Rotation period — with probabilistic tidal locking
// =============================================================================

// Returns hours. Close-in bodies probabilistically lock (rotation =
// orbital period); free rotators draw from the per-class log-ish normal.
// Tidal-lock proxy uses the body's host star + semi-major axis from the
// star, even for moons (whose stellar-flux context is inherited).
function rotationPeriodHoursFor(body, periodDays, lockProxy) {
  const spec = ROTATION_PERIOD_HOURS_BY_CLASS[body.worldClass];
  if (spec == null) return null;
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
  return Number(sampleTruncated(prng, spec).toFixed(2));
}

// =============================================================================
// Magnetic field
// =============================================================================

// Terrestrial fields scale with tectonicActivity (core convection) and
// inversely with rotation period (faster dynamo = stronger field). Gas
// giants ignore both — their fields come from metallic-hydrogen
// convection deep in the mantle, not core dynamos.
function magneticFieldGaussFor(body) {
  const spec = MAGNETIC_FIELD_GAUSS_BY_CLASS[body.worldClass];
  if (spec == null) return null;
  if (spec.max === 0) return 0;
  const base = sampleTruncated(fieldPrng(body, 'magneticFieldGauss'), spec);
  const wc = body.worldClass;
  if (wc === 'gas_giant' || wc === 'gas_dwarf' || wc === 'ice_giant') {
    return Number(base.toFixed(3));
  }
  // Terrestrials: gate on core activity + rotation rate, with a per-class
  // gameplay multiplier (realistic = 1.0; tune lifts rocky/ocean toward
  // a habitability floor).
  const tect = body.tectonicActivity ?? 0.3;
  const rot = body.rotationPeriodHours ?? 24;
  const gameplayMul = MAGNETIC_DYNAMO_MULTIPLIER_BY_CLASS[wc] ?? 1.0;
  const dynamoScale = tect * Math.sqrt(24 / Math.max(rot, 4)) * gameplayMul;
  return Number(Math.max(0, base * dynamoScale).toFixed(4));
}

// =============================================================================
// Surface temperature extremes
// =============================================================================

// Per-class fractional swing widened by axial tilt and eccentricity. Tilt
// drives seasonal variation; eccentricity drives orbital insolation
// variation. Combined multiplicatively over the class base.
function surfaceTempRangeFor(body) {
  if (body.avgSurfaceTempK == null) return { min: null, max: null };
  const spec = TEMP_SWING_FRAC_BY_CLASS[body.worldClass];
  if (spec == null) return { min: null, max: null };
  const baseSwing = sampleTruncated(fieldPrng(body, 'tempSwing'), spec);
  // Tilt 0 → ×1.0, tilt 90° → ×2.0; capped at 2.5 at extreme retrograde.
  const tiltDeg = body.axialTiltDeg ?? 20;
  const tiltFactor = 1 + Math.min(Math.abs(tiltDeg), 90) / 90;
  // Eccentricity 0 → ×1.0, e=0.3 → ×1.6.
  const ecc = body.eccentricity ?? 0.05;
  const eccFactor = 1 + ecc * 2;
  const swing = Math.min(2.5, baseSwing * tiltFactor * eccFactor);
  const half = swing / 2;
  return {
    min: Math.round(body.avgSurfaceTempK * (1 - half)),
    max: Math.round(body.avgSurfaceTempK * (1 + half)),
  };
}

// =============================================================================
// Atmosphere composition
// =============================================================================

// Pick the top 3 gases for the given world class by weighted-random draw
// without replacement, then renormalize their fractions to sum to 1.0.
// Returns null entries for classes with no atmosphere table or when the
// surface pressure is below the trace floor.
function atmosphereFor(body, S) {
  if (body.surfacePressureBar != null && body.surfacePressureBar < ATMOSPHERE_MIN_PRESSURE_BAR) {
    return [null, null, null];
  }
  // Cold terrestrials that passed the Titan-class thick-atm retention
  // roll get the N2/CH4 outgassed mix rather than the warm-body
  // CO2/H2O baseline (Titan's real chemistry). Gas/ice giants and
  // gas dwarfs always use their own class entries since they don't
  // have a cold-zone variant.
  const cold = S != null && S < INSOLATION_COLD_MAX;
  const wc = body.worldClass;
  const isTerrestrial = wc === 'rocky' || wc === 'ocean' || wc === 'desert';
  const table = (cold && isTerrestrial)
    ? ATMOSPHERE_GASES_COLD_OVERLAY
    : ATMOSPHERE_GASES_BY_CLASS[wc];
  if (!table) return [null, null, null];
  const prng = fieldPrng(body, 'atmosphere');
  // Per-gas seeded weight perturbation (×0.5 to ×1.5) so two same-class
  // worlds don't end up with identical mixes.
  const weights = {};
  for (const [gas, w] of Object.entries(table)) {
    if (w <= 0) continue;
    weights[gas] = w * (0.5 + prng());
  }
  // Biotic O2 lift: photosynthetic life makes free O2. Abiotic rocky/ocean
  // worlds carry only photolysis-trace O2 (the small weight in the table);
  // worlds with carbon_aqueous life at microbial+ tier get a multiplicative
  // lift, so a Gaian Earth-analog ends up with Earth-class O2 fractions.
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

// BIOSPHERE_TIERS order; used by chromophore gate matching.
const BIOSPHERE_TIER_ORDER = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];

// Returns true if the body matches the branch's gate. Null gate matches
// everything (default branches). Multiple gate fields are AND-combined.
function chromophoreGateMatches(body, S, gate) {
  if (gate == null) return true;
  if (gate.insolationAbove != null) {
    if (S == null || S <= gate.insolationAbove) return false;
  }
  if (gate.insolationBelow != null) {
    if (S == null || S >= gate.insolationBelow) return false;
  }
  if (gate.biosphereArchetype != null) {
    if (body.biosphereArchetype !== gate.biosphereArchetype) return false;
  }
  if (gate.tierAtLeast != null) {
    const idx = BIOSPHERE_TIER_ORDER.indexOf(body.biosphereTier ?? 'none');
    const minIdx = BIOSPHERE_TIER_ORDER.indexOf(gate.tierAtLeast);
    if (idx < 0 || minIdx < 0 || idx < minIdx) return false;
  }
  return true;
}

// Visually-dominant trace species. Walks CHROMOPHORE_BY_CLASS[worldClass]
// in order and picks the first branch whose gate matches. Returns null
// gas + null frac when no branch matches OR the body is airless (no
// atmosphere can host an aerosol chromophore — chromophoreFrac of an
// airless body would be meaningless).
function chromophoreFor(body, S) {
  if (body.surfacePressureBar != null && body.surfacePressureBar < ATMOSPHERE_MIN_PRESSURE_BAR) {
    return { gas: null, frac: null };
  }
  const branches = CHROMOPHORE_BY_CLASS[body.worldClass];
  if (!branches || branches.length === 0) return { gas: null, frac: null };
  for (const branch of branches) {
    if (!chromophoreGateMatches(body, S, branch.gate)) continue;
    const frac = sampleTruncated(fieldPrng(body, 'chromophore'), branch.frac);
    return { gas: branch.gas, frac: Number(frac.toFixed(5)) };
  }
  return { gas: null, frac: null };
}

// =============================================================================
// Resources
// =============================================================================

// Six per-class truncated-normal draws. Returns null for unsupported
// worldClass values (none currently — every defined class is in the
// table).
function resourcesFor(body) {
  const spec = PLANET_RESOURCE_PRIORS_BY_CLASS[body.worldClass];
  if (!spec) return null;
  const draw = (field, fieldSpec) => {
    if (fieldSpec.max === 0 || (fieldSpec.mean === 0 && fieldSpec.sd === 0)) return 0;
    return Math.round(sampleTruncated(fieldPrng(body, field), fieldSpec));
  };
  return {
    resMetals:       draw('resMetals',       spec.resMetals),
    resSilicates:    draw('resSilicates',    spec.resSilicates),
    resVolatiles:    draw('resVolatiles',    spec.resVolatiles),
    resRareEarths:   draw('resRareEarths',   spec.resRareEarths),
    resRadioactives: draw('resRadioactives', spec.resRadioactives),
    resExotics:      draw('resExotics',      spec.resExotics),
  };
}

// =============================================================================
// Biosphere — archetype × tier
// =============================================================================

function insolationGateSatisfied(gate, S) {
  if (gate == null) return true;
  const range = BIOSPHERE_GATE_INSOLATION[gate];
  if (!range || S == null) return false;
  return S >= range.min && S < range.max;
}

// For each eligible archetype on this world class: check insolation gate,
// roll occurrence, sample a tier. Among all hits, return the one with the
// highest tier; ties broken by archetype order (rarer ones come first in
// the prior table, so they win ties).
function biosphereFor(body, S) {
  const table = BIOSPHERE_BY_CLASS[body.worldClass];
  if (!table) return { archetype: null, tier: 'none' };
  const TIER_ORDER = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];
  let best = { archetype: null, tier: 'none', tierIdx: 0 };
  for (const [archetype, spec] of Object.entries(table)) {
    if (!insolationGateSatisfied(spec.gate, S)) continue;
    const prng = fieldPrng(body, `biosphere:${archetype}`);
    if (prng() >= spec.occurrenceRate) continue;
    // Sample tier from the conditional weights.
    let total = 0;
    for (const w of Object.values(spec.tierWeights)) total += w;
    let r = prng() * total;
    let chosenTier = 'microbial';
    for (const [tier, w] of Object.entries(spec.tierWeights)) {
      r -= w;
      if (r <= 0) { chosenTier = tier; break; }
    }
    const tierIdx = TIER_ORDER.indexOf(chosenTier);
    if (tierIdx > best.tierIdx) {
      best = { archetype, tier: chosenTier, tierIdx };
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
  const lockProxy = (b.kind === 'planet' && hostStar)
    ? tidalLockProxy(hostStar.mass, b.semiMajorAu)
    : (b.kind === 'moon' ? tidalLockProxy(hostMassSolar, b.semiMajorAu) : null);
  const unknowns = new Set(b._unknowns ?? []);

  // Track filled values starting from the body's current state. Each
  // generator reads its dependencies from a working copy that includes
  // previously-filled values; that's how downstream rules pick up upstream
  // results within the same pass.
  let {
    radiusEarth, worldClass,
    waterFraction, iceFraction, surfaceAge,
    avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
    tectonicActivity, rotationPeriodHours, magneticFieldGauss,
    surfacePressureBar,
    atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac,
    chromophoreGas, chromophoreFrac,
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

  if (unknowns.has('worldClass')) {
    const w = worldClassFor(working, S);
    if (w != null) worldClass = w;
  }
  working = { ...working, worldClass };

  // Surface composition — iceFraction also lifts the Bond albedo consumed
  // by avgSurfaceTempFor downstream.
  if (unknowns.has('waterFraction')) {
    waterFraction = waterFractionFor(working);
  }
  working = { ...working, waterFraction };
  if (unknowns.has('iceFraction')) {
    iceFraction = iceFractionFor(working, S);
  }
  working = { ...working, iceFraction };

  // Tectonics → Kepler → rotation → magnetic-field chain.
  if (unknowns.has('tectonicActivity')) {
    tectonicActivity = tectonicActivityFor(working);
  }
  working = { ...working, tectonicActivity };

  // rotationPeriodHours needs periodDays for the lock branch; fill the
  // Kepler relation here before consulting it.
  if (unknowns.has('periodDays') && semiMajorAu != null) {
    const p = keplerPeriodDays(semiMajorAu, hostMassSolar);
    if (p != null) periodDays = p;
  }
  if (unknowns.has('semiMajorAu') && periodDays != null) {
    const a = keplerSemiMajorAu(periodDays, hostMassSolar);
    if (a != null) semiMajorAu = a;
  }
  working = { ...working, periodDays, semiMajorAu };

  if (unknowns.has('rotationPeriodHours')) {
    rotationPeriodHours = rotationPeriodHoursFor(working, periodDays, lockProxy);
  }
  working = { ...working, rotationPeriodHours };

  if (unknowns.has('magneticFieldGauss')) {
    magneticFieldGauss = magneticFieldGaussFor(working);
  }
  working = { ...working, magneticFieldGauss };

  // Pressure must precede temperature: avgSurfaceTempFor reads pressure
  // for the greenhouse-pressure scaling.
  if (unknowns.has('surfacePressureBar')) {
    const p = surfacePressureFor(working, S);
    if (p != null) surfacePressureBar = p;
  }
  working = { ...working, surfacePressureBar };

  if (unknowns.has('avgSurfaceTempK')) {
    const t = avgSurfaceTempFor(working, S);
    if (t != null) avgSurfaceTempK = t;
  }
  working = { ...working, avgSurfaceTempK };

  // Orbital flavor before temperature range — range reads tilt/ecc.
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
  working = { ...working, eccentricity, axialTiltDeg };

  // Surface age reads eccentricity (for the moon-of-giant tidal lift) and
  // the host body's worldClass (giant vs. non-giant decides whether the lift
  // fires), so it has to run after the eccentricity draw.
  if (unknowns.has('surfaceAge')) {
    surfaceAge = surfaceAgeFor(working, hostBody);
  }
  working = { ...working, surfaceAge };

  if (unknowns.has('surfaceTempMinK') || unknowns.has('surfaceTempMaxK')) {
    const { min, max } = surfaceTempRangeFor(working);
    if (unknowns.has('surfaceTempMinK') && min != null) surfaceTempMinK = min;
    if (unknowns.has('surfaceTempMaxK') && max != null) surfaceTempMaxK = max;
  }

  // Biosphere BEFORE atmosphere — atmosphereFor reads biosphereArchetype/
  // biosphereTier to lift O2 for photosynthetic worlds.
  if (unknowns.has('biosphereArchetype') || unknowns.has('biosphereTier')) {
    const { archetype, tier } = biosphereFor(working, S);
    if (unknowns.has('biosphereArchetype')) biosphereArchetype = archetype;
    if (unknowns.has('biosphereTier'))      biosphereTier = tier;
  }
  working = { ...working, biosphereArchetype, biosphereTier };

  // Atmosphere — picks top 3 gases with renormalized fractions. Skips
  // worlds with sub-trace surface pressure (ice / airless bodies).
  if (unknowns.has('atm1') || unknowns.has('atm2') || unknowns.has('atm3')) {
    const [a1, a2, a3] = atmosphereFor(working, S);
    if (unknowns.has('atm1')) { atm1 = a1?.gas ?? null; atm1Frac = a1?.frac ?? null; }
    if (unknowns.has('atm2')) { atm2 = a2?.gas ?? null; atm2Frac = a2?.frac ?? null; }
    if (unknowns.has('atm3')) { atm3 = a3?.gas ?? null; atm3Frac = a3?.frac ?? null; }
  }

  // Chromophore — visually-dominant trace species, independent of the
  // by-mass top 3. Reads worldClass + surfacePressureBar so it has to
  // run after both are settled. Gameplay treats this as a small
  // additional resource at its real fraction; the renderer applies a
  // visibility boost (see CHROMOPHORE_VISUAL_BOOST in stars.ts).
  if (unknowns.has('chromophoreGas') || unknowns.has('chromophoreFrac')) {
    const c = chromophoreFor(working, S);
    if (unknowns.has('chromophoreGas'))  chromophoreGas  = c.gas;
    if (unknowns.has('chromophoreFrac')) chromophoreFrac = c.frac;
  }

  // Resources — six 0..10 scalars.
  if (
    unknowns.has('resMetals') || unknowns.has('resSilicates') || unknowns.has('resVolatiles') ||
    unknowns.has('resRareEarths') || unknowns.has('resRadioactives') || unknowns.has('resExotics')
  ) {
    const r = resourcesFor(working);
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
    radiusEarth, worldClass,
    waterFraction, iceFraction, surfaceAge,
    avgSurfaceTempK, surfaceTempMinK, surfaceTempMaxK,
    tectonicActivity, rotationPeriodHours, magneticFieldGauss,
    surfacePressureBar,
    atm1, atm1Frac, atm2, atm2Frac, atm3, atm3Frac,
    chromophoreGas, chromophoreFrac,
    resMetals, resSilicates, resVolatiles, resRareEarths, resRadioactives, resExotics,
    biosphereArchetype, biosphereTier,
    periodDays, semiMajorAu,
    eccentricity, inclinationDeg, axialTiltDeg, orbitalPhaseDeg,
  };
}
