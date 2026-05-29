// Procgen priors — the data side of the body-catalog procgen pipeline.
//
// Mostly constants plus one merge helper. The Architect (in procgen.mjs,
// planned) reads these to sample per-system architecture: how many planets
// a star is likely to host, where they sit in orbit, what mass/radius mix
// is plausible at each insolation, how many moons each planet type carries.
// The Filler reads its own (smaller) prior set; this file is the
// Architect's tuning surface.
//
// === Realistic base, gameplay tune layered on top ===
// Sections we've intentionally biased away from physical realism for
// game-feel reasons keep two blocks side-by-side:
//   - `*_REALISTIC` — scientifically anchored against published exoplanet
//     statistics (Dressing & Charbonneau 2015 for M-dwarf occurrence;
//     Petigura et al. 2018 / Hsu et al. 2019 for Kepler FGK; Wright et al.
//     2012 for hot Jupiter rate). This block is what the universe
//     actually looks like as best we can tell.
//   - `*_TUNE` — sparse overrides, mentions ONLY the fields we're
//     deliberately pushing away from realistic for gameplay reasons. The
//     header comment on each TUNE block explains the player-visible
//     effect we're after.
// `mergeTunes()` deep-merges the two and that's what gets exported.
// Reverting a section to pure realism is a one-block deletion.
//
// Sections without a `*_TUNE` peer are exported directly as realistic —
// either we're satisfied with the calibration, or the field isn't yet
// known to need a thumb on the scale. Add the realistic/tune split when
// you start to push a section away from reality.
//
// === Bias assumption ===
// The catalog is treated as dramatically incomplete for every star. The
// Architect samples toward these target counts regardless of how many
// catalog rows already exist on a star, then anchors catalog rows into
// their slots and fills the rest. So PLANET_COUNT_BY_CLASS reflects
// expected TOTAL bodies (catalog + procgen), not just procgen extras.
//
// === Sampling conventions ===
// `{ mean, sd, min, max }` blocks describe a truncated normal:
// sample N(mean, sd), clamp to [min, max]. Round to integer where the
// field is a count. Where a log-normal is more physically accurate
// (orbital spacing ratios, planet mass), the comment calls it out and the
// Architect's sampler is expected to log-transform.
//
// === Versioning ===
// PROCGEN_VERSION is the seed-suffix hook. The Filler/Architect mix it
// into every PRNG seed; bumping it reseeds the entire galaxy without
// touching CSV ids. Per-generator version suffixes are layered on top.

import { sampleLogTruncated } from './prng.mjs';

// Deep merge a sparse `tune` over `base`. Plain objects are merged
// recursively (so a tune entry can override a single nested field without
// restating its siblings); everything else — primitives, arrays — is
// replaced wholesale. Use a named record (not an array) if you need
// partial overrides on what would otherwise be an ordered list.
function mergeTunes(base, tune) {
  const out = {};
  for (const key of Object.keys(base)) {
    const b = base[key];
    const t = tune[key];
    if (t === undefined) { out[key] = b; continue; }
    const bothObj = typeof b === 'object' && b !== null && !Array.isArray(b)
                 && typeof t === 'object' && t !== null && !Array.isArray(t);
    out[key] = bothObj ? mergeTunes(b, t) : t;
  }
  for (const key of Object.keys(tune)) {
    if (!(key in base)) out[key] = tune[key];
  }
  return out;
}

export const STELLAR_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'WD', 'BD'];

// ---------------------------------------------------------------------------
// System-level architecture
// ---------------------------------------------------------------------------

// Total expected planet count per stellar class (catalog + procgen,
// after bias correction).
//
// G mean=6 lands close to Sol (8 planets) while allowing room for systems
// with fewer detectable bodies. M mean=4 reflects TRAPPIST-1's 7 and the
// many M dwarfs with 2–3 detected; bias-corrected total around 4 is the
// Dressing & Charbonneau estimate. WD low because most planets are
// ejected or destroyed during the post-main-sequence phase; survivors are
// rare but documented.
// Per-companion planet-count suppression multiplier. Companions in tight
// stellar binaries have narrow stability windows for S-type (single-star
// circumstellar) planets, and most planetesimals get scattered out of the
// system during formation. Wang et al. 2014 and Kraus et al. 2016 measured
// ~50% planet-occurrence suppression for stellar companions inside ~50 AU,
// stronger for tighter pairs. Our cluster builder doesn't carry per-pair
// AU separation (it works in light-year space), so we use rank-in-cluster
// as a proxy: cluster members are dominantly co-located within ~50 AU
// once they share a sub-light-year position, so the suppression applies.
// Wide-separation companions (Proxima Cen ~13,000 AU from α Cen AB) would
// be exempt in reality but we don't distinguish them yet — accepted v1
// scope, may revisit with a sampled-separation lookup later.
//
// Primary = heaviest member (`cluster.members[0]`) — always 1.0, unchanged
// from independent-roll behavior. Secondary = 2nd-heaviest. Tertiary+ =
// anything past that. Singleton-cluster stars are 'primary' by default →
// no behavior change for ~82% of the catalog.
//
// Anchors: α Cen AB (G+K, ~11-36 AU binary) has zero confirmed planets
// despite extensive search; the 0.3 secondary rate produces a low but
// non-zero expected count that reads as "barren but not impossible."
// Kraus 2016's binary-suppression curve at <50 AU sits near 0.3-0.5.
export const COMPANION_PLANET_SUPPRESSION = {
  primary:       1.0,
  secondary:     0.3,
  tertiary_plus: 0.2,
};

const PLANET_COUNT_BY_CLASS_REALISTIC = {
  O:  { mean: 2,   sd: 1.5, min: 0, max: 5  },  // massive, short-lived; observation-limited
  B:  { mean: 2,   sd: 1.5, min: 0, max: 5  },
  A:  { mean: 4,   sd: 2,   min: 0, max: 8  },
  F:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  G:  { mean: 6,   sd: 2,   min: 1, max: 12 },  // Sol = 8
  K:  { mean: 5,   sd: 2,   min: 1, max: 10 },
  M:  { mean: 4,   sd: 1.5, min: 1, max: 8  },  // TRAPPIST-1 = 7, compact common
  // WD: post-main-sequence ejection + tidal disruption destroys most
  // primary-formation planets, but theory + accumulating discoveries
  // support survivor populations the literature only partially samples:
  // chthonian cores (envelope-stripped giants), iron-rich red-giant
  // survivors, and second-generation rocks formed from accretion-disk
  // material. 0.6 mean produces a system that usually has a husk world
  // or two without contradicting the rarity of detection.
  WD: { mean: 0.6, sd: 0.5, min: 0, max: 2  },
  BD: { mean: 1,   sd: 1,   min: 0, max: 4  },  // compact, tight orbits when present
};

// Gameplay tune: pull system planet counts into the 0..8 range the
// system-diagram dome can lay out without crowding. Lowered means (not
// just `max` clamps) so the post-prune distribution lands organically
// across 0..8 instead of piling at the cap. The Architect walks the
// full realistic orbital extent under the spacing prior above, then
// uniformly-randomly prunes to K (sampled from this distribution). The
// random part is load-bearing: trimming outer planets would
// systematically remove gas giants (they form past the snow line),
// trimming small planets would systematically remove terrestrials, and
// either bias would shift the galaxy-wide body-type frequency away
// from what physics produces. Random preserves the type distribution
// exactly; only absolute count drops.
//
// Sol's 8 planets sit at the upper tail of G's distribution (+2σ
// against mean=4, sd=2) — Sol is curated so its CSV is authoritative
// regardless. M dwarfs unchanged; their realistic block already lands
// in range.
const PLANET_COUNT_BY_CLASS_TUNE = {
  F: { mean: 4,   sd: 2,   max: 8 },
  G: { mean: 4,   sd: 2,   max: 8 },
  K: { mean: 3.5, sd: 2,   max: 8 },
};

export const PLANET_COUNT_BY_CLASS = mergeTunes(
  PLANET_COUNT_BY_CLASS_REALISTIC,
  PLANET_COUNT_BY_CLASS_TUNE,
);

// Gameplay tune: cap the *sum* of planets across all members of a
// multi-star cluster, since gameplay presents a cluster as one system.
// No realistic peer — physical planet formation has no cluster-level
// budget; each star's count is independent (modulated by the realistic
// COMPANION_PLANET_SUPPRESSION above for binary-stability effects).
//
// Allocation is primary-first: the heaviest member (cluster.members[0])
// rolls under the per-star clamp as usual, the secondary's clamp tightens
// to whatever budget remains, then tertiary+. Singleton clusters (~82% of
// the catalog) see no change — their budget equals the per-star clamp.
export const MAX_PLANETS_PER_CLUSTER = 8;

// Inner/outer orbital bounds (AU) per stellar class.
//
// Inner edge: thermal-survival limit — closer than this and the body
// either tidally disrupts or vaporizes on geologically relevant
// timescales. Scales with stellar luminosity (∝ √L roughly).
//
// Outer edge: practical cutoff for what the game cares about. Real
// systems extend further (Oort cloud, scattered disc) but bodies past
// the gas-giant zone matter less for 4X gameplay.
//
// spacingRatio: period ratio between consecutive planets (P_n+1 / P_n).
// Sampled log-normal: exp(N(log(mean), sd)). AU ratio = period_ratio^(2/3).
// Kepler multi-transit detection is biased toward tightly-spaced
// near-coplanar systems, so the literature's median-of-detected ~1.9
// understates the true population: Sol's average adjacent period ratio
// across observed planets is 2.6 (excluding the Mars→Jupiter asteroid
// gap; 3.1 with). FGK values here sit closer to Sol's pattern under the
// bias-correction principle that drives every other prior in this file
// — what the universe actually contains, not what Kepler can detect.
// M dwarfs stay tight (TRAPPIST-1's adjacent ratios cluster around
// 1.4–1.6, and near-coplanar tight packing is dynamically favored at
// low stellar mass), so the bias-correction lift applies to FGK only.
// SD is in log space; widened slightly on FGK so a few systems realize
// Sol-like wide gaps while others stay near the median. Inner edges
// raised on FGK: previous 0.03–0.05 AU values were Kepler-USP-anchored
// (rare hot-tail floor, ~1–5% of detected innermost), not the
// bias-corrected typical innermost (~0.1 AU for FGK multis after
// accounting for the long-period detection cliff). With the orbital
// walk starting at the typical-not-floor value, the 8-planet budget
// can reach the snow line and gas giants can form.
const ORBITAL_GEOMETRY_BY_CLASS_REALISTIC = {
  O:  { innerEdgeAu: 0.5,   outerEdgeAu: 80, spacingRatio: { mean: 1.9, sd: 0.3 } },
  B:  { innerEdgeAu: 0.3,   outerEdgeAu: 70, spacingRatio: { mean: 1.9, sd: 0.3 } },
  A:  { innerEdgeAu: 0.10,  outerEdgeAu: 60, spacingRatio: { mean: 2.4, sd: 0.4 } },
  F:  { innerEdgeAu: 0.08,  outerEdgeAu: 50, spacingRatio: { mean: 2.5, sd: 0.4 } },
  G:  { innerEdgeAu: 0.06,  outerEdgeAu: 40, spacingRatio: { mean: 2.5, sd: 0.4 } },
  K:  { innerEdgeAu: 0.05,  outerEdgeAu: 30, spacingRatio: { mean: 2.3, sd: 0.4 } },
  M:  { innerEdgeAu: 0.008, outerEdgeAu: 8,  spacingRatio: { mean: 1.6, sd: 0.3 } },
  WD: { innerEdgeAu: 0.005, outerEdgeAu: 5,  spacingRatio: { mean: 1.7, sd: 0.4 } },
  BD: { innerEdgeAu: 0.001, outerEdgeAu: 0.5, spacingRatio: { mean: 1.4, sd: 0.3 } },
};

// Gameplay tune: push the M-dwarf inner edge outward. M dwarfs are ~60%
// of the catalog and a 0.008 AU inner edge lets their tight spacing pack
// 3–4 planets all inside S>1.5 before reaching anywhere interesting —
// which is why 87.6% of all terrestrials end up hot-zone and 35% of
// procgen planets are `desert`. 0.02 AU is still inside Mercury-equivalent
// insolation around an M dwarf, but lets the spacing walk reach the
// temperate band more often, surfacing more habitable-zone worlds.
const ORBITAL_GEOMETRY_BY_CLASS_TUNE = {
  M: { innerEdgeAu: 0.02 },
};

export const ORBITAL_GEOMETRY_BY_CLASS = mergeTunes(
  ORBITAL_GEOMETRY_BY_CLASS_REALISTIC,
  ORBITAL_GEOMETRY_BY_CLASS_TUNE,
);

// ---------------------------------------------------------------------------
// Per-planet sampling
// ---------------------------------------------------------------------------

// Log-scatter (multiplicative) on the Otegi mass-radius relation. A
// single value because the continuous pipeline already produces mass
// variety from accretion-efficiency + envelope-ratio rolls; the radius
// scatter only needs to capture residual composition noise at fixed
// mass (water-vs-iron-vs-silicate, envelope contraction state). Real
// exoplanet scatter at fixed mass runs ~0.10–0.15 dex.
export const RADIUS_SCATTER_LOG = 0.10;

// Moon count is sampled as Binomial(MOON_COUNT_MAX, p), where the
// per-trial success probability `p` is a saturating function of the
// host's Hill radius. Binomial (vs the older Poisson + clip) is
// naturally bounded at MOON_COUNT_MAX so the distribution shape is
// smooth across the full 0..MAX range without piling up at the cap —
// that pile-up is what an unbounded-λ Poisson + clamp produces and what
// these constants are calibrated to avoid.
//
// p = min(MOON_PROBABILITY_CAP, hillAu × MOON_PROBABILITY_PER_HILL)
//
// Sol-anchored means at PER_HILL=2.3, CAP=0.60 (mean = MAX × p):
//   Mercury (R_H ≈ 0.0015 AU): p ≈ 0.003 → mean 0.02 (Mercury: 0)
//   Earth   (R_H ≈ 0.010  AU): p ≈ 0.023 → mean 0.11 (Earth: 1)
//   Mars    (R_H ≈ 0.007  AU): p ≈ 0.016 → mean 0.08 (Mars: 2 small)
//   Jupiter (R_H ≈ 0.354  AU): p ≈ 0.60  → mean 3.00 (Jupiter: 4 Galileans, on the high end here)
//   Saturn  (R_H ≈ 0.434  AU): p ≈ 0.60  → mean 3.00
//   Uranus  (R_H ≈ 0.469  AU): p ≈ 0.60  → mean 3.00 (now curated to top 3)
//   Neptune (R_H ≈ 0.771  AU): p ≈ 0.60  → mean 3.00
//   Hot Jupiter at 0.05 AU (R_H ≈ 0.003): p ≈ 0.007 → mean 0.04 (stripped)
//   Warm Jupiter at 1 AU   (R_H ≈ 0.032): p ≈ 0.073 → mean 0.37 (rare moons)
//
// CAP=0.60 → binomial(5, 0.60) shape is P(0)=1%, P(1)=8%, P(2)=23%,
// P(3)=35%, P(4)=26%, P(5)=8%. Smooth peak at 3 with symmetric falloff
// and only 8% at the cap, so gas giants vary across 1-5 moons as
// designer-visible variety rather than always-saturated. The PER_HILL
// slope keeps the migration-strip behavior emergent from physics — a
// hot Jupiter's shrunk Hill sphere maps to p≈0.007, and binomial(5, 0.007)
// rolls 0 moons 96% of the time. No separate migration-strip pass needed.
export const MOON_PROBABILITY_PER_HILL = 3.0;
export const MOON_PROBABILITY_CAP      = 0.60;

// Per-planet hard upper bound on moon count — the `n` in the
// Binomial(n, p) sampler above. Setting it to 5 caps Saturn-class arcs
// at a readable size on the system-diagram rim split (no 6-to-8-moon
// arcs overlapping into illegibility) and keeps the per-cluster
// colonization decision space tractable. The realistic peer at 8
// preserves more of the gas-giant moon variety; the gameplay tune
// trades that for legibility. Combined with `MOON_PROBABILITY_CAP =
// 0.60`, the maximum mean moon count for the largest Hill spheres is
// `5 × 0.60 = 3.0`, with a smooth bell across 0..5 rather than a
// pile-up at the cap.
const MOON_COUNT_MAX_REALISTIC = 8;
const MOON_COUNT_MAX_TUNE = 5;

export const MOON_COUNT_MAX = MOON_COUNT_MAX_TUNE;

// Moon mass distribution — truncated log-normal in M⊕, sampled per moon.
// Centered on Europa-class (10⁻³ M⊕) so the bulk matches Sol; sd=1.5 in
// log space gives a tail extending to Earth-mass and beyond, capped by
// host dynamics. Lower clamp at 10⁻⁵ M⊕ (sub-Enceladus). Upper clamp at
// log10(2 M⊕) = 0.3 so super-Earths can never be moons (they'd be binary
// planets, not moons).
//
// Tail distribution under N(-3, 1.5, [-5, 0.3]):
//   ~50% below Europa (1e-3 M⊕)
//   ~14% above Ganymede (2.5e-2)
//   ~2.5% above Mars (1e-1)
//   ~0.3% above Earth (1)
// On top of this, each moon's upper bound is further capped by its
// host's mass × MOON_MAX_HOST_MASS_RATIO so a giant moon can only form
// around a giant host (Earth-mass moons need a Saturn-plus host).
// Realistic baseline: log-mean = -3 (Europa-class median), max =
// log10(2) = 0.3 (2 M⊕ ceiling so super-Earth-mass binaries don't
// emerge as moons). Sol's moons cluster around 10^-3 to 10^-2.
const MOON_MASS_LOG_EARTH_REALISTIC = { mean: -3, sd: 1.5, min: -5, max: 0.3 };

// Gameplay tune: shift log-mean to -1.8 AND widen sd to 2.0. Median
// ≈ 0.016 M⊕ (between Ganymede and Mars). The sd widening is the more
// load-bearing change — it fattens the right tail so ~25% of moons
// land above 0.1 M⊕ (Mars-class) and a meaningful minority (~10%)
// reach 0.3+ M⊕ where atm retention works. Without the tail width,
// the chain Warm-host migrator → big moon → T+P+water Endor produces
// a hard zero; with it, a scattering of Pandora-class moons emerges
// across the galaxy as a game-discoverable rarity. Heller & Pudritz
// 2015 argue exomoon habitability needs ≥0.25 M⊕, well inside the new
// right tail.
const MOON_MASS_LOG_EARTH_TUNE = { mean: -1.5, sd: 2.0 };

export const MOON_MASS_LOG_EARTH = mergeTunes(
  MOON_MASS_LOG_EARTH_REALISTIC,
  MOON_MASS_LOG_EARTH_TUNE,
);

// Circumplanetary-disk delivered water floor for moons. Real moons of
// giants form in their host's CPD, which accretes water-rich pebbles
// drifting inward from the outer protoplanetary disk independent of
// the host's local formation zone. Galilean moons formed in Jupiter's
// CPD with bulkWater ≈ 0.1–0.5, even though Jupiter's local nebular
// region wasn't uniformly that wet — the CPD acted as a pebble trap.
//
// Modeled here as a minimum bulkWater for any procgen moon:
//   bulkWater = max(formation-zone sample, MOON_CPD_WATER_FLOOR)
//
// 0.01 (1%) sits well above Earth's 2.3e-4 but well below a Galilean
// (~0.5). Specifically unlocks the Pandora-class chain: in-situ-formed
// HZ giants around hot stars (A/F-class, with HZ at 3-5 AU but inside
// the H2O frost line) have moons drawn from the inside_H2O zone
// (median ~1e-4, dry). The floor lifts those to 1e-2, enough for the
// surface-cover formula to produce ocean cover when T > 273 K. Stalled
// warm-Jupiter migrators are unaffected (their moons already inherit
// the H2O_to_NH3 zone's wet bulk via formationAu). Curated catalog
// moons (Luna, Europa, etc.) bypass entirely — their bulkWater comes
// from CSV.
export const MOON_CPD_WATER_FLOOR = 0.01;

// Maximum moon-to-host mass ratio for stable orbital dynamics.
// Realistic ratio: Earth/Moon 1.2%; Pluto/Charon 12% (binary, not
// moon). The realistic 3% cap is conservative — comfortably below
// binary-planet territory but binding on warm-host moons (a gas
// dwarf at 11 M⊕ caps moon mass at 0.33 M⊕, just at the Endor
// retention threshold). Lifting to 5% lets HZ-giant hosts spawn
// 0.5-Earth-mass moons without crossing into binary dynamics
// (Heller-Pudritz exomoon stability bounds allow up to 8-10%
// before tidal disruption becomes the dominant outcome).
const MOON_MAX_HOST_MASS_RATIO_REALISTIC = 0.03;
const MOON_MAX_HOST_MASS_RATIO_TUNE = 0.05;
export const MOON_MAX_HOST_MASS_RATIO = MOON_MAX_HOST_MASS_RATIO_TUNE;

// ---------------------------------------------------------------------------
// Disk physics — protoplanetary-disk parameters for the continuous mass
// pipeline. Helpers in astrophysics.mjs (frostLineS, frostLineAU,
// solidSurfaceDensity, isolationMass) consume these. No callers yet — the
// architect wires up in Phase B; this is the tuning surface.
// ---------------------------------------------------------------------------

// Volatile condensation temperatures in K. Each defines a snow line — the
// orbital distance past which the volatile freezes out of the disk and
// joins the solid surface density. Three matter for the catalog:
//   H2O — ~170 K: enables Galilean-type icy moons and gas-giant cores
//   NH3 — ~75 K:  Triton/Pluto-zone composition (ammonia + water mix)
//   CH4 — ~40 K:  Eris-class deep-cold (methane-dominant)
// See frostLineS(T) / frostLineAU(starMass, T) in astrophysics.mjs for the
// radiative-equilibrium conversion to insolation / AU.
export const SNOW_LINE_TEMPERATURES = { H2O: 170, NH3: 75, CH4: 40 };

// Solid surface density boost past each snow line (multiplicative). When
// a volatile freezes onto pre-existing dust grains and forms its own
// condensate, the effective Σ_solid jumps. Each boost stacks on top of
// any inner snow lines already crossed.
//
// H2O boost is well above the classical Hayashi value (~3×). The classical
// step-up captures the gas-phase-to-ice condensation alone; modern disk
// models add pebble drift concentrating mass at the snow line, which
// inflates the effective Σ jump. We use a single permanent step rather
// than a peaked profile, calibrated so isolationMass(5 AU, M_sun) crosses
// CRITICAL_CORE_MASS_EARTH and gas-giant cores can form past the H2O line.
//
// Known artifact: the classical Lissauer M_iso formula with this profile
// makes outer-disk isolation mass keep climbing (M_iso ∝ a^0.75); the
// Architect (Phase B+) should cap with an outer-disk truncation or pebble-
// drift correction. See PROCGEN-ARCHITECT-REFACTOR.md.
export const SNOW_LINE_BOOSTS = { H2O: 12.0, NH3: 1.5, CH4: 1.2 };

// Σ_solid at 1 AU around the Sun, in g/cm². Anchors the MMSN profile
// Σ(a) = NORM × M_star_sun × a_au^(-1.5). Classical Hayashi MMSN is
// ~7 g/cm² at 1 AU; modern revisions sit 1.5–10× higher. Calibrated so
// isolationMass(1 AU, M_sun) ≈ 0.05 M⊕ (Mars-mass inner-Sol anchor).
export const MMSN_NORMALIZATION = 14;

// Disk gas lifetime in Myr per stellar class. Real disks live 1–10 Myr;
// M dwarfs hold gas longer (slower UV photo-evaporation), massive stars
// disperse faster (own + neighborhood ionization). Architect samples once
// per star via sampleTruncated(prng, DISK_GAS_LIFETIME_MYR[cls]) and
// caches the value for downstream gas-envelope decisions.
export const DISK_GAS_LIFETIME_MYR = {
  O:  { mean: 1, sd: 1, min: 0.5, max: 3  },
  B:  { mean: 2, sd: 1, min: 0.5, max: 5  },
  A:  { mean: 3, sd: 1, min: 1,   max: 6  },
  F:  { mean: 3, sd: 2, min: 1,   max: 8  },
  G:  { mean: 3, sd: 2, min: 1,   max: 10 },
  K:  { mean: 4, sd: 2, min: 1,   max: 10 },
  M:  { mean: 6, sd: 3, min: 1,   max: 15 },
  WD: { mean: 3, sd: 2, min: 1,   max: 10 },
  BD: { mean: 4, sd: 2, min: 1,   max: 10 },
};

// Accretion efficiency: multiplier on isolation mass. Zoned because the
// dominant growth mechanism differs by formation zone:
//
//   inner (inside H2O frost line) — terrestrial mergers dominate.
//     Embryos are densely packed (Σ × small a means many small bodies);
//     oligarchic growth merges them into Mercury/Venus/Earth-class
//     bodies. Earth's formation is the canonical case: ~20× feeding-
//     zone mergers (Theia-class impacts). Heavy tail captures the
//     occasional super-Earth.
//   outer (past H2O frost line) — gas-envelope capture dominates, not
//     terrestrial mergers. Cores grow modestly (~M_iso × 2) but then
//     ENVELOPE_FRACTION fires when CRITICAL_CORE_MASS_EARTH is crossed
//     and the disk still has gas. Final mass comes from envelope, not
//     core mergers.
//
// Sampled via sampleLogTruncated. Sol calibration (NORM=14):
//   1 AU Sun (inner): mass median ≈ 0.75 M⊕ (Venus), tail to ~2.5 M⊕
//   5 AU Sun (outer): core median ≈ 14 M⊕ (Uranus-core), envelope
//     fires → typical total ~85 M⊕ (Saturn-class)
const ACCRETION_EFFICIENCY_REALISTIC = {
  inner: { mean: 20, sd: 10, min: 1,   max: 80, log: true },
  outer: { mean: 3,  sd: 2,  min: 0.3, max: 15, log: true },
};

// Gameplay tune: lift inner-zone accretion efficiency so M-dwarf HZ
// bodies grow toward Earth-mass rather than clustering sub-Mars. Under
// the realistic value 65% of temperate rocky bodies are < 0.1 M⊕ —
// physics-correct given M-dwarf HZ sits at tiny `a` where isolation
// mass is naturally small, but the classical Lissauer M_iso formula
// understates real-world pebble-accretion growth (which bypasses the
// isolation-mass cap entirely). Real M-dwarf planets reach 0.5-1.4 M⊕
// commonly (TRAPPIST-1's seven planets span 0.33-1.37). Lifting inner
// mean 20→35 pushes the temperate-mass distribution toward the
// observed M-dwarf range without modeling pebble accretion explicitly.
const ACCRETION_EFFICIENCY_TUNE = {
  inner: { mean: 80 },
};

export const ACCRETION_EFFICIENCY = mergeTunes(
  ACCRETION_EFFICIENCY_REALISTIC,
  ACCRETION_EFFICIENCY_TUNE,
);

// Core mass above which gas accretion can run away (assuming the disk
// still has gas). Below the critical mass, envelope contraction is too
// slow to capture significant gas before disk dispersal. Setting too
// low overproduces gas giants; too high underproduces them.
export const CRITICAL_CORE_MASS_EARTH = 10;

// Envelope mass as a ratio to core mass once runaway accretion fires.
// Median envelope ratio matches Solar System cold giants:
//   Uranus: ratio ~0.5    (~10 M⊕ core, ~4.5 M⊕ envelope)
//   Neptune: ratio ~0.7
//   Saturn: ratio ~8.5    (~10 M⊕ core, ~85 M⊕ envelope)
//   Jupiter: ratio ~31    (~10 M⊕ core, ~310 M⊕ envelope)
// Log-normal with median ~5 captures the Neptune-Saturn middle as
// typical, with Jupiter-class and super-Jupiters in the tail. Max
// caps at 50× to stay well below the brown-dwarf threshold (13 M_jup
// ≈ 4100 M⊕); a 35-M⊕ core hits ~1750 M⊕ at the cap, ~5 M_jup.
export const ENVELOPE_FRACTION = { mean: 5, sd: 10, min: 0.3, max: 50, log: true };

// Time in Myr between critical-core-mass and runaway gas accretion. If
// the disk's gas component disperses inside this window, the body ends
// as a "failed giant" — massive bare core, no envelope (Uranus/Neptune-
// like or chthonian-precursor).
export const TIME_TO_RUNAWAY_MYR = 0.5;

// Type II disk migration: a fraction of gas giants formed past the H2O
// frost line spiral inward through the gas disk and end as hot Jupiters
// at a tiny fraction of their formation distance. Migration sweeps the
// inner system clean of original-zone planets (the architect's migration
// pass removes any companions inside the migrator's formationAu).
//
// MIGRATION_RATE: probability the system's innermost gas giant
//   migrates inward. System-level roll (not per-body) — multi-migrator
//   chains are dynamically unstable and observed hot-Jupiter systems
//   almost always have a solo migrator, so migratePass picks the
//   innermost eligible giant and rolls once. Real Kepler hot-Jupiter
//   occurrence around Sun-likes is ~1%, but our visible eligible pool
//   (Architect-only stars with a gas giant) is smaller than the
//   catalog-wide observed rate would suggest. 10% per eligible system
//   produces a noticeable but-not-dominant population of hot Jupiters
//   without cascading migration sweeping inner systems away from their
//   physics-produced body-type mix.
// MIGRATION_FRACTION: how far inward, sampled as fraction of formation
//   distance. Real hot Jupiters sit at 0.02–0.10 AU after forming at
//   3–10 AU — fractions in the 0.005–0.05 band.
// MIGRATION_MIN_MASS_EARTH: only bodies above this mass migrate. Type II
//   migration is gas-disk-driven and needs a body massive enough to open
//   a disk gap. Hot Neptune-mass migrators are real (GJ 436b at 22 M⊕,
//   GJ 1214b at ~6 M⊕) so we sit the cutoff below Neptune-mass.
// MIN_HOT_JUPITER_AU: hard floor — migrators can't end inside ~0.01 AU
//   (Roche-limit destruction territory).
export const MIGRATION_RATE = 0.20;

// Two-mode mixture: most migrators end at hot-Jupiter orbits (the
// observed Kepler population), but a minority stall mid-disk at
// warm-orbit / HZ distances. Real warm-Jupiter populations (Kepler-22b,
// HD 28185 at ~0.85–1 AU) confirm both end-states exist; the bistable
// shape lets the architect produce both without restating each as a
// separate pass.
//
// Hot-Jupiter mode (primary, 70%): observed-Kepler distribution —
//   migrators land at 0.5–8% of formation distance. A Jupiter forming
//   at 5 AU ends at 0.025–0.4 AU (Roche-floor by MIN_HOT_JUPITER_AU).
// Warm-Jupiter mode (secondary, 30%): mid-disk stall — disk gap closes
//   or photoevaporation truncates migration before the giant reaches
//   the hot-Jupiter range. Lands at 15–50% of formation distance. A
//   Jupiter forming at 5 AU stalls at 0.75–2.5 AU (warm/HZ band for
//   FGK-class hosts; HZ-edge for cool stars). Hill sphere shrinks
//   proportionally — these giants retain fewer moons than primordial
//   cold giants but more than hot Jupiters, opening a path to Pandora-
//   class habitable moons (Endor-class) which astrobiologists treat
//   as plausibly outnumbering habitable planets if HZ giants are
//   common (Heller & Pudritz 2015).
//
// Sampled via sampleMixture; the existing two-mode samplers in
// ECCENTRICITY and PRESSURE_HISTORY_MULTIPLIER use the same shape.
// Secondary's min lowered from 0.15 → 0.05 to fill the migration-end-state
// gap. The previous gap 0.08–0.15 was unreachable by either mode, but
// it's exactly where M-dwarf HZ migrations land (HZ at ~0.05–0.3 AU,
// giants forming at ~5 AU → HZ stall fraction 1–6%). Now the secondary
// mode covers 0.05–0.50, so a Jupiter formed past the M-dwarf's frost
// line can stall anywhere from M-dwarf HZ (0.25 AU) up to a Sun-like
// warm-Jupiter band (2.5 AU). Slight widening of the mean to 0.20 to
// keep the distribution roughly balanced after the lower bound shifts.
export const MIGRATION_FRACTION = {
  primary:   { mean: 0.02, sd: 0.015, min: 0.005, max: 0.08, weight: 0.60 },
  secondary: { mean: 0.20, sd: 0.12,  min: 0.05,  max: 0.50, weight: 0.40 },
};
export const MIGRATION_MIN_MASS_EARTH = 15;
export const MIN_HOT_JUPITER_AU = 0.01;

// ---------------------------------------------------------------------------
// Bulk composition (read by the Architect, persisted on the body)
// ---------------------------------------------------------------------------

// Formation-zone classifier. Bodies sample bulk composition from one of
// four buckets keyed on which snow lines they accreted past. Threaded
// the per-star frost-line trio (computed in buildStarDiskContext) rather
// than a global S threshold — M-dwarf systems have their H2O snow line
// inside 1 AU, A-stars have it past 5 AU.
//
// Inputs: formationAu (where the body accreted) and frostLinesAu
// ({ H2O, NH3, CH4 } AU). Returns one of the four zone keys below.
export function zoneForFormationAu(formationAu, frostLinesAu) {
  if (formationAu == null || frostLinesAu == null) return 'inside_H2O';
  if (formationAu < frostLinesAu.H2O) return 'inside_H2O';
  if (formationAu < frostLinesAu.NH3) return 'H2O_to_NH3';
  if (formationAu < frostLinesAu.CH4) return 'NH3_to_CH4';
  return 'past_CH4';
}

// Sample a bulk-composition mass fraction (0..1) from a zone-keyed prior.
// Classifies the body's formation zone, draws from that zone's log-normal
// spec, and rounds to the stored 5-dp precision. Shared by the Architect
// (top-down, per-slot PRNG) and the Filler (per-field PRNG for catalog
// rows) so the water / metal / volatile draws can't drift between layers —
// each caller supplies its own `prng` and the matching `BULK_*_BY_ZONE`
// table.
export function sampleBulkFraction(prng, formationAu, frostLinesAu, byZoneTable) {
  const zone = zoneForFormationAu(formationAu, frostLinesAu);
  return Number(sampleLogTruncated(prng, byZoneTable[zone]).toFixed(5));
}

// Body-mass fraction that is H₂O ice / liquid water. Architect samples
// once per body from one of four zones, then persists — bulk composition
// is a formation-time property, not a re-rollable surface scalar. The
// Filler derives surface waterFraction / iceFraction / pressure-retention
// from this attribute + temperature + pressure.
//
// Zones (formationAu vs per-star frost lines):
//   inside_H2O   — interior to H2O snow line (Mercury, Earth, Mars zone)
//   H2O_to_NH3   — past H2O, inside NH3 (Europa, Ganymede formation zone) — peak water
//   NH3_to_CH4   — past NH3, inside CH4 (Triton, Pluto zone) — water present but ammonia competes for ice budget
//   past_CH4     — past CH4 (Eris-class) — methane dominant, water lower fraction
//
// Anchors (Sol, formationAu = semiMajorAu for in-situ):
//   inside_H2O — Mercury ~0, Earth 0.00023, Mars 0.0001, Luna 1e-5
//   H2O_to_NH3 — Europa/Ganymede/Callisto/Titan ≈ 0.5, Enceladus 0.6
//   NH3_to_CH4 — Uranus/Neptune ≈ 0.1, Triton 0.5 (captured KBO)
//   past_CH4   — Pluto ~0.4 (mixed ice), Eris-class ~0.3
//
// Specs are linear-space {mean, sd, min, max} consumed by sampleLogTruncated.
export const BULK_WATER_FRACTION_BY_ZONE = {
  // Dry. Earth's 0.00023 is the upper tail — most inner-system bodies
  // are drier (Mars, Mercury, Venus). Log-uniform-ish from sub-Mercury
  // (1e-6) to a Venus-class hothouse cap (1e-3).
  inside_H2O: { mean: 1e-4, sd: 1e-4, min: 1e-6, max: 1e-3 },
  // Peak water zone — Galilean moons centered around 0.5 with a tail
  // down to Io-class dry outliers (post-tidal water loss). 0.5 is the
  // geometric cap — half the body's mass in water is the upper bound
  // short of a pure ice ball.
  H2O_to_NH3: { mean: 0.20, sd: 0.20, min: 0.01, max: 0.5 },
  // Past ammonia line — water is still present (H2O froze out at the
  // inner edge of this zone) but the ice budget is split with NH3.
  // Triton's 0.5 sits at the upper tail; typical body lands lower.
  NH3_to_CH4: { mean: 0.15, sd: 0.10, min: 0.01, max: 0.40 },
  // Past methane line — methane dominates condensables, water is the
  // minority ice. Pluto-class.
  past_CH4:   { mean: 0.08, sd: 0.08, min: 0.01, max: 0.30 },
};

// Body-mass fraction that is iron / metallic content (vs. silicate +
// volatile). Refractory metals (Fe, Ni, Al, Si) condense first in the
// proto-planetary disk so inside-H2O bodies form metal-rich; bodies
// formed past each successive snow line dilute their metal fraction
// further as more volatiles join the solid budget.
//
// Anchors (Sol):
//   Mercury 0.70 (inside_H2O, super-iron tail), Earth/Venus 0.32, Mars 0.24
//   Moon 0.03 (silicate-dominant, giant-impact-formed)
//   Galilean moons 0.10–0.20, Titan 0.10
//   Uranus/Neptune 0.20 (heavy elements in ice mantle)
//   Pluto-class 0.10 (silicate + ice + organics)
export const BULK_METAL_FRACTION_BY_ZONE = {
  // Metal-rich. Mercury 0.70 upper tail; mean ~0.30 places Earth-class.
  inside_H2O: { mean: 0.30, sd: 0.20, min: 0.02, max: 0.80 },
  // Silicate + water-ice dominant — Galilean / Titan-class differentiation.
  H2O_to_NH3: { mean: 0.12, sd: 0.10, min: 0.01, max: 0.35 },
  // Ice-rich, lower core fraction. Ice-giant mantles + KBO captures.
  NH3_to_CH4: { mean: 0.08, sd: 0.07, min: 0.01, max: 0.25 },
  // Almost pure ice + organics; tiny silicate/iron core.
  past_CH4:   { mean: 0.05, sd: 0.05, min: 0.005, max: 0.20 },
};

// Body-mass fraction that is non-water condensable volatiles — NH3, CH4,
// CO, CO2, N2, organics. Captures the inventory that water doesn't, so
// downstream atmosphere / cloud / haze / biosphere decisions can read a
// real "non-water volatile budget" rather than papering over with a
// per-body floor (cf. OUTGASSING.volatileFloor — the proxy this replaces).
//
// Each zone adds the volatiles that just condensed plus carryover from
// upstream:
//   inside_H2O — only the refractory-trapped fraction (CO2 mineralized
//     in carbonates, N2 from accretion). Venus / Earth / Mars all sit here.
//   H2O_to_NH3 — water dominates; non-water volatiles still trace (CO2/
//     organics in the ice). Jupiter's atmosphere CH4/NH3 are minor here.
//   NH3_to_CH4 — ammonia condenses, adds substantial mass. Uranus and
//     Neptune "ice" mantles are ~30-40% non-water (NH3 + CH4 + organics).
//   past_CH4 — methane condenses, becomes the dominant ice. Triton-Pluto-
//     Eris class. The driver of methane-world variety.
//
// Anchors (Sol):
//   inside_H2O — Mercury ~0.001, Earth/Venus/Mars 0.003–0.01 (mostly CO2)
//   H2O_to_NH3 — Galilean/Titan moons 0.01–0.05, Jupiter/Saturn 0.01–0.03
//   NH3_to_CH4 — Uranus/Neptune 0.25–0.35, Triton 0.10
//   past_CH4   — Pluto 0.30, Eris-class 0.25
export const BULK_VOLATILE_FRACTION_BY_ZONE = {
  inside_H2O: { mean: 0.005, sd: 0.005, min: 1e-4, max: 0.02 },
  H2O_to_NH3: { mean: 0.02,  sd: 0.02,  min: 1e-3, max: 0.10 },
  NH3_to_CH4: { mean: 0.15,  sd: 0.10,  min: 0.02, max: 0.40 },
  past_CH4:   { mean: 0.30,  sd: 0.15,  min: 0.05, max: 0.55 },
};

// ---------------------------------------------------------------------------
// World class derivation thresholds (Phase 4)
// ---------------------------------------------------------------------------
//
// `worldClass` is a pure label derived from settled physical state — it
// flows downstream of mass, radius, temperature, water/ice cover, NOT
// upstream of them. These thresholds bucket the (radius × temperature ×
// cover) state space into seven labels (rocky, ocean, desert, lava,
// gas_dwarf, ice_giant, gas_giant). Designer-dispatched tables
// (atmosphere species, biosphere, cloud / haze, resources) consume the
// label; no physical scalar does.
export const WORLD_CLASS_THRESHOLDS = {
  // ─── Radius gates (gaseous vs terrestrial) ───
  jupiterRadius:        8,     // R⊕; gas giant lower bound
  neptuneRadius:        3.5,   // Neptune-class lower bound
  gasDwarfRadius:       2,     // rocky/sub-Neptune boundary
  // Warm-vs-cold gate within the Neptune bracket. Cold → ice_giant.
  iceGiantTempCeilingK: 200,

  // ─── Sub-Neptune variant gates (hycean / helium) ───
  // Hycean: cold sub-Neptune with H2 atm and high bulkWater (K2-18b-class).
  hyceanTempCeilingK:   300,
  hyceanBulkWaterMin:   0.05,
  // Helium: gas dwarf with He-dominant atm (post-H-stripping survivor).
  // Detected by atm1 === 'He'.

  // ─── Terrestrial gates ───
  // Lava: sustained molten surface.
  lavaTempFloorK:       1000,
  // Magma ocean: hot + active tectonics (early-Earth class, partial melt).
  magmaOceanTempFloorK: 700,
  magmaOceanTectMin:    0.5,
  // Chthonian: stripped giant core — close-in + massive + metal-dominant.
  chthonianMassMin:     2.0,
  chthonianMetalMin:    0.4,
  chthonianInsolationMin: 100,
  // Iron: bulkMetal dominant (Mercury-class super-iron).
  ironMetalMin:         0.5,
  // Ice: surface ice without liquid (Callisto-class water-ice).
  // 0.7 floor so bodies with partial ice cover (seasonal caps, mixed
  // regolith-ice) stay `rocky` rather than collapsing into the ice
  // bucket. At 0.5 the bucket eats half the procgen population because
  // every body past the H2O frost line saturates iceFraction.
  iceIceMin:            0.7,
  iceWaterCeiling:      0.1,
  // Carbon: methane/volatile-frost-dominant frozen body (Pluto/Triton/
  // Eris class). Splits off from `ice` when the body's bulk inventory
  // is volatile-dominated rather than water-dominated — visually and
  // gameplay-distinct from a water-ice ocean shell.
  carbonBulkVolatileMin: 0.10,
  // Ocean: surface liquid water dominant.
  oceanWaterFloor:      0.5,
  // Solid giant: large rocky terrestrial (analogous to gas_giant /
  // ice_giant in the gaseous bracket — the biggest body in its
  // compositional family).
  solidGiantMassMin:    1.5,
  solidGiantRadiusMin:  1.3,
  // Desert: both water + ice low.
  desertWaterCeiling:   0.05,
  desertIceCeiling:     0.05,
};

// ---------------------------------------------------------------------------
// Universal orbital flavor
// ---------------------------------------------------------------------------

// These distributions don't vary by stellar class — they're per-body
// dynamics that physics doesn't strongly favor by host type. The
// Architect samples one of each per body it generates.

// Two-mode mixture: 95% of planets are near-circular ("peas in a pod"
// multis, dynamically settled by mutual interactions; Weiss 2018), 5%
// come from the long-tail (single-planet systems, scattered worlds,
// migrated hot Jupiters — HD 80606b sits at e=0.93, GJ 876d at e=0.025
// despite a same-system neighbor at e=0.32). A single normal can't
// capture this — it either undercounts the tail or overcounts the bulk.
// Sampled by sampleMixture in prng.mjs.
const ECCENTRICITY_REALISTIC = {
  primary:   { mean: 0.04, sd: 0.05, min: 0, max: 0.9, weight: 0.95 },
  secondary: { mean: 0.40, sd: 0.20, min: 0, max: 0.9, weight: 0.05 },
};

// Gameplay tune: cap the eccentric mode's max at 0.6. Real Kepler
// data extends to e=0.93 (HD 80606b) but for 4X gameplay a planet whose
// perihelion-to-aphelion insolation varies by 30× has habitability
// windows too short to design a colonization mechanic around. The 0.6
// ceiling keeps the dramatic-orbit flavor (still e=0.5 worlds, still
// noticeable seasons) while removing the unplayable tail. The bulk
// 95% near-circular mode is untouched.
const ECCENTRICITY_TUNE = {
  secondary: { max: 0.6 },
};

export const ECCENTRICITY = mergeTunes(ECCENTRICITY_REALISTIC, ECCENTRICITY_TUNE);

// Inclination off the host's invariant plane, degrees. Real systems are
// near-coplanar (sigma ~1–3°); the long tail covers misaligned hot
// Jupiters and dynamical perturbations.
export const INCLINATION_DEG = { mean: 0, sd: 2, min: 0, max: 30 };

// Axial tilt in degrees. Sol terrestrials span 0–25°; gas giants 3–28°;
// Uranus is 97° (single dramatic outlier). Sample from a mixture: most
// pick from N(20, 15), 5% from U(60, 180) for the dramatic cases.
// Architect can choose to implement the mixture or use this simpler form.
export const AXIAL_TILT_DEG = { mean: 20, sd: 20, min: 0, max: 180 };

// ---------------------------------------------------------------------------
// Haze blend — universal category multipliers
// ---------------------------------------------------------------------------

// The unified haze pass blends every atmospheric contributor — bulk
// atm gases, formation-gated aerosol products, lifted dust, and
// Rayleigh scattering — into one color + one opacity per body. Each
// category's contribution is `Σ (perSpeciesWeight × GAS_POTENCY ×
// log10(P+1)) × scale` — column thickness gates every species so a
// thin-atm body can't paint full haze regardless of formation strength.
// These four scales are the system-wide tuning handles. Aerosol scale
// is set so thick-column anchors (Titan-class) land near their
// pre-pressure-fix opacity; dust scale keeps dusty bodies in the
// 0.1–1 bar regime visibly hazy. Tune these globals — not per-species
// coefficients — if the anchors drift.
export const HAZE_BULK_GAS_SCALE = 0.2;
export const HAZE_AEROSOL_SCALE  = 1.25;
export const HAZE_DUST_SCALE     = 3.0;
export const HAZE_RAYLEIGH_SCALE = 0.15;

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

// Seed-suffix hook. The Filler and Architect mix this into every per-body
// PRNG seed: seed = hash32(body.id + field + PROCGEN_VERSION). Bumping
// the version reseeds the whole galaxy without changing CSV ids. Per-
// generator suffixes can be layered on top by individual generators that
// want to be re-rollable independently.
export const PROCGEN_VERSION = 'v17';

// ---------------------------------------------------------------------------
// Belts — system-level structural bands
// ---------------------------------------------------------------------------

// Belt context is a single thermal axis: warm (inward of giants, rocky-
// leaning) or cold (outward of giants, volatile-leaning). Composition is
// a two-deposit draw from BELT_RESOURCE_OCCURRENCE keyed on this context;
// the renderer derives belt color from resVolatiles vs. rocky resources.
// Size character emerges from
// shepherding — belts anchored to a giant draw `largestBodyKm` from
// the parent-body range (Ceres / Pluto class); free-float belts draw
// from the dust-cascade range (~tens of km). No discrete enum exposes
// the parent-body vs. dust-cascade distinction since gameplay treats
// all belts uniformly as resource sources.
export const BELT_CONTEXTS = ['warm', 'cold'];

// Per-stellar-class occurrence probability for each belt context.
// Rolled independently per context — a system can host warm + cold,
// either alone, or neither. Belts represent NOTABLE structural bands
// worth a player's attention (resource clusters, mining sites), not
// every system's background Kuiper-analog. Sol's Main Belt counts as
// notable (named, hand-curated); Sol's Kuiper Belt does not. These
// rates are pulled down from the underlying physical occurrence stats
// by an order of magnitude — most stars have *some* belt structure,
// but only a minority host one that reads as a navigable / mine-able
// landmark in the game.
//
// Rates are the union of the old discrete + collisional rates (a
// system used to roll each independently — same total occurrence,
// minus the small double-belt overlap). Survey anchors: Spitzer/
// Herschel debris statistics (Su 2006, Thureau 2014, Chen 2014).
// WD/BD rates are theory-anchored rather than detection-anchored:
// metal-pollution evidence puts 25–50% of WDs accreting tidally-
// disrupted debris (Zuckerman 2010), and BDs show protoplanetary
// discs across surveys of young clusters — the in-game framing is
// "what could a remnant disc look like," not "what fraction has been
// confirmed at multi-kpc distances."
const BELT_OCCURRENCE_BY_CLASS_REALISTIC = {
  O:  { warm: 0.15, cold: 0.19 },
  B:  { warm: 0.21, cold: 0.26 },
  A:  { warm: 0.25, cold: 0.32 },
  F:  { warm: 0.25, cold: 0.25 },
  G:  { warm: 0.26, cold: 0.19 },
  K:  { warm: 0.25, cold: 0.18 },
  M:  { warm: 0.22, cold: 0.14 },
  WD: { warm: 0.35, cold: 0.35 },
  BD: { warm: 0.25, cold: 0.25 },
};

// No gameplay tunes on belt occurrence today — the realistic rates above
// already track survey statistics closely, and the perceptual filtering
// happens at the renderer (sub-pixel belts wouldn't read anyway, but the
// scale we draw at can carry the survey-anchored rates without flooding
// the view). Structural placeholder kept for symmetry with ring /
// resource priors so future game-feel adjustments have a clear home.
const BELT_OCCURRENCE_BY_CLASS_TUNE = {};

export const BELT_OCCURRENCE_BY_CLASS = mergeTunes(
  BELT_OCCURRENCE_BY_CLASS_REALISTIC,
  BELT_OCCURRENCE_BY_CLASS_TUNE,
);

// Belt extent in AU when shepherding doesn't apply, scaled by stellar
// luminosity via the host's outerEdgeAu from ORBITAL_GEOMETRY_BY_CLASS.
// innerFrac / outerFrac are multiplied by outerEdgeAu to get the band's
// AU bounds. Mass is in M⊕, log-uniform between min and max.
//
//   warm: wide band from inside the rocky zone out to mid-planet zone
//         (0.05–0.50×). Used as fallback when no inner giant shepherds.
//   cold: past the planet zone out to where cold dust rings sit
//         (0.75–2.50×). Fallback when no outer giant shepherds.
//
// Mass ranges span both archetypes — the realistic distribution
// emerges because shepherded belts tend to be more massive (primordial
// planetesimal survivors) while free-float belts tend smaller (recent
// dust cascades), but we don't enforce a bimodal cut here.
export const BELT_PLACEMENT = {
  warm: { innerFrac: 0.05, outerFrac: 0.50, mass: { min: 0.0001, max: 0.05 } },
  cold: { innerFrac: 0.75, outerFrac: 2.50, mass: { min: 0.001,  max: 0.3  } },
};

// Belt resource occurrence — belts use the same two-deposit draw as
// planets/moons (see RESOURCE_OCCURRENCE + `drawWeightedDeposits`): per
// context, draw TWO resource types weighted-without-replacement and roll a
// context-scaled abundance for each (others 0). A belt reads as "the iron
// belt" / "the ice-and-exotics belt" rather than a flat six-resource smear,
// while the rocky-vs-icy split still emerges from whether volatiles win a
// slot (the renderer's `bodyIcyness` reads the same grid).
//
// Context base weights carry the belt's physical character; the secondary
// draw supplies variety:
//   warm: rocky — metals usually primary (THE strategic metal source),
//         silicates a strong alternate, volatiles near-absent. Anchored on
//         Sol Main Belt + HD 69830 warm-dust envelope.
//   cold: icy — volatiles dominate, exotics the common accent. Anchored on
//         Kuiper Belt + β Pic outer-ring envelope.
//
// `abundance` runs richer than the planet spec (strongMean 9, so a primary
// deposit lands ~9-10): belts are strategic mining targets that should
// DOMINATE their niche, not tie a planet's surface yield. That dominance
// now rides the primary-deposit abundance rather than a per-field mean bump.
const BELT_RESOURCE_OCCURRENCE_REALISTIC = {
  abundance: { weakMean: 4, strongMean: 9, sd: 1.5, min: 1, max: 10, primaryBonus: 1 },
  warm: { resMetals: 5, resSilicates: 3.5, resVolatiles: 0.4, resRareEarths: 2, resRadioactives: 1.5, resExotics: 1.5 },
  cold: { resVolatiles: 6, resExotics: 2.5, resMetals: 1.2, resSilicates: 1.2, resRareEarths: 1, resRadioactives: 1 },
};

// No gameplay flatten on belts — their rocky/icy character is the point, and
// the strategic-dominance tune the old per-field model carried is now
// inherent in the abundance spec (primary deposit ≈ 9-10). Kept as a split
// for structural parity + a future tuning home.
const BELT_RESOURCE_OCCURRENCE_TUNE = {};

export const BELT_RESOURCE_OCCURRENCE = mergeTunes(
  BELT_RESOURCE_OCCURRENCE_REALISTIC,
  BELT_RESOURCE_OCCURRENCE_TUNE,
);

// largestBodyKm draw range, conditioned on shepherding rather than a
// discrete population enum. Shepherded belts (anchored to a giant via
// BELT_GIANT_ADJACENCY) tend to be primordial parent-body inventories
// with Ceres/Pluto-class anchors; free-float belts tend to be dust
// cascades with sub-50-km parents. The architect picks the bucket
// based on whether the belt found a shepherd at placement time.
//
// Anchors:
//   warm shepherded:    Ceres 940 km (Sol Main Belt); range covers
//                       Vesta-class 525 km to the upper bound where
//                       a single body would dominate dynamics.
//   cold shepherded:    Pluto 2376 km, Eris 2326 km (KBO inventory);
//                       Quaoar / Sedna ~1000 km set the low end of
//                       "notable belt with a named parent body."
//   warm free-float:    dust cascade parent bodies; observed debris-
//                       disk parents top out at tens-of-km (HD 69830
//                       warm dust, β Pic parents inferred from
//                       collision rates).
//   cold free-float:    same scale as warm free-float — collisional
//                       cascades require many small parents regardless
//                       of where they sit.
export const BELT_LARGEST_BODY_KM = {
  warm: {
    shepherded: { min: 100, max: 1000 },
    freeFloat:  { min: 1,   max: 50   },
  },
  cold: {
    shepherded: { min: 500, max: 2500 },
    freeFloat:  { min: 1,   max: 50   },
  },
};

// Giant adjacency placement. Belts placed adjacent to a shepherding
// giant (mass ≥ SHEPHERD_MIN_MASS_EARTH) inherit stable
// resonance-anchored orbits — Sol Main Belt sits at Jupiter's resonance
// boundary, the Kuiper Belt at Neptune's. Without a giant nearby,
// belts fall back to BELT_PLACEMENT's system-edge-scaled band; the
// `GIANTLESS_BELT_PENALTY` reflects the lower physical likelihood of
// a stable belt persisting without a shepherd.
//
// Fractions are multiples of the shepherding giant's semiMajorAu:
//   warm: anchored INWARD of the innermost giant. Sol Main Belt at
//         2.7 AU = 0.52 × Jupiter's 5.2 AU; band 2.1–3.3 AU spans
//         0.40–0.65×. Generalized to 0.40–0.70×.
//   cold: anchored OUTWARD of the outermost giant. Kuiper Belt at
//         ~40 AU = ~1.33 × Neptune's 30 AU; classical KBO band
//         extends to ~50 AU = ~1.67×. Generalized to 1.30–1.85×.
export const BELT_GIANT_ADJACENCY = {
  warm: { innerFrac: 0.40, outerFrac: 0.70 },
  cold: { innerFrac: 1.30, outerFrac: 1.85 },
};

// Occurrence multiplier applied when the system has no shepherding body.
// Without a shepherd, belts can still form but are rarer (Wyatt 2008
// estimates <20% of the giant-shepherded rate for primordial belts;
// dust cascades are less affected because they don't depend on
// resonance trapping). 0.50/0.60 lands between the primordial-only
// extreme and the dust-cascade-only no-penalty, weighting toward
// "many real belts have at least some collisional component."
//
// Per-class to express the physics of each stellar archetype: WD belts
// are tidally-disrupted-planet rubble (Zuckerman 2010), not shepherded
// primordials, so a Jupiter-shepherd-or-nothing model is the wrong
// physics — set 1.0 (no penalty). BD belts are scaled-down protoplanetary
// discs around sub-stellar masses; they don't depend on internal-giant
// resonance trapping either — set 1.0.
export const GIANTLESS_BELT_PENALTY = {
  O:  { warm: 0.50, cold: 0.60 },
  B:  { warm: 0.50, cold: 0.60 },
  A:  { warm: 0.50, cold: 0.60 },
  F:  { warm: 0.50, cold: 0.60 },
  G:  { warm: 0.50, cold: 0.60 },
  K:  { warm: 0.50, cold: 0.60 },
  M:  { warm: 0.50, cold: 0.60 },
  WD: { warm: 1.00, cold: 1.00 },
  BD: { warm: 1.00, cold: 1.00 },
};

// Mass threshold for "big enough to shepherd a belt". In compact systems
// a super-Earth at 0.05 AU dominates orbital resonances the way Jupiter
// does at 5 AU around the Sun — shepherding tracks architecture, not
// absolute mass. 3 M⊕ admits super-Earths (and chthonian-class envelope-
// stripped survivors that retain a multi-Earth core) into the shepherd
// role, which matters most for M-dwarf systems where gas giants are rare
// but super-Earths are typical.
export const SHEPHERD_MIN_MASS_EARTH = 3;

// ---------------------------------------------------------------------------
// Rings — per-planet ring systems (0 or 1)
// ---------------------------------------------------------------------------

// Per-planet probability of having a ring system, derived from the
// Roche disruption cross-section. Rings form when satellites or
// captured planetesimals migrate inside the Roche limit (~2.5 × R_p
// for ice-density debris) and shatter; the larger the disruption
// zone, the higher the probability the planet has been hosting fresh
// ring material within the ring-dispersal timescale.
//
//   P_ring = R_planetEarth² × RING_DISRUPTION_RATE
//
// Cross-section scales as R_p² (area). Density and mass are NOT
// factored in — we treat the Roche/R_p ratio as ~constant across
// compositions since ice debris is the dominant feed (gas giants' icy
// satellites migrating in, super-Earths' captured KBO analogs). Sheer
// planet radius is the load-bearing signal.
//
// Sol-anchored at Jupiter ≈ 0.30 — matches the prior visual-budget
// rate. Realistic physical-presence rate is ~80%, but most real rings
// are sub-pixel at our zoom and would only register as visual noise,
// so this scale stays at the perceptible-rate level rather than the
// physical-presence one.
//
// Sol calibration at RING_DISRUPTION_RATE = 0.00239:
//   Jupiter     (R = 11.21 R⊕): P ≈ 0.300
//   Saturn      (R =  9.45 R⊕): P ≈ 0.213
//   Uranus      (R =  4.00 R⊕): P ≈ 0.038
//   Neptune     (R =  3.88 R⊕): P ≈ 0.036
//   Super-Earth (R ≈  1.80 R⊕): P ≈ 0.008
//   Earth       (R =  1.00 R⊕): P ≈ 0.0024
//   Mercury     (R =  0.38 R⊕): P ≈ 0.00035
//
// The R² curve concentrates rings on gas giants more sharply than the
// prior per-type tune did: super-Earth rate drops from ~7% to ~1%.
// At the procgen scale (4000+ super-earth-class planets per build),
// this still produces ~40 ringed super-earths galaxy-wide — enough
// for the "settle here, look at the sky" iconic SF beat to remain a
// recurring outcome rather than a paper one. Revisit if gameplay
// needs more visible ringed terrestrials.
export const RING_DISRUPTION_RATE = 0.00239;

// Ring extent in multiples of the host planet's radius. Inner edge sits
// above the Roche limit (~1.1–1.5 R_p depending on density); outer edge
// inside the synchronous-orbit boundary (Saturn's F ring ≈ 2.3 R_S, well
// inside synchronous). One distribution spans both bright icy rings and
// faint dusty ones — composition lives in the resource grid (see
// RING_RESOURCE_ICY / RING_RESOURCE_ROCKY below), not in a separate
// class branch.
export const RING_EXTENT = {
  inner: { mean: 1.40, sd: 0.15, min: 1.05, max: 2.0 },
  outer: { mean: 2.20, sd: 0.20, min: 1.5,  max: 3.0 },
};

// ---------------------------------------------------------------------------
// Ring resources — six 0..10 scalars per ring; gated by formation zone
// ---------------------------------------------------------------------------

// Rings inherit composition from the circumplanetary-disk material at
// formation — primarily water ice past the H2O frost line, primarily
// silicate dust and refractory debris inside it. Two priors gated by
// whether the host's formationAu sat past the H2O snow line; no per-
// planet-type dispatch.
//
// Saturn's main ring is the iconic 99% water-ice case (Sol H2O frost
// ≈ 2.7 AU; Saturn formed at 9.5 AU). Uranus's narrow rings are
// carbonaceous-darkened ice — still icy at the molecular level, just
// surface-radiation-darkened (which the renderer handles via the
// volatile-vs-silicate color/alpha lerp, no separate "dark ring"
// composition needed). Jupiter's faint main ring is a rocky/silicate
// outlier — captured here through the per-resource sd, not a separate
// table.
export const RING_RESOURCE_ICY = {
  resMetals:        { mean: 1, sd: 1, min: 0, max: 10 },
  resSilicates:     { mean: 2, sd: 2, min: 0, max: 10 },
  resVolatiles:     { mean: 7, sd: 2, min: 0, max: 10 },
  resRareEarths:    { mean: 0, sd: 0, min: 0, max: 10 },
  resRadioactives:  { mean: 0, sd: 0, min: 0, max: 10 },
  resExotics:       { mean: 1, sd: 1, min: 0, max: 10 },
};

// Inside-H2O-frost rings are rare events — tidally-disrupted
// asteroidal capture or impact ejecta — so the composition skews
// heavily rocky / low volatiles. Hot-zone (Mercury/Venus-class) rings
// follow the same prior since the dominant disruption feed is
// regolith-class debris regardless of stellar insolation; the
// silicate-vs-metal split emerges from the per-resource sd.
export const RING_RESOURCE_ROCKY = {
  resMetals:        { mean: 4, sd: 2, min: 0, max: 10 },
  resSilicates:     { mean: 5, sd: 2, min: 0, max: 10 },
  resVolatiles:     { mean: 1, sd: 1, min: 0, max: 10 },
  resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
  resRadioactives:  { mean: 0, sd: 0, min: 0, max: 10 },
  resExotics:       { mean: 1, sd: 1, min: 0, max: 10 },
};

// ---------------------------------------------------------------------------
// Surface composition — water / ice cover derivation (Phase 3)
// ---------------------------------------------------------------------------
//
// Surface liquid water and surface ice are derived from `bulkWaterFraction`
// + temperature + pressure, not sampled per class. The cover formulas live
// in procgen.mjs; the tuning scalars live here.
//
// Gates: liquid water requires P ≥ TRIPLE_POINT_BAR AND T ∈ [273, T_boil(P)].
// Surface ice has two regimes:
//   - cold-trap (T_mean < 273): global freezing, any pressure; scaled by
//     bulkWaterFraction (a small bulkWater still produces visible ice).
//   - polar cap (T_mean > 273 but T_pole < 273, P ≥ triple point): small
//     caps proportional to (273 - T_pole).
//
// Liquid water coverage saturates: Earth's tiny absolute bulkWater
// (0.00023) still covers 71% of the surface because the absolute
// amount is enough to spread thin. SURFACE_WATER_SAT is the
// bulkWaterFraction value at which surface coverage = 1.0.

// Triple-point of water in bar. Below this, liquid is thermodynamically
// impossible at any temperature — water either freezes or sublimes.
export const TRIPLE_POINT_BAR = 0.006;

// Boiling-point curve anchors (P_bar → T_boil_K). The cover formula
// log-interpolates linearly between these three points; above 100 bar
// the asymptote holds (supercritical territory above ~218 bar in
// reality, but for gameplay the formula stops at 583 K).
// Real anchors: triple point (0.006, 273), STP (1.0, 373), high-P (100, 583).
export const BOILING_POINT_ANCHORS = [
  { p: 0.006, t: 273 },
  { p: 1.0,   t: 373 },
  { p: 100,   t: 583 },
];

// bulkWaterFraction at which surface liquid water coverage saturates to
// 1.0 (linear ramp from 0). Earth-anchor: bulkWater 0.00023 → cover
// ~0.70, so threshold ≈ 3.3e-4. Bodies with bulkWater above this read
// as fully covered when the temperature/pressure gates pass.
export const SURFACE_WATER_SAT = 3.3e-4;

// bulkWaterFraction at which ice cover saturates. Lower than the
// liquid threshold because ice can pile up on any surface (no
// gravitational-pooling constraint). Anchored so Europa/Callisto/
// Titan-class moons (bulkWater ~0.5) saturate easily, and Mars-class
// (bulkWater ~1e-4) produces visible polar caps.
export const SURFACE_ICE_SAT = 1e-2;

// Polar-cap regime parameters. base_cap is the maximum cap fraction
// at T_pole = 273 - T_pole_full_K (e.g. 60K below freezing → max cap).
// Earth-anchor: T_pole ~ T_min ~ 184K, capWeight = 89/60 → 1.0, cover
// ≈ 0.10 with a noise multiplier ~ 0.67.
export const POLAR_CAP = {
  baseFraction:    0.15,  // max cap cover at full polar freeze
  poleFullDeltaK:  60,    // (273 - T_pole) for capWeight = 1
  maxCoverFraction: 0.40, // hard cap on polar-cap mode output
  // Mean-temperature ceiling. Caps are only stable when the *bulk* body
  // is temperate enough that cold polar regions can retain a frozen
  // reservoir without it sublimating equatorward and escaping. On a
  // 1500K lava world the poles can briefly cool (thin atm + tidal lock
  // → T_pole reads 195K) but any surface water dissociates / escapes on
  // geological timescales, so no stable cap exists. 350K leaves Earth
  // (288K) comfortably inside the regime while excluding hot terrestrial
  // / iron / lava classes whose nominal T_eq is hundreds of K above any
  // plausible cap-formation regime.
  meanTempMaxK:    350,
};

// Cold-trap regime parameters. T_full_freeze_K = T below which the
// cold-factor saturates at 1.0 (everything that can freeze has frozen);
// linear ramp from 273 down to here. Europa T=102K → factor=1, Mars
// T=210K → factor=0.63.
export const COLD_TRAP = {
  freezeFullK:   173,  // smoothstep ceiling
  freezeStartK:  273,  // smoothstep floor (water freezes)
};

// Per-body stochastic noise on the derived cover fractions. Captures
// variance the physics formula can't explain: subsurface aquifers,
// mineral-bound water, regolith covering ice (Callisto vs. Europa
// despite similar T + bulkWater), Titan's hydrocarbon-lake surface
// disrupting clean ice cover. Truncated normal, narrow spread.
export const WATER_COVER_NOISE = { mean: 1.0, sd: 0.25, min: 0.5, max: 1.5 };
export const ICE_COVER_NOISE   = { mean: 1.0, sd: 0.25, min: 0.5, max: 1.5 };

// ---------------------------------------------------------------------------
// Bond albedo — composition-derived (Phase 4)
// ---------------------------------------------------------------------------
//
// Bond albedo is a linear blend of cover-component albedos. Water cover is
// dark (~0.06), ice cover is bright (~0.85), bare land sits in between
// (~0.20 rocky/desert). A cloud bump on top of that scales with
// `bulkWaterFraction × temperate_factor` as a proxy for cloud cover —
// without computing atmospheric H2O species explicitly. Curated Sol bodies
// bypass this entirely.
//
// Earth check (water=0.71, ice=0.10, bulkWater=0.00023 → cloudFactor≈0.7):
//   A = 0.71×0.06 + 0.10×0.85 + 0.19×0.20 + 0.7×0.15 = 0.27 vs real 0.31.
// Europa (ice=0.85, cold → no cloud bump):
//   A = 0×0.06 + 0.85×0.85 + 0.15×0.20 = 0.75 vs real 0.67.
// Both within tolerance for procgen.
export const ALBEDO_COMPONENTS = {
  water:       0.06,  // open ocean
  ice:         0.85,  // mixed ice (less than fresh snow's 0.95)
  land:        0.20,  // rocky/desert average
  // Pass A cloud bump — bulkWater proxy, used before atm composition is
  // known. Pass B replaces this with per-gas cloud-table contributions
  // from CLOUD_BY_GAS below.
  cloudBoost:  0.15,
  cloudSatBulkWater: 3.3e-4,
  cloudTempMin: 240,
  cloudTempMax: 320,
};

// ---------------------------------------------------------------------------
// Per-gas cloud potency — Pass B composition-aware albedo
// ---------------------------------------------------------------------------
//
// Each cloud-active gas contributes an additive bump to Bond albedo when:
//   - the body's surface T is inside the gas's condensation window, AND
//   - the gas's partial pressure × cloud potency reaches the saturation
//     point pSat (above which the cloud deck is fully formed).
//
// The total cloud bump is summed across atm1/2/3. The bump is added
// to the cover-blend surface albedo and the whole thing is clamped to
// [0, 1].
//
// Aerosol-only species (DUST, SILICATE) saturate at tiny partial
// pressures — trace concentrations are visually dominant for these.
//
// Calibration anchors (curated Sol):
//   Earth  H2O 0.004 partial @ 288K → boost ≈ 0.16 (real albedo 0.31)
//   Venus  SO2 0.0138 partial @ 737K → boost ≈ 0.50 (real albedo 0.77)
//   Mars   DUST 0.002×0.006 partial @ 210K → boost ≈ 0.01 (real albedo 0.25)
//   Titan  CH4 0.041 partial @ 94K → boost ≈ 0.10 (real albedo 0.22 —
//          ice-albedo overshoot is a separate known limitation)
//
// Sol bodies are curated; this table only affects procgen analogs.
export const CLOUD_BY_GAS = {
  H2O:      { maxBump: 0.20, condenseLow: 200, condenseHigh: 350,  pSat: 0.005 },
  SO2:      { maxBump: 0.50, condenseLow: 200, condenseHigh: 800,  pSat: 0.010 },  // H2SO4 deck
  CH4:      { maxBump: 0.10, condenseLow: 60,  condenseHigh: 130,  pSat: 0.005 },
  NH3:      { maxBump: 0.15, condenseLow: 80,  condenseHigh: 200,  pSat: 0.002 },
  CO2:      { maxBump: 0.10, condenseLow: 100, condenseHigh: 200,  pSat: 0.500 },  // dry-ice clouds (rare)
  CO:       { maxBump: 0.05, condenseLow: 60,  condenseHigh: 100,  pSat: 0.010 },
  // Aerosol species — trace partial pressure but visually dominant
  DUST:     { maxBump: 0.10, condenseLow: 150, condenseHigh: 500,  pSat: 1e-4 },
  SILICATE: { maxBump: 0.15, condenseLow: 800, condenseHigh: 3000, pSat: 1e-4 },
};

// ---------------------------------------------------------------------------
// Greenhouse — Pass A pressure proxy + Pass B per-gas composition refinement
// ---------------------------------------------------------------------------
//
// Pass A (initial cascade, before atm composition is known): pressure
// proxy `K = baseK × P^exponent`. Used to settle T, water/ice, class so
// the atm dispatch can run.
//
// Pass B (post-atm refinement): partial-pressure × per-gas potency
// power law summed over atm1/2/3. Captures composition effects the
// pressure proxy misses — Titan's N2-dominant atm produces
// far less greenhouse than its 1.45 bar would suggest, and Mars's
// CO2-rich thin atm produces more than its 0.006 bar would suggest.
//
// Pass A is kept as the initial estimate because Pass B requires class
// (for atm dispatch); without Pass A the cascade has no entry point.
export const GREENHOUSE = {
  baseK:    33,   // Earth at P=1 bar (pressure proxy)
  exponent: 0.6,  // saturating power law
};

// Per-gas greenhouse potency. Each contribution = `kMax × min(P_partial, pSat)^exp`
// where P_partial = P_bar × gas_fraction. Sum across atm species gives
// composition-aware greenhouse.
//
// Calibration anchors (curated Sol):
//   Mars  CO2 0.0057 bar partial → real ~5K   → solves CO2 against Venus
//   Venus CO2 88     bar partial → real ~500K → simultaneously
//   Titan CH4 0.0406 bar partial → real ~12K  → solves CH4
//   Earth H2O 0.004  bar partial → real ~20K  → solves H2O
// CO2 spans the widest range (Mars→Venus is 100× greenhouse over
// 15000× pressure), giving the cleanest power-law fit.
//
// `pSat` caps each gas's effective partial pressure at the saturation
// point where additional gas stops adding meaningful greenhouse (optical
// depth saturates → atmosphere is already opaque in that gas's IR bands).
// Without this cap, Phase 2 runaway-tail bodies (P > 1000 bar) compound
// the power law to physically implausible T > 3000K.
//
// Transparent gases (N2/O2/Ar/H2/He) get kMax=0 — pressure alone in
// pure-N2 atms (Titan) doesn't produce greenhouse. CO is a weak
// greenhouse gas; potency tuned by analogy with CH4.
export const GREENHOUSE_POTENCY_BY_GAS = {
  CO2: { kMax: 59,  exp: 0.477, pSat: 200 },  // CO2 supercritical above ~75 bar; cap higher to allow tail
  H2O: { kMax: 100, exp: 0.30,  pSat: 30  },  // saturates as steam atm
  CH4: { kMax: 38,  exp: 0.43,  pSat: 20  },
  NH3: { kMax: 40,  exp: 0.45,  pSat: 20  },
  SO2: { kMax: 40,  exp: 0.40,  pSat: 15  },  // Venus minor + Io — moderate IR
  CO:  { kMax: 8,   exp: 0.40,  pSat: 30  },
  N2:  { kMax: 0,   exp: 0,     pSat: 0   },
  O2:  { kMax: 0,   exp: 0,     pSat: 0   },
  Ar:  { kMax: 0,   exp: 0,     pSat: 0   },
  H2:  { kMax: 0,   exp: 0,     pSat: 0   },
  He:  { kMax: 0,   exp: 0,     pSat: 0   },
};

// ---------------------------------------------------------------------------
// Tectonic activity — mass-driven (Phase 4)
// ---------------------------------------------------------------------------
//
// tect = baseSample × sqrt(massEarth). Bigger bodies retain more
// radiogenic heat over Gyr, sustain longer-lived dynamos and surface
// renewal. Earth (M=1) lands at the prior mean; Mars (M=0.107) at ~30%
// of that; a 5 M⊕ super-Earth at ~2.2×.
//
// Realistic baseline: { mean: 0.4, sd: 0.25 } puts Earth at the mean and
// gives Mars-mass bodies ~0.13 tect (matching reality).
//
// Tune: lift mean to 0.55 + widen sd to 0.35. The sqrt(mass) damping
// pushes most procgen rocky bodies (sub-Earth mass) below tect=0.2,
// which then dampens magnetic field dynamos below the threshold any
// biotic productivity needs. Lifting mean compensates so the
// population spans tect=0.2..0.9 instead of clustering 0.1..0.4 —
// more diversity in the dynamo, surface-renewal, and outgassing
// signals all of which downstream rules consume.
const TECTONIC_BASE_REALISTIC = { mean: 0.4,  sd: 0.25, min: 0, max: 1.0 };
const TECTONIC_BASE_TUNE      = { mean: 0.55, sd: 0.35 };
export const TECTONIC_BASE = mergeTunes(TECTONIC_BASE_REALISTIC, TECTONIC_BASE_TUNE);

// Tidal-heating lift for moons of giants. Real tidal heating scales as
// M_host² · e² / a⁵; for our catalog the host-mass term doesn't change
// ordering (gas giants all dominate), so eccentricity-only is the simplest
// defensible proxy. Pulls surfaceAge toward 1.0 by liftAmount × normalized
// fraction. Below the threshold, no lift (Ganymede e≈0.001 stays old).
export const SURFACE_AGE_TIDAL_LIFT = {
  eThreshold:    0.005,
  eMaxNormalize: 0.05,
  liftAmount:    0.70,
};

// ---------------------------------------------------------------------------
// Surface age — tectonic-driven (Phase 4)
// ---------------------------------------------------------------------------
//
// age = tect^exponent × noise + tidal_lift. High-tect bodies renew their
// surface frequently (young surface fraction high); low-tect bodies
// accumulate impact gardening (old). The exponent < 1 pulls modest tect
// values upward so Earth (tect ≈ 0.4) lands at age ≈ 0.6 rather than 0.4.
export const SURFACE_AGE_FROM_TECTONIC = {
  exponent: 0.7,
  noise:    { mean: 1.2, sd: 0.3, min: 0.7, max: 1.5 },
};

// ---------------------------------------------------------------------------
// Rotation period — universal log-normal + tidal locking (Phase 4)
// ---------------------------------------------------------------------------
//
// Anchors: Earth 24h, Mars 24.6h, Jupiter 9.9h, Saturn 10.7h, Uranus 17h,
// Neptune 16h. Venus's 5832h retrograde spin is the long-tail outlier —
// reachable through the sd but not the mode. Mass-keyed modulation could
// later refine this (gas giants spin faster from angular momentum
// conservation during collapse), but a universal log-normal is the
// minimal class-free shape.
export const ROTATION_INIT_HOURS = { mean: 24, sd: 30, min: 8, max: 200 };

// Tidal-locking probability ramps with `tidalLockProxy(M_star, a_AU)` from
// astrophysics.mjs. proxy ≤ proxyLocked → locked with probability ~1;
// proxy ≥ proxyFree → never locked. Log-interpolated between.
const TIDAL_LOCK_RANGE_REALISTIC = { proxyLocked: 0.005, proxyFree: 2.0 };

// Gameplay tune: tighten proxyLocked from 0.005 → 0.001. M-dwarf HZ worlds
// SHOULD be near-universally tide-locked astronomically, but M-dwarfs are
// 61% of our catalog and tide-locked terrestrials are colonization-hostile.
// The tighter threshold means ~30% of M-dwarf HZ worlds break free.
const TIDAL_LOCK_RANGE_TUNE = { proxyLocked: 0.001 };

export const TIDAL_LOCK_RANGE = mergeTunes(TIDAL_LOCK_RANGE_REALISTIC, TIDAL_LOCK_RANGE_TUNE);

// ---------------------------------------------------------------------------
// Surface temperature swing — thermal-inertia derived (Phase 4)
// ---------------------------------------------------------------------------
//
// swing = SWING_BASE / inertia × tilt_factor × ecc_factor × noise
// where inertia = max(inertiaMin, 1 + atmTerm×log10(P+0.001) + oceanTerm×waterFraction)
//
// Thick atmospheres and oceans buffer thermal variability; thin atms +
// dry bodies (Mars, Mercury) swing wildly. Class isn't an input — the
// physics-determined P and waterFraction are.
export const TEMP_SWING = {
  swingBase:   0.4,   // base fractional swing at unit inertia
  inertiaMin:  0.3,   // floor on inertia for airless bodies
  atmTerm:     0.5,   // log10(P) coefficient
  oceanTerm:   1.5,   // waterFraction coefficient
  noise:       { mean: 1.0, sd: 0.2, min: 0.5, max: 1.5 },
};

// ---------------------------------------------------------------------------
// Magnetic field — mass-cap × dynamo × noise (Phase 4)
// ---------------------------------------------------------------------------
//
// field = (capBase × mass^capExponent) × (tect × sqrt(24/rot)) × noise.
// The mass-based cap replaces the per-class baseline — bigger bodies
// sustain larger fields by virtue of larger conducting cores. Gas giants
// land high because they're high-mass; rocky M-dwarf worlds with active
// tectonics still get respectable fields.
//
// Earth (M=1, tect≈0.4, rot≈24): cap=0.5 × dynamo=0.4×1=0.4 → 0.20 G.
// Real Earth 0.31. Within an sd.
// Mars (M=0.107, tect≈0.07): cap=0.5×0.5=0.25 × dynamo=0.07×1=0.07 → 0.017 G.
// Real Mars (relict) ~0.01-0.04. ✓
// Realistic baseline: { capBase: 0.5 } is Earth-anchored — at M=1, tect≈0.4,
// rot≈24, noise=1 → B≈0.20 G, matching Earth's measured 0.31 G to
// within one sd. giantBoost=5 anchors Jupiter at ~14 G (real 4-13 G).
//
// Tune: bump capBase to 0.75 and widen noise so the population is
// more bimodal — some rocky worlds get strong dynamos (Earth-class),
// others stay essentially field-free (Mars/Mercury-class), with fewer
// in the muddy middle. Real exoplanet science suggests a bimodal
// distribution: dynamo activity follows a step function in core
// heat-flow + rotation, so populations cluster at "active" or "dead"
// rather than uniform low values. Widening sd to 0.7 + max to 4.0
// gives both more peaks AND more troughs.
const MAGNETIC_FIELD_REALISTIC = {
  capBase:        0.5,
  capExponent:    0.3,
  giantBoost:     5.0,
  noise:          { mean: 1.0, sd: 0.5, min: 0.1, max: 3.0 },
};
const MAGNETIC_FIELD_TUNE = {
  capBase:        0.75,
  noise:          { sd: 0.7, max: 4.0 },
};
export const MAGNETIC_FIELD = mergeTunes(MAGNETIC_FIELD_REALISTIC, MAGNETIC_FIELD_TUNE);

// ---------------------------------------------------------------------------
// Atmosphere composition — top-3 gases per world class
// ---------------------------------------------------------------------------

// Each world class lists candidate gases with weights. The Filler samples
// without replacement until it has 3 (or until the class runs dry), then
// renormalizes those three fractions to sum to 1.0 — with a per-body
// seeded perturbation so two identical-class worlds don't look identical.
//
// Anchors: Mars 0.95 CO2 / 0.027 N2 / 0.016 Ar (the abiotic-rocky baseline);
// Venus 0.965 CO2 / 0.035 N2; Titan 0.95 N2 / 0.05 CH4; Jupiter 0.90 H2 /
// 0.10 He / trace CH4. Earth's 0.78 N2 / 0.21 O2 is the OUTLIER, not the
// rocky template — O2 at that concentration is a biosignature, produced
// by photosynthesis. Abiotic rocky worlds carry O2 only as a photolysis
// trace (sub-percent). Biotic O2 lift is now a continuous function of
// productivity[carbon_aqueous] applied at atm-sample time in procgen.mjs
// (see BIOTIC_O2_LIFT_FACTOR there) — no table lookup.
//
// Atmosphere composition is dispatched on physical regime (not class).
// Five regimes based on (radius, T, P, bulkWater):
//
//   primary         — radius ≥ gasDwarfRadius. Captured H/He primordial
//                     atm (gas giant / ice giant / sub-Neptune).
//   cold_outgassed  — T < 200K (Titan/Triton-class). N2 dominant from
//                     NH3 photolysis aging; CH4 stable at cold T.
//   thick_outgassed — surfacePressureBar ≥ 30 (Venus-class runaway).
//                     CO2 + SO2 from stagnant-lid outgassing.
//   wet_outgassed   — bulkWaterFraction ≥ 1e-4 (Earth-class). N2
//                     dominant (NH3 photolysis ages), trace CO2
//                     (carbonate-cycle reservoir on biotic worlds).
//                     Biotic O2 lift handles Earth's 21% via
//                     productivity-driven biotic O2 lift in procgen.mjs.
//   dry_outgassed   — Mars-class. CO2 dominant (volcanic outgassing,
//                     no carbonate sink), thin pressure means most
//                     species lost.
//
// Class is no longer involved. The Filler dispatches on regime, applies
// per-gas Jeans escape filter (light gases zeroed when escape ratio
// fails), and applies O2 biotic lift.
export const ATMOSPHERE_GASES_BY_REGIME = {
  primary:         { H2: 8,   He: 2,   CH4: 0.5, NH3: 0.2 },
  cold_outgassed:  { N2: 5,   CH4: 2,  H2: 0.5,  CO: 0.3 },
  thick_outgassed: { CO2: 5,  SO2: 3,  H2O: 1,   N2: 0.5 },
  // wet_outgassed — N2 dominant (78% Earth), trace CO2/H2O (0.04% / ~1%
  // Earth). O2 stays trace abiotically; biotic lift on top.
  wet_outgassed:   { N2: 8,   Ar: 0.5, CO2: 0.05, H2O: 0.1, O2: 0.05 },
  dry_outgassed:   { CO2: 5,  N2: 2,   Ar: 1,    SO2: 0.3, H2O: 0.3 },
};

// Realistic baseline: wetBulkWaterMin=1e-4 was calibrated against
// Earth's bulk-water fraction (~2.3e-4) — bodies with at least that
// much water reservoir entered the N2-dominant regime.
//
// Tune: loosen wetBulkWaterMin to 1e-5. The procgen distribution of
// bulkWaterFraction puts most rocky bodies below the realistic
// threshold, even when they're in the habitable zone — they fall to
// dry_outgassed (CO2-dominant Mars-class atmospheres) by default. The
// looser threshold catches more habitable-zone bodies and gives them
// Earth-class N2 atmospheres, which is the precondition for biotic
// carbon_aqueous productivity to fire. Hot Venus-class bodies still
// hit the thick_outgassed gate first, so this only affects temperate
// thin-atm bodies.
const ATMOSPHERE_REGIME_THRESHOLDS_REALISTIC = {
  coldTempMaxK:      200,
  thickPressureBar:  30,
  wetBulkWaterMin:   1e-4,
};
const ATMOSPHERE_REGIME_THRESHOLDS_TUNE = {
  wetBulkWaterMin:   1e-5,
};
export const ATMOSPHERE_REGIME_THRESHOLDS = mergeTunes(
  ATMOSPHERE_REGIME_THRESHOLDS_REALISTIC,
  ATMOSPHERE_REGIME_THRESHOLDS_TUNE,
);

// Sub-trace surface pressure is treated as airless — the Filler skips
// atm fill when surfacePressureBar is below this floor (covers airless
// rocky moons like Callisto/Ganymede whose nominal atmospheres are
// kinetic exospheres rather than thermodynamic ones).
export const ATMOSPHERE_MIN_PRESSURE_BAR = 0.01;

// Atmospheric retention shape — Jeans escape sigmoid + magnetic-shield
// floor. The Filler computes v_escape/v_thermal(N2, T_eq) per body and
// smoothsteps the ratio into a 0..1 "long-term retained fraction" over
// ~Gyr timescales. Magnetic-field shielding multiplies on top: bodies
// with no internal dynamo (Mars, Venus) lose atmosphere faster to
// stellar-wind stripping, captured by the magneticFloor.
//
// Calibration anchors (Sol v_esc/v_th(N2, T_eq) ratios):
//   Earth ~22, Venus ~20  → above thresholdHigh, retention = 1.0
//   Mars  ~12             → mid, retention ≈ 0.9
//   Titan ~9              → near low, retention ≈ 0.4
//   Mercury ~7, Europa ~7 → near low, retention ≈ 0.1
//   Luna ~5               → below thresholdLow, retention = 0
// Realistic baseline: jeansLow=6, magneticFloor=0.05 — tightly anchored
// against Sol's airless / thin-atm bodies (Luna ratio ~5 fully stripped;
// Mars ratio ~12 mostly retained but stellar-wind erosion through the
// non-existent dynamo bleeds it to 0.006 bar).
const ATMOSPHERIC_RETENTION_REALISTIC = {
  jeansLow:       6,
  jeansHigh:      13,
  magneticFloor:  0.05,
  magneticLow:    0.02,
  magneticHigh:   0.20,
};

// Gameplay tune: loosen the sigmoid + lift the no-dynamo floor so
// marginal-gravity rocky bodies (Mars-class through sub-Earth-mass)
// retain enough atm to land in the habitable pool. Under the realistic
// values only 43/290 temperate-zone rocky procgen bodies hold P≥0.1
// bar; the rest end up airless desert/iron. Real Solar System is
// 4/8 (Venus/Earth/Mars/Titan) at the Mars threshold and our
// distribution sits well below that. Effects per knob:
//   - jeansLow 6→5: bodies at v_esc/v_th = 5-6 (sub-Mars, marginal
//     gravity) keep ~30% retention instead of 0. ~20 added.
//   - magneticFloor 0.05→0.15: no-dynamo bodies (Mars-class, ~210 of
//     the 290 temperate population) retain 3× more atm against stellar
//     wind. ~30 added.
//   Combined: ~50 marginal-mass bodies move from airless to thin-atm,
//   roughly doubling the habitable-eligible pool.
const ATMOSPHERIC_RETENTION_TUNE = {
  jeansLow:       5,
  magneticFloor:  0.15,
};

export const ATMOSPHERIC_RETENTION = mergeTunes(
  ATMOSPHERIC_RETENTION_REALISTIC,
  ATMOSPHERIC_RETENTION_TUNE,
);

// Outgassing-potential scaling — total atm-bar a body would produce if
// its full volatile inventory cycled to the surface. Linear in mass ×
// effective-volatiles, where effective-volatiles = max(bulkWaterFraction,
// volatileFloor). The floor represents the CO2/N2/other-volatile
// inventory every rocky body has from accretion, independent of water
// budget — bulkWaterFraction alone undercounts (e.g. Venus is bone-dry
// by H2O but has a Venus-bar of CO2 from carbonate-equivalent
// outgassing).
//
// Calibrated so Earth (M=1, eff-vol=0.005 from floor) × retention=1.0
// × shield=1.0 × multiplier=1.0 ≈ 1.0 bar.
export const OUTGASSING = {
  outgassingScale: 200,
  volatileFloor:   0.005,
};

// History multiplier — bistable mixture capturing the "did this body
// run away into a thick greenhouse / get its atm preferentially
// stripped" dichotomy that simple physics can't model from
// (mass, T, bulkWater) alone. Earth and Venus have ≈ identical
// fundamentals; their divergence is an attractor-basin bifurcation
// (carbonate-cycle vs. stagnant-lid runaway). 90% of bodies land in
// the typical mode; 10% in the heavy-tail runaway mode.
//
// Same shape as ECCENTRICITY's near-circular/scattered mixture —
// probabilistic spreads are the house pattern; deterministic physics
// + stochastic history multiplier is more honest than either alone.
export const PRESSURE_HISTORY_MULTIPLIER = {
  primary:   { mean: 1.0, sd: 0.4, min: 0.3, max: 3,   weight: 0.90 },
  secondary: { mean: 50,  sd: 50,  min: 5,   max: 500, weight: 0.10 },
};

// Per-species condensation specs. One row per visible cloud-deck
// species. No regime classification: every body iterates through this
// list, gating each species on its temperature window AND its
// precursor availability. Multi-deck stacks (Jupiter's NH3 / NH4SH /
// H2O) emerge naturally when multiple windows simultaneously match.
//
// Fields:
//   gas             — condensate species. The shader reads
//                     CONDENSATE_COLOR[gas] (with GAS_COLOR fallback)
//                     for the deck's color.
//   condenseTempK   — [low, high] window in K where this species
//                     condenses at cloud-top pressure. tempCondenseFactor
//                     gates strength: 1.0 inside the window, ramping to
//                     0 across a 30 K skirt on each side.
//   altitudeNorm    — fixed per-species render altitude (0..1). Drives
//                     back-to-front composite order + per-deck haze
//                     pre-tint weighting.
//   altitudeTempOffsetK — for gaseous bodies, how much warmer this
//                     species' altitude is than the body's cloud-top
//                     reference T (= avgSurfaceTempK). The temp gate
//                     evaluates `body.T + altitudeTempOffsetK` against
//                     condenseTempK, so deeper-warmer species can fire
//                     on cold ice giants while still firing at the
//                     correct altitude on temperate gas giants.
//                     Terrestrials ignore this — their cloud altitudes
//                     are near-surface so the surface T IS the cloud T.
//   precursor       — function(body, ctx) → 0..1, "is this species
//                     available?" Gaseous (H2/He-dominant) bodies get
//                     cosmic-abundance trace for NH3/NH4SH/CH4/H2O
//                     even though those aren't recorded in the 3-slot
//                     atm. Terrestrials gate on the actual atm record
//                     + waterFraction.
//
// strength = tempCondenseFactor(effectiveT, lo, hi) × precursor(body, ctx).
// coverage is then derived in cloudDecksFor — see the procgen.mjs
// coverageFor function for the full-cover vs. sparse-cirrus split.
//
// The list is **sorted top-to-bottom in the atm column for the
// gas-giant regime that's most relevant to it** (refractory species
// first, then mid-T condensates, then volatile ices). Order doesn't
// affect emission — the final list is sorted by altitudeNorm before
// upload — but reading the table top-down traces the same vertical
// stack you'd see in a Galilean-type cloud-structure diagram.
export const CONDENSABLES = [
  {
    gas: 'SILICATE',
    condenseTempK: [1500, 2500],
    altitudeNorm: 0.85,
    altitudeTempOffsetK: 0,
    // Hot-Jupiter regime: refractory minerals as atm vapor rain out
    // as silicate cloud at extreme T. The condensation T IS the
    // cloud-top T on hot Jupiters (whole atm is hot enough), so no
    // altitude offset. Always available in gaseous bodies; terrestrials
    // never reach these temps without becoming molten surfaces.
    precursor: (_body, ctx) => ctx.isGaseous ? 1.0 : 0,
  },
  {
    gas: 'H2SO4',
    condenseTempK: [400, 900],
    altitudeNorm: 0.50,
    altitudeTempOffsetK: 0,
    // Venus-class: hot CO2 atm + sulfur from volcanism. Gate fires
    // on surface T as a proxy for "Venus regime" — real cloud
    // altitude T (~350 K) is much cooler than Venus surface (737 K),
    // but the window is wide enough to capture both ends without
    // an altitude offset on a terrestrial.
    precursor: (body, ctx) => {
      if (ctx.isGaseous) return 0;
      const co2 = ctx.atmFrac('CO2');
      const press = body.surfacePressureBar ?? 0;
      return ctx.smoothstep(0.3, 0.95, co2) * ctx.smoothstep(5, 50, press);
    },
  },
  {
    gas: 'SALT',
    condenseTempK: [400, 1450],
    altitudeNorm: 0.60,
    altitudeTempOffsetK: 50,
    // Warm sub-Neptune / warm gas giant: KCl + ZnS condensate deck
    // between H2O (≤380 K) and SILICATE (≥1500 K). +50 K altitude
    // offset puts the deck slightly deeper-and-warmer than cloud-top,
    // matching real altitude T profiles on warm gas giants.
    // Gaseous-only: alkali salts as cloud condensates are a
    // gas-giant phenomenon (terrestrials at this T have molten
    // surfaces, not salt cloud decks).
    precursor: (_body, ctx) => ctx.isGaseous ? 1.0 : 0,
  },
  {
    gas: 'H2O',
    condenseTempK: [180, 380],
    altitudeNorm: 0.30,
    altitudeTempOffsetK: 130,
    // Terrestrials: H2O atm OR surface water → near-surface cloud
    // cover (Earth cumulus, Mars cirrus). Window bottom 180 K (skirt
    // → 150 K) covers Mars-class trace cirrus; top 380 K covers hot
    // ocean worlds.
    // Gaseous: H2O condenses DEEP in the atm column (real Jupiter
    // deck at ~5-10 bar where T ~270 K, cloud-top T = 165 K → offset
    // +105-130 K). +130 K offset lets H2O fire on all four Sol
    // gas/ice giants from their actual cloud-top temperatures.
    // Cosmic trace H2O is universally present in H/He giants
    // regardless of bulk water fraction (Jupiter's bulk water is
    // ~1% but its deep H2O cloud is real).
    precursor: (body, ctx) => {
      if (ctx.isGaseous) return 1.0;
      const atmGate = ctx.smoothstep(0.001, 0.01, ctx.atmFrac('H2O'));
      const waterGate = body.waterFraction ?? 0;
      const direct = 0.05 + 0.5 * Math.max(atmGate, waterGate);
      return direct;
    },
  },
  {
    gas: 'NH4SH',
    condenseTempK: [120, 220],
    altitudeNorm: 0.50,
    altitudeTempOffsetK: 35,
    // Jovian belt brown — NH3 + H2S photochemistry. Sits slightly
    // deeper than the NH3 deck (real Jupiter NH4SH at ~2-3 bar vs
    // NH3 at ~0.5 bar → +35 K hotter). Precursor requires the body's
    // cloud-top T to be in the NH3-active range — NH4SH formation
    // needs NH3 to ALSO be condensing nearby (it's a NH3 + H2S
    // reaction product). On ice giants (Neptune T=72 K below NH3
    // window), no NH3 → no NH4SH.
    precursor: (body, ctx) => {
      if (!ctx.isGaseous) return 0;
      const T = body.avgSurfaceTempK;
      if (T == null) return 0;
      return ctx.smoothstep(100, 130, T) * (1 - ctx.smoothstep(180, 220, T));
    },
  },
  {
    gas: 'NH3',
    condenseTempK: [120, 200],
    altitudeNorm: 0.80,
    altitudeTempOffsetK: 0,
    // Cosmic-abundance trace in H2/He giants; on terrestrials gate
    // on the atm record. NH3 condenses near the cloud-top (no
    // altitude offset) on Jupiter/Saturn-class temperate giants.
    precursor: (_body, ctx) => {
      if (ctx.isGaseous) return 1.0;
      return ctx.smoothstep(0.001, 0.05, ctx.atmFrac('NH3'));
    },
  },
  {
    gas: 'CH4',
    condenseTempK: [60, 130],
    altitudeNorm: 0.85,
    altitudeTempOffsetK: 0,
    // H2/He giants: trace CH4 → ice cirrus (Uranus/Neptune sparse
    // streaks at cloud-top). Terrestrials need CH4 in atm (Titan).
    precursor: (_body, ctx) => {
      if (ctx.isGaseous) return 1.0;
      return ctx.smoothstep(0.001, 0.05, ctx.atmFrac('CH4'));
    },
  },
  {
    gas: 'N2',
    condenseTempK: [30, 80],
    altitudeNorm: 0.50,
    altitudeTempOffsetK: 0,
    // Triton/Pluto: very cold, N2-dominant atm → N2 frost / sparse
    // cloud near surface. Requires substantial N2 atm presence.
    precursor: (_body, ctx) => {
      if (ctx.isGaseous) return 0;
      return ctx.smoothstep(0.1, 0.9, ctx.atmFrac('N2'));
    },
  },
];

// Haze aerosol formation gates — per-species calibration windows consumed
// by hazeContribution in procgen.mjs. The haze layer is still derived from
// body physics (atm + T + P), not a regime-keyed spec; these are the tuning
// edges those gates read. Each `[lo, hi]` pair is a smoothstep window;
// peaked species combine a `tempRise` against `1 − tempFall`. Calibration
// anchors (the regimes each window is centered on) are documented on the
// consuming case in hazeContribution: Titan ~95K THOLIN, Jupiter ~165K
// NH4SH, Saturn ~125K CHROMOPHORE, GJ 1214 b ~600K SALT, Venus ~720K H2SO4,
// Io-class SULFUR, hot-Jupiter SILICATE.
export const HAZE_GATES = {
  THOLIN:      { tempRise: [40, 95],   tempFall: [95, 150],   ch4: [0.001, 0.04], n2: [0.1, 0.6] },
  NH4SH:       { tempRise: [120, 165], tempFall: [165, 225] },
  CHROMOPHORE: { tempRise: [90, 125],  tempFall: [125, 180] },
  SALT:        { tempRise: [250, 625], tempFall: [625, 950] },
  H2SO4:       { tempRise: [500, 720], tempFall: [720, 1100], press: [5, 150] },
  SULFUR:      { tempRise: [250, 400], tempFall: [400, 800],  so2: [0.01, 0.3], pressFall: [0.5, 5], dryFall: [0.0, 0.2] },
  SILICATE:    { tempRise: [900, 1500] },
};

// Lifted mineral-dust gate — terrestrial, dry surface, thin atmosphere,
// moderate T (not frozen, not boiled). `maxPressureBar` is a hard cutoff
// (thicker air can't keep grains airborne); `pressFall` is the smoothstep
// that tapers strength toward it.
export const DUST_GATE = {
  dryFall: [0.0, 0.3], pressFall: [0.001, 1], tempRise: [150, 200], tempFall: [300, 400], maxPressureBar: 1,
};

// Resource occurrence — the resource grid is no longer a physics-derived
// bulk-composition readout. It records the body's NOTABLE MINERAL DEPOSITS:
// `resourcesFor` (procgen.mjs) draws TWO resource types per body from a
// context-weighted probability table and rolls a context-driven abundance
// for each (the other four are 0). Bulk composition is assumed background —
// silicate rock, etc. is everywhere and gameplay-boring, so it stops being
// a tracked-everywhere scalar and becomes "is it a notable deposit here?"
//
// Why a draw, not a derivation: the old `gain × bulk-fraction` model was
// chained to the identity silicates = 1 − metal − water, which guaranteed a
// bulk resource always dominated the top-2 — no amount of gain tuning could
// surface scarce resources or let arbitrary pairs co-occur (proven: even at
// exotics-in-55%-of-worlds the rare|rare pairs stayed at zero). A weighted
// draw without replacement makes any two resources able to land together,
// with their odds shaped by physical context rather than a hard floor.
//
// Per resource: `base` weight × the product of whichever `context`-axis
// multipliers apply to this body (absent axis ⇒ ×1). The axes ARE the
// physics, re-expressed as odds: hot/inner → metals, cold/icy → volatiles,
// metal-rich host → rare-earths + radioactives, tidal moon / gas giant →
// exotics. Then two distinct resources are drawn weighted-without-
// replacement, so a strong-fit resource is likely-not-guaranteed and a
// long-shot still has a chance.
//
// `abundance` is dynamic to the same context: a picked resource's mean
// scales from `weakMean`→`strongMean` by its normalized occurrence weight
// (strong contextual fit ⇒ richer deposit), and the first (primary) draw
// gets `primaryBonus`. So one table drives both presence AND richness.
//
// `_REALISTIC` keeps physics-flavored odds (bulk favored, context-shaped);
// `_TUNE` flattens the bases toward uniform for compositional diversity.
// Deleting the tune reverts to physics-flavored odds.
const RESOURCE_OCCURRENCE_REALISTIC = {
  context: {
    hotK: 400, coldK: 200,
    metalRichBulk: 0.40,
    metalRichHostDex: 0.10, metalPoorHostDex: -0.10,
    youngHostGyr: 3,
    icyFrac: 0.30, wateryFrac: 0.50,
  },
  abundance: { weakMean: 3, strongMean: 8, sd: 1.5, min: 1, max: 10, primaryBonus: 1.5 },
  resMetals:       { base: 4,   hot: 1.5, metalRichBulk: 2.0, gaseous: 0.2 },
  resSilicates:    { base: 5,   gaseous: 0.2 },
  resVolatiles:    { base: 3,   cold: 2.0, icy: 2.2, gaseous: 3.0, hot: 0.3 },
  resRareEarths:   { base: 1.5, metalRichHost: 2.2, metalPoorHost: 0.4 },
  resRadioactives: { base: 1.0, metalRichHost: 2.0, youngHost: 1.6 },
  resExotics:      { base: 0.8, gaseous: 2.0, tidalMoon: 3.0 },
};

// Gameplay tune — flatten the base weights toward uniform so the scarce
// resources compete with the bulk ones for a world's two deposits. Bases are
// equalized AND the context multipliers are compressed toward 1 (vs the
// realistic block's stronger pulls) — the realistic volatiles stack
// (cold × icy × gaseous) otherwise makes ice worlds a near-monoculture. The
// axes still tilt the odds (cold worlds lean volatile, metal-rich hosts lean
// rare-earth) but no longer dominate, so no single resource defines more
// than ~1/5 of worlds. Calibrated to that ceiling against the live catalog.
const RESOURCE_OCCURRENCE_TUNE = {
  resMetals:       { base: 3,   hot: 1.2, metalRichBulk: 1.3, gaseous: 0.55 },
  resSilicates:    { base: 3.2, gaseous: 0.55 },
  resVolatiles:    { base: 2.4, cold: 1.2, icy: 1.25, gaseous: 1.4, hot: 0.7 },
  resRareEarths:   { base: 3.6, metalRichHost: 1.4, metalPoorHost: 0.75 },
  resRadioactives: { base: 3.2, metalRichHost: 1.4, youngHost: 1.3 },
  resExotics:      { base: 3,   gaseous: 1.4, tidalMoon: 1.8 },
};

export const RESOURCE_OCCURRENCE = mergeTunes(RESOURCE_OCCURRENCE_REALISTIC, RESOURCE_OCCURRENCE_TUNE);

// ---------------------------------------------------------------------------
// Biosphere — three orthogonal derived fields: archetype × complexity × surface impact
// ---------------------------------------------------------------------------
//
// Two paths populate the three fields:
//   1. CSV-authored — bodies.csv carries `biosphere_archetype` and
//      `biosphere_complexity` columns. Curated rows (Sol's bodies)
//      author values verbatim (Earth = `carbon_aqueous, complex`;
//      Mars = `n/a, n/a` for sterile; etc.). The Filler uses these
//      as-is and computes surfaceImpact from the body's measured
//      productivity × per-body coupling for the authored archetype.
//   2. Procgen-derived — both cells blank on a CSV row means
//      "procgen target." The Filler runs argmax over the six
//      productivity scalars (productivityPreAtm + productivityPostAtm)
//      to pick archetype, applies per-archetype complexity thresholds
//      to bucket complexity, then derives surfaceImpact the same way
//      as the authored path.
//
// Complexity and surfaceImpact are split because they pull apart at the
// edges. Earth was chemically dominant in atmosphere for ~2 Gyr (post-
// GOE, pre-Cambrian) on entirely microbial life — high impact, low
// complexity. A complex Europa subsurface biosphere never touches the
// surface — high complexity, no impact. One ladder can't represent both.
//
// Fields:
//   biosphereArchetype       — argmax archetype label (this list)
//   biosphereComplexity      — bucketed off productivity using
//                              per-archetype thresholds; encodes
//                              probabilistic headwinds (silicate must
//                              climb a steeper ladder than carbon_aq
//                              to reach the same complexity tier)
//   biosphereSurfaceImpact   — scalar [0..1] = productivity × coupling,
//                              where coupling is per-body sampled from
//                              archetype substrate base (jittered log-
//                              normally) plus an always-on additive
//                              contribution at the microbial/complex
//                              tiers. Continuous, never identically zero
//                              once life is present.

// All recognized archetypes — each describes a distinct biochemistry /
// habitat combination. Productivity formulas in procgen.mjs derive a
// continuous [0..1] scalar per archetype from the body's physics; the
// argmax assigns the body's archetype label.
export const BIOSPHERE_ARCHETYPES = [
  'carbon_aqueous',      // Earth-standard, water + carbon
  'subsurface_aqueous',  // ice-shell ocean (Europa, Enceladus)
  'aerial',              // gas-giant atmospheric (Sagan's floaters)
  'cryogenic',           // methane/ethane solvent (Titan-hypothesized)
  'silicate',            // crystalline mineral metabolism (speculative SF)
  'sulfur',              // sulfur-cycle / thermal vent biology
];

// Complexity tiers — describe the life itself. `gaian` is intentionally
// not on this axis (it was never a complexity descriptor; it surfaces
// instead as the high-end of biosphereSurfaceImpact below). Ordered
// ladder (none < prebiotic < microbial < complex).
export const BIOSPHERE_COMPLEXITY = ['none', 'prebiotic', 'microbial', 'complex'];

// Per-archetype productivity thresholds for reaching each complexity
// tier. Steeper thresholds = harder ladder; every archetype CAN reach
// `complex` in principle, but only with high productivity. Anchors:
//   Earth     productivity 0.85 carbon_aq → complex
//   Mars      productivity 0.02 carbon_aq → none
//   K2-18b    productivity 0.30 carbon_aq → microbial
//   Venus     productivity 0.25 sulfur    → microbial
//   Io        productivity 0.20 sulfur    → microbial
//   Jupiter   productivity 0.22 aerial    → microbial
//   Europa    productivity 0.55 sub_aq    → complex
//   Titan     productivity 0.50 cryogenic → complex
// Each entry: [prebiotic, microbial, complex]. < prebiotic → none;
// >= complex → complex. Thresholds are exclusive at the lower bound
// (matches the existing labelsFromProductivity convention).
export const COMPLEXITY_THRESHOLDS = {
  carbon_aqueous:     [0.05, 0.20, 0.50],   // baseline
  sulfur:             [0.05, 0.20, 0.50],   // energy-rich chemistry
  aerial:             [0.05, 0.20, 0.60],   // no surface anchor; harder complex
  subsurface_aqueous: [0.10, 0.30, 0.50],   // mild headwind on lower tiers
  cryogenic:          [0.10, 0.30, 0.50],   // slow cold-solvent chemistry
  silicate:           [0.15, 0.35, 0.65],   // hardest ladder; speculative substrate
};

// Surface-impact buckets for display. Scalar biosphereSurfaceImpact
// thresholds — `< 0.05 → none`, `0.05–0.20 → trace`, `0.20–0.50 →
// modifying`, `>= 0.50 → dominant`. Cutoffs exposed here so the audit,
// the info card, and any other reader share one source.
export const BIOSPHERE_IMPACT_LEVELS = ['none', 'trace', 'modifying', 'dominant'];
export const IMPACT_BUCKET_THRESHOLDS = [0.05, 0.20, 0.50];

// Substrate surface coupling — per-body multiplier on productivity that
// produces biosphereSurfaceImpact before life contribution is added.
// `base` is the archetype's typical coupling; `sigma` is the log-space
// jitter (multiplicative — large sigma produces a fat upper tail). For
// subsurface_aqueous specifically, base is low (sealed by default) but
// sigma is wide — Enceladus-class plume worlds exist alongside sealed
// Europas, and the log-normal tail naturally produces both.
// Calibration note: the procgen productivity distribution is right-skewed
// (most archetypes' >0.5 productivity tail is fatter than the plan's
// anchor table assumed), so base coupling is set conservatively for the
// non-carbon archetypes — only carbon_aqueous gets the uncapped path to
// `dominant`, matching the science framing that surface-light-coupled
// photosynthesis is the unique route to atmosphere-running biospheres.
// cryogenic / sulfur / silicate cap at `modifying` in practice.
export const ARCHETYPE_COUPLING_PRIOR = {
  carbon_aqueous:     { base: 1.00, sigma: 0.10 },   // surface biosphere by definition
  aerial:             { base: 1.00, sigma: 0.10 },   // lives in the atmosphere; bounded by low productivity
  sulfur:             { base: 0.50, sigma: 0.20 },   // Venus/Io atm coupling; capped below dominant
  cryogenic:          { base: 0.40, sigma: 0.25 },   // Titan-class slow-chemistry surface
  silicate:           { base: 0.20, sigma: 0.40 },   // speculative; mostly substrate-bound
  subsurface_aqueous: { base: 0.05, sigma: 0.60 },   // sealed default, fat tail for plumes
};

// Additive life contribution to coupling once the body crosses into
// the COMPLEX complexity tier. Log-normal: median anchors the typical
// addition; sigma controls the upper tail. Always-on (never zero) so
// complex biospheres always leave at least a faint signature. The fat
// tail is where the "telescopes poking out of the ice" case lives —
// no discrete breakthrough roll, just the natural log-normal tail
// (~3-in-1000 bodies clear contribution > 0.30 for subsurface_aqueous).
// Sigma tuning rationale: subsurface_aqueous keeps the widest tail
// because the "telescopes poking through ice" case is the user-facing
// narrative point; cryogenic / sulfur / silicate get tighter tails
// because their archetypes shouldn't routinely reach `dominant`
// (only carbon_aqueous gets that path). Carbon_aqueous keeps a
// moderate sigma — Earth's productivity is already near the dominant
// floor; extra tail width here would over-paint complex Earths.
export const LIFE_SURFACE_CONTRIBUTION = {
  carbon_aqueous:     { median: 0.08, sigma: 0.6 },
  aerial:             { median: 0.10, sigma: 0.5 },
  sulfur:             { median: 0.05, sigma: 0.5 },
  cryogenic:          { median: 0.04, sigma: 0.5 },
  silicate:           { median: 0.03, sigma: 0.6 },
  subsurface_aqueous: { median: 0.03, sigma: 1.0 },
};

// Smaller, tighter version of LIFE_SURFACE_CONTRIBUTION applied at the
// MICROBIAL tier. Biosignature work (methanogen trace gases, pre-
// Cambrian O₂) supports microbial biospheres being faintly detectable
// in principle; medians 3–5× smaller than the complex tier keep this
// honest without flooding the catalog with weakly-flagged microbial
// worlds. Set null on any archetype if microbial signatures should
// stay invisible — current calibration enables it everywhere.
export const MICROBIAL_SURFACE_CONTRIBUTION = {
  carbon_aqueous:     { median: 0.020, sigma: 0.4 },
  aerial:             { median: 0.025, sigma: 0.4 },
  sulfur:             { median: 0.015, sigma: 0.5 },
  cryogenic:          { median: 0.012, sigma: 0.5 },
  silicate:           { median: 0.010, sigma: 0.5 },
  subsurface_aqueous: { median: 0.008, sigma: 0.6 },
};

// Stars whose body list is hand-curated and authoritative. Curated
// systems bypass procgen backfill (architect overlay, moon/ring
// derivation); their CSV silence reads as "really none / not yet
// curated" rather than "we don't know, please invent." Sol is the
// canonical reference; extend this set when other systems get fully
// hand-tuned.
//
// Biosphere labels for curated bodies travel through bodies.csv via
// the `biosphere_archetype` + `biosphere_complexity` columns (Earth
// authors `carbon_aqueous, complex`; sterile Sol bodies author `n/a,
// n/a`; etc.) — same cell-semantics convention as the rest of the
// CSV, no separate override map.
export const CURATED_SYSTEM_HOSTS = new Set(['sol']);
