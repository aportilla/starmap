// FNV-1a + mulberry32 — shared seeded PRNG helpers, the single source of the
// deterministic seeding used across the build and the runtime. procgen and the
// other build scripts import them here to derive per-body seeds from id
// strings; the browser bundle re-exports hash32 / mulberry32 through
// src/scene/system-diagram/geom/prng.ts (typed by prng.d.mts) so the moon /
// belt / ring layouts the diagram rolls match the seeds baked into
// catalog.generated.json by construction. This file is plain JS so the Node
// build can run it without a TS toolchain; that's why the runtime reaches in
// here rather than the two forking. sampleNormal / sampleTruncated and the
// other samplers below are build-time only and have no runtime consumer.

export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// One instance per consumer so draws stay isolated — a shared global PRNG
// would couple every belt's chunk layout to every other belt's draw count,
// breaking determinism under any reordering.
export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller normal sample. Returns one variate per call; the second
// variate is discarded — cheap enough for build-time use.
export function sampleNormal(prng, mean, sd) {
  let u1 = prng(); if (u1 < 1e-9) u1 = 1e-9;
  const u2 = prng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

// Sample N(mean, sd), clamp to [min, max]. Optionally round to integer.
export function sampleTruncated(prng, spec, round = false) {
  const v = sampleNormal(prng, spec.mean, spec.sd);
  const clamped = Math.max(spec.min, Math.min(spec.max, v));
  return round ? Math.round(clamped) : clamped;
}

// Sample log-normal in natural log space, interpreting `spec.mean` as
// the median (geometric mean) and `spec.sd / spec.mean` as the log-space
// stdev. Clamps the linear-space result to [min, max]. Use for priors
// whose realistic distribution is heavy-tailed in linear space (envelope
// mass ratio is the canonical case — linear truncated normal under-
// produces the super-Jupiter tail because the upper half of the
// distribution gets compressed into [mean, max] in linear space rather
// than spreading across [mean, max] in log space). Spec flag `log: true`
// is the convention for marking a prior as log-distributed.
export function sampleLogTruncated(prng, spec, round = false) {
  const logMean = Math.log(spec.mean);
  const logSd = spec.sd / spec.mean;
  const v = Math.exp(sampleNormal(prng, logMean, logSd));
  const clamped = Math.max(spec.min, Math.min(spec.max, v));
  return round ? Math.round(clamped) : clamped;
}

// Dispatch by `spec.log`: log-normal if truthy, otherwise linear
// truncated normal. Lets a prior spec flag itself as log-distributed
// without forcing every caller to branch.
export function samplePhysical(prng, spec, round = false) {
  return spec.log
    ? sampleLogTruncated(prng, spec, round)
    : sampleTruncated(prng, spec, round);
}

// Sample from a mixture of truncated normals. `spec` is an object mapping
// mode names to `{ mean, sd, min, max, weight }`. Weights need not sum to
// 1 — the sampler normalizes. Used for priors whose true distribution is
// bimodal (e.g. eccentricity: settled multi-planet systems vs. scattered
// outliers — a single normal can't fit both).
export function sampleMixture(prng, spec) {
  const modes = Object.values(spec);
  let totalWeight = 0;
  for (const m of modes) totalWeight += m.weight;
  let r = prng() * totalWeight;
  for (const m of modes) {
    r -= m.weight;
    if (r <= 0) return sampleTruncated(prng, m);
  }
  return sampleTruncated(prng, modes[modes.length - 1]);
}

// Binomial(n, p) — independent Bernoulli trials. Returns an integer in
// [0, n] with mean np and variance np(1-p). Used for discrete counts
// with a hard cap where a Poisson tail would either fail to fire or pile
// up at the clamp: binomial's natural bound at n produces a smooth
// distribution across the full 0..n range. n stays small (<10) in our
// uses so the trivial linear-time draw is fine.
export function sampleBinomial(prng, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  let k = 0;
  for (let i = 0; i < n; i++) if (prng() < p) k += 1;
  return k;
}

// Pick `n` distinct items from `items` weighted by `weightMap[item]`,
// drawing sequentially from one PRNG (without replacement). Items with
// weight ≤ 0 are excluded.
export function weightedPickN(prng, items, weightMap, n) {
  const pool = items
    .map((it) => ({ it, w: weightMap[it] ?? 0 }))
    .filter((e) => e.w > 0);
  const out = [];
  while (out.length < n && pool.length > 0) {
    const total = pool.reduce((s, e) => s + e.w, 0);
    let r = prng() * total;
    let idx = 0;
    while (idx < pool.length - 1 && r >= pool[idx].w) { r -= pool[idx].w; idx++; }
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}

// The shared "notable deposits" draw used by both the planet/moon resource
// model and the belt model. Given per-key occurrence `weights` and an
// `abundance` spec ({ weakMean, strongMean, sd, min, max, primaryBonus }),
// draw `count` distinct keys weighted-without-replacement and roll each an
// abundance whose mean scales with that key's normalized weight (strong
// contextual fit ⇒ richer), with `primaryBonus` added to the first (primary)
// draw. Unpicked keys are 0. `prngFor(name)` returns a seeded PRNG per draw
// stage so callers control determinism. Returns an object over all `keys`.
export function drawWeightedDeposits(keys, weights, abundance, prngFor, count = 2) {
  let maxW = 0;
  for (const k of keys) if ((weights[k] ?? 0) > maxW) maxW = weights[k] ?? 0;
  const picks = weightedPickN(prngFor('pick'), keys, weights, count);
  const grid = {};
  for (const k of keys) grid[k] = 0;
  picks.forEach((res, i) => {
    const norm = maxW > 0 ? (weights[res] ?? 0) / maxW : 0;
    const mean = abundance.weakMean
      + (abundance.strongMean - abundance.weakMean) * norm
      + (i === 0 ? abundance.primaryBonus : 0);
    grid[res] = sampleTruncated(
      prngFor(`abund_${res}`),
      { mean, sd: abundance.sd, min: abundance.min, max: abundance.max },
      true,
    );
  });
  return grid;
}
