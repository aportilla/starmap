// GAS_POTENCY — approximate per-gas visual absorption strength in the visible
// band. The single source for both the renderer (column + cloud-deck color in
// body-palette.ts) and procgen's sparse-cirrus mode gate (procgen.mjs). Plain
// JS so the Node build can import it; the browser re-exports it through
// body-palette.ts, typed by the sibling gas-potency.d.mts.
//
// This object MUST carry an entry for every AtmGas (the .d.mts asserts
// Record<AtmGas, number>); a missing key reads as 0 via the `?? 0` guards at
// the call sites. procgen only looks up the species that can be both cloud
// condensates and atm-column absorbers — the extra keys here are inert on that
// path and present so the renderer's table is complete.
export const GAS_POTENCY = {
  // Near-transparent — these species don't absorb meaningfully in
  // visible wavelengths but contribute subtle Rayleigh-scattered
  // lightening to the apparent column color in deep atmospheres.
  // Tiny non-zero values keep gas-giant columns from going dark
  // pure-absorber (Neptune saturated cyan vs. pale cyan) while
  // ensuring trace absorbers (CH4 at 1-2%) still dominate the
  // overall hue. Limb Rayleigh is handled separately by
  // SCATTERING_POTENCY for the rim halo.
  H2:  0.02,  // weak Rayleigh, mostly transparent
  He:  0.01,  // weaker than H2 (heavier atom, less scattering)
  N2:  0.05,  // modest — Earth's blue-sky Rayleigh source
  Ar:  0.05,  // similar to N2
  // Modest absorbers — visible at appreciable fractions.
  O2:  1.0,
  CO2: 1.0,
  CO:  1.0,
  // Cloud formers / strong condensates — visible signal disproportionate
  // to fraction (NH3 ice clouds dominate Jupiter's bands; H2O cloud
  // decks dominate Earth's appearance).
  H2O: 3.0,
  NH3: 3.0,
  // Strong selective absorbers — visually dominant at trace levels.
  // CH4 is the Uranus/Neptune blue; SO2 is the Venus sulfur haze.
  // CH4 at 12 captures how strongly methane absorbs in the red
  // through a deep gas-giant column: even at 1-2% atm fraction it
  // dominates the column's apparent color (cyan).
  CH4: 12.0,
  SO2: 8.0,
  // Condensate / aerosol / product species — only enter rendering via
  // cloudGas or the hazeAerosols contributor list. Potency 3 matches
  // the cloud-former magnitude so each species contributes meaningfully
  // when emitted.
  H2SO4:       3.0,
  SILICATE:    3.0,
  DUST:        3.0,
  THOLIN:      3.0,
  NH4SH:       3.0,
  CHROMOPHORE: 3.0,
  SALT:        3.0,
  SULFUR:      3.0,
};
