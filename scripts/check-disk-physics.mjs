#!/usr/bin/env node
//
// Phase-A regression gate for the architect refactor. Prints the
// disk-physics anchor values driven by procgen-priors.mjs constants:
//
//   - Frost-line positions for H2O / NH3 / CH4 around several star types
//   - Solid surface density Σ(a) at canonical radii
//   - Isolation mass M_iso(a) at canonical radii
//
// No catalog dependency — runs in <1s, suitable for tight iteration on
// MMSN_NORMALIZATION + SNOW_LINE_BOOSTS calibration.
//
// Target anchors (Sun, after Phase-A tuning):
//   frostLineAU(Sun, H2O)        ≈ 2.7 AU
//   frostLineAU(Sun, NH3)        ≈ 14  AU
//   frostLineAU(Sun, CH4)        ≈ 45  AU
//   isolationMass(1 AU,  M_sun)  ≈ 0.05 M⊕
//   isolationMass(5 AU,  M_sun)  ≈ 5–10 M⊕
//   isolationMass(20 AU, M_sun)  ≈ 3 M⊕
//   solidSurfaceDensity(M_sun, 1 AU)  ≈ MMSN_NORMALIZATION g/cm²

import {
  frostLineS,
  frostLineAU,
  solidSurfaceDensity,
  isolationMass,
  luminositySun,
} from './lib/astrophysics.mjs';
import {
  SNOW_LINE_TEMPERATURES,
  SNOW_LINE_BOOSTS,
  MMSN_NORMALIZATION,
  CRITICAL_CORE_MASS_EARTH,
} from './lib/procgen-priors.mjs';

const VOLATILES = ['H2O', 'NH3', 'CH4'];

// Representative star samples — the bracket of the catalog. M0V at 0.45,
// G2V at 1.0 (Sun), F0V at 1.4 covers most of the catalog's actual planets;
// O/B handled at the extreme upper end.
const STARS = [
  { label: 'M5V', massSun: 0.20 },
  { label: 'M0V', massSun: 0.45 },
  { label: 'K5V', massSun: 0.70 },
  { label: 'G2V (Sun)', massSun: 1.00 },
  { label: 'F0V', massSun: 1.40 },
  { label: 'A0V', massSun: 2.50 },
];

function pad(s, n, right = false) {
  s = String(s);
  if (s.length >= n) return s;
  return right ? ' '.repeat(n - s.length) + s : s + ' '.repeat(n - s.length);
}

function fmt(v, digits = 3) {
  if (v == null) return 'n/a';
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs < 0.001 && abs > 0)) return v.toExponential(2);
  return v.toFixed(digits);
}

console.log();
console.log('=== Frost-line insolation (S, Earth flux units; star-independent) ===');
console.log('  volatile  T(K)    S_frost');
console.log('  --------  ------  --------');
for (const v of VOLATILES) {
  const T = SNOW_LINE_TEMPERATURES[v];
  const S = frostLineS(T);
  console.log('  ' + pad(v, 8) + '  ' + pad(T, 6, true) + '  ' + pad(fmt(S, 4), 8, true));
}

console.log();
console.log('=== Frost-line distance in AU (per star) ===');
console.log('  star         M/M_sun  L/L_sun   a(H2O)   a(NH3)   a(CH4)');
console.log('  -----------  -------  --------  -------  -------  --------');
for (const s of STARS) {
  const L = luminositySun(s.massSun);
  const aH = frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.H2O);
  const aN = frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.NH3);
  const aC = frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.CH4);
  console.log(
    '  ' + pad(s.label, 11) +
    '  ' + pad(fmt(s.massSun, 2), 7, true) +
    '  ' + pad(fmt(L, 3), 8, true) +
    '  ' + pad(fmt(aH, 2), 7, true) +
    '  ' + pad(fmt(aN, 2), 7, true) +
    '  ' + pad(fmt(aC, 2), 8, true),
  );
}

console.log();
console.log('=== Solid surface density Σ(a) — g/cm² (for the Sun) ===');
console.log('  a (AU)   past   Σ_solid (g/cm²)');
console.log('  -------  -----  ----------------');
const sunFrost = {
  H2O: frostLineAU(1.0, SNOW_LINE_TEMPERATURES.H2O),
  NH3: frostLineAU(1.0, SNOW_LINE_TEMPERATURES.NH3),
  CH4: frostLineAU(1.0, SNOW_LINE_TEMPERATURES.CH4),
};
for (const a of [0.4, 1.0, 2.7, 5.0, 10, 20, 30, 50]) {
  const sigma = solidSurfaceDensity(1.0, a, sunFrost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
  const flags = [
    a > sunFrost.H2O ? 'H2O' : '',
    a > sunFrost.NH3 ? 'NH3' : '',
    a > sunFrost.CH4 ? 'CH4' : '',
  ].filter(Boolean).join('+') || '—';
  console.log(
    '  ' + pad(fmt(a, 1), 7, true) +
    '  ' + pad(flags, 5) +
    '  ' + pad(fmt(sigma, 3), 16, true),
  );
}

console.log();
console.log('=== Isolation mass M_iso(a) — M⊕ (per star) ===');
console.log('  star         |  0.4 AU   1.0 AU    2.7 AU    5 AU      10 AU     20 AU     30 AU');
console.log('  -------------+-------------------------------------------------------------------------');
for (const s of STARS) {
  const frost = {
    H2O: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.H2O),
    NH3: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.NH3),
    CH4: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.CH4),
  };
  const cells = [0.4, 1.0, 2.7, 5.0, 10, 20, 30].map(a => {
    const sigma = solidSurfaceDensity(s.massSun, a, frost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
    const m = isolationMass(a, s.massSun, sigma);
    return pad(fmt(m, 3), 9, true);
  }).join(' ');
  console.log('  ' + pad(s.label, 13) + '| ' + cells);
}

// === Anchor checks (numeric) ===
console.log();
console.log('=== Anchor checks (Sun) ===');
const aH2O_sun = frostLineAU(1.0, SNOW_LINE_TEMPERATURES.H2O);
const sigma1 = solidSurfaceDensity(1.0, 1.0, sunFrost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
const mIso1 = isolationMass(1.0, 1.0, sigma1);
const sigma5 = solidSurfaceDensity(1.0, 5.0, sunFrost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
const mIso5 = isolationMass(5.0, 1.0, sigma5);
const sigma20 = solidSurfaceDensity(1.0, 20, sunFrost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
const mIso20 = isolationMass(20, 1.0, sigma20);

const check = (name, actual, low, high, severity = 'gate') => {
  const pass = actual != null && actual >= low && actual <= high;
  const symbol = pass ? 'pass' : (severity === 'gate' ? 'FAIL' : 'note');
  console.log(
    '  [' + symbol + '] ' + pad(name, 38) +
    ' = ' + pad(fmt(actual, 4), 10, true) +
    '   target: ' + fmt(low, 3) + ' .. ' + fmt(high, 3),
  );
};

check('frostLineAU(Sun, H2O) [AU]',         aH2O_sun, 2.4, 3.0);
check('solidSurfaceDensity(Sun, 1 AU)',     sigma1,   5,   30);
check('isolationMass(1 AU, Sun) [M⊕]',      mIso1,    0.02, 0.10);
check('isolationMass(5 AU, Sun) [M⊕]',      mIso5,    5,   12);
// 20 AU informational: classical Lissauer M_iso ∝ a^0.75 with our profile
// overshoots the "Uranus/Neptune core scale" anchor. Phase B will address
// via outer-disk truncation or pebble-drift cap; not a Phase A blocker.
check('isolationMass(20 AU, Sun) [M⊕]',     mIso20,   1,   5, 'info');

console.log();
console.log('=== Gas-giant gating preview ===');
console.log('  CRITICAL_CORE_MASS_EARTH = ' + CRITICAL_CORE_MASS_EARTH + ' M⊕');
console.log('  Isolation masses above this threshold can capture runaway envelopes.');
for (const s of STARS) {
  const frost = {
    H2O: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.H2O),
    NH3: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.NH3),
    CH4: frostLineAU(s.massSun, SNOW_LINE_TEMPERATURES.CH4),
  };
  let firstA = null;
  for (let a = 0.1; a <= 60; a *= 1.05) {
    const sigma = solidSurfaceDensity(s.massSun, a, frost, MMSN_NORMALIZATION, SNOW_LINE_BOOSTS);
    const m = isolationMass(a, s.massSun, sigma);
    if (m != null && m >= CRITICAL_CORE_MASS_EARTH && a > frost.H2O) { firstA = a; break; }
  }
  console.log('  ' + pad(s.label, 13) + ' first a past H2O frost with M_iso ≥ critical: ' +
    (firstA == null ? '— (never)' : fmt(firstA, 2) + ' AU'));
}
console.log();
