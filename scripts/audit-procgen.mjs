#!/usr/bin/env node
//
// Audit procgen output against the priors in lib/procgen-priors.mjs.
// Walks src/data/catalog.generated.json — the post-build snapshot —
// and reports observed occurrence rates next to the expected rates
// from each prior. Read-only.
//
// Use after editing a prior + `npm run build:catalog`: re-run this
// script and the deltas in the rightmost columns surface what moved.
//
// Denominators are scoped to the population a given prior actually
// governs — catalog anchors don't participate in procgen rolls, so:
//   - Ring / moon comparisons exclude curated-system planets (Sol),
//     since their CSV is the source of truth there. They also include
//     non-curated catalog planets, since those go through ring/moon
//     backfill in build-catalog.mjs.
//   - Belt comparisons cover every non-curated star (both architect
//     and overlay paths fire belt rolls). The cold context can also
//     include floor belts emitted by generateFloorBelt for empty
//     systems, which inflates the cold rate vs. its base prior for
//     classes that would otherwise often roll zero of either context
//     (WD, BD, K). Treat cold over-shoots in those classes as the
//     content-floor backstop firing, not a calibration miss.
//
// Mostly procgen rates won't match the prior `p` exactly — sample
// noise on 100–5000 rolls is real — but a 2× or larger drift usually
// means a typo or a calibration miss worth investigating.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insolation, frostLineAU, hillRadiusAu } from './lib/astrophysics.mjs';
import { classifyBody } from './lib/body-archetype.mjs';
import {
  STELLAR_CLASSES,
  ACCRETION_EFFICIENCY,
  PLANET_COUNT_BY_CLASS,
  MAX_PLANETS_PER_CLUSTER,
  RING_DISRUPTION_RATE,
  MOON_PROBABILITY_PER_HILL,
  MOON_PROBABILITY_CAP,
  MOON_COUNT_MAX,
  BELT_OCCURRENCE_BY_CLASS,
  BELT_RESOURCE_OCCURRENCE,
  RESOURCE_KEYS,
  RESOURCE_TIER,
  RESOURCE_OCCURRENCE,
  RESOURCE_PAIR_AFFINITY,
  MOTHERLODE_HOSTILITY,
  DEPOSIT_COUNT_DIST,
  COMPANION_PLANET_SUPPRESSION,
  zoneForFormationAu,
  SNOW_LINE_TEMPERATURES,
  BULK_WATER_FRACTION_BY_ZONE,
  BULK_METAL_FRACTION_BY_ZONE,
  BULK_VOLATILE_FRACTION_BY_ZONE,
  TRIPLE_POINT_BAR,
  BIOSPHERE_ARCHETYPES,
  BIOSPHERE_COMPLEXITY,
  BIOSPHERE_IMPACT_LEVELS,
  IMPACT_BUCKET_THRESHOLDS,
} from './lib/procgen-priors.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');

// Mirrors CURATED_SYSTEM_HOSTS in build-catalog.mjs. Kept inline rather
// than imported so this script stays Node-runnable without pulling the
// build module's other deps.
const CURATED_HOSTS = new Set(['sol']);

const cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const { stars, bodies, clusters } = cat;

// --- helpers -----------------------------------------------------------------

function meanStd(arr) {
  if (!arr.length) return { mean: 0, sd: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

function insolationFor(body) {
  // A moon inherits its host planet's insolation: same orbit around the star.
  if (body.hostStarIdx == null && body.hostBodyIdx != null) {
    const host = bodies[body.hostBodyIdx];
    if (host?.hostStarIdx == null || host.semiMajorAu == null) return null;
    const star = stars[host.hostStarIdx];
    if (!star || star.mass == null) return null;
    return insolation(star.mass, host.semiMajorAu);
  }
  if (body.semiMajorAu == null || body.hostStarIdx == null) return null;
  const star = stars[body.hostStarIdx];
  if (!star || star.mass == null) return null;
  return insolation(star.mass, body.semiMajorAu);
}

// The gaseous archetypes — everything the old worldClass set
// {gas_giant, ice_giant, gas_dwarf, hycean, helium} maps onto under the
// richer enum (gas_giant splits into gas_giant/hot_jupiter; gas_dwarf is
// now sub_neptune). Used wherever a check meant "skip the envelope worlds."
const GASEOUS_ARCHETYPES = new Set([
  'gas_giant', 'hot_jupiter', 'ice_giant', 'sub_neptune', 'hycean', 'helium',
]);

function pct(n, d, decimals = 2) {
  if (!d) return '   —   ';
  return (n / d * 100).toFixed(decimals).padStart(5 + decimals) + '%';
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

// z-score for a binomial proportion (k successes in n trials vs. prior
// rate p). Normal approximation; returns null when the comparison isn't
// defined. Use min(np, n(1-p)) ≥ 5 to decide whether the approximation
// is trustworthy enough to flag a deviation.
function zBinom(k, n, p) {
  if (n === 0 || p <= 0 || p >= 1) return null;
  const se = Math.sqrt(p * (1 - p) / n);
  return (k / n - p) / se;
}

// z-score for a sample mean against a prior N(μ, σ²). Standard-error of
// the mean is σ/√n, so z = (obs − μ) / (σ/√n).
function zMean(obsMean, n, priorMean, priorSd) {
  if (n === 0 || priorSd <= 0) return null;
  return (obsMean - priorMean) / (priorSd / Math.sqrt(n));
}

// Format a z-score for column display. `validN` gates the `*` marker —
// for binomial: min(np, n(1-p)); for means: n. We always show the value
// so small-n cells stay visible, but only mark a cell as significant
// (|z| ≥ 2) when the underlying approximation is reasonable.
function fmtZ(z, validN = Infinity) {
  if (z == null || !Number.isFinite(z)) return '   —     ';
  const sign = z >= 0 ? '+' : '';
  const marker = (validN >= 5 && Math.abs(z) >= 2) ? '*' : ' ';
  return ' z=' + (sign + z.toFixed(2)).padStart(5) + marker;
}

// --- 1. Overview -------------------------------------------------------------

console.log('=== Overview ===');
console.log('catalog:', CATALOG_PATH);
console.log('stars:  ', stars.length, '  bodies:', bodies.length);
const kindSrc = {};
for (const b of bodies) {
  const k = b.kind + ' / ' + (b.source || '?');
  kindSrc[k] = (kindSrc[k] || 0) + 1;
}
for (const k of Object.keys(kindSrc).sort()) {
  console.log('  ' + pad(k, 22), pad(kindSrc[k], 6, true));
}
console.log();

// --- 2. Planets per system, by stellar class --------------------------------

// `obs.max` and `% at cap` exist to verify hard upper-bound tunes — the
// distribution mean/sd don't tell you whether a single system slipped past
// the prior's `max`, and the share clipped at the cap is the visible
// signal of how aggressive the clamp is.
console.log('=== Planets per system, by stellar class ===');
console.log('  cls | systems |  obs.mean  obs.sd  obs.max   prior.mean  prior.sd  prior.max   % at cap    z');
console.log('  ----+---------+----------  ------  -------   ----------  --------  ---------   --------    --------');
const planetCountByCls = {};
for (const star of stars) {
  const cls = star.cls || '?';
  if (!planetCountByCls[cls]) planetCountByCls[cls] = [];
  planetCountByCls[cls].push(star.planets.length);
}
for (const cls of STELLAR_CLASSES) {
  const arr = planetCountByCls[cls] || [];
  const obs = meanStd(arr);
  const p = PLANET_COUNT_BY_CLASS[cls];
  const obsMax = arr.length ? Math.max(...arr) : 0;
  const atCap = arr.filter(n => n >= p.max).length;
  console.log(
    '  ' + pad(cls, 4) +
    '| ' + pad(arr.length, 7, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '   ' + pad(obsMax, 5, true) +
    '       ' + pad(p.mean.toFixed(2), 5, true) +
    '       ' + pad(p.sd.toFixed(2), 4, true) +
    '       ' + pad(p.max, 4, true) +
    '    ' + pct(atCap, arr.length) +
    fmtZ(zMean(obs.mean, arr.length, p.mean, p.sd), arr.length),
  );
}
console.log();

// --- 2b. Planets per system, by cluster role --------------------------------
//
// Verifies that multi-star companion suppression (COMPANION_PLANET_SUPPRESSION
// in procgen-priors.mjs) lands roughly where the multiplier predicts.
// Primaries should match the per-class prior unchanged; secondary/tertiary
// counts should sit near `multiplier × class-weighted-mean prior`.
console.log('=== Planets per system, by cluster role ===');
console.log('  role          | stars |  obs.mean  obs.sd     suppression   expected*');
console.log('  --------------+-------+----------  ------     -----------   --------');
const roleByStarIdx = new Map();
for (const cluster of clusters) {
  for (let i = 0; i < cluster.members.length; i++) {
    const role = i === 0 ? 'primary' : i === 1 ? 'secondary' : 'tertiary_plus';
    roleByStarIdx.set(cluster.members[i], role);
  }
}
const countByRole = { primary: [], secondary: [], tertiary_plus: [] };
const classDistByRole = { primary: {}, secondary: {}, tertiary_plus: {} };
for (let i = 0; i < stars.length; i++) {
  const role = roleByStarIdx.get(i) ?? 'primary';
  countByRole[role].push(stars[i].planets.length);
  const cls = stars[i].cls || '?';
  classDistByRole[role][cls] = (classDistByRole[role][cls] || 0) + 1;
}
for (const role of ['primary', 'secondary', 'tertiary_plus']) {
  const arr = countByRole[role];
  if (!arr.length) continue;
  const obs = meanStd(arr);
  // Expected = sum over classes of (class_share × class_prior_mean) × suppression
  const dist = classDistByRole[role];
  const total = arr.length;
  let weighted = 0;
  for (const [cls, n] of Object.entries(dist)) {
    const p = PLANET_COUNT_BY_CLASS[cls];
    if (p) weighted += (n / total) * p.mean;
  }
  const mul = COMPANION_PLANET_SUPPRESSION[role];
  const expected = weighted * mul;
  console.log(
    '  ' + pad(role, 13) +
    ' |' + pad(arr.length, 6, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '       ' + pad(mul.toFixed(2) + '×', 6, true) +
    '        ' + pad(expected.toFixed(2), 5, true),
  );
}
console.log();

// --- 2c. Planets per cluster (gameplay system) ------------------------------
//
// Gameplay framing treats a multi-star cluster as one system, so the
// cluster total is the player-visible planet count. MAX_PLANETS_PER_CLUSTER
// is the gameplay cap; this block verifies the sum across cluster members
// holds against it.
console.log('=== Planets per cluster (gameplay system) ===');
console.log('  members  | clusters |  obs.mean  obs.sd   obs.max   cap   % at cap');
console.log('  ---------+----------+----------  ------   -------   ---   --------');
const planetsPerCluster = { 1: [], 2: [], '3+': [] };
let totalPlanets = [];
for (const cluster of clusters) {
  let n = 0;
  for (const idx of cluster.members) n += stars[idx].planets.length;
  const bucket = cluster.members.length === 1 ? 1
                : cluster.members.length === 2 ? 2 : '3+';
  planetsPerCluster[bucket].push(n);
  totalPlanets.push(n);
}
for (const bucket of [1, 2, '3+', 'total']) {
  const arr = bucket === 'total' ? totalPlanets : planetsPerCluster[bucket];
  if (!arr.length) continue;
  const obs = meanStd(arr);
  const obsMax = Math.max(...arr);
  const atCap = arr.filter(n => n >= MAX_PLANETS_PER_CLUSTER).length;
  console.log(
    '  ' + pad(bucket, 8) +
    ' |' + pad(arr.length, 7, true) +
    '  |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '   ' + pad(obsMax, 5, true) +
    '     ' + pad(MAX_PLANETS_PER_CLUSTER, 3, true) +
    '    ' + pct(atCap, arr.length),
  );
}
console.log();

// --- 3. Planet-type mix (procgen taxonomy) ----------------------------------

// "Procgen-eligible" planets = everything outside curated systems. Architect-
// generated planets always qualify; catalog planets qualify too, since the
// ring/moon backfill treats them with the same priors.
const procgenPlanets = bodies.filter(
  b => b.kind === 'planet' && !CURATED_HOSTS.has(b.hostId),
);

// Categorical mix by (mass, radius, insolation) bands — a named view
// over the continuous mass pipeline. Labels are descriptive only; no
// downstream code depends on them.
const totalProcgen = procgenPlanets.length;
console.log('=== Planet-class mix (procgen-eligible planets, descriptive) ===');
function describePlanet(p) {
  const r = p.radiusEarth;
  const m = p.massEarth;
  const S = insolationFor(p);
  if (r != null && r >= 8) return 'jupiter (R≥8)';
  if (r != null && r >= 4) return 'neptune (R 4-8)';
  if (r != null && r >= 2) return 'sub-neptune (R 2-4)';
  if (S != null && S > 100) return 'hot-rocky (S>100)';
  if (m != null && m >= 3) return 'super-earth (m≥3)';
  return 'rocky';
}
const planetClassCount = {};
for (const p of procgenPlanets) {
  const c = describePlanet(p);
  planetClassCount[c] = (planetClassCount[c] || 0) + 1;
}
const CLASS_ORDER = ['hot-rocky (S>100)', 'rocky', 'super-earth (m≥3)', 'sub-neptune (R 2-4)', 'neptune (R 4-8)', 'jupiter (R≥8)'];
for (const c of CLASS_ORDER) {
  const n = planetClassCount[c] || 0;
  console.log('  ' + pad(c, 22) + pad(n, 6, true) + '   ' + pct(n, totalProcgen));
}
console.log('  ' + pad('total', 22) + pad(totalProcgen, 6, true));
console.log();

// --- 3b. Mass histogram + gas-giant gate (Phase B regression view) --------
//
// Continuous mass pipeline produces a smooth log distribution; this block
// surfaces any bucketing artifacts (spikes at boundaries would indicate
// the old type-keyed dispatch leaked back in). The S<0.1 gas-giant rate
// is the doc's regression gate for the outer-orbit envelope mechanic.

const MASS_BINS = [
  [0,     0.01,  '< 0.01'],
  [0.01,  0.1,   '0.01–0.1'],
  [0.1,   0.5,   '0.1–0.5'],
  [0.5,   2,     '0.5–2'],
  [2,     10,    '2–10'],
  [10,    50,    '10–50'],
  [50,    300,   '50–300'],
  [300,   Infinity, '300+'],
];
console.log('=== Mass histogram (procgen planets, log bins, M⊕) ===');
for (const [lo, hi, label] of MASS_BINS) {
  const n = procgenPlanets.filter(p => p.massEarth != null && p.massEarth >= lo && p.massEarth < hi).length;
  const p = (n / totalProcgen * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(n / totalProcgen * 50));
  console.log('  ' + pad(label, 10) + pad(n, 6, true) + '  ' + pad(p + '%', 6, true) + '  ' + bar);
}
console.log();

console.log('=== Gas-giant rate by insolation band (procgen planets, m≥10 M⊕) ===');
console.log('  band               |  planets   m≥10   pct-gaseous   median.mass');
console.log('  -------------------+----------------------------------------------');
const S_BANDS = [
  [100, Infinity, 'hot (S > 100)'],
  [10,  100,      'warm (10–100)'],
  [0.5, 10,       'temperate (0.5–10)'],
  [0.05, 0.5,     'cool (0.05–0.5)'],
  [0,    0.05,    'deep_cold (<0.05)'],
  [0,    0.1,     '— S < 0.1 (gate)'],
];
for (const [lo, hi, label] of S_BANDS) {
  const planets = procgenPlanets.filter(p => {
    const s = insolationFor(p); return s != null && s >= lo && s < hi;
  });
  if (planets.length === 0) {
    console.log('  ' + pad(label, 18) + ' | ' + pad('—', 8, true));
    continue;
  }
  const masses = planets.map(p => p.massEarth ?? 0).sort((a, b) => a - b);
  const med = masses[masses.length >> 1];
  const big = planets.filter(p => (p.massEarth ?? 0) >= 10).length;
  console.log(
    '  ' + pad(label, 18) +
    ' | ' + pad(planets.length, 7, true) +
    '   ' + pad(big, 5, true) +
    '   ' + pad((big / planets.length * 100).toFixed(1) + '%', 8, true) +
    '     ' + pad(med.toFixed(3), 8, true),
  );
}
console.log();

// --- 4. Ring occurrence by host radius --------------------------------------

// Ring occurrence is P_ring = R_p² × RING_DISRUPTION_RATE per planet
// (Phase E). Bucket procgen planets by radius and report observed rate
// against the in-bucket mean of P_p — the bucket midpoint would
// mis-anchor since planets cluster at the low end of each band.
const RADIUS_BUCKETS = [
  { label: 'sub-Mercury (<0.5)',   lo: 0,    hi: 0.5  },
  { label: 'Mercury-Earth (0.5-1.5)', lo: 0.5,  hi: 1.5  },
  { label: 'super-Earth (1.5-2.5)',   lo: 1.5,  hi: 2.5  },
  { label: 'sub-Neptune (2.5-4)',     lo: 2.5,  hi: 4    },
  { label: 'Neptune (4-8)',           lo: 4,    hi: 8    },
  { label: 'Jupiter (8-15)',          lo: 8,    hi: 15   },
  { label: 'super-Jupiter (>=15)',    lo: 15,   hi: Infinity },
];
console.log('=== Rings, by host radius bucket ===');
console.log('  bucket                  | planets |  rings    obs.rate    prior.p̄    z          volatiles  rocky');
console.log('  ------------------------+---------+-------    --------    -------    --------   ---------  -----');
const ringsByBucket = RADIUS_BUCKETS.map(b => ({ ...b, planets: [], rings: [] }));
for (const p of procgenPlanets) {
  if (p.radiusEarth == null) continue;
  const bucket = ringsByBucket.find(b => p.radiusEarth >= b.lo && p.radiusEarth < b.hi);
  if (bucket) bucket.planets.push(p);
}
for (const b of bodies) {
  if (b.kind !== 'ring') continue;
  const host = bodies[b.hostBodyIdx];
  if (!host) continue;
  if (CURATED_HOSTS.has(host.hostId)) continue;
  if (host.radiusEarth == null) continue;
  const bucket = ringsByBucket.find(bb => host.radiusEarth >= bb.lo && host.radiusEarth < bb.hi);
  if (bucket) bucket.rings.push(b);
}
for (const b of ringsByBucket) {
  const planets = b.planets.length;
  const ringCount = b.rings.length;
  const obsRate = planets ? ringCount / planets : 0;
  const meanP = planets
    ? b.planets.reduce((s, p) => s + p.radiusEarth * p.radiusEarth * RING_DISRUPTION_RATE, 0) / planets
    : 0;
  const sumVol = b.rings.reduce((s, r) => s + (r.resVolatiles ?? 0), 0);
  const sumRocky = b.rings.reduce((s, r) => s + (r.resMetals ?? 0) + (r.resSilicates ?? 0) + (r.resRareEarths ?? 0), 0);
  const avgVol = ringCount ? sumVol / ringCount : 0;
  const avgRocky = ringCount ? sumRocky / ringCount : 0;
  console.log(
    '  ' + pad(b.label, 23) +
    ' |' + pad(planets, 8, true) +
    ' |' + pad(ringCount, 7, true) +
    '   ' + pad((obsRate * 100).toFixed(2) + '%', 8, true) +
    '   ' + pad((meanP * 100).toFixed(2) + '%', 7, true) +
    fmtZ(zBinom(ringCount, planets, meanP), Math.min(planets * meanP, planets * (1 - meanP))) +
    '   ' + pad(avgVol.toFixed(1), 7, true) +
    '   ' + pad(avgRocky.toFixed(1), 5, true),
  );
}
console.log();

// --- 5. Moon count by Hill-sphere capacity ----------------------------------

// Moon count is Binomial(MOON_COUNT_MAX, p) with p = min(CAP, R_H × PER_HILL).
// Bucket procgen planets by R_H and report observed mean against the mean
// of per-planet binomial mean (n × p) in the bucket — comparing to a
// bucket midpoint would mis-anchor the prior since most planets cluster
// at the low end of each band. Binomial SD = √(n × p × (1−p)) for the z-score.
const starByIdForMoons = new Map(stars.map(s => [s.id, s]));
const HILL_BUCKETS = [
  { label: 'tiny (<0.005 AU)',     lo: 0,      hi: 0.005    },
  { label: 'small (0.005-0.05)',   lo: 0.005,  hi: 0.05     },
  { label: 'mid (0.05-0.2)',       lo: 0.05,   hi: 0.2      },
  { label: 'large (0.2-0.5)',      lo: 0.2,    hi: 0.5      },
  { label: 'huge (>=0.5)',         lo: 0.5,    hi: Infinity },
];
console.log('=== Moons per planet, by Hill-sphere bucket ===');
console.log('  bucket                | planets |  obs.mean  obs.sd     prior.λ̄   prior.sd    z            %with-moons    at-cap');
console.log('  ----------------------+---------+----------  ------     --------  --------    --------     -----------    ------');
const moonsByBucket = HILL_BUCKETS.map(b => ({ ...b, counts: [], lambdas: [] }));
for (const p of procgenPlanets) {
  const star = starByIdForMoons.get(p.hostId);
  if (!star || star.mass == null) continue;
  if (p.massEarth == null || p.semiMajorAu == null) continue;
  const hill = hillRadiusAu(p.semiMajorAu, p.massEarth, star.mass);
  if (hill == null) continue;
  const bucket = moonsByBucket.find(b => hill >= b.lo && hill < b.hi);
  if (bucket) {
    bucket.counts.push(p.moons.length);
    const prob = Math.min(MOON_PROBABILITY_CAP, hill * MOON_PROBABILITY_PER_HILL);
    bucket.lambdas.push(MOON_COUNT_MAX * prob);
    bucket.probs = bucket.probs || [];
    bucket.probs.push(prob);
  }
}
for (const b of moonsByBucket) {
  const arr = b.counts;
  const obs = meanStd(arr);
  const withMoons = arr.filter(n => n > 0).length;
  const atCap = arr.filter(n => n >= MOON_COUNT_MAX).length;
  const meanLambda = b.lambdas.length ? b.lambdas.reduce((s, x) => s + x, 0) / b.lambdas.length : 0;
  const meanProb = b.probs && b.probs.length ? b.probs.reduce((s, x) => s + x, 0) / b.probs.length : 0;
  const priorSd = Math.sqrt(MOON_COUNT_MAX * meanProb * (1 - meanProb));
  console.log(
    '  ' + pad(b.label, 21) +
    ' |' + pad(arr.length, 8, true) +
    ' |  ' + pad(obs.mean.toFixed(2), 6, true) +
    '   ' + pad(obs.sd.toFixed(2), 4, true) +
    '       ' + pad(meanLambda.toFixed(2), 5, true) +
    '       ' + pad(priorSd.toFixed(2), 4, true) +
    fmtZ(zMean(obs.mean, arr.length, meanLambda, priorSd), arr.length) +
    '   ' + pct(withMoons, arr.length) +
    '    ' + pct(atCap, arr.length),
  );
}
console.log();

// --- 6. Belt occurrence by stellar class + context --------------------------

// Every non-curated star is architect- or overlay-touched today, so the
// belt-roll population is "stars with a class supported by the priors,
// minus curated hosts (Sol's belts are catalog-canonical)."
const eligibleStars = stars.filter(s => s.cls && !CURATED_HOSTS.has(s.id));

// Belt context (warm / cold) isn't stored as a public field — derive
// it from the belt id, which the architect emits as
// `${starId}-belt-${context}`.
const BELT_CONTEXTS = ['warm', 'cold'];
function beltContextOf(belt) {
  for (const c of BELT_CONTEXTS) if (belt.id.endsWith(`-belt-${c}`)) return c;
  return null;
}

console.log('=== Belts, by stellar class + context (architect + overlay) ===');
console.log('  z column: standard deviations from the prior. `*` flags |z|≥2 when min(np, n(1-p))≥5.');
console.log('  cls | systems |  warm.obs  warm.prior   z          cold.obs  cold.prior   z');
console.log('  ----+---------+----------  ----------   ---------  --------  ----------   ---------');
const beltsByCls = {};
for (const star of eligibleStars) {
  const cls = star.cls || '?';
  if (!beltsByCls[cls]) beltsByCls[cls] = { systems: 0, warm: 0, cold: 0 };
  beltsByCls[cls].systems += 1;
  for (const bi of star.belts) {
    const belt = bodies[bi];
    if (!belt || belt.source !== 'procgen') continue;
    const ctx = beltContextOf(belt);
    if (ctx) beltsByCls[cls][ctx] += 1;
  }
}
for (const cls of STELLAR_CLASSES) {
  const row = beltsByCls[cls] || { systems: 0, warm: 0, cold: 0 };
  const p = BELT_OCCURRENCE_BY_CLASS[cls];
  const n = Math.max(1, row.systems);
  const cells = BELT_CONTEXTS.map(ctx => {
    const obs = row[ctx] / n;
    const pri = p[ctx];
    return (
      '  ' + pad((obs * 100).toFixed(2) + '%', 7, true) +
      '   ' + pad((pri * 100).toFixed(2) + '%', 7, true) +
      fmtZ(zBinom(row[ctx], row.systems, pri), Math.min(row.systems * pri, row.systems * (1 - pri)))
    );
  }).join('  ');
  console.log('  ' + pad(cls, 4) + '| ' + pad(row.systems, 7, true) + ' |' + cells);
}
console.log();

// --- 7. Surface scalars by archetype ----------------------------------------

console.log('=== Surface scalars, by archetype (procgen planets) ===');
function auditScalar(field, priorTable, label) {
  console.log('  --- ' + label + ' ---');
  console.log('  class       |  n      obs.mean  obs.sd     prior.mean  prior.sd   z');
  const byClass = {};
  for (const b of bodies) {
    if (b.kind !== 'planet' || b.source !== 'procgen') continue;
    if (b[field] == null) continue;
    const arch = classifyBody(b);
    if (!byClass[arch]) byClass[arch] = [];
    byClass[arch].push(b[field]);
  }
  for (const cls of Object.keys(priorTable).sort()) {
    const arr = byClass[cls] || [];
    const obs = meanStd(arr);
    const p = priorTable[cls];
    if (!arr.length) continue;
    console.log(
      '  ' + pad(cls, 11) +
      ' |' + pad(arr.length, 5, true) +
      '   ' + pad(obs.mean.toFixed(3), 6, true) +
      '   ' + pad(obs.sd.toFixed(3), 5, true) +
      '      ' + pad(p.mean.toFixed(3), 5, true) +
      '       ' + pad(p.sd.toFixed(3), 5, true) +
      fmtZ(zMean(obs.mean, arr.length, p.mean, p.sd || 0.001), arr.length),
    );
  }
}
// Phase 3 closes the bug where small airless bodies rendered liquid
// oceans and warm airless bodies rendered surface ice. Both cases
// should be ≈ 0 once the cover formulas read (T, P, bulkWater).
// Reports raw counts so a non-zero number is immediately visible.
function auditCoverBugClosure() {
  console.log('  --- Phase 3 bug-closure check (small airless + warm airless) ---');
  let smallAirlessOcean = 0;
  let warmAirlessIce    = 0;
  let totalSmallAirless = 0;
  let totalWarmAirless  = 0;
  for (const b of bodies) {
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    if (b.source !== 'procgen') continue;
    if (b.massEarth == null || b.avgSurfaceTempK == null) continue;
    const airless = (b.surfacePressureBar ?? 0) < TRIPLE_POINT_BAR;
    const small   = b.massEarth < 0.1;
    const warm    = b.avgSurfaceTempK > 280;
    if (small && airless && b.avgSurfaceTempK > 250) {
      totalSmallAirless += 1;
      if ((b.waterFraction ?? 0) > 0.1) smallAirlessOcean += 1;
    }
    if (warm && airless) {
      totalWarmAirless += 1;
      if ((b.iceFraction ?? 0) > 0.1) warmAirlessIce += 1;
    }
  }
  console.log('  small (M<0.1) + airless (P<triple) + temperate (T>250K) with waterFrac>0.1:');
  console.log('    ' + smallAirlessOcean + ' / ' + totalSmallAirless + (smallAirlessOcean === 0 ? '  ✓' : '  ← bug not closed'));
  console.log('  warm (T>280K) + airless (P<triple) with iceFrac>0.1:');
  console.log('    ' + warmAirlessIce + ' / ' + totalWarmAirless + (warmAirlessIce === 0 ? '  ✓' : '  ← bug not closed'));
}

// Surface water/ice are now physics-derived (Phase 3) rather than
// class-keyed truncated normals. Audit reports distribution by regime
// so it's clear how often each derivation path fires.
function auditSurfaceCover() {
  console.log('  --- surface water/ice cover (by regime) ---');
  let liquidGated = 0, frozenGlobal = 0, polarCap = 0, airlessOrDry = 0;
  for (const b of bodies) {
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    if (b.source !== 'procgen') continue;
    if (GASEOUS_ARCHETYPES.has(classifyBody(b))) continue;
    const w = b.waterFraction ?? 0;
    const i = b.iceFraction ?? 0;
    if (w > 0.05 && i < 0.5)     liquidGated += 1;
    else if (i > 0.5)             frozenGlobal += 1;
    else if (i > 0.01 && w < 0.05) polarCap += 1;
    else                           airlessOrDry += 1;
  }
  console.log('  liquid-water cover (water>5% non-global):  ' + liquidGated);
  console.log('  globally frozen (ice>50%):                  ' + frozenGlobal);
  console.log('  polar caps (1% < ice ≤ 50%, water < 5%):    ' + polarCap);
  console.log('  airless or dry (cover ≈ 0):                 ' + airlessOrDry);
}

// Bulk-composition audit. Architect samples bulkWater / bulkMetal /
// bulkVolatile per body from the four-zone formation gate (inside_H2O /
// H2O_to_NH3 / NH3_to_CH4 / past_CH4). Geometric stats per zone — the
// priors are log-space sampleLogTruncated, so geometric mean lines up
// cleanly with each spec's mean.
//
// Zones the body via host star mass → per-star frost lines + body's
// formationAu (planets) or host's formationAu (moons). Planets / moons
// without a formationAu (catalog rows) fall back to their semiMajorAu.
function bulkCompositionZone(body) {
  const host = body.kind === 'moon' ? (bodies[body.hostBodyIdx] ?? null) : body;
  if (!host || host.hostStarIdx == null) return null;
  const star = stars[host.hostStarIdx];
  if (!star || star.mass == null) return null;
  const aForm = host.formationAu ?? host.semiMajorAu;
  if (aForm == null) return null;
  const fl = {
    H2O: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.H2O),
    NH3: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.NH3),
    CH4: frostLineAU(star.mass, SNOW_LINE_TEMPERATURES.CH4),
  };
  return zoneForFormationAu(aForm, fl);
}

function auditBulkComposition(field, label, priors) {
  console.log('  --- ' + label + ' (by formation zone) ---');
  console.log('  zone         |  n      obs.geo-mean   prior.mean   obs.min   obs.max');
  const byZone = { inside_H2O: [], H2O_to_NH3: [], NH3_to_CH4: [], past_CH4: [] };
  for (const b of bodies) {
    if ((b.kind !== 'planet' && b.kind !== 'moon') || b.source !== 'procgen') continue;
    if (b[field] == null) continue;
    const zone = bulkCompositionZone(b);
    if (!zone) continue;
    byZone[zone].push(b[field]);
  }
  for (const zone of ['inside_H2O', 'H2O_to_NH3', 'NH3_to_CH4', 'past_CH4']) {
    const arr = byZone[zone];
    if (!arr.length) { console.log('  ' + pad(zone, 12) + ' |     0   (none)'); continue; }
    const logs = arr.map(x => Math.log(Math.max(x, 1e-9)));
    const geoMean = Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const p = priors[zone];
    console.log(
      '  ' + pad(zone, 12) +
      ' |' + pad(arr.length, 5, true) +
      '   ' + pad(geoMean.toExponential(2), 11, true) +
      '   ' + pad(p.mean.toExponential(2), 10, true) +
      '   ' + pad(min.toExponential(2), 8, true) +
      '   ' + pad(max.toExponential(2), 8, true),
    );
  }
}

auditSurfaceCover();
auditCoverBugClosure();
auditBulkComposition('bulkWaterFraction',    'bulkWaterFraction',    BULK_WATER_FRACTION_BY_ZONE);
auditBulkComposition('bulkMetalFraction',    'bulkMetalFraction',    BULK_METAL_FRACTION_BY_ZONE);
auditBulkComposition('bulkVolatileFraction', 'bulkVolatileFraction', BULK_VOLATILE_FRACTION_BY_ZONE);
// Phase 4: surfaceAge / tectonicActivity / magneticFieldGauss are now
// physics-derived (no per-class prior table); the class-keyed auditScalar
// is incompatible. Drop these reports for now; replace with derivation-
// distribution reports if needed.

// Archetype distribution (runtime classifier). After all physics settles,
// classifyBody is the label dispatched to designer content. Report counts
// so it's easy to spot if an archetype is over- or under-represented.
console.log('  --- archetype distribution (procgen, classifier) ---');
const classCount = {};
for (const b of bodies) {
  if ((b.kind !== 'planet' && b.kind !== 'moon') || b.source !== 'procgen') continue;
  const arch = classifyBody(b);
  classCount[arch] = (classCount[arch] ?? 0) + 1;
}
const totalDerived = Object.values(classCount).reduce((a, b) => a + b, 0);
for (const cls of Object.keys(classCount).sort()) {
  console.log('  ' + pad(cls, 16) + ' | ' + pad(classCount[cls], 6, true) + '  ' + pct(classCount[cls], totalDerived));
}
console.log();

// --- 8. Atmosphere top-gas distribution -------------------------------------

console.log('=== Atmosphere top gas (atm1) by archetype ===');
const atmByClass = {};
for (const b of bodies) {
  if (b.kind !== 'planet' || b.source !== 'procgen') continue;
  if (!b.atm1) continue;
  const arch = classifyBody(b);
  if (!atmByClass[arch]) atmByClass[arch] = { total: 0, gases: {} };
  atmByClass[arch].total += 1;
  atmByClass[arch].gases[b.atm1] = (atmByClass[arch].gases[b.atm1] || 0) + 1;
}
for (const cls of Object.keys(atmByClass).sort()) {
  const r = atmByClass[cls];
  const sorted = Object.entries(r.gases).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const breakdown = sorted.map(([g, n]) => `${g} ${(n / r.total * 100).toFixed(0)}%`).join('  ');
  console.log('  ' + pad(cls, 16) + ' | n=' + pad(r.total, 4, true) + '  ' + breakdown);
}
console.log();

// --- 9. Resource means by archetype (label-only — physics-derived) -------

console.log('=== Resource means, by archetype (procgen planets, 0-10 scale) ===');
console.log('  archetype        |  n      met  sil  vol  rare radio exo');
const RES = ['resMetals','resSilicates','resVolatiles','resRareEarths','resRadioactives','resExotics'];
const resByClass = {};
for (const b of bodies) {
  if (b.kind !== 'planet' || b.source !== 'procgen') continue;
  const arch = classifyBody(b);
  if (!resByClass[arch]) {
    resByClass[arch] = { n: 0, sums: Object.fromEntries(RES.map(f => [f, 0])) };
  }
  resByClass[arch].n += 1;
  for (const f of RES) if (b[f] != null) resByClass[arch].sums[f] += b[f];
}
for (const cls of Object.keys(resByClass).sort()) {
  const r = resByClass[cls];
  if (!r || !r.n) continue;
  const obs = RES.map(f => (r.sums[f] / r.n).toFixed(1).padStart(3));
  console.log(
    '  ' + pad(cls, 16) +
    ' | ' + pad(r.n, 4, true) +
    '   ' + obs.join('  '),
  );
}
console.log();

console.log('=== Resource means, by belt context (procgen belts, 0-10 scale) ===');
console.log('  context           |  n      met  sil  vol  rare radio exo    (occurrence weights in brackets)');
const beltResByCtx = {};
for (const b of bodies) {
  if (b.kind !== 'belt' || b.source !== 'procgen') continue;
  const ctx = beltContextOf(b);
  if (!ctx) continue;
  if (!beltResByCtx[ctx]) {
    beltResByCtx[ctx] = { n: 0, sums: Object.fromEntries(RES.map(f => [f, 0])) };
  }
  beltResByCtx[ctx].n += 1;
  for (const f of RES) if (b[f] != null) beltResByCtx[ctx].sums[f] += b[f];
}
for (const ctx of BELT_CONTEXTS) {
  const r = beltResByCtx[ctx];
  const p = BELT_RESOURCE_OCCURRENCE[ctx];
  if (!r || !r.n) continue;
  const obs = RES.map(f => (r.sums[f] / r.n).toFixed(1).padStart(3));
  const prior = RES.map(f => String(p[f] ?? 0).padStart(3));
  console.log(
    '  ' + pad(ctx, 17) +
    ' | ' + pad(r.n, 4, true) +
    '   ' + obs.join('  ') +
    '   [' + prior.join(' ') + ']',
  );
}
console.log();

// --- 9b. Belt largest body + shepherd coverage ------------------------------

console.log('=== Belt largestBodyKm, by context × shepherding (procgen belts) ===');
console.log('  context  shepherded |  n     geomean.km    range.km');
const beltExtras = {};
for (const b of bodies) {
  if (b.kind !== 'belt' || b.source !== 'procgen') continue;
  const ctx = beltContextOf(b);
  if (!ctx) continue;
  const key = `${ctx}:${b.shepherdBodyIdx != null ? 'yes' : 'no'}`;
  if (!beltExtras[key]) beltExtras[key] = { logKm: [] };
  if (b.largestBodyKm != null) beltExtras[key].logKm.push(Math.log10(b.largestBodyKm));
}
for (const ctx of BELT_CONTEXTS) {
  for (const shep of ['yes', 'no']) {
    const r = beltExtras[`${ctx}:${shep}`];
    if (!r || !r.logKm.length) continue;
    const logMean = r.logKm.reduce((a, b) => a + b, 0) / r.logKm.length;
    const kmGeomean = Math.pow(10, logMean);
    const kmMin = Math.pow(10, Math.min(...r.logKm));
    const kmMax = Math.pow(10, Math.max(...r.logKm));
    console.log(
      '  ' + pad(ctx, 8) +
      '    ' + pad(shep, 3) +
      '     | ' + pad(r.logKm.length, 4, true) +
      '   ' + pad(kmGeomean.toFixed(1), 9, true) +
      '       ' + pad(kmMin.toFixed(1) + '–' + kmMax.toFixed(1), 16, true),
    );
  }
}
console.log();

// Shepherd coverage — what fraction of belts landed adjacent to a
// giant vs took the giantless penalty path. Shepherded belts pull
// largestBodyKm from the parent-body scale; free-float belts pull
// from the dust-cascade scale. High coverage indicates most procgen
// systems are spawning at least one giant; low coverage flags either
// over-penalty or under-supply of giants.
console.log('=== Belt shepherd coverage (procgen belts) ===');
console.log('  context           |  n      shepherded   pct');
const shepCov = {};
for (const b of bodies) {
  if (b.kind !== 'belt' || b.source !== 'procgen') continue;
  const ctx = beltContextOf(b);
  if (!ctx) continue;
  if (!shepCov[ctx]) shepCov[ctx] = { n: 0, shepherded: 0 };
  shepCov[ctx].n += 1;
  if (b.shepherdBodyIdx != null) shepCov[ctx].shepherded += 1;
}
for (const ctx of BELT_CONTEXTS) {
  const r = shepCov[ctx];
  if (!r) continue;
  console.log(
    '  ' + pad(ctx, 17) +
    ' | ' + pad(r.n, 4, true) +
    '   ' + pad(r.shepherded, 5, true) +
    '       ' + pct(r.shepherded, r.n),
  );
}
console.log();

// --- 9c. Resource distribution schemes (S1–S6) ------------------------------
//
// The planet/moon resource grid is shaped by six composable schemes (see
// plans/ + procgen-priors.mjs): S1 star-type bias, S2 bimodal abundance, S3
// scarcity tiers, S4 pair affinity, S5 hostility-scaled motherlodes, S6
// keystone multi-deposit worlds. This block reports the realized shape; the
// R-series structural invariants at the bottom turn the load-bearing
// properties into hard gates. Population = non-curated planets + moons (Sol's
// bodies are CSV-authored with full grids, so they're excluded — their
// hostId chains up to a curated star).

// Walk a body to its host star index (planet → hostStarIdx directly; moon →
// up through its parent planet). Null if unresolved.
function hostStarIdxOf(body) {
  let cur = body;
  for (let guard = 0; cur && guard < 6; guard++) {
    if (cur.hostStarIdx != null) return cur.hostStarIdx;
    cur = cur.hostBodyIdx != null ? bodies[cur.hostBodyIdx] : null;
  }
  return null;
}
function resHostClassOf(body) {
  const si = hostStarIdxOf(body);
  return si != null ? (stars[si].cls || '?') : '?';
}
function isCuratedResBody(body) {
  const si = hostStarIdxOf(body);
  return si != null && CURATED_HOSTS.has(stars[si].id);
}
function nonzeroRes(body) {
  return RESOURCE_KEYS.filter(k => (body[k] ?? 0) > 0);
}

// The resource-bearing population the six schemes govern.
const resBodies = bodies.filter(
  b => (b.kind === 'planet' || b.kind === 'moon')
    && RESOURCE_KEYS.some(k => b[k] != null)
    && !isCuratedResBody(b),
);

// Tier lookup (resource → 'bulk' | 'strategic' | 'exotic').
const TIER_OF = {};
for (const [tier, keys] of Object.entries(RESOURCE_TIER)) for (const k of keys) TIER_OF[k] = tier;

// All 15 unordered resource pairs, as canonical "i|j" keys (i < j).
const RES_PAIRS = [];
for (let i = 0; i < RESOURCE_KEYS.length; i++)
  for (let j = i + 1; j < RESOURCE_KEYS.length; j++)
    RES_PAIRS.push(RESOURCE_KEYS[i] + '|' + RESOURCE_KEYS[j]);
function pairKey(a, b) {
  return RESOURCE_KEYS.indexOf(a) < RESOURCE_KEYS.indexOf(b) ? a + '|' + b : b + '|' + a;
}
const RES_SHORT = {
  resMetals: 'met', resSilicates: 'sil', resVolatiles: 'vol',
  resRareEarths: 'rare', resRadioactives: 'radio', resExotics: 'exo',
};

// S1/S3 — presence per resource, with tier tag.
console.log('=== Resource presence + tier (non-curated planets + moons, n=' + resBodies.length + ') ===');
const resPresence = Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0]));
for (const b of resBodies) for (const k of nonzeroRes(b)) resPresence[k] += 1;
for (const k of RESOURCE_KEYS) {
  console.log('  ' + pad(RES_SHORT[k], 6) + pad('[' + TIER_OF[k] + ']', 12) + pct(resPresence[k], resBodies.length));
}
console.log();

// S4 — pair co-occurrence (2-deposit subset). Tag synergy/exclusion cells.
console.log('=== Resource pair co-occurrence (2-deposit non-curated planets + moons) ===');
const twoDep = resBodies.filter(b => nonzeroRes(b).length === 2);
const pairCount = Object.fromEntries(RES_PAIRS.map(p => [p, 0]));
for (const b of twoDep) { const z = nonzeroRes(b); pairCount[pairKey(z[0], z[1])] += 1; }
const presentPairs = RES_PAIRS.filter(p => pairCount[p] > 0).length;
const minPair = Math.min(...RES_PAIRS.map(p => pairCount[p]));
console.log('  pairs present: ' + presentPairs + '/15   min pair count: ' + minPair + '   (n=' + twoDep.length + ')');
const pairRows = RES_PAIRS.map(p => ({ p, n: pairCount[p] })).sort((a, b) => b.n - a.n);
for (const { p, n } of pairRows) {
  const [a, b2] = p.split('|');
  const aff = RESOURCE_PAIR_AFFINITY[a]?.[b2];
  const tag = aff == null ? '     ' : aff > 1 ? ' syn+' : ' exc-';
  console.log('  ' + pad(RES_SHORT[a] + '+' + RES_SHORT[b2], 12) + pad(n, 6, true) + '  ' + pct(n, twoDep.length) + tag);
}
console.log();

// S2/S5 — abundance shape + hostility gradient.
console.log('=== Resource abundance (bimodal grade + hostility gradient) ===');
const allGrades = [];
for (const b of resBodies) for (const k of nonzeroRes(b)) allGrades.push(b[k]);
allGrades.sort((a, b) => a - b);
const medianGrade = allGrades.length ? allGrades[allGrades.length >> 1] : 0;
const star5 = allGrades.filter(v => v >= 9).length;
console.log('  deposits: ' + allGrades.length + '   median grade: ' + medianGrade
  + '   5★ (grade ≥ 9) rate: ' + (star5 / allGrades.length * 100).toFixed(1) + '%');
function gradeStats(set) {
  let tot = 0, hi = 0;
  for (const b of set) for (const k of nonzeroRes(b)) { tot += 1; if (b[k] >= 9) hi += 1; }
  return { n: set.length, rate: tot ? hi / tot : 0 };
}
const hostile = resBodies.filter(b => (b.avgSurfaceTempK ?? 0) >= 400 || (b.radiusEarth ?? 0) >= 3);
const benign = resBodies.filter(b => (b.radiusEarth ?? 0) < 3 && (b.avgSurfaceTempK ?? 0) >= 200 && (b.avgSurfaceTempK ?? 0) < 400);
const hs = gradeStats(hostile), bs = gradeStats(benign);
console.log('  motherlode rate — hostile (hot or gaseous) ' + (hs.rate * 100).toFixed(1) + '% (n=' + hs.n + ')'
  + '   vs benign (temperate terrestrial) ' + (bs.rate * 100).toFixed(1) + '% (n=' + bs.n + ')');
console.log();

// S1 — per-host-class lean (volatiles vs metals presence).
console.log('=== Resource lean by host class (presence%, classes with n≥50) ===');
console.log('  cls |   n   ' + RESOURCE_KEYS.map(k => pad(RES_SHORT[k], 6, true)).join(''));
const resByHostClass = {};
for (const b of resBodies) {
  const c = resHostClassOf(b);
  if (!resByHostClass[c]) resByHostClass[c] = [];
  resByHostClass[c].push(b);
}
for (const cls of STELLAR_CLASSES) {
  const arr = resByHostClass[cls];
  if (!arr || arr.length < 50) continue;
  const cells = RESOURCE_KEYS.map(k =>
    pad((arr.filter(b => (b[k] ?? 0) > 0).length / arr.length * 100).toFixed(0), 6, true)).join('');
  console.log('  ' + pad(cls, 4) + '|' + pad(arr.length, 5, true) + '   ' + cells);
}
console.log();

// S6 — deposit-count distribution.
console.log('=== Deposit-count distribution (non-curated planets + moons) ===');
const depCount = {};
for (const b of resBodies) { const n = nonzeroRes(b).length; depCount[n] = (depCount[n] || 0) + 1; }
const multiDep = resBodies.filter(b => nonzeroRes(b).length >= 3).length;
for (const n of Object.keys(depCount).sort()) {
  console.log('  ' + n + ' deposits: ' + pad(depCount[n], 6, true) + '  ' + pct(depCount[n], resBodies.length));
}
console.log('  multi-deposit (≥3): ' + (multiDep / resBodies.length * 100).toFixed(1)
  + '%   prior: ' + (DEPOSIT_COUNT_DIST.filter(o => o.count >= 3).reduce((s, o) => s + o.weight, 0) * 100).toFixed(0) + '%');
console.log();

// --- 10. Biosphere distribution ---------------------------------------------

// Population: planets + moons across all sources. Subsurface-aqueous
// life lives overwhelmingly on moons (Europa/Enceladus-class), so a
// planet-only matrix understates the actual catalog by ~6×. Curated
// bodies (Sol's Earth, Europa, Enceladus, Titan) are included too —
// they're hand-anchored ground truth, and excluding them would hide
// the only Earth-class dominant carbon-aqueous in the catalog.
console.log('=== Biosphere — archetype × complexity matrix (planets + moons, all sources) ===');
const bioMatrix = {};               // [arch][complexity] across both kinds
const bioMatrixByKind = {           // [kind][arch][complexity]
  planet: {}, moon: {},
};
let aliveCount = 0;
let alivePlanets = 0, aliveMoons = 0;
let totalHabitatBodies = 0;
let planetCount = 0, moonCount = 0;
for (const b of bodies) {
  if (b.kind !== 'planet' && b.kind !== 'moon') continue;
  totalHabitatBodies += 1;
  if (b.kind === 'planet') planetCount += 1; else moonCount += 1;
  const c = b.biosphereComplexity ?? 'none';
  const a = b.biosphereArchetype ?? 'sterile';
  if (c !== 'none') {
    aliveCount += 1;
    if (b.kind === 'planet') alivePlanets += 1; else aliveMoons += 1;
    if (!bioMatrix[a]) bioMatrix[a] = {};
    bioMatrix[a][c] = (bioMatrix[a][c] || 0) + 1;
    const byKind = bioMatrixByKind[b.kind];
    if (!byKind[a]) byKind[a] = {};
    byKind[a][c] = (byKind[a][c] || 0) + 1;
  }
}
console.log('  total planets + moons: ' + totalHabitatBodies +
            '   (planets ' + planetCount + ', moons ' + moonCount + ')');
console.log('  with life:             ' + aliveCount +
            ' (' + (aliveCount / totalHabitatBodies * 100).toFixed(2) + '%)' +
            '   — ' + alivePlanets + ' planets, ' + aliveMoons + ' moons');
console.log();
const COMPLEXITY_BUCKETS = BIOSPHERE_COMPLEXITY.filter(c => c !== 'none');
function printMatrix(label, matrix) {
  console.log('  ' + label);
  console.log('  archetype           |' + COMPLEXITY_BUCKETS.map(c => pad(c, 11, true)).join(' |') + ' |  total');
  console.log('  --------------------+' + COMPLEXITY_BUCKETS.map(_ => '-'.repeat(12)).join('+') + '+--------');
  for (const a of BIOSPHERE_ARCHETYPES) {
    const row = matrix[a] || {};
    const cells = COMPLEXITY_BUCKETS.map(c => pad(row[c] || 0, 11, true));
    const total = COMPLEXITY_BUCKETS.reduce((s, c) => s + (row[c] || 0), 0);
    console.log('  ' + pad(a, 19) + ' |' + cells.join(' |') + ' | ' + pad(total, 6, true));
  }
}
printMatrix('combined', bioMatrix);
console.log();
printMatrix('planets only', bioMatrixByKind.planet);
console.log();
printMatrix('moons only', bioMatrixByKind.moon);
console.log();

// --- 10b. Surface impact distribution ---------------------------------------
//
// Verifies the substrate-coupling + life-contribution model produces
// the intended shape: carbon_aqueous should peak at `dominant` (Earth-
// class biospheres run the atmosphere); subsurface_aqueous should peak
// at `none/trace` (sealed by default) with a thin tail into modifying/
// dominant (the rare-percentile plume worlds and surface-active complex
// civilizations). Cryogenic / silicate / sulfur sit in between.

function impactBucketFor(impact) {
  if (impact == null || impact <  IMPACT_BUCKET_THRESHOLDS[0]) return 'none';
  if (impact <  IMPACT_BUCKET_THRESHOLDS[1]) return 'trace';
  if (impact <  IMPACT_BUCKET_THRESHOLDS[2]) return 'modifying';
  return 'dominant';
}

console.log('=== Biosphere — archetype × surface-impact matrix (planets + moons, all sources) ===');
const impactMatrix = {};
const impactRawByArch = {};   // raw scalars for percentile reporting
for (const b of bodies) {
  if (b.kind !== 'planet' && b.kind !== 'moon') continue;
  const a = b.biosphereArchetype;
  if (a === null) continue;   // sterile — no archetype, no impact
  const bucket = impactBucketFor(b.biosphereSurfaceImpact);
  if (!impactMatrix[a]) impactMatrix[a] = {};
  impactMatrix[a][bucket] = (impactMatrix[a][bucket] || 0) + 1;
  if (!impactRawByArch[a]) impactRawByArch[a] = [];
  impactRawByArch[a].push(b.biosphereSurfaceImpact ?? 0);
}
console.log('  archetype           |' + BIOSPHERE_IMPACT_LEVELS.map(b => pad(b, 11, true)).join(' |') + ' |  total');
console.log('  --------------------+' + BIOSPHERE_IMPACT_LEVELS.map(_ => '-'.repeat(12)).join('+') + '+--------');
for (const a of BIOSPHERE_ARCHETYPES) {
  const row = impactMatrix[a] || {};
  const cells = BIOSPHERE_IMPACT_LEVELS.map(b => pad(row[b] || 0, 11, true));
  const total = BIOSPHERE_IMPACT_LEVELS.reduce((s, b) => s + (row[b] || 0), 0);
  console.log('  ' + pad(a, 19) + ' |' + cells.join(' |') + ' | ' + pad(total, 6, true));
}
console.log();

// Per-archetype impact percentiles — surfaces the log-normal tail shape
// directly. Subsurface_aqueous specifically should show median ≈ very
// low, p99 substantially above (the "telescopes" tail).
console.log('=== Surface impact percentiles (per archetype, non-sterile only) ===');
console.log('  archetype           |    n      median     p75       p90       p95       p99      max');
console.log('  --------------------+-------------------------------------------------------------------');
function pctile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}
for (const a of BIOSPHERE_ARCHETYPES) {
  const arr = (impactRawByArch[a] || []).slice().sort((x, y) => x - y);
  if (!arr.length) {
    console.log('  ' + pad(a, 19) + ' |    0       —         —         —         —         —         —');
    continue;
  }
  console.log(
    '  ' + pad(a, 19) +
    ' | ' + pad(arr.length, 5, true) +
    '   ' + pad(pctile(arr, 0.50).toFixed(3), 6, true) +
    '   ' + pad(pctile(arr, 0.75).toFixed(3), 6, true) +
    '   ' + pad(pctile(arr, 0.90).toFixed(3), 6, true) +
    '   ' + pad(pctile(arr, 0.95).toFixed(3), 6, true) +
    '   ' + pad(pctile(arr, 0.99).toFixed(3), 6, true) +
    '   ' + pad(arr[arr.length - 1].toFixed(3), 6, true),
  );
}
console.log();

console.log('=== Biotic productivity distribution (per archetype, planets + moons, all sources) ===');
console.log('  archetype           |  n>0      mean     >0.3      >0.5      >0.75');
console.log('  --------------------+----------------------------------------------');
const BIOTIC_FIELD_BY_ARCH = {
  carbon_aqueous:     'bioticCarbonAqueous',
  subsurface_aqueous: 'bioticSubsurfaceAqueous',
  aerial:             'bioticAerial',
  cryogenic:          'bioticCryogenic',
  silicate:           'bioticSilicate',
  sulfur:             'bioticSulfur',
};
for (const a of BIOSPHERE_ARCHETYPES) {
  const f = BIOTIC_FIELD_BY_ARCH[a];
  const vals = [];
  for (const b of bodies) {
    if (b.kind !== 'planet' && b.kind !== 'moon') continue;
    const v = b[f];
    if (v != null && v > 0) vals.push(v);
  }
  if (!vals.length) {
    console.log('  ' + pad(a, 19) + ' |     0       —        —         —         —');
    continue;
  }
  const mean = vals.reduce((s,v)=>s+v,0) / vals.length;
  const above3 = vals.filter(v => v > 0.3).length;
  const above5 = vals.filter(v => v > 0.5).length;
  const above75 = vals.filter(v => v > 0.75).length;
  console.log(
    '  ' + pad(a, 19) +
    ' | ' + pad(vals.length, 6, true) +
    '   ' + pad(mean.toFixed(3), 6, true) +
    '   ' + pad(above3, 6, true) +
    '   ' + pad(above5, 6, true) +
    '   ' + pad(above75, 6, true),
  );
}
console.log();

// =============================================================================
// Structural invariants — hard assertions that FAIL the build (exit 1) rather
// than just reporting a distribution. Everything above is advisory (z-scores a
// human reads); these BITE. Each guards one defect class from the 2026-05
// render+procgen review so the next tuning cycle can't silently re-introduce
// it. Tag each with the review item id it descends from.
// =============================================================================
console.log('=== Structural invariants (hard gate) ===');
const invariantFailures = [];
function invariant(id, label, ok, detail) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  [' + id + '] ' + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) invariantFailures.push(`[${id}] ${label}${detail ? '  (' + detail + ')' : ''}`);
}

// B5 — the cold extreme is floored at absolute zero. A large swing on a hot,
// high-tilt airless body used to drive surfaceTempMinK negative (unphysical,
// and it feeds surfaceIceCover as T_pole).
{
  const neg = bodies.filter(b => b.surfaceTempMinK != null && b.surfaceTempMinK < 0);
  invariant('B5', 'no body has surfaceTempMinK < 0 K', neg.length === 0,
    neg.length ? `${neg.length} negative, e.g. ${neg.slice(0, 3).map(b => `${b.id}:${b.surfaceTempMinK}`).join(', ')}`
               : `${bodies.length} bodies checked`);
}

// B2 — the accretion-efficiency priors aren't degenerate. A log-truncated
// draw with mean pinned at (or above) max clamps roughly half its mass to the
// ceiling, collapsing the intended mass variety. Guard: min < mean < max.
{
  const bad = [];
  for (const zone of ['inner', 'outer']) {
    const s = ACCRETION_EFFICIENCY[zone];
    if (!s || !(s.min < s.mean && s.mean < s.max)) {
      bad.push(`${zone}={mean:${s?.mean}, min:${s?.min}, max:${s?.max}}`);
    }
  }
  invariant('B2', 'ACCRETION_EFFICIENCY not ceiling-pinned (min < mean < max)', bad.length === 0,
    bad.length ? bad.join(' ') : 'inner + outer well-formed');
}

// B3/B4 — the subsurface_aqueous archetype actually fires. Both of its drivers
// were starved (bulk_water read the volatile fraction; the radiogenic term ran
// read-before-write and was structurally 0), zeroing the Europa/Enceladus
// biosphere. Tripwire: a healthy population fires AND at least one is purely
// radiogenic-driven (negligible tidal heating, real resRadioactives) — the
// exact case B4 resurrected.
{
  const fire = bodies.filter(b => b.bioticSubsurfaceAqueous > 0);
  const radiogenic = fire.filter(b => (b.eccentricity ?? 0) < 0.02 && (b.resRadioactives ?? 0) > 0);
  invariant('B3/B4', 'subsurface_aqueous fires, incl. radiogenic-driven cases',
    fire.length > 50 && radiogenic.length > 0,
    `${fire.length} fire, ${radiogenic.length} radiogenic-driven`);
}

// B1 — procgen never emits more real cloud decks than the renderer can hold.
// The disc palette prepends a synthetic base deck on no-surface bodies and
// trims the lowest real deck to fit MAX_CLOUD_LAYERS; that trim relies on
// procgen itself staying within budget. cloudDecksFor has no explicit cap (it
// emits one deck per condensing species), so this enforces the otherwise-
// emergent procgen→renderer contract. CLOUD_DECK_BUDGET mirrors
// MAX_CLOUD_LAYERS in src/scene/materials/planet.ts (not importable from a
// .mjs); keep the two in sync.
{
  const CLOUD_DECK_BUDGET = 4;
  const over = bodies.filter(b => Array.isArray(b.cloudLayers) && b.cloudLayers.length > CLOUD_DECK_BUDGET);
  const maxObserved = bodies.reduce((m, b) => Array.isArray(b.cloudLayers) ? Math.max(m, b.cloudLayers.length) : m, 0);
  invariant('B1', `no body emits > CLOUD_DECK_BUDGET (${CLOUD_DECK_BUDGET}) real cloud decks`, over.length === 0,
    over.length ? `${over.length} over budget, e.g. ${over.slice(0, 3).map(b => `${b.id}:${b.cloudLayers.length}`).join(', ')}`
                : `max observed ${maxObserved}`);
}

// R-series — resource-distribution gameplay schemes (S1–S6, see plans/
// resource-distribution-gameplay-plan.md). Each guards one scheme's
// load-bearing property so a knob retune in procgen-priors.mjs that
// accidentally collapses it (a flatten, a dropped tail, a reverted bias) fails
// the build instead of silently shipping. All ride the §9c `resBodies`
// population + helpers.

// R1 — the probabilistic-not-threshold guarantee: affinity (S4) shapes which
// pairs co-occur via multipliers, never gates, so every one of the 15 pairs
// must still be reachable. A zero would mean someone introduced a hard gate.
invariant('R1', 'all 15 resource pairs co-occur (planets + moons)', presentPairs === 15,
  presentPairs === 15 ? `15/15 present, min pair count ${minPair}` : `only ${presentPairs}/15 present`);

// R2 — scarcity tiers (S3) hold: every bulk resource is more common than every
// strategic / exotic one. Catches a re-flatten (all ~33%) or a strategic/exotic
// base set too high. Loose by design — protects the tier ordering, not exact %.
{
  const bulk = RESOURCE_TIER.bulk.map(k => resPresence[k] / resBodies.length);
  const rest = [...RESOURCE_TIER.strategic, ...RESOURCE_TIER.exotic].map(k => resPresence[k] / resBodies.length);
  const minBulk = Math.min(...bulk), maxRest = Math.max(...rest);
  invariant('R2', 'scarcity tiers hold (every bulk resource > every strategic/exotic)', minBulk > maxRest,
    `min bulk ${(minBulk * 100).toFixed(0)}% vs max non-bulk ${(maxRest * 100).toFixed(0)}%`);
}

// R3 — bimodal abundance (S2): a motherlode tail exists AND most deposits stay
// modest. Catches both reversions — tail removed (5★ vanishes) and the old
// everything-rich state (median grade climbs back toward 8).
{
  const star5Rate = allGrades.length ? star5 / allGrades.length : 0;
  invariant('R3', 'abundance bimodal (motherlode tail present, most deposits modest)',
    star5Rate >= 0.02 && star5Rate <= 0.18 && medianGrade <= 6,
    `5★ rate ${(star5Rate * 100).toFixed(1)}% (want 2–18%), median grade ${medianGrade} (want ≤6)`);
}

// R4 — star-type bias (S1) is live. Bulk bases make metals (6) intrinsically
// more common than volatiles (3.5); only the M-dwarf class lean (volatile ×1.4,
// metal ×0.8) flips that. So "M-dwarf worlds lean volatile over metal" is a
// sharp tripwire for the bias table reverting to neutral.
{
  const m = resByHostClass['M'] || [];
  const mVol = m.filter(b => (b.resVolatiles ?? 0) > 0).length;
  const mMet = m.filter(b => (b.resMetals ?? 0) > 0).length;
  invariant('R4', 'star-type bias present (M-dwarf worlds lean volatile over metal)',
    m.length > 100 && mVol > mMet, `M-dwarf vol ${mVol} vs met ${mMet} (n=${m.length})`);
}

// R5 — value-tied-to-hostility (S5): the richest deposits concentrate on
// hard-to-exploit worlds. Hostile worlds' motherlode rate must clear benign by
// a clear margin; equalization means MOTHERLODE_HOSTILITY reverted to neutral.
invariant('R5', 'motherlodes concentrate on hostile worlds (hostile rate > benign × 1.3)',
  hs.n > 100 && bs.n > 100 && hs.rate > bs.rate * 1.3,
  `hostile ${(hs.rate * 100).toFixed(1)}% (n=${hs.n}) vs benign ${(bs.rate * 100).toFixed(1)}% (n=${bs.n})`);

// R6 — keystone worlds (S6) exist as a minority. Zero means DEPOSIT_COUNT_DIST
// collapsed to always-two; too high means it's no longer a rare standout.
{
  const multiRate = resBodies.length ? multiDep / resBodies.length : 0;
  invariant('R6', 'keystone (≥3-deposit) worlds present as a minority (2–25%)',
    multiRate >= 0.02 && multiRate <= 0.25, `multi-deposit ${(multiRate * 100).toFixed(1)}%`);
}

// R7 — rings carry a SINGLE resource (S7). A ring is one smeared disrupted
// body, so every procgen ring must have exactly one nonzero deposit. Curated
// rings (Sol's Saturn) are CSV-authored full grids and excluded.
{
  const procRings = bodies.filter(b => b.kind === 'ring' && b.source === 'procgen');
  const bad = procRings.filter(r => RESOURCE_KEYS.filter(k => (r[k] ?? 0) > 0).length !== 1);
  invariant('R7', 'procgen rings carry exactly one resource', bad.length === 0,
    bad.length ? `${bad.length} rings with ≠1 deposit, e.g. ${bad[0].id}` : `${procRings.length} procgen rings checked`);
}

// R8 — differentiation (S7) produces both prize archetypes. Belts: an M-type
// minority (metals + a strategic) must exist. Rings: the shredded-moon path is
// the ONLY route to ring rare-earths/radioactives, so at least one such ring
// must appear — and the pristine default must still dominate (most rings carry
// no strategic). Catches both a reverted differentiation gate and an
// over-cranked one.
{
  const procBelts = bodies.filter(b => b.kind === 'belt' && b.source === 'procgen');
  const mType = procBelts.filter(b =>
    (b.resMetals ?? 0) > 0 && ((b.resRareEarths ?? 0) > 0 || (b.resRadioactives ?? 0) > 0));
  const mRate = procBelts.length ? mType.length / procBelts.length : 0;
  const procRings = bodies.filter(b => b.kind === 'ring' && b.source === 'procgen');
  const stratRings = procRings.filter(r => (r.resRareEarths ?? 0) > 0 || (r.resRadioactives ?? 0) > 0);
  const stratRingRate = procRings.length ? stratRings.length / procRings.length : 0;
  invariant('R8', 'differentiation yields M-type belts + scarce strategic rings',
    mRate >= 0.05 && mRate <= 0.40 && stratRings.length > 0 && stratRingRate <= 0.25,
    `M-type belts ${(mRate * 100).toFixed(1)}%, strategic rings ${stratRings.length} (${(stratRingRate * 100).toFixed(1)}%)`);
}

// S-series — surface-liquid solvent distribution. Procgen paints liquids by
// composition (temp/pressure/ice), and worldClass became display-only. These
// gates pin the SHAPE of that distribution so a tuning pass can't silently
// collapse it (water everywhere, or an exotic ballooning) and can't quietly
// re-introduce a worldClass read in the generator.

// S1 — water is the default solvent of the liquid-bearing population: the
// single most common species (plurality) AND a meaningful share of it. The
// share floor is 25%, not a majority: the exotic-frequency tune deliberately
// made non-water seas common enough to encounter, so water leads the field
// (~32%, next ~24%) without holding a majority. The plurality clause is the
// real guarantee; the floor just catches water collapsing toward the pack.
{
  const liq = bodies.filter(b => b.surfaceLiquidSpecies != null);
  const counts = {};
  for (const b of liq) counts[b.surfaceLiquidSpecies] = (counts[b.surfaceLiquidSpecies] ?? 0) + 1;
  const water = counts.water ?? 0;
  const maxOther = Math.max(0, ...Object.entries(counts).filter(([k]) => k !== 'water').map(([, v]) => v));
  const frac = liq.length ? water / liq.length : 0;
  invariant('S1', 'water leads the liquid-bearing population (plurality, ≥25%)',
    water > maxOther && frac >= 0.25,
    `water ${water}/${liq.length} (${pct(water, liq.length)}), next ${maxOther}`);
}

// S2 — exotic solvents stay an encounterable minority, never a bloom. The
// design target is "a player sees one sometimes," not "everywhere": each of
// hydrocarbon / nitrogen / sulfur < 4% of surface-bearing bodies. Water
// staying the most common is guarded by S1, so this only has to catch a
// runaway — the pre-tune over-saturation put sulfur/nitrogen at ~5.4%, which
// this trips, while leaving headroom for the deliberately-visible frequency.
{
  const surf = bodies.filter(b => b.surfaceLiquidFraction != null);
  const speciesCount = (s) => bodies.filter(b => b.surfaceLiquidSpecies === s).length;
  const hc = speciesCount('hydrocarbon');
  const ni = speciesCount('nitrogen');
  const su = speciesCount('sulfur');
  const cap = 0.04 * surf.length;
  invariant('S2', 'exotic solvents an encounterable minority (<4% of surface-bearers each)',
    hc < cap && ni < cap && su < cap,
    `hc ${hc} (${pct(hc, surf.length)}), n2 ${ni} (${pct(ni, surf.length)}), s ${su} (${pct(su, surf.length)}); cap≈${Math.floor(cap)}`);
}

// S3 — reachability: probabilistic shaping must never zero a species. Mirrors
// R1's "all pairs co-occur" philosophy — every exotic + ammonia_water keeps ≥1
// body so a knob retune can't make one extinct.
{
  const c = (s) => bodies.filter(b => b.surfaceLiquidSpecies === s).length;
  const hc = c('hydrocarbon'), ni = c('nitrogen'), su = c('sulfur'), aw = c('ammonia_water');
  invariant('S3', 'every exotic solvent + ammonia_water still reachable (≥1 each)',
    hc >= 1 && ni >= 1 && su >= 1 && aw >= 1,
    `hydrocarbon ${hc}, nitrogen ${ni}, sulfur ${su}, ammonia_water ${aw}`);
}

// S6 — the non-water gradient stays physically plausible. The exoplanet
// reasoning: liquid N2 is a 14 K knife-edge (most cold worlds freeze it solid)
// and surface sulfur seas need rare sulfur-enrichment + heat, so nitrogen and
// sulfur are the EXOTIC TAIL — they must stay rarer than the "uncommon middle"
// solvents (ammonia-water's wide cold-brine window, Titan-class hydrocarbon).
// Guards against the cover model re-inflating N2/SO2 worlds off their common
// atmospheres (which once made nitrogen/sulfur the most common non-water seas
// — backwards). Robust to ammonia⇄hydrocarbon swapping; only the tail ordering
// is asserted.
{
  const c = (s) => bodies.filter(b => b.surfaceLiquidSpecies === s).length;
  const aw = c('ammonia_water'), hc = c('hydrocarbon'), ni = c('nitrogen'), su = c('sulfur');
  const tailFloor = Math.min(aw, hc);
  invariant('S6', 'exotic tail (nitrogen, sulfur) rarer than the uncommon middle (ammonia, hydrocarbon)',
    ni < tailFloor && su < tailFloor && su <= ni,
    `ammonia_water ${aw}, hydrocarbon ${hc} | nitrogen ${ni}, sulfur ${su}`);
}

// S4 — subsurface oceans are a cold-icy-body phenomenon (Europa/Enceladus).
// A strong majority of ocean-bearers must be cold (< 260 K) with substantial
// ice (≥ 0.3). Catches a regression that strews oceans onto warm/dry bodies.
{
  const ocean = bodies.filter(b => b.subsurfaceOceanSpecies != null);
  const cold = ocean.filter(b => (b.avgSurfaceTempK ?? Infinity) < 260 && (b.iceFraction ?? 0) >= 0.3);
  const frac = ocean.length ? cold.length / ocean.length : 0;
  invariant('S4', 'subsurface oceans cluster on cold icy bodies (≥70% < 260K & ice ≥0.3)',
    frac >= 0.70,
    `${cold.length}/${ocean.length} qualify (${pct(cold.length, ocean.length)})`);
}

// S5 — `worldClass` is fully eliminated: no body carries a stored category.
// The body archetype is derived on demand from physics (classifyBody); a
// stored `worldClass` key reappearing means someone re-introduced the field
// in the data model or a procgen write. Asserts the catalog itself is clean.
{
  const stored = bodies.filter(b => 'worldClass' in b).length;
  invariant('S5', 'no body carries a stored worldClass key (eliminated; archetype is runtime-derived)',
    stored === 0,
    `${stored} bodies with a worldClass key (of ${bodies.length})`);
}

// S7 — chthonian (stripped hot-Jupiter cores) exist. They were silently 0
// (the lava check, T≥1000, preempted the chthonian signature); now classified
// ahead of lava. Rare by nature, but the catalog's hot dense super-Earths
// (55 Cnc e class) anchor a stable floor — a regression to 0 means the
// ordering or the gate broke again.
{
  const chth = bodies.filter(b => classifyBody(b) === 'chthonian').length;
  invariant('S7', 'chthonian worlds exist (stripped hot-Jupiter cores; rare but non-zero)',
    chth >= 1,
    `${chth} chthonian`);
}

console.log();
if (invariantFailures.length > 0) {
  process.stderr.write(`audit-procgen: ${invariantFailures.length} structural invariant(s) FAILED:\n`);
  for (const f of invariantFailures) process.stderr.write('  - ' + f + '\n');
  process.exit(1);
}
console.log('Structural invariants: all passed.');
