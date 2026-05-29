// Shared physical-relation approximations used by the procgen Architect
// and Filler. Kept as one module so the two layers agree on derived
// quantities (insolation, luminosity); divergence here would mean the
// Architect's slot-zone choice doesn't match what the Filler reads when
// classifying world_class later.

// Earth masses per solar mass — the canonical Earth↔solar mass ratio,
// shared so the Architect, Filler, and these helpers all spell it once.
export const EARTH_PER_SOLAR_MASS = 333000;

// Stellar luminosity in solar units from mass in solar units.
// Piecewise empirical: M dwarfs follow a shallower relation than FGK+
// (Eker et al. 2015). The 0.43 M☉ break point is the conventional
// fully-convective boundary. There's a small (~30%) discontinuity at the
// break — accepted for v1 since neither side is exact.
export function luminositySun(massSun) {
  if (massSun == null || massSun <= 0) return null;
  if (massSun < 0.43) return 0.23 * Math.pow(massSun, 2.3);
  return Math.pow(massSun, 4);
}

// Insolation in Earth flux units (Earth at 1 AU around Sol = 1.0).
// Returns null when host mass or distance isn't available.
export function insolation(hostStarMass, aAu) {
  if (hostStarMass == null || aAu == null || aAu <= 0) return null;
  const L = luminositySun(hostStarMass);
  if (L == null) return null;
  return L / (aAu * aAu);
}

// Stellar metallicity proxy from spectral class. Returns a coarse [Fe/H]
// estimate (-0.5 to +0.3 dex) per spectral class typical-population
// mapping. Higher metallicity → more refractory + radioactive material
// available for planet building. Used by the Filler to scale
// rare-earths / radioactives resource priors.
//
// Anchors:
//   Sun (G2V): [Fe/H] = 0.0   (by definition Pop I solar reference)
//   M dwarfs:  bimodal — Pop I (~0.0) and Pop II (~-0.5). Mean ≈ -0.2.
//   K dwarfs:  Pop I bias, mean ≈ 0.0
//   F/G:       Pop I, mean ≈ 0.0 with scatter
//   A/B/O:     Pop I young, mean ≈ +0.1 (metal-enriched ISM)
//   WD:        progenitor-dependent, mean ≈ 0.0 with wide scatter
//   BD:        long-lived, mean ≈ -0.1 (older population skew)
//
// Returns the mean metallicity for the class as a deterministic scalar.
// Per-star variation handled by callers via seeded draws around this mean.
export function meanMetallicityForClass(cls) {
  switch (cls) {
    case 'O': return 0.10;
    case 'B': return 0.10;
    case 'A': return 0.05;
    case 'F': return 0.00;
    case 'G': return 0.00;
    case 'K': return -0.05;
    case 'M': return -0.20;
    case 'WD': return 0.00;
    case 'BD': return -0.10;
    default:  return 0.00;
  }
}

// Stellar age proxy from spectral class. Returns a representative age in
// Gyr. Massive hot stars are necessarily young (short main-sequence
// lifetimes); cool dwarfs span Gyr to hundreds of Gyr.
//
// Used by the Filler to compute radiogenic-resource decay (older bodies
// have depleted U/Th) and to inform formation-time context.
//
// Returns the typical mean age. Callers can layer per-star seeded
// scatter on top.
export function meanAgeForClass(cls) {
  switch (cls) {
    case 'O': return 0.005;   // 5 Myr — short MS lifetime
    case 'B': return 0.05;    // 50 Myr
    case 'A': return 0.5;     // 500 Myr
    case 'F': return 3;       // 3 Gyr
    case 'G': return 5;       // 5 Gyr (Sun is 4.6)
    case 'K': return 7;       // 7 Gyr
    case 'M': return 8;       // 8 Gyr (long-lived but mix of young/old)
    case 'WD': return 3;      // cooling age 3 Gyr typical
    case 'BD': return 5;      // 5 Gyr
    default:  return 5;
  }
}

// Frost-line insolation in Earth flux units. Below this S (closer to the
// star, hotter) the volatile stays gaseous; above this S (farther, cooler)
// it condenses out of the disk and joins the solid surface density.
//
// Derived from radiative equilibrium for a fast rotator with no internal
// heat: T^4 = S × S₀ / (4σ). Formation-era disk grains are effectively
// black so albedo is omitted (A ≈ 0); the bare formula reproduces the
// conventional 2.7 AU water frost line for the Sun (T_H2O = 170 K → S ≈ 0.14).
//
// S₀ = 1361 W/m² (solar constant), σ = 5.670374e-8 W/m²/K⁴ (Stefan-Boltzmann).
export function frostLineS(volatileTempK) {
  if (volatileTempK == null || volatileTempK <= 0) return null;
  return Math.pow(volatileTempK, 4) * 4 * 5.670374e-8 / 1361;
}

// Frost-line distance in AU for a given star and volatile. Uses
// L_star × insolation_at_a = constant, so a_frost = sqrt(L_star_sun / S_frost).
// Tight around M dwarfs (low L → small a), wide around F/A stars — the
// asymmetry that lets M-dwarf systems host icy worlds inside 1 AU.
export function frostLineAU(starMassSun, volatileTempK) {
  const L = luminositySun(starMassSun);
  if (L == null) return null;
  const S = frostLineS(volatileTempK);
  if (S == null || S <= 0) return null;
  return Math.sqrt(L / S);
}

// Solid surface density Σ_solid in g/cm² at orbital distance a around a
// star of mass starMassSun. Minimum-mass-solar-nebula profile stepped up
// past each snow line:
//
//   Σ_base = normalization × starMassSun × a_au^(-1.5)
//   × boosts.H2O if a > frostLinesAu.H2O
//   × boosts.NH3 if a > frostLinesAu.NH3
//   × boosts.CH4 if a > frostLinesAu.CH4
//
// `normalization` is Σ at 1 AU around the Sun in g/cm². frostLinesAu is
// { H2O, NH3, CH4 } in AU; boosts is { H2O, NH3, CH4 } unitless.
// Deep outer system asymptotes downward — Kuiper-belt mass deficit emerges
// from the a^(-1.5) decline outpacing the cumulative snow-line boosts.
export function solidSurfaceDensity(starMassSun, aAu, frostLinesAu, normalization, boosts) {
  if (starMassSun == null || starMassSun <= 0 || aAu == null || aAu <= 0) return null;
  let sigma = normalization * starMassSun * Math.pow(aAu, -1.5);
  if (aAu > frostLinesAu.H2O) sigma *= boosts.H2O;
  if (aAu > frostLinesAu.NH3) sigma *= boosts.NH3;
  if (aAu > frostLinesAu.CH4) sigma *= boosts.CH4;
  return sigma;
}

// Classical Lissauer-1987 isolation mass — the mass a protoplanet collects
// from its feeding zone before runaway stalls:
//
//   M_iso = (8π × a² × Σ_solid)^(3/2) / (3 × M_star)^(1/2)
//
// Drives the continuous mass pipeline (Phase B+). Anchors (Sun, post-calibration):
//   1 AU:  ≈ 0.05 M⊕ (Mars-mass inner planets)
//   5 AU:  ≈ 5–10 M⊕ (gas-giant-core capable, past H2O frost line)
//   20 AU: ≈ 3 M⊕    (ice-giant-core scale)
//   30+ AU: drops off — Kuiper-belt mass deficit
//
// aAu in AU, starMassSun in solar masses, surfaceDensity in g/cm².
// Returns M_iso in Earth masses; null on missing inputs.
export function isolationMass(aAu, starMassSun, surfaceDensity) {
  if (aAu == null || aAu <= 0 || starMassSun == null || starMassSun <= 0) return null;
  if (surfaceDensity == null || surfaceDensity <= 0) return null;
  const AU_CM = 1.495978707e13;
  const M_SUN_G = 1.98892e33;
  const M_EARTH_G = 5.9722e27;
  const a_cm = aAu * AU_CM;
  const M_star_g = starMassSun * M_SUN_G;
  const numerator = Math.pow(8 * Math.PI * a_cm * a_cm * surfaceDensity, 1.5);
  const denominator = Math.sqrt(3 * M_star_g);
  return (numerator / denominator) / M_EARTH_G;
}

// Hill radius in AU — the planet's gravitational sphere of influence.
// Inside R_H, satellite orbits are stable against the host star's tidal
// perturbation; outside, satellites are stripped on Gyr timescales.
//
//   R_H = a × (M_planet / (3 × M_star))^(1/3)
//
// Drives moon-count capacity (Phase E+): bigger Hill spheres hold more
// satellites. A hot Jupiter at 0.05 AU has a tiny R_H (~0.003 AU) and
// loses essentially all its original moons; Jupiter at 5 AU has R_H ≈
// 0.35 AU and retains a Galilean-class satellite system.
//
// aAu in AU, planetMassEarth in Earth masses, starMassSun in solar
// masses. Returns R_H in AU; null on missing inputs.
export function hillRadiusAu(aAu, planetMassEarth, starMassSun) {
  if (aAu == null || aAu <= 0) return null;
  if (planetMassEarth == null || planetMassEarth <= 0) return null;
  if (starMassSun == null || starMassSun <= 0) return null;
  const massRatio = planetMassEarth / (3 * starMassSun * EARTH_PER_SOLAR_MASS);
  return aAu * Math.pow(massRatio, 1 / 3);
}

// Dimensionless proxy for tidal-locking timescale, normalized so Earth = 1.
// The physical timescale is τ_lock ∝ a^6 / M_star^2 (the planet-side factors
// are weaker and don't vary much across our taxonomy). Earth at 1 AU around
// the Sun isn't locked over the age of the universe; Mercury (a=0.387) is;
// M-dwarf HZ planets at a~0.15 AU around 0.2 M☉ stars are deeply locked.
// Smaller proxy → faster locking → more likely locked.
//
// Returns null when inputs aren't available. The Filler maps the proxy to a
// log-interpolated locking probability so the rocky M-dwarf HZ catalog
// reads as mostly tide-locked while G-dwarf systems mostly aren't.
export function tidalLockProxy(hostStarMass, aAu) {
  if (hostStarMass == null || hostStarMass <= 0 || aAu == null || aAu <= 0) return null;
  return Math.pow(aAu, 6) / (hostStarMass * hostStarMass);
}
