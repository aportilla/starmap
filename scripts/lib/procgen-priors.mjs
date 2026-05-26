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
  // planets; surviving systems are very rare (~10 confirmed in the
  // literature). Debris disks are common but those aren't planets.
  WD: { mean: 0.1, sd: 0.4, min: 0, max: 3  },
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

// Conservative habitable-zone bounds (AU). Not used at runtime — species
// tolerance computes habitability per-species. Included here so the
// Architect can bias the "temperate" insolation zone toward rocky worlds
// rather than (say) sub-Neptunes.
export const HABITABLE_ZONE_AU = {
  O:  [50,    100  ],
  B:  [20,     50  ],
  A:  [ 2.5,    4.0],
  F:  [ 1.3,    2.0],
  G:  [ 0.95,   1.4],  // Sol baseline
  K:  [ 0.4,    0.9],
  M:  [ 0.05,   0.3],
  WD: [ 0.01,   0.02],
  BD: [ 0.002,  0.01],
};

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

// Moon-count capacity scale — multiplied by the host's Hill radius (AU)
// to set λ for a Poisson draw on the moon count. Linear scaling: a planet
// with a 10× larger Hill sphere holds 10× more satellites. Captures the
// dominant physical signal — Hill volume sets how much circumplanetary
// disk + capturable planetesimals stay bound — without modeling the
// individual capture/migration history per moon.
//
// Sol-anchored λ values at MOON_CAPACITY_SCALE = 12:
//   Mercury (R_H ≈ 0.0015 AU): λ ≈ 0.02 → 0 moons (Mercury: 0)
//   Earth   (R_H ≈ 0.01   AU): λ ≈ 0.12 → ~0–1 (Earth: 1)
//   Mars    (R_H ≈ 0.007  AU): λ ≈ 0.09 → ~0 (Mars: 2 captured asteroids)
//   Jupiter (R_H ≈ 0.354  AU): λ ≈ 4.2  → ~4 (Sol: 4 Galilean + tail)
//   Saturn  (R_H ≈ 0.434  AU): λ ≈ 5.2  → ~5 (Sol: 6+ major)
//   Uranus  (R_H ≈ 0.469  AU): λ ≈ 5.6  → ~6 (Sol: 5 major)
//   Neptune (R_H ≈ 0.771  AU): λ ≈ 9.2  → ~9 (Sol: Triton + tail)
//
// Sits ~3× below the unconstrained physical anchor (Galilean CPD models
// predict λ ≈ 12–20 for a Sol-Jupiter analog if Hill volume alone gated
// count). The lower scale keeps the system-diagram's back/front moon-pool
// budget readable. Outlier rolls past MOON_COUNT_MAX are pruned uniformly
// at random (see MOON_COUNT_MAX_TUNE below).
//
// Hot Jupiters (R_H ≈ 0.003 AU at 0.05 AU): λ ≈ 0.04 → 0 moons, matching
// observation. Migrated giants lose their satellites naturally through
// the shrunk Hill sphere; no separate migration-strip pass needed.
export const MOON_CAPACITY_SCALE = 12;

// Defensive ceiling against the unbounded Poisson upper tail. For λ = 9
// (Neptune-class) the 99th-percentile draw is ~17 — well past any
// physical Sol anchor. The realistic peer caps at 8, which still
// preserves the gas-giant-dominates-the-top variety the unconstrained
// distribution produces. This is the value the architect would use
// under pure realism; the gameplay tune below tightens it further.
const MOON_COUNT_MAX_REALISTIC = 8;

// Gameplay tune: tighten the per-planet moon cap from the realistic
// 8 down to 5. The architect samples the full Poisson(λ) count, builds
// every candidate moon under the realistic mass + bulk-composition
// priors, then uniformly-randomly prunes the survivor set to this cap
// (Fisher-Yates partial shuffle, deterministic via a per-planet PRNG).
//
// Random pruning is load-bearing: moon mass and bulk composition are
// independently sampled today, but any future scheme that ties
// composition to orbital position (mIdx) would silently bias the type
// distribution if we just clipped from the outer slots. Uniform random
// preserves moon-type frequency (Europa-class / Ganymede-class /
// Titan-class shares) exactly — only absolute count drops. Mirrors
// the planet-prune-to-K mechanism in procgen-architect.mjs.
//
// Player-visible effect: Saturn- and Neptune-class moon arcs stay
// readable on the system-diagram rim split — no more 6-to-8-moon arcs
// overlapping into illegibility — and the per-cluster colonization
// decision space stays tractable.
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
export const MOON_MASS_LOG_EARTH = { mean: -3, sd: 1.5, min: -5, max: 0.3 };

// Maximum moon-to-host mass ratio for stable orbital dynamics. Earth/
// Moon sits at 1.2%; Pluto/Charon at 12% behaves as a binary, not a
// moon. 3% is a conservative-stable cap that allows mass-comparable
// satellites without crossing into binary-planet territory.
export const MOON_MAX_HOST_MASS_RATIO = 0.03;

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
export const ACCRETION_EFFICIENCY = {
  inner: { mean: 20, sd: 10, min: 1,   max: 80, log: true },
  outer: { mean: 3,  sd: 2,  min: 0.3, max: 15, log: true },
};

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
export const MIGRATION_RATE = 0.10;
export const MIGRATION_FRACTION = { mean: 0.02, sd: 0.015, min: 0.005, max: 0.08 };
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
  // Ice: surface ice without liquid (Callisto/Triton-class).
  iceIceMin:            0.5,
  iceWaterCeiling:      0.1,
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

// Orbital phase (starting angle around the orbit) — uniform 0..360. Each
// body picks its own so the diagrammatic system view doesn't comb-align.
export const ORBITAL_PHASE_DEG = { min: 0, max: 360 };

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
// leaning) or cold (outward of giants, volatile-leaning). Composition
// lives in the six-resource grid; the renderer derives belt color from
// resVolatiles vs. rocky resources. Size character emerges from
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
// Herschel debris statistics (Su 2006, Thureau 2014, Chen 2014); WD
// captures metal-pollution-evidence disks (Zuckerman 2010 — ~25–50%
// of WDs accrete tidally-disrupted debris).
const BELT_OCCURRENCE_BY_CLASS_REALISTIC = {
  O:  { warm: 0.15, cold: 0.19 },
  B:  { warm: 0.21, cold: 0.26 },
  A:  { warm: 0.25, cold: 0.32 },
  F:  { warm: 0.25, cold: 0.25 },
  G:  { warm: 0.26, cold: 0.19 },
  K:  { warm: 0.25, cold: 0.18 },
  M:  { warm: 0.22, cold: 0.14 },
  WD: { warm: 0.11, cold: 0.11 },
  BD: { warm: 0.06, cold: 0.06 },
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

// Resource priors per belt context. Sampled as truncated normals,
// rounded to integer, clamped [0, 10]. The grid carries composition
// AND drives rendered character (resVolatiles dominant → bright icy
// chunks; rocky resources dominant → tan/dusty chunks). Wide sd
// reflects the real spread: a warm belt can be a Sol-Main-Belt rocky
// parent-body system OR an HD 69830-style processed-material cascade,
// and the priors here cover both.
//
//   warm: rocky-dominant — high metals/silicates, low volatiles.
//         Anchored on Sol Main Belt (rocky) + HD 69830 (warm dust)
//         composition envelope.
//   cold: volatile-dominant — high volatiles, low rocky. Anchored on
//         Kuiper Belt (icy KBOs) + β Pic outer ring (mixed cold dust)
//         envelope.
const BELT_RESOURCE_PRIORS_REALISTIC = {
  warm: {
    resMetals:        { mean: 6, sd: 3, min: 0, max: 10 },
    resSilicates:     { mean: 6, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 1, sd: 1, min: 0, max: 10 },
    resRareEarths:    { mean: 3, sd: 2, min: 0, max: 10 },
    resRadioactives:  { mean: 2, sd: 2, min: 0, max: 10 },
    resExotics:       { mean: 2, sd: 2, min: 0, max: 10 },
  },
  cold: {
    resMetals:        { mean: 2, sd: 2, min: 0, max: 10 },
    resSilicates:     { mean: 2, sd: 2, min: 0, max: 10 },
    resVolatiles:     { mean: 7, sd: 3, min: 0, max: 10 },
    resRareEarths:    { mean: 1, sd: 1, min: 0, max: 10 },
    resRadioactives:  { mean: 1, sd: 1, min: 0, max: 10 },
    resExotics:       { mean: 3, sd: 2, min: 0, max: 10 },
  },
};

// Gameplay tune: belts should be strategic mining targets that DOMINATE
// their resource niche, not generic "any-resource" sources roughly equal
// to planet surface mining. Without these tunes a rocky planet
// (5/6/3/4/3/1) ties or beats a warm belt on per-cell metal yield once
// volumetric extraction factors in — so a player thinking "where do I
// send the mining fleet" picks planets every time and belts feel
// decorative. Bumps:
//   - warm resMetals    6→8 (THE strategic metal source)
//   - cold resVolatiles 7→9 (THE volatile source)
// Other resources untouched.
const BELT_RESOURCE_PRIORS_TUNE = {
  warm: { resMetals:    { mean: 8 } },
  cold: { resVolatiles: { mean: 9 } },
};

export const BELT_RESOURCE_PRIORS = mergeTunes(
  BELT_RESOURCE_PRIORS_REALISTIC,
  BELT_RESOURCE_PRIORS_TUNE,
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

// Occurrence multiplier applied when the system has no gas/ice giant.
// Without a shepherd, belts can still form but are rarer (Wyatt 2008
// estimates <20% of the giant-shepherded rate for primordial belts;
// dust cascades are less affected because they don't depend on
// resonance trapping). Halfway between the old discrete-only penalty
// (0.15–0.25) and collisional-only no-penalty (1.0) to represent the
// blended physical likelihood.
export const GIANTLESS_BELT_PENALTY = {
  warm: 0.30,
  cold: 0.40,
};

// Mass threshold for "giant enough to shepherd a belt". Sub-Neptune-class
// bodies (~7 M⊕ and up) are heavy enough to dominate orbital resonances
// the way Sol's Jupiter does for the Main Belt and Neptune does for the
// Kuiper Belt. The threshold is mass-based rather than type-keyed so
// migrated giants stripped of their envelopes (chthonian-class survivors)
// still anchor belts if they retain enough core mass.
export const SHEPHERD_MIN_MASS_EARTH = 7;

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
export const TECTONIC_BASE = { mean: 0.4, sd: 0.25, min: 0, max: 1.0 };

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
export const MAGNETIC_FIELD = {
  capBase:        0.5,   // gauss at M=1 (Earth-anchored cap)
  capExponent:    0.3,   // mass scaling
  giantBoost:     5.0,   // multiplier for radius >= 2 (deep convective dynamo)
  noise:          { mean: 1.0, sd: 0.5, min: 0.1, max: 3.0 },
};

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
// trace (sub-percent). See ATMOSPHERE_O2_BIOTIC_LIFT below for the
// biosphere-conditional uplift.
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
//                     ATMOSPHERE_O2_BIOTIC_LIFT.
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

// Atm regime thresholds. Kept here so they can be tuned without touching
// the dispatch code in procgen.mjs.
export const ATMOSPHERE_REGIME_THRESHOLDS = {
  coldTempMaxK:      200,    // T below → cold_outgassed
  thickPressureBar:  30,     // P above → thick_outgassed
  wetBulkWaterMin:   1e-4,   // bulkWater above → wet_outgassed
};

// O2 weight multiplier applied to `rocky`/`ocean` worldClass atmospheres
// when the host carries oxygenic-photosynthesis-grade biosphere. Without
// life, O2 stays at its trace photolysis weight (~0.05); with `complex`
// or `gaian` carbon_aqueous life, weight × 60 ≈ 3, restoring Earth-class
// O2 fractions on planets that should actually have them. Microbial
// carbon_aqueous gets a partial lift (×15 ≈ 0.75) to model early-Earth
// "Great Oxidation transition" worlds where O2 is rising but not dominant.
export const ATMOSPHERE_O2_BIOTIC_LIFT = {
  carbon_aqueous: { microbial: 15, complex: 60, gaian: 60 },
};

// Sub-trace surface pressure is treated as airless — the Filler skips
// atm fill when surfacePressureBar is below this floor (covers airless
// rocky moons like Callisto/Ganymede whose nominal atmospheres are
// kinetic exospheres rather than thermodynamic ones).
export const ATMOSPHERE_MIN_PRESSURE_BAR = 0.01;

// Insolation upper bound below which a body is treated as "cold" by the
// cloud / haze / biosphere / iceFraction / thick-atm rules. Cold bodies
// have S < this threshold; warm/temperate/hot bodies sit above. Anchored
// roughly at Sol's Jupiter orbit (S ≈ 0.04); Mars is just above at 0.43,
// Europa well below at ~0.04.
export const INSOLATION_COLD_MAX = 0.1;

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
export const ATMOSPHERIC_RETENTION = {
  // Jeans-escape sigmoid: v_esc/v_th below jeansLow → fully stripped;
  // above jeansHigh → fully retained.
  jeansLow:       6,
  jeansHigh:      13,
  // Magnetic-shielding sigmoid: B in gauss. magneticFloor is the
  // residual retention for bodies with no internal field (Mars-class
  // stellar-wind erosion is real but not total).
  magneticFloor:  0.05,
  magneticLow:    0.02,
  magneticHigh:   0.20,
};

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

// Haze layer is derived directly from body physics in procgen.mjs's
// hazeFor — per-species formation gates consult atm + T + P rather than
// looking up a regime-keyed spec. See hazeContribution for the
// per-species gates and calibration anchors.

// Resources are now physics-derived in resourcesFor (procgen.mjs):
//   metals       ∝ bulkMetalFraction
//   silicates    ∝ (1 - bulkMetal - bulkWater)
//   volatiles    ∝ surface water/ice cover + atm volatile fraction
//                  (gaseous bodies: 8 + bulkWater × 20)
//   rare earths  ∝ stellar metallicity
//   radioactives ∝ stellar metallicity × age-decay
//   exotics      ∝ gaseous bonus + tidal-heated moon bonus + noise
// No class-keyed table.

// ---------------------------------------------------------------------------
// Biosphere — two orthogonal axes: archetype × tier
// ---------------------------------------------------------------------------

// Tiers form an ordered ladder (none < prebiotic < microbial < complex <
// gaian); the runtime can answer "is there any life here?" with a tier
// check and "what kind?" with the archetype check. Sterile worlds carry
// tier=`none` and archetype=null.
export const BIOSPHERE_TIERS = ['none', 'prebiotic', 'microbial', 'complex', 'gaian'];

// All recognized archetypes. Each describes a distinct biochemistry /
// habitat combination — see BIOSPHERE_HABITATS for physics-keyed gates.
export const BIOSPHERE_ARCHETYPES = [
  'carbon_aqueous',      // Earth-standard, water + carbon
  'subsurface_aqueous',  // ice-shell ocean (Europa, Enceladus)
  'aerial',              // gas-giant atmospheric (Sagan's floaters)
  'cryogenic',           // methane/ethane solvent (Titan-hypothesized)
  'silicate',            // crystalline mineral metabolism (speculative SF)
  'sulfur',              // sulfur-cycle / thermal vent biology
];

// Per-(worldClass, archetype) rolls. `gate` constrains which insolation
// zone the host body must sit in for this archetype to even consider
// appearing; `occurrenceRate` is P(this archetype takes hold | gate
// satisfied); `tierWeights` is the conditional distribution over non-`none`
// tiers when it does. Each eligible archetype rolls independently per
// body; multiple hits get resolved by highest tier (ties → archetype
// listed earlier wins, so put rarer/more-evocative archetypes first).
//
// Realistic block uses literature-derived rates where possible:
//   - carbon_aqueous: 30-40% of temperate rocky/ocean worlds carry life of
//     SOME tier. Within published f_life envelopes (Lineweaver 2007,
//     Schulze-Makuch & Irwin 2008, Catling & Kasting 2017 — pessimistic
//     ~1%, optimistic ~50%; we sit on the optimistic-but-defensible side).
//   - subsurface_aqueous: Europa/Enceladus/Ganymede make this the most
//     defensible "exotic habitat." Hand & Carlson 2017 estimate "a few
//     percent" of icy moons may host subsurface oceans with chemistry.
//     3% is conservative-optimistic.
//   - sulfur: extension of Earth's chemoautotrophic thermal-vent biology.
//     Real-but-rare; 1-3% is a reasonable extrapolation.
//   - silicate, cryogenic, aerial: speculative SF tropes, no astrobiology
//     consensus or examples. Realistic estimates are <0.1%. We keep them
//     non-zero so the discovery moment exists at all, but they're
//     deeply rare without the gameplay tune.
// Biosphere habitats — physics-keyed (no class input). Each entry is a
// {archetype, habitat-name, physical-gates, occurrenceRate, tierWeights}
// tuple. The Filler walks the list, fires each habitat that matches the
// body's physical state, and the highest-tier hit wins.
//
// Tuning rationale (preserved from the prior class-keyed table):
//
// (1) carbon_aqueous tier weights are tuned for 4X discovery — complex/
//     gaian biased over the realistic prebiotic-heavy tail (Earth was
//     prebiotic for ~1 Gyr, but "organic chemistry without replicating
//     life" is the least interesting tier for the player).
//
// (2) Exotic archetypes (silicate, cryogenic, aerial) get boosted
//     occurrence rates so they actually appear in a playthrough — real
//     literature rates are <0.1% and would make them once-per-galaxy
//     unicorns.
//
// (3) Aerial gas-world rates lifted (8-10%) for the visual-distinctness
//     of atmospheric biospheres; ice_giant stays cooler at 2%.
//
// Habitats can overlap — a Europa-class body matches both
// `icy_moon_subsurface` AND no other branch (its surface T excludes
// all carbon/silicate paths). A super-Earth in the temperate zone
// might match both ocean_temperate and rocky_temperate; the gates are
// tight enough that overlap is rare. When it happens, multiple rolls
// fire and the highest-tier wins.
export const BIOSPHERE_HABITATS = [
  // ─── carbon_aqueous — liquid water, atm, temperate ───
  {
    archetype: 'carbon_aqueous',
    name: 'rocky_temperate',
    gates: { tempMinK: 250, tempMaxK: 340, waterMin: 0.05, waterMax: 0.5, pressureMin: 0.006 },
    occurrenceRate: 0.30,
    tierWeights: { prebiotic: 0.35, microbial: 0.30, complex: 0.25, gaian: 0.10 },
  },
  {
    archetype: 'carbon_aqueous',
    name: 'ocean_temperate',
    gates: { tempMinK: 250, tempMaxK: 340, waterMin: 0.5, pressureMin: 0.006 },
    occurrenceRate: 0.40,
    tierWeights: { prebiotic: 0.25, microbial: 0.30, complex: 0.30, gaian: 0.15 },
  },
  {
    archetype: 'carbon_aqueous',
    name: 'desert_temperate',
    gates: { tempMinK: 250, tempMaxK: 340, waterMax: 0.05, iceMax: 0.05, pressureMin: 0.006 },
    occurrenceRate: 0.05,
    tierWeights: { prebiotic: 0.80, microbial: 0.20 },
  },

  // ─── subsurface_aqueous — cold + high bulkWater + ice shell ───
  // Europa/Enceladus class. Doesn't require atm — ice shell IS the
  // habitat barrier; subsurface ocean does the rest.
  {
    archetype: 'subsurface_aqueous',
    name: 'icy_moon',
    gates: { tempMaxK: 200, bulkWaterMin: 0.2, iceMin: 0.5, radiusMax: 2 },
    occurrenceRate: 0.08,
    tierWeights: { microbial: 0.85, complex: 0.15 },
  },

  // ─── aerial — gas/ice giant atmospheric biospheres ───
  {
    archetype: 'aerial',
    name: 'gas_giant',
    gates: { radiusMin: 8 },
    occurrenceRate: 0.10,
    tierWeights: { microbial: 0.85, complex: 0.15 },
  },
  {
    archetype: 'aerial',
    name: 'gas_dwarf_warm',
    gates: { radiusMin: 2, radiusMax: 8, tempMinK: 200 },
    occurrenceRate: 0.08,
    tierWeights: { microbial: 0.85, complex: 0.15 },
  },
  {
    archetype: 'aerial',
    name: 'ice_giant_cold',
    gates: { radiusMin: 3.5, tempMaxK: 200 },
    occurrenceRate: 0.02,
    tierWeights: { microbial: 0.90, complex: 0.10 },
  },

  // ─── cryogenic — cold terrestrial with hydrocarbon cycle ───
  // Titan-class. Gates on cold + retained atm + volatile-rich bulk
  // — these conditions imply CH4 in the atm via the cold_outgassed
  // regime, no need to reference atm gases directly.
  {
    archetype: 'cryogenic',
    name: 'titan_class',
    gates: { tempMaxK: 200, radiusMax: 2, bulkWaterMin: 0.1, pressureMin: 0.5 },
    occurrenceRate: 0.04,
    tierWeights: { prebiotic: 0.80, microbial: 0.20 },
  },

  // ─── silicate — hot solid surfaces with mineral chemistry ───
  {
    archetype: 'silicate',
    name: 'hot_rocky',
    gates: { tempMinK: 400, tempMaxK: 900, radiusMax: 2, tectonicMin: 0.1 },
    occurrenceRate: 0.005,
    tierWeights: { prebiotic: 0.70, microbial: 0.25, complex: 0.05 },
  },
  {
    archetype: 'silicate',
    name: 'lava_silicate',
    gates: { tempMinK: 900, radiusMax: 2 },
    occurrenceRate: 0.03,
    tierWeights: { prebiotic: 0.65, microbial: 0.30, complex: 0.05 },
  },

  // ─── sulfur — thermal vents + active outgassing ───
  // Sulfur chemistry needs SO2 + sulfides which are produced by
  // volcanic outgassing. Gate on (warm/hot + active tectonics + atm)
  // rather than referencing SO2 directly — those conditions are what
  // produce the SO2 in the first place.
  {
    archetype: 'sulfur',
    name: 'thermal_vents',
    gates: { tempMinK: 280, tempMaxK: 400, tectonicMin: 0.5, pressureMin: 0.1 },
    occurrenceRate: 0.03,
    tierWeights: { microbial: 1.0 },
  },
  {
    archetype: 'sulfur',
    name: 'volcanic',
    gates: { tempMinK: 600, radiusMax: 2, tectonicMin: 0.7 },
    occurrenceRate: 0.05,
    tierWeights: { microbial: 1.0 },
  },
];
