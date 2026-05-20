# Procgen Architect Refactor — Physics-Rooted System Generation

Working plan for replacing the Architect's `PlanetType` taxonomy with continuous physics-driven generators. Builds on the worldClass refactor (`PROCGEN-FUNDAMENTALS-REFACTOR.md`) which decoupled `worldClass` from physics generation; this doc extends the same principle to the architect side.

Status: All phases (A–F) landed. `PlanetType` and its dispatch tables are fully removed; the architect now runs end-to-end on continuous physics (disk → mass → migration → composition → satellites).

---

## Progress

| Phase | Status | Notes |
|---|---|---|
| **A — Disk-physics foundations** | ✅ landed | Helpers + priors in place; anchor regression script at `scripts/check-disk-physics.mjs` (`npm run check:disk-physics`) |
| **B — Continuous mass pipeline** | ✅ landed | `planetTypeFor` is now a pure derived label; mass histogram is continuous |
| **C — Formation zone + migration** | ✅ landed | `formationAu` primary attribute; Type II migration with inner-sweep collision handling |
| **D — Multi-snow-line composition** | ✅ landed | Four-zone formation gate (`zoneForFormationAu`); `bulkVolatileFraction` persisted as primary field; audit reports per-zone geometric means against priors |
| **E.1 — Moons from Hill-sphere capacity** | ✅ landed | `hillRadiusAu` helper; `generateMoons` is Poisson(R_H × `MOON_CAPACITY_SCALE`), no planetType dispatch; visual hard cap `MOON_COUNT_MAX = 8`; audit buckets by R_H |
| **E.2 — Rings from Roche-zone disruption** | ✅ landed | `generateRing` is Bernoulli(R_p² × `RING_DISRUPTION_RATE`); two composition priors (`RING_RESOURCE_ICY` / `RING_RESOURCE_ROCKY`) gated on formationAu vs H2O frost line; audit buckets by R_p |
| **F — Delete PlanetType + cleanup** | ✅ landed | `PlanetType` type union, `Body.planetType` field, `planetTypeFor`, `PLANET_TYPES`, `SHEPHERD_PLANET_TYPES` all deleted; `SHEPHERD_MIN_MASS_EARTH = 7` replaces type-set belt-shepherd gate; audit's planet-class table now descriptive-only (no downstream consumers) |

### Calibration deviations from doc anchors (informational)

The doc lists target anchor values for each phase. Landing-time tuning produced these deviations — each documented in code comments where the constant lives:

- **Phase A — `MMSN_NORMALIZATION` and `SNOW_LINE_BOOSTS.H2O`** were tuned higher than the doc's classical-MMSN values to satisfy the load-bearing `isolationMass(5 AU, Sun)` anchor (gas-giant gating). Side effect: outer-disk `isolationMass(20 AU, Sun)` overshoots the doc anchor (graphed as informational in the anchor check, not a hard gate). Phase B+ will need a disk-extent cutoff or pebble-drift correction to bring outer M_iso down; see the `SNOW_LINE_BOOSTS` comment.
- **Phase B — `ACCRETION_EFFICIENCY` zoned (inner/outer) with heavy-tailed log-normal**, departing from the doc's single distribution. Inner zone captures terrestrial mergers (Theia-class impacts → Earth-mass); outer zone keeps cores modest so the envelope multiplier delivers gas-giant variety. `ENVELOPE_FRACTION` median anchored on Saturn-Neptune-Uranus rather than Jupiter (doc had Jupiter as typical).
- **Phase C — `MIGRATION_RATE` set to 0.6 vs the doc's ~10%**. The architect-eligible pool of gas giants is structurally small (~5 per build) because most procgen large bodies come via the overlay path, which is excluded from migration (catalog observations would have already detected any hot Jupiter around an observed system). High per-roll rate lifts hot-Jupiter visibility without distorting the underlying physics. Revisit once the eligible pool grows.
- **Phase D — `bulkVolatileFraction` persisted as a primary field** (not derived-only). Decision favored render-time consumers: surface chromophore, atmosphere regime, biosphere gates can read the field directly without recomputing the zone from `formationAu` + frost lines on every consumer. CSV-level stability also means Sol curation (Earth 0.005, Uranus 0.30, etc.) doesn't drift between builds.
- **Phase E.1 — `MOON_CAPACITY_SCALE = 12` calibrated to "major moons" not full satellite counts**. Anchored so Sol-Jupiter (R_H ≈ 0.35 AU) yields λ ≈ 4 (matches the 4 Galileans), not the ~95 confirmed Jupiter satellites. Visual-budget driven: the system-diagram dome lays moons on back/front pools around the planet rim, and >8 moons clutter the silhouette into unreadability. Side effect: 94% of procgen planets land in the close-in "tiny" Hill bucket (R_H < 0.005 AU) where λ < 0.06 → near-zero moons. This is physically correct (close-in planets lose moons to stellar tides — Mercury/Venus = 0) but represents a large drop from the prior tune's ~4000 procgen moons down to ~260. Earth-Moon analogs land at ~11% per Earth-analog draw (consistent with the Theia-impact origin theory: rare oligarchic-merger event). Outer gas giants concentrate the moon supply, with `MOON_COUNT_MAX = 8` clipping the saturated upper tail. Revisit the scale if gameplay needs more colonizable satellites.
- **Phase E.2 — `RING_DISRUPTION_RATE = 0.00239` calibrated to the prior visual-budget tune, not the doc's realistic anchor**. Doc target was 80% rings on gas giants; we land at ~20–30% (matches the previous `RING_OCCURRENCE_BY_TYPE_TUNE` rate). Most real ring systems are sub-pixel at our zoom and would only register as visual noise, so the calibration stays at the perceptible-rate level. The R² scaling concentrates rings on gas giants more sharply than the prior per-type tune did: super-Earth ring rate drops from ~7% to ~1% (still ~40 ringed super-earths galaxy-wide at procgen scale — enough for the iconic SF "ringed Earth-analog" beat to remain recurring). Ring composition gates on host formationAu vs H2O frost line — icy/rocky split is binary at the prior level, with per-resource sd within each prior providing variety.

### Pickup notes for a fresh session

Start by reading this section + the "Phasing" section below. Phase A/B/C/D deliverables are in:
- `scripts/lib/astrophysics.mjs` — disk-physics helpers (`frostLineS`, `frostLineAU`, `solidSurfaceDensity`, `isolationMass`, `hillRadiusAu`)
- `scripts/lib/procgen-priors.mjs` — all priors (disk physics, accretion, envelope, migration, four-zone bulk composition, `MOON_CAPACITY_SCALE` + `MOON_COUNT_MAX`, `RING_DISRUPTION_RATE` + `RING_RESOURCE_ICY`/`RING_RESOURCE_ROCKY`); `PROCGEN_VERSION = 'v15'`; `zoneForFormationAu` helper
- `scripts/lib/procgen-architect.mjs` — `buildStarDiskContext`, `buildPlanetCore`, `attachMoonsAndRing`, `migratePass`, `sampleBulk{Water,Metal,Volatile}Fraction`
- `scripts/lib/procgen.mjs` — `bulk{Water,Metal,Volatile}FractionFor`, filler four-zone fill with per-star `frostLinesAu`
- `src/data/stars.ts` — `Body.formationAu`, `Body.bulkVolatileFraction`
- `src/data/bodies.csv` — `formation_au` + `bulk_volatile_fraction` columns (Sol curated, others empty)
- `scripts/check-disk-physics.mjs` — Phase A anchor regression gate
- `scripts/audit-procgen.mjs` — Mass histogram + gas-giant-by-S-band + four-zone bulk-composition audit (`auditBulkComposition`)

To resume Phase F: `PlanetType` and the remaining `*_BY_TYPE` tables are now consumer-free for ring/moon generation. Surviving callers are the audit script's planet-type-mix table, `SHEPHERD_PLANET_TYPES` for belt anchoring, and `planet.planetType` persisted on each catalog/architect planet (only consumed by the audit). Phase F drops the field + type union + `planetTypeFor`, replaces `SHEPHERD_PLANET_TYPES` with a mass threshold (`SHEPHERD_MIN_MASS_EARTH`), and reworks the audit's planet-type-mix table to bucket by mass-radius bands.

---

## Where we are starting from

The worldClass refactor (completed) decoupled the runtime planet taxonomy from physics generation. `worldClass` is now a pure derived label that flows downstream from settled physical state — `mass, radius, T, P, water, ice, bulkWater, bulkMetal, atm composition` — and is consumed only by UI labels and renderer palettes. Atmosphere, biosphere, chromophore, and resources are physics-keyed (regimes / habitat gates), not class-keyed.

The catalog now produces 14 distinct worldClass labels (`rocky | solid_giant | desert | ocean | ice | iron | lava | magma_ocean | chthonian | gas_dwarf | hycean | helium | ice_giant | gas_giant`) — all emerging from physical state, none reading class as causal input.

This refactor takes the same architectural principle to the Architect side, where `PlanetType` (a separate 6-bucket enum used during system generation) is still doing class-as-causal-upstream.

## Motivation

### The structural issue

`PlanetType` is a 6-bucket taxonomy (`hot_rocky | rocky | super_earth | sub_neptune | neptune | jupiter`) that lives in `scripts/lib/procgen-architect.mjs` (consumer) and `scripts/lib/procgen-priors.mjs` (priors). It drives four discrete dispatches:

1. **Mass-distribution selection** via `PHYSICAL_SPEC_BY_TYPE` — each type has its own truncated-normal / log-normal mass distribution
2. **Type-of-planet-per-slot dispatch** via `TYPE_WEIGHTS_BY_INSOLATION × TYPE_MULTIPLIER_BY_CLASS` — picks a type per orbital slot weighted by insolation and stellar class
3. **Moon counts** via `MOON_COUNT_BY_TYPE` — gas giants get many moons, rocky almost none
4. **Ring occurrence** via `RING_OCCURRENCE_BY_TYPE` — gas giants almost always, rocky rare

It's the architect-side mirror of the original `worldClass` problem. A 6-bucket enum stands in for a real continuous physical state space; downstream physics is forced to inherit the bucket boundaries.

### The architectural cost

The discrete bucket flattens real continuous physics:

- **Mass is genuinely continuous.** The boundary between `super_earth` and `sub_neptune` at R≈2 R⊕ isn't a physical line — the transition is a smooth function of core mass and gas-envelope mass.
- **Hot Jupiters are emergent, not categorical.** Today we paper this in via hand-tuned weights (e.g. `jupiter: 0.01` in the hot-zone weight column). Real hot Jupiters formed at 5+ AU and migrated inward — the same body, different orbital location.
- **One frost line is a coarse model.** The current code uses `FROST_LINE_S = 0.15` (a single binary). Real disks have three relevant snow lines (water at S≈0.14 for the Sun, ammonia at S≈0.005, methane at S≈0.0005) — each adds material to bodies forming past it.
- **Mass deficits (Kuiper-belt-like gaps)** can't form naturally because the orbital walk always places something at each orbit.

### The variety cost

Several body types our procgen can't currently produce naturally:

- **Hot Jupiters from migration** — outer-zone formation + inward drift
- **Failed gas giants** — bodies that nearly reached critical core mass but ran out of disk gas time
- **Methane-ice worlds** — bodies past the CH4 snow line, distinct from ammonia-zone Triton/Pluto-class
- **Multi-zone composition gradients** — bulk water vs ammonia vs methane content differs by formation zone
- **Coreless gas giants** — rare bodies with extreme envelope-to-core ratios
- **Resonance chains** (TRAPPIST-1-like) — not modeled

The user's framing for this refactor: physics that *creates interest and is plausible*. We're not optimizing for matching Kepler-observed-bias distributions (those are partial data); we're optimizing for physically defensible variety.

---

## Target architecture

### Pipeline shape

Today's per-slot generation in `buildPlanetAtOrbit`:
```
slot a → planetType (zone-weighted dispatch)
       → mass (sampled from PHYSICAL_SPEC_BY_TYPE[planetType])
       → radius (mass-radius relation + per-type scatter)
       → moons (rate[planetType])
       → ring (rate[planetType])
```

Target:
```
slot a → isolation mass (zone physics)
       → core mass (stochastic accretion efficiency)
       → gas envelope (decision: core ≥ critical AND past frost line AND disk gas remaining)
       → total mass (core + envelope)
       → radius (mass-radius relation)
       → moons (Hill sphere capacity × orbital distance)
       → ring (Roche-zone disruption probability)

       → planetType (DERIVED label if needed by Phase B/C consumers; deleted in Phase F)
```

### New primary attribute

- **`formationAu`** — the orbital distance at which the body accreted. Usually equals `semiMajorAu`, but for migrated bodies (hot Jupiters) the two differ.

Promoting `formationAu` to a stored primary attribute is the load-bearing addition. It lets downstream physics read formation context (where the body formed, what was in the disk there) rather than current orbital context (where it is now). A hot Jupiter at 0.05 AU should have outer-zone bulk composition because it formed at 5+ AU.

### Per-star derived quantities

Not new Body fields — computed per star from existing inputs (mass, spectral class):

- **Frost lines** for H2O, NH3, CH4 — three insolation values per star marking volatile condensation distances
- **Disk gas lifetime** — sampled per star, longer-lived for cooler stars
- **Disk solid surface density profile** — function of orbital distance, with step-up factors past each frost line

### Derivation formulas (replacing the per-type tables)

These are the rough shapes; tuning lives in `procgen-priors.mjs` as named scalars.

**`frostLineS(starMass, volatile)`** — solves radiative equilibrium for the volatile's condensation temperature:
```
S = T_volatile^4 × 4σ / (SOLAR_CONSTANT × (1 - A_ICE))
```
Anchors:
- H2O condensation T ≈ 170K → solar frost line at S ≈ 0.14 (≈ 2.7 AU around the Sun)
- NH3 condensation T ≈ 75K → S ≈ 0.005 (≈ 14 AU around the Sun)
- CH4 condensation T ≈ 40K → S ≈ 0.0005 (≈ 45 AU around the Sun)

The frost line *distance in AU* varies by stellar luminosity: tight around M dwarfs, wide around F/A stars.

**`solidSurfaceDensity(starMass, a)`** — minimum-mass-solar-nebula profile with frost-line step-ups:
```
Σ_base = MMSN_NORMALIZATION × starMass × (a)^(-1.5)
if a > water frost line:   Σ_base *= SNOW_LINE_BOOST_H2O   (≈ 3)
if a > ammonia frost line: Σ_base *= SNOW_LINE_BOOST_NH3   (≈ 1.5)
if a > methane frost line: Σ_base *= SNOW_LINE_BOOST_CH4   (≈ 1.2)
return Σ_base
```
`MMSN_NORMALIZATION` is anchored so the inner-Sol disk has Σ ≈ 7 g/cm² at 1 AU.

**`diskGasLifetimeMyr(starMass, prng)`** — sampled per star. Real disks live 1-10 Myr. M dwarfs hold gas longer; massive stars disperse faster (UV photo-evaporation).

**`isolationMass(a, starMass, surfaceDensity)`** — classical feeding-zone capacity:
```
M_iso = (8π × a² × Σ_solid)^(3/2) / (3 × M_star)^(1/2)
```
Anchors for the Sun:
- 1 AU: M_iso ≈ 0.05 M⊕ (Mars-mass scale — matches small inner planets)
- 5 AU: M_iso ≈ 8 M⊕ (Neptune-core scale — enables gas accretion for Jupiter/Saturn)
- 20 AU: M_iso ≈ 3 M⊕ (Uranus/Neptune scale)
- 30 AU: M_iso ≈ 1 M⊕ (drops off — Kuiper Belt territory, mass deficit)

**`coreMassFor(a, star, prng)`** — actual core mass, stochastic fraction of isolation:
```
M_core = M_iso × sampleTruncated(prng, ACCRETION_EFFICIENCY)
```
With `ACCRETION_EFFICIENCY = { mean: 0.6, sd: 0.4, min: 0.1, max: 3 }`. Most bodies accrete most but not all of their isolation mass; some are smaller (incomplete) and some are larger (oligarchic merging across multiple isolation masses).

**`gasEnvelopeFor(coreMass, a, star, age, prng)`** — gas accretion decision + envelope sampling:
```
if M_core < CRITICAL_CORE_MASS_EARTH:    return 0     // no runaway
if a <= water_frost_line_au:             return 0     // no volatile-ice feed
if disk_gas_lifetime < TIME_TO_RUNAWAY:  return 0     // disk dispersed too soon

// Log-normal envelope mass: ratio of envelope to core
ratio = sampleLogTruncated(prng, ENVELOPE_FRACTION)
return M_core × ratio
```
`ENVELOPE_FRACTION` anchored to capture Saturn (~30× core), Jupiter (~60× core), brown-dwarf-edge (~200×).

**`migrationFor(formationAu, mass, star, prng)`** — disk-era migration:
```
if mass < MIGRATION_MIN_MASS_EARTH: return formationAu
if prng() >= MIGRATION_RATE: return formationAu

// Hot Jupiter migration: pull inward by 70-95% of formation distance
migrated_au = formationAu × sampleTruncated(prng, MIGRATION_FRACTION)
return Math.max(MIN_HOT_JUPITER_AU, migrated_au)
```
Tuning target: ~5-10% of procgen gas giants end up as hot Jupiters. Real Kepler-derived rate is ~1%, but we're not bound to that — the goal is plausible variety.

**`moonCountFor(planet, star, prng)`** — Hill-sphere capacity:
```
hill_radius_au = planet.semiMajorAu × (planet.massEarth / star.massEarthEquiv)^(1/3)
capacity_factor = log10(planet.massEarth × planet.semiMajorAu × MOON_CAPACITY_SCALE)
N_lambda = max(0, capacity_factor)
return samplePoisson(prng, N_lambda)
```
Anchors:
- Jupiter at 5 AU: capacity → ~50+ moons (real Jupiter has 95 confirmed)
- Earth at 1 AU: capacity → ~1 moon
- Mars at 1.5 AU: capacity → ~2 moons
- Mercury at 0.4 AU: capacity → ~0 moons

**`moonMassFor(host, hillRadius, prng)`** — per-moon mass distribution scales with Hill sphere capacity. Largest moon ≤ ~10% of host mass (Pluto/Charon is the binary-planet edge case).

**`ringOccurrenceFor(planet, star, age, prng)`** — Roche-zone-density × age-weighted disruption:
```
roche_au = ROCHE_FACTOR × planet.radiusAu × (ρ_planet / ρ_moon)^(1/3)
roche_volume_factor = roche_au^3 / planet.semiMajorAu  // scaled
recent_disruption_prob = roche_volume_factor × RING_DISRUPTION_RATE × age_factor
return prng() < recent_disruption_prob
```
Anchors:
- Gas giants: large Roche zone, ~80% have rings
- Ice giants: ~30%
- Rocky/terrestrial: rare

### What stays unchanged

- **The orbital walk in `generateSystem`** — Kepler period-ratio spacing is real physics. Inner edge + outward spread with log-normal period ratios. Keep.
- **Belt context (`warm` / `cold`)** — anchored to giant-adjacency, not class. Already physics-keyed.
- **Catalog overlay (`generateOverlay`)** — adds siblings for catalog-anchored stars. Same shape; just uses the new mass pipeline internally.
- **`COMPANION_PLANET_SUPPRESSION` and `MAX_PLANETS_PER_CLUSTER`** — cluster-level dynamics constraints.

### What dies (in Phase F)

- `Body.planetType` field on `Body` interface
- `PlanetType` enum
- `planetTypeFor` derived function (no callers left after B/D/E)
- All `*_BY_TYPE` tables: `PHYSICAL_SPEC_BY_TYPE`, `TYPE_WEIGHTS_BY_INSOLATION`, `TYPE_MULTIPLIER_BY_CLASS`, `RADIUS_SCATTER_SIGMA_LOG`, `RADIUS_CLAMP_BY_TYPE`, `MOON_COUNT_BY_TYPE`, `MOON_MASS_LOG_EARTH`, `MOON_MAX_HOST_MASS_RATIO`, `RING_OCCURRENCE_BY_TYPE`, `RING_EXTENT`, `RING_RESOURCE_PRIORS_BY_TYPE`
- `SHEPHERD_PLANET_TYPES` (replaced by mass-based shepherd criterion)

---

## Phasing — six landable units

Each phase is independently landable with its own regression gate. Sol bodies are the load-bearing calibration (their CSV values override procgen and are not touched by the Filler). Procgen distributions can shift freely between phases.

### Phase A — Disk-physics foundations

**Adds to `scripts/lib/astrophysics.mjs`:**
- `frostLineS(starMass, volatile)` returning insolation value at the volatile's condensation distance
- `solidSurfaceDensity(starMass, aAu, frostLineAUs)` returning Σ_solid in g/cm²
- `diskGasLifetimeMyr(starMass, prng)` returning sampled disk lifetime
- `isolationMass(aAu, starMass, surfaceDensity)` returning M_iso in M⊕

**Adds to `scripts/lib/procgen-priors.mjs`:**
- `MMSN_NORMALIZATION` — Σ_solid normalization at 1 AU around the Sun (~7 g/cm²)
- `SNOW_LINE_TEMPERATURES = { H2O: 170, NH3: 75, CH4: 40 }`
- `SNOW_LINE_BOOSTS = { H2O: 3, NH3: 1.5, CH4: 1.2 }`
- `DISK_GAS_LIFETIME_MYR` — per-class spec (e.g. `M: {mean: 6, sd: 3, min: 1, max: 15}`)
- `ACCRETION_EFFICIENCY = { mean: 0.6, sd: 0.4, min: 0.1, max: 3 }`
- `CRITICAL_CORE_MASS_EARTH = 10`
- `ENVELOPE_FRACTION = { mean: 30, sd: 50, min: 1, max: 200, log: true }`
- `TIME_TO_RUNAWAY_MYR = 0.5` (time required from critical core mass to runaway accretion)

**Behavior:** none. Helpers only.

**Regression gate:**
- `isolationMass(1 AU, M_sun)` ≈ 0.05 M⊕
- `isolationMass(5 AU, M_sun)` ≈ 5–10 M⊕
- `frostLineAU(Sun, 'H2O')` ≈ 2.7 AU
- `solidSurfaceDensity(M_sun, 1 AU)` ≈ 7 g/cm²
- `diskGasLifetimeMyr(M_sun)` mean ≈ 3 Myr

### Phase B — Continuous mass pipeline

**Replaces** the `(planetType, mass spec)` dispatch in `buildPlanetAtOrbit` with the continuous physics pipeline.

**Touches:**
- `scripts/lib/procgen-architect.mjs`: `buildPlanetAtOrbit` mass + radius sampling block. New flow: isolation mass → core mass → gas envelope decision → total mass → radius.
- `scripts/lib/procgen-priors.mjs`: delete `TYPE_WEIGHTS_BY_INSOLATION`, `TYPE_MULTIPLIER_BY_CLASS`, `PHYSICAL_SPEC_BY_TYPE`, `RADIUS_SCATTER_SIGMA_LOG`, `RADIUS_CLAMP_BY_TYPE`, `PLANET_TYPES`.
- `scripts/lib/procgen.mjs`: `planetTypeFor` becomes a *derived* function — same shape as `worldClassFor`. Reads mass + radius + has_envelope, returns the legacy planetType label. Kept temporarily so any remaining callers (audit, moon backfill) keep working.

**Behavior change:** Mass distribution becomes continuous. No more clustering at type boundaries; the histogram of procgen masses becomes smooth.

**Regression gate:**
- Sol planets unchanged (CSV curation)
- Procgen Earth-analog (S ≈ 1, terrestrial) mass median ≈ 1 M⊕
- Procgen gas giant rate at outer orbits (S < 0.1) ≈ 30–50% (matches Sun-like systems pattern)
- Audit: mass histogram is continuous (no spikes)

### Phase C — Formation zone + migration

**Adds:**
- `Body.formationAu` primary attribute
- Migration pass after the orbital walk in `generateSystem` / `buildPlanetAtOrbit`

**Touches:**
- `src/data/stars.ts`: `Body.formationAu` field
- `src/data/bodies.csv`: new column `formation_au`; Sol bodies curated with `formationAu = semiMajorAu` (no migration in Sol's history)
- `scripts/build-catalog.mjs`: `BODY_NUMERIC_FIELDS` entry
- `scripts/lib/procgen-architect.mjs`: migration pass between orbital walk and moon/ring generation
- `scripts/lib/procgen-priors.mjs`: `MIGRATION_RATE`, `MIGRATION_FRACTION`, `MIGRATION_MIN_MASS_EARTH`, `MIN_HOT_JUPITER_AU`
- `scripts/lib/procgen.mjs`: `bulkWaterFractionFor` and `bulkMetalFractionFor` now read `formationAu` (not current `semiMajorAu`) for the zone gate

**Behavior change:** ~5–10% of procgen gas giants are hot Jupiters with `formationAu` significantly greater than `semiMajorAu`. Their bulk composition reflects outer-zone formation.

**Regression gate:**
- Sol bodies: `formationAu === semiMajorAu` for all anchors
- Procgen: hot-Jupiter rate ~5–10% of gas giants
- Procgen hot Jupiters: `bulkWaterFraction ≥ 0.05` (outer-zone formation) despite hot current position
- New emergent variety: chthonian candidate count should rise (stripped giant cores are migrated giants that lost their envelopes)

### Phase D — Multi-snow-line composition

**Replaces** binary `inner`/`outer` zone gating with three-snow-line gradient.

**Touches:**
- `scripts/lib/procgen.mjs`: `bulkWaterFractionFor`, `bulkMetalFractionFor` zone logic
- `scripts/lib/procgen-architect.mjs`: `sampleBulkWaterFraction`, `sampleBulkMetalFraction` updated to take a per-star frost-line trio
- `scripts/lib/procgen-priors.mjs`: replace `BULK_WATER_FRACTION_BY_ZONE` two-bucket spec with four-zone:
  - `inside_H2O` — refractory metals + silicates, dry
  - `H2O_to_NH3` — water ice rich (Europa/Ganymede formation zone)
  - `NH3_to_CH4` — ammonia + water mixed (Triton/Pluto formation zone)
  - `past_CH4` — methane-dominant deep cold
- Add new `BULK_VOLATILE_FRACTION_BY_ZONE` (non-water volatiles inventory) — feeds atmosphere regime decisions and unlocks methane-world variety

**Behavior change:** Outer-system bodies differentiate by formation zone. Three new bulk-composition gradients instead of one binary.

**Regression gate:**
- Sol curation unchanged (CSV anchors win)
- Procgen Europa-class composition concentrated in `H2O_to_NH3` zone (S 0.005–0.1)
- Procgen Triton-class composition concentrated in `NH3_to_CH4` zone
- New body type emerges: methane-ice-rich worlds past CH4 snow line (Eris-class)

### Phase E — Moons + rings physics-derived

**Replaces** `MOON_COUNT_BY_TYPE` + `RING_OCCURRENCE_BY_TYPE` with mass × orbital context.

**Touches:**
- `scripts/lib/procgen-architect.mjs`: `generateMoons` mass + count + per-moon mass distribution from Hill sphere; `generateRing` from Roche-zone disruption probability
- `scripts/lib/procgen-priors.mjs`: delete `MOON_COUNT_BY_TYPE`, `RING_OCCURRENCE_BY_TYPE`, `MOON_MASS_LOG_EARTH`, `MOON_MAX_HOST_MASS_RATIO`, `RING_EXTENT`, `RING_RESOURCE_PRIORS_BY_TYPE`. Add `MOON_CAPACITY_SCALE`, `ROCHE_FACTOR`, `RING_DISRUPTION_RATE`, `RING_EXTENT_BY_HOST_MASS`.
- Ring resource grid: derive from host's bulk composition (icy host → icy ring, rocky host → rocky ring) rather than per-type tables.

**Behavior change:** Moon counts scale with Hill sphere capacity (host mass × orbital distance / star mass). Big distant gas giants get many moons; small close-in rockies get none. Ring rate tracks host mass × Roche-zone density.

**Regression gate:**
- Sol moon counts unchanged (CSV)
- Procgen gas giants: 10–30 moons typical
- Procgen rocky inner-zone bodies: 0–2 moons
- Procgen ring occurrence: ~80% on gas giants, ~30% on ice giants, ~5% elsewhere

### Phase F — Delete PlanetType + cleanup

**Removes:**
- `Body.planetType` field
- `PlanetType` type union
- `planetTypeFor` derived function (no callers left after B/D/E)
- All remaining `*_BY_TYPE` tables not deleted in earlier phases
- `SHEPHERD_PLANET_TYPES` (belt shepherd identification — replaced by mass-based criterion: `mass ≥ SHEPHERD_MIN_MASS_EARTH`)

**Touches:**
- `src/data/stars.ts`: drop `PlanetType` and `Body.planetType`
- `src/data/bodies.csv`: drop `planet_type` column if it exists (architect-internal; may not be in CSV — verify)
- `scripts/build-catalog.mjs`: BODY_STRING_FIELDS update, planetType validation removal
- `scripts/lib/procgen-architect.mjs`: clean up any remaining type references
- `scripts/lib/procgen.mjs`: delete `planetTypeFor`
- `scripts/audit-procgen.mjs`: drop planetType-keyed audits, add continuous-mass-distribution audit

**Behavior change:** None — purely cleanup. `Body.planetType` was already a derived label after Phase B and has no consumers by this point.

**Regression gate:**
- Build still produces the same body counts
- Audit still produces sane reports
- typecheck passes

---

## Variety this unlocks

| Body type | Sol analog | Current procgen | Post-refactor |
|---|---|---|---|
| **Hot Jupiter (migrated)** | none | rare via hand-tuned weight | natural via migration pass |
| **Failed gas giant** (massive core, no envelope) | (Uranus/Neptune cores may qualify) | not modeled | emerges when disk dispersed before runaway |
| **Methane-ice world** (past CH4 line) | (Eris-class, theoretical) | flattened into generic "outer ice" | distinct composition zone |
| **Ammonia-ice world** (past NH3 line) | Triton, Pluto | flattened | distinct from H2O-only outer zone |
| **Coreless gas giant** | none (theoretical) | not modeled | rare emergent from high envelope/core ratio |
| **Sub-Neptune (intermediate envelope)** | none in Sol | bucketed | continuous gradient |
| **Mass-gap / Kuiper analog** | Kuiper Belt | per-belt generation | could emerge from low-Σ outer regions |
| **Iron stripped-core (post-migration)** | none | rare iron procgen | natural — migrated giants stripped to cores |

The architectural payoff isn't *adding* these as cases — it's that they emerge from physical regions of the (mass, formation zone, migration, age) hypercube that the current taxonomy collapses.

---

## Calibration anchors

The Sun's system is our highest-confidence calibration target. The physics pipeline should reproduce its structure:

- **Inner zone (0.3–2 AU):** isolation mass peaks around Mars-mass → matches 4 small inner planets (Mercury, Venus, Earth, Mars). Procgen should produce similar Mars-Earth-class inner-zone bodies.
- **Past water frost (~2.7 AU):** isolation mass jumps to ~5–10 M⊕ → enables gas-envelope capture for Jupiter and Saturn. Procgen Sol-class systems should produce 1–2 gas giants in this band.
- **Past ammonia frost (~14 AU):** isolation mass lower (less material at large `a`) → ice-giant-mass cores (Uranus, Neptune) with modest envelopes.
- **Beyond (~30+ AU):** mass deficit → Kuiper Belt. Procgen could produce mass-deficit outer regions naturally (low Σ + low isolation mass).

Each phase's regression gate verifies Sol stays in this band. Sol bodies are curated (CSV); procgen Sun-class systems should produce structurally similar distributions.

The user's framing: physics over Kepler-bias-matching. We're not bound to reproduce observational survey distributions (which are necessarily partial). We *are* bound to produce physically plausible variety.

---

## Consequences

### What gets easier

- **Hot Jupiters are emergent, not bolted-in.** Currently we hand-tune `jupiter: 0.01` in the hot-zone weight column; after Phase C they emerge from migration physics.
- **Multi-zone composition.** Three frost lines instead of one means bulkWater and bulkMetal can differentiate Europa-zone from Triton-zone bodies, which feeds chromophore + atmosphere regime decisions naturally.
- **Stellar context matters in physically honest ways.** M-dwarf systems get tight frost lines, longer disk lifetimes, smaller isolation masses — different planet distributions emerge without hand-tuned `TYPE_MULTIPLIER_BY_CLASS`.
- **Adding new physics is local.** Resonance capture, late accretion bombardment, disk-instability binary planet formation — each is one Phase G+ addition, not a refactor across multiple class tables.

### What gets harder

- **Calibration loses observational grounding.** Kepler-derived weights anchor the current type distribution against survey occurrence rates. Physics-rooted produces whatever physics produces — could over- or under-produce gas giants vs Kepler. Mitigation: per-phase regression gates checking Sol bodies + plausible procgen distributions.
- **More physics to model is more potential for unintended interactions.** Disk-mass × accretion × envelope × migration is four coupled stochastic decisions. Tuning is a higher-dimensional problem than tuning per-type weights.
- **PROCGEN_VERSION will churn the whole catalog across each phase.** Sol stays curated; procgen bodies shift between builds.

### What doesn't change

- The Architect's `generateSystem` orbital walk
- The `generateOverlay` posture for catalog-anchored stars
- Belt context (`warm` / `cold`)
- Cluster-level constraints (`MAX_PLANETS_PER_CLUSTER`, `COMPANION_PLANET_SUPPRESSION`)
- Sol curation (CSV is authoritative)
- Renderer (it reads `worldClass` for palette, which is derived — Architect changes are invisible)

---

## Open questions

- **Disk lifetime: per-star sampled vs class mean?** Real disks have wide spread; sampling per star adds variance but complicates regression checks. Recommendation: per-star sample with class-mean center. Cache the lifetime per star to keep the per-body decisions deterministic.
- **Migration: per-body random vs system-coupled?** Real migration is gas-disk-driven and affects whole systems. Recommendation: per-body random draw is the simpler defensible shortcut; could revisit if it produces implausible single-hot-Jupiter systems with neighbors.
- **Should we track `coreMassEarth` separately from `mass` on gaseous bodies?** Useful for: aerial-biosphere gating, chromophore decisions, deep-mining gameplay. Recommendation: yes, add as `coreMassEarth` in Phase B. Cheap, opens future doors.
- **Should `formationAu` be persisted on belts and rings?** Probably not — they're sub-features of their host. Inherit `formationAu` from host where it matters for composition.
- **How do we audit migration realism?** Real Kepler hot-Jupiter rate is ~1%; our target is 5–10% for plausible variety. Decision: don't aim at Kepler; aim at "noticeable but not dominant".

---

## Out of scope

- **N-body dynamics** — resonance capture, scattering, secular instability. Phase G+ candidates; each is a sub-system.
- **Late heavy bombardment** — planetesimal-delivered water, comet impacts. Subsumed into bulkWater accretion at formation.
- **Atmospheric evolution over time** — we already have per-gas Jeans escape; long-term photochemistry is a separate problem.
- **Stellar age evolution** — bodies don't yet track age-since-formation distinct from host star age.
- **Disk-instability binary planet formation** — would produce Pluto-Charon-class binary systems. Defer to a possible Phase H.

---

## Critical files (full refactor)

- `src/data/stars.ts` — `Body` interface (`+formationAu`, `-planetType`); `PlanetType` type removed in Phase F
- `src/data/bodies.csv` — `+formation_au` column + Sol curation; `-planet_type` removed in Phase F (verify exists first)
- `scripts/build-catalog.mjs` — `BODY_NUMERIC_FIELDS` updates, validator cleanup, moon backfill caller updates
- `scripts/lib/astrophysics.mjs` — disk-physics helpers (Phase A)
- `scripts/lib/procgen-priors.mjs` — disk-physics priors added (Phase A); per-type tables removed across B–F
- `scripts/lib/procgen-architect.mjs` — `buildPlanetAtOrbit` mass pipeline rewrite (Phase B); migration pass (Phase C); moons/rings rewrite (Phase E)
- `scripts/lib/procgen.mjs` — `bulkWaterFractionFor` / `bulkMetalFractionFor` multi-zone update (Phase D); `planetTypeFor` becomes derived (Phase B) then deleted (Phase F)
- `scripts/audit-procgen.mjs` — per-type audits replaced with continuous-distribution reports
