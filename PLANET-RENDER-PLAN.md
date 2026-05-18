# Planet render plan

Multi-phase roadmap for enriching the planet/moon disc renderer in the system view. Captures durable design intent — kept distinct from `README.md` (which documents the steady-state architecture) and from ephemeral session-scoped refactor docs (which stay out of the repo via `.git/info/exclude`).

Implementation lands incrementally; expect each phase to ship as one or two commits with a working browser smoke before moving on.

## Premise

Make planets and moons feel like *places* — distinct, beautiful, enticing — while preserving the pixel-crisp aesthetic and the primary-attributes-only data philosophy. Visual character emerges from the same fields gameplay reads. No separate "appearance" enum, no derived weights stacked on top of an already-emergent signal.

## Current state

Surface mode reads `worldClass`, `axialTiltDeg`, the six-scalar resource grid, atmosphere (top three gases + chromophore), `waterFraction`, `iceFraction`, `surfaceAge`, plus `biosphereArchetype × biosphereTier × hostStar.cls`. Banded mode reads the same gases + chromophore + `axialTiltDeg`. Both share parity-aware pixel snap and the same sphere-projection foreshortening (`RING_MINOR_OVER_MAJOR` pole tilt) so a ringed body's bands and ring share one vantage.

Most-recent landings:
- **Phase 1.4 — cratering from `surfaceAge`** (done). Per-worley-cell uniform-RGB lightness perturbation in the surface branch, amplitude tapered by `(1 − surfaceAge)`. Restores the Ganymede/Enceladus distinction sacrificed when albedo left the render path — properly this time, via the primary attribute that *causes* the brightness difference rather than the derived measurement of it. Mercury / Luna / Callisto read as mottled, pitted; Io / Enceladus / Earth stay smooth. Same perturbation on cap, ocean, and land cells — one visual language for "old surface."
- **`surfaceAge` primary attribute landed.** 0..1 fraction of the surface that is geologically young; per-class procgen prior plus a tidal-lift branch for moons of giants (linear in eccentricity past `TIDAL_E_THRESHOLD`). Eleven hand-curated Sol anchors in `bodies.csv`.
- **Albedo fully out of the data model.** The Stefan-Boltzmann temp pass derives its Bond albedo locally via `effectiveBondAlbedo` rather than consuming a stored field; procgen-derived `avgSurfaceTempK` stays byte-identical against the prior catalog.
- **Phase 1.3a/b/c — atmospheric rim + tint + clouds** (all done). Every banded body and every surface body with non-trivial pressure now carries an atmospheric column visible at the limb: a stroke-stacked outward halo extending up to 3 px into space, an inward fade following the sphere-projection foreshortening curve (band widths 1, 2, 3, ... px from the limb inward), and a per-fragment uniform tint on surface bodies with a haze-class chromophore. Earth gets the Rayleigh cyan limb plus H2O cloud patches; Venus, Titan, Io get their SO2/CH4 chromophore haze; Jupiter and Saturn get the bright H2 cream limb (the NH3 chromophore color is *deep* cloud chemistry, not at the limb); Uranus and Neptune get CH4 cyan-blue (absorption-dominant ice giants). Curated chromophores expanded from `{Jupiter NH3, Earth H2O, Saturn NH3, Titan CH4}` to also include `{Venus SO2, Mars DUST, Io SO2}`.
- **Phase 1.2 — biome stipple** driven by `biosphereArchetype × biosphereTier × hostStar.cls`. Earth's temperate land paints as dense green chlorophyll; M-dwarf carbon_aqueous worlds shift to deep purple (Kiang-style "Purple Earth"); K → rust-red; F/A → gold. Tier drives coverage density (microbial sparse, gaian dense). O/B/WD/BD hosts and prebiotic worlds suppress entirely.
- **Phase 1.1 — oceans + polar caps** from `waterFraction` + `iceFraction`. Earth reads as ocean-dominated with small caps; Europa fills white; Mars keeps a thin polar trim.

## Design principles

These are constraints every Phase entry must satisfy.

- **Primary attributes only.** Every visual feature is driven by a field that gameplay also cares about. No derived weights (the `albedo` mistake), no "appearance" enums layered on top of `worldClass`.
- **Pixel-crisp.** Every feature resolves to integer-pixel boundaries — no AA fringes, no sub-pixel positioning, no gradients. Use cell-based hashes for non-uniform regions; sphere-projected latitude for curved features; integer-px stair-stepped warps for irregular edges.
- **Mode-separated machinery.** Surface and banded are nearly-independent shader paths. A feature lives in one or the other (or is explicitly cross-cutting, like ring shadow).
- **Emergent brightness.** A body's overall brightness is what falls out of its rendered features — never multiplied by a stored albedo scalar. If a body looks "wrong-brightness," fix the palette hues or add a primary feature; don't add a darkening factor.
- **Determinism.** Per-body seeding via `hash32(body.id + ':' + field)`. Visuals stable across reloads and procgen regenerations. Bumping `PROCGEN_VERSION` reseeds everything without touching ids.

---

## Primary attribute: `surfaceAge`

A 0..1 scalar — the fraction of a body's surface that is geologically young. **1.0** = perpetually refreshed (Io's lava, Enceladus's cryovolcanic plumes, Earth's plate-tectonics-refreshed crust). **0.5** = mixed (Mars's young plains over old highlands, Titan's hydrocarbon-eroded crust). **0.0** = ancient unmodified (Mercury, Luna, Callisto). `null` for bodies with no solid surface (gas/ice giants, gas dwarfs, belts, rings).

Sampled per-class via `SURFACE_AGE_BY_CLASS` in `procgen-priors.mjs` — priors lean "old" by default; `ocean` and `lava` classes anchor high. Moons of giants get a tidal-heating lift: above `SURFACE_AGE_TIDAL_LIFT.eThreshold`, eccentricity normalizes linearly to `eMaxNormalize` and pulls the age toward 1.0 by `liftAmount × normalizedFraction`. Eccentricity-only is a simplification — real tidal heating scales as `M_host² · e² / a⁵`, but the host-mass term doesn't change ordering across our catalog (giants all dominate). Eleven hand-curated Sol anchors in `bodies.csv` (Mercury 0.05, Earth 0.70, Io 1.00, Enceladus 0.95, …).

Drives the Phase 1.4 cratering pass (below). Restores the Ganymede/Enceladus distinction lost when albedo left the render path — properly, via the primary attribute that *causes* the brightness difference rather than the derived measurement of it.

---

## Phase 1 — Terrestrial worlds feel alive (surface mode)

Goal: Earth, Mars, Europa, Titan, Mercury, Moon, Io, Enceladus all read as distinct, identifiable bodies at a glance. Phase 1.1 is the foundation; 1.2-1.4 layer character on top.

### 1.1 Oceans + polar caps (done)

Driven by `waterFraction` + `iceFraction`. Sphere-projected latitude (shared with banded mode) defines the cap region; coarse-cell hash defines ocean continents. See README §"Procedural disc texture" for the steady-state spec.

### 1.2 Biome stipple on temperate land (done)

**Why.** Earth's living biosphere is the single biggest "this is a place that matters" signal in our catalog. A flat hue shift on land cells risks reading as "different-colored rock" rather than "alive" — what makes Earth pop is the *tactile* impression of growth, not a uniform tint. A per-pixel stipple within biome-eligible land cells paints individual pixels in biome color over the underlying resource color, reading as moss / lichen / canopy growth. Tier drives coverage density (microbial sparse → gaian dense), so one dial covers the full life spectrum with one mechanism.

Color comes from two stacked tables: archetype picks the *pigment chemistry* hue, stellar class shifts that hue based on what wavelengths the host star actually delivers. Earth (G2V) lands on chlorophyll-green; an M-dwarf carbon_aqueous world lands near "Purple Earth" because pigments under red/IR-rich light evolve to absorb broadly and reflect less in the visible band (Kiang et al. on alien photosynthesis). M-dwarfs are ~60% of the catalog — without the stellar shift every alien biome would paint Earth-green, collapsing the visual distinction the data already encodes.

**Trigger.** All of:
- Surface mode
- `biosphereArchetype !== null` and `biosphereTier in (microbial, complex, gaian)` — prebiotic skipped (no visible biomass)
- Land cell only (not ocean, not ice)
- Temperate latitude — `|latSinS| < BIOME_LAT_MAX`, with a smoothstep taper toward the poles
- Disc radius ≥ `PROCEDURAL_TEXTURE_MIN_PX` — sub-threshold discs skip the stipple (would resolve as noise, not pattern)

**Data inputs.** `biosphereArchetype`, `biosphereTier`, `latSinS`, host star's `cls` (resolved CPU-side through `body.hostStarIdx`, or up the moon→planet chain for satellites).

**Palette — two layers.**

`BIOME_TINT_COLOR[archetype]` — base pigment hue assuming G-class light, hand-tuned in `disc-palette.ts`:

| Archetype | Base tint (G-class) | Why |
|---|---|---|
| carbon_aqueous | forest green | Earth's chlorophyll signature |
| subsurface_aqueous | null | Under-ice life doesn't reach the visible surface |
| aerial | null | Banded mode only — doesn't reach surface |
| cryogenic | methane-tinted ochre | Hydrocarbon-cycle biosphere |
| silicate | grey-green crystalline | Hypothetical mineral metabolism |
| sulfur | yellow-brown | Sulfur-cycle thermal-vent life |

`BIOME_STELLAR_SHIFT[cls]` — multiplicative hue rotation by host stellar class. Pigments absorb the wavelengths the star delivers; reflected color shifts accordingly.

| Stellar class | Shift | Why |
|---|---|---|
| O, B | null (suppresses biome render entirely) | Stellar lifetime too short + UV-sterilizing |
| A | warm gold | Blue-dominant input → reflect red/orange |
| F | gold / yellow-tan | Subtle warm shift from G baseline |
| G | identity | Earth baseline — pigments calibrated to Sun's spectrum |
| K | rust-red | Red-shifted input; broader-band pigments shift visible reflectance toward red |
| M | deep purple | Red/IR-dominant input; broadband absorption → "Purple Earth" |
| WD, BD | null | Insufficient luminosity for a surface biosphere |

Combined per body: `biomeColor = BIOME_TINT_COLOR[archetype] · BIOME_STELLAR_SHIFT[hostStarCls]`, computed CPU-side in `buildDiscPalette`. Null when either table returns null (carbon_aqueous on an M-dwarf renders; subsurface_aqueous anywhere doesn't; anything on an O/B/WD/BD doesn't).

**Pipeline.**
- CPU-side in `buildDiscPalette`: derive `biomeColor` (as above) and `coverage = BIOME_COVERAGE_BY_TIER[tier]` (microbial sparse → gaian dense). Pack into `aBiomeColor: vec3` (zero when no biome applies) and `aBiomeCoverage: float` (0 when no biome applies).
- Shader, in the land branch only:
  - `taper = smoothstep(BIOME_LAT_MAX, BIOME_LAT_MAX - BIOME_LAT_RAMP, abs(latSinS))`
  - `effectiveCoverage = vBiomeCoverage * taper`
  - Per-fragment stipple hash on integer pixel coords with its own salt: `if (hash21(pixelCoord, BIOME_SALT) < effectiveCoverage) col = vBiomeColor`
  - Stipple replaces the underlying resource color at hit pixels (no blend — these are pixels of growth *on* rock, not a glaze over it).
- Applied *only* to the land branch — stipple over ocean would lock to the disc's pixel grid and read as wireframe; over ice would obscure the cap signal.

**Tuning anchors.**
- Earth (carbon_aqueous, gaian, G2V) — dense green stipple in the temperate band; polar cells unchanged; arctic cells smoothstep-tapered.
- A procgen K-dwarf carbon_aqueous gaian — rust-red stipple at gaian density. Reads as "alien Earth."
- A procgen M-dwarf complex carbon_aqueous — deep-purple stipple at complex density. "Purple Earth" world.
- A procgen F-dwarf complex carbon_aqueous — gold-tan stipple at complex density.
- A microbial-tier body — same color tables, sparse stipple. Visibly distinct from a tier-complex sibling.
- A prebiotic-tier body — no stipple (skipped at trigger).
- A 40-px disc — stipple skipped regardless of tier (sub-threshold resolution).

**Risk.**
- M-dwarf "deep purple" risks reading as "absent biome" rather than "dark biome." The shift table needs enough saturation that the stipple still pops against the underlying rocky resource cells — pick a hue closer to true violet than to black.
- Stipple, biome, cratering, and clouds all share the per-pixel hash space. The stipple salt must be distinct from all other surface-pass salts (see the cross-cutting salt budget below).
- Coverage curve for the three tiers is the load-bearing visual choice — too sparse and gaian reads as microbial; too dense and microbial reads as gaian. First pass should leave a clear visual gap between the three.

### 1.3 Atmospheric haze and clouds (DONE)

Three sub-passes shipped, covering every body in the catalog that carries any atmospheric signal. The chromophore signal splits cleanly into two physically distinct rendering paths driven by *which* chromophore species is set, plus a third channel for clear thick atmospheres:

- **H2O** condenses into discrete cloud cells via localized convection (Earth's cumulus, an ocean world's overcast). Patchy → 1.3c.
- **CH4, SO2, DUST, SILICATE** form well-mixed photochemical hazes or wind-suspended aerosols (Titan tholin, Venusian SO2, Martian dust, hot sub-Neptune silicate fog). Uniform → 1.3a.
- **Clear thick atmospheres** with no haze chromophore (Earth above 0.1 bar) get Rayleigh-blue scattering at the limb → 1.3b.

Banded bodies (Venus, Titan, gas/ice giants) have no surface to tint, so the 1.3a uniform tint is suppressed for them — but they still get the 1.3a outward halo + inward fade, with the rim color picked from a small three-regime decision (see "Banded rim color" below).

**Chromophore exits the surface-mode resource palette in this phase.** Land cells revert to top-3 resources by `dominantResources(body, 3)`. `SURFACE_CHROMOPHORE_WEIGHT` deleted.

#### Atmospheric rim: outward halo + inward fade

The rim is symmetric around the disc edge: an outward halo extending into space, plus an inward fade across the visible limb representing edge-on column thickening. Both use the same rim color (`vHazeColor`), the same per-stroke base alpha, and the same **stroke-stacking** opacity model — but their geometries differ to honor how the atmosphere sits on a sphere.

**Outward halo (`vRadius < r ≤ vRadius + vRimWidthPx`).** Width 0–3 px, driven by `log10(surfacePressureBar + 1)` thresholds (`HAZE_RIM_LOG10_THRESHOLDS`). Each integer-pixel layer L outward gets stack count `(W − L)`: innermost layer (closest to disc) is covered by all W conceptual strokes, outermost by only the widest. Effective alpha per layer = `1 − (1 − OUTER_BASE_ALPHA)^stackCount` — the closed form of painting W concentric strokes back-to-front. Output is `vec4(vHazeColor, rimA)` with the planet material's `transparent: true`, so the halo alpha-blends correctly with rings, moons, and other bodies behind it. The sprite (`gl_PointSize`) is enlarged per-vertex by `2 × rimWidthPx` so the rasterizer covers the halo region.

**Inward fade (`vRadius − maxInward ≤ r < vRadius`).** Width `floor(vRadius × INWARD_RIM_FRACTION)`, radius-driven only (a bigger planet has a more visible limb under edge-on column geometry). **Band widths grow 1, 2, 3, ... px from the limb inward**, following the natural sphere-projection foreshortening curve: equal angular shells of a 3D atmosphere project to image bands whose width is approximately linear in shell index. The closed-form inverse maps `distFromLimb d` to `bandIdx = floor((sqrt(1 + 8d) − 1) / 2)`. Stack count and alpha follow the same model as the outward halo (with `INNER_BASE_ALPHA` tuned subtler than the outer base). A per-pixel hash dither (`INWARD_BAND_DITHER`) scatters band boundaries across ±0.75 px so they read as organic haze, not concentric stripes. Output is the standard opaque per-fragment lerp `col = mix(col, vHazeColor, fadeA)`.

The continuity is intentional: at the limb (`r = vRadius`), the innermost outward layer and the outermost inward band both hit their maximum stack, so the opacity ridge centers exactly on the disc edge.

#### Banded rim color: a three-regime decision

`bandedRimColor(body)` in `disc-palette.ts` picks the limb color for banded bodies. The same regime applies to surface-mode bodies too (1.3a haze rim, 1.3b Rayleigh limb) but their decision tree is simpler.

| Regime | What's at the limb | Color source | Examples |
|---|---|---|---|
| High-altitude aerosol chromophore | The aerosol layer itself | `CHROMOPHORE_COLOR[gas]` (with `GAS_COLOR` fallback) | Titan CH4 tholin, Venus SO2, hot sub-Neptune SILICATE |
| Strong absorber mixed throughout (ice giant) | The absorber's transmission color | `topGases(body)[0]` (rank by `frac × potency`) | Uranus / Neptune CH4 cyan-blue |
| Forward scattering through a transparent column | Lightest gas's clear-gas color | `GAS_COLOR` of `pickLightestAtmGas(body)` (uses `GAS_MOLECULAR_WEIGHT`) | Jupiter / Saturn H2 cream |

`HIGH_ALTITUDE_CHROMOPHORES = {CH4, SO2, SILICATE}` — excludes NH3 (deep cloud chemistry on gas giants, not visible at the limb) and H2O (routes to 1.3c cloud patches, not a limb haze).

Because each body's rim color is now physically appropriate (light for scattering atmospheres, saturated for absorbing/haze atmospheres), the inward fade uses a plain `mix()` lerp and the limb naturally brightens or color-shifts in the right direction.

#### 1.3a Atmospheric haze tint (surface-mode bodies)

The per-fragment uniform tint that paints over the whole disc on surface-mode bodies with a haze chromophore (Mars rust, Io sulfur, procgen pre-banded SO2 / silicate worlds). Quantized into 3 discrete lerp amounts (`HAZE_TINT_LIGHT/MEDIUM/HEAVY_AMOUNT`) keyed off `chromophoreFrac × CHROMOPHORE_VISUAL_BOOST`. Suppressed on banded bodies (no surface to tint).

#### 1.3b Rayleigh limb

A 1-px sky-cyan rim (`THEME_RAYLEIGH_COLOR`) for surface-mode bodies with `surfacePressureBar ≥ RAYLEIGH_PRESSURE_THRESHOLD` and no haze chromophore. Earth is the canonical case. Reuses the rim shader path — `hazeColor` becomes the Rayleigh cyan, `rimWidthPx = 1`, `hazeTint` stays 0.

#### 1.3c H2O cloud patches

Discrete cloud cells painted over land + ocean (suppressed in the polar cap region). Active only when `chromophoreGas === H2O`. Implemented as **anisotropic worley cells** in the equator-aligned frame (`CLOUD_LON_PX / CLOUD_LAT_PX` ≈ 2.4:1 stretch), so cloud silhouettes elongate east-west — wind-swept zonal-flow streaks rather than axis-aligned grid squares. Cells have jittered centers via the standard worley pattern; density = `clamp(chromophoreFrac × CHROMOPHORE_VISUAL_BOOST, 0, CLOUD_MAX_COVERAGE)`. Cloud color is the hardcoded `CLOUD_COLOR` (~`GAS_COLOR[H2O]` near-white).

### 1.4 Cratering (DONE)

Per-worley-cell uniform-RGB lightness perturbation in the surface branch, amplitude `(1 − vSurfaceAge) × CRATER_MAX_AMPLITUDE`. Uniform RGB delta preserves hue — only lightness varies cell-to-cell — so an old icy moon (Callisto) gets dimmed-ice mottling and an old rocky body (Mercury) gets dimmed-rock cratering, both reading as the same "old surface" visual language.

Sits in the paint pipeline AFTER the cap/ocean/land branches set `col`, and BEFORE the cloud and haze passes — so atmospheric layers cover the perturbed surface intact. Active on all three surface branches (cap, ocean, land), since the unifying read is "old = pitted everywhere," not "old rock looks different from old ice."

Hash salts (547, 569) are distinct primes from worley jitter (13/19, 23/29), continent (113/127), resource (1009/2017), biome (197/311), cloud (991/...), and inward-fade dither (829/853), so a "lucky" cell can't accidentally line up old + biome-y or old + ocean-y from a shared noise stream.

---

## Phase 2 — Gas giants get personality (banded mode)

Goal: make Jupiter, Saturn, Uranus, Neptune and procgen siblings read as distinct, characterful giants — not a flotilla of curved-band variants.

### 2.1 Banded storms

**Why.** Today's banded discs all read as tidy zonal flow. Real giants have non-band features: Jupiter's Great Red Spot, Saturn's hexagonal pole vortex, Neptune's Great Dark Spot. Approximate as 1–3 elliptical "spots" overlaid on the bands, positioned and colored from chromophore data.

**Trigger.** Banded mode AND `worldClass in (gas_giant, ice_giant, gas_dwarf)`. Venus-class banded rockies are excluded — they're banded because of thick atmosphere, not zonal-flow systems.

**Data inputs.** `chromophoreFrac` (storm density), per-body `vSeed` (storm positions and sizes).

**Pipeline.**
- `stormCount = clamp(round(chromophoreFrac × STORM_DENSITY_BOOST), 0, MAX_STORMS_PER_DISC)`. Bodies with no chromophore (e.g. pure H2/He near-transparent giant) get zero storms.
- Per storm, hash a position `(latSin, lonOffset)` and an `(semiLat, semiLon)` size from `(vSeed, stormIdx)`. Long-axis along longitude (Jupiter's GRS is ~3:1).
- Storm color: `CHROMOPHORE_COLOR[gas]` (the condensed-product hue — NH3 → NH4SH brown for Jupiter).
- Fragment test (in rotated band frame, after the tilt math runs): if inside the ellipse, paint storm color. Per-band lightness jitter still applies on top so the spot stays band-aligned in feel.
- Storms render in the rotated band frame so they tilt with the rest of the disc.

**Tuning anchors.**
- Jupiter (NH3 chromophore at small frac, large `CHROMOPHORE_VISUAL_BOOST`) — one Red Spot analog, mid-southern latitude.
- Saturn (NH3, lower frac than Jupiter) — 0 or 1 storm; matches Saturn's variable history.
- Uranus (no chromophore set, CH4 wins via potency but no chromophore slot) — zero storms. Matches Voyager's bland disc.
- Procgen Neptune-analog with stronger chromophore — one storm. GDS analog.

**Risk.**
- Ellipse silhouette stair-steps under the per-pixel discard test. Acceptable — matches the disc's own jagged rim under low size and the bands' undulating boundary.
- Storm + band overpaint order: storm replaces underlying band color in its footprint, doesn't blend. (Blend would smear the band-aligned read.)

### 2.2 Aurora pole tint ( DEFER FOR NOW - ASK AT THE END )

**Why.** Magnetic-field differentiation that the banded shader doesn't read today. Jupiter alone has a dramatic field; the others sit much lower. Aurora-tinted poles let the disc read this without text.

**Trigger.** Banded mode, `worldClass in (gas_giant, ice_giant, gas_dwarf)`, `magneticFieldGauss > AURORA_FIELD_THRESHOLD`.

**Data inputs.** `magneticFieldGauss`, plus the body's chromophore for the auroral color (real auroras are H emission lines; we approximate via the body's chromophore palette so a chromophore-less body gets a fallback to `palette0`).

**Pipeline.**
- `auroraStrength = smoothstep(AURORA_FIELD_THRESHOLD, AURORA_FIELD_FULL, magneticFieldGauss)`.
- `polarTaper = pow(abs(latSin), AURORA_POLE_EXPONENT)` — concentrates effect at the poles.
- After the band color pick: `col = mix(col, CHROMOPHORE_COLOR[gas] ?? palette0, auroraStrength × polarTaper × AURORA_TINT_AMOUNT)`.
- Pipeline order in banded mode (final spec): band pick → band lightness jitter → aurora tint → storms. Storms win at the poles when they overlap (the band-aligned spots paint last).

**Tuning anchors.**
- Jupiter — pronounced amber-brown lift at the poles (NH4SH chromophore color), matching the real auroral cap region.
- Saturn — faint tint, barely visible.
- Uranus / Neptune — subdued. Uranus's tilted-axis field is weird, but our static disc doesn't model the offset — accepted limitation.

**Risk.** Pipeline ordering with storms — codify in the shader to avoid drift.

---

## Phase 3 — Scene-level cinema

### 3.1 Ring shadow ( DEFER FOR NOW - ASK AT THE END )

**Why.** Ringed giants currently render with rings and bands but no interaction between them. A ring shadow line crossing the planet's disc is the single biggest visual cue that the ring is *physical*, not a sticker.

**Trigger.** A body has a non-null `ring` index.

**Data inputs.** Ring inner/outer radii (from the ring body), host `axialTiltDeg` (already in `vTilt`), the implicit star direction.

**Star direction is a project-wide decision** — picking one and committing to it for ALL system-view cinema (ring shadows now; future day/night terminator; etc.) is the load-bearing call. Recommendation: +X from the right edge of the screen, matching the layout's left-to-right "innermost to outermost" axis (the star is conceptually to the left of the leftmost body, but for shadow geometry "light comes from the star direction" reads consistently with that left-to-right narrative).

**Pipeline.**
- Plumb ring `innerPlanetRadii`, `outerPlanetRadii`, and the ring's `axialTiltDeg` (if it differs from the host's; today they share) as new disc attributes when the body has a ring; zero / `mode_off` flag when not.
- Per fragment on the disc, project the fragment's planet-local position onto the ring plane along the assumed star direction. If the projection's `r` falls within `[innerR, outerR]`, the fragment is in shadow.
- `col *= RING_SHADOW_AMOUNT` (multiplicative darken — preserves hue; just dims).
- Edge of the shadow follows the same `WARP_CHUNK_PX` stair-stepping the band boundaries use, so it reads as deliberate pixel-art rather than a thin smooth band.

**Tuning anchors.**
- Saturn (procgen-equivalent, since our catalog's Saturn doesn't have a ring body today) — clear dark line across the disc, narrower at the equator (ring edge-on relative to assumed light) and broader where tilt projects the ring further.
- A Uranus-class high-tilt body — ring shadow runs near-vertical across the disc.

**Risk.**
- Star direction commitment is the biggest. Pick once; revisit only if Phase 3.2+ demands a different convention.
- Computing the shadow in the planet shader (we're darkening the *disc*, not the ring) — plumbing is straightforward but introduces per-disc conditional attributes (zero if no ring; set if ring).

---

## Demoted / dropped from the original brainstorm

- **Volcanic hot spots.** Io is the only catalog body that strongly triggers (lava class + tectonicActivity=1). Procgen lava worlds are rare. Fold into lava-class palette tuning later if it ever feels worth the dedicated machinery.
- **Temp-gradient palette.** Banded mode already encodes equator/pole variation via per-band picks. Surface-mode oceans gain little from a warm/cool tropical lerp once biome tint and clouds are in.

## Out of scope (would require new mechanics)

- **Day/night terminator.** Needs a sub-solar point on every body and a lighting model. The system view is intentionally a static screen layout (no orbit, no zoom); committing to a single light direction project-wide is the prerequisite — see Phase 3.1's note.
- **Animated rotation.** `rotationPeriodHours` is on every body but the renderer is static. Out of scope until the system view gains time semantics.
- **Vegetation density / canopy detail.** Below the resolution we're rendering at (40–120 px discs).

## Cross-cutting notes

- **Paint order (current).** Surface fragments traverse this fixed pipeline before the rim/halo passes paint over the disc edge:
  ```
  resource cell pick
    → biome stipple
    → ocean override
    → ice cap override
    → cloud patches (1.3c, H2O only)
    → haze surface tint (1.3a, non-H2O haze chromophores)
    → INWARD fade (1.3a/b rim color × bandIdx alpha)
  ```
  Banded fragments skip everything before the inward fade — their disc-interior pass is the banded-strip paint, and the inward fade lerps that toward the rim color near the limb. The outward halo (1.3a/b) paints at fragments where `r > vRadius` regardless of mode, as alpha-blended `vec4(vHazeColor, rimA)` with the planet material `transparent: true`. Hover rim (1-px white stamp at `r > vRadius - 1`) is the final per-fragment override on the disc-interior pass.

  Cratering (1.4) sits **after** cap and **before** clouds/haze — the per-cell lightness perturbation applies to the surface beneath any atmospheric layer.

- **Hash-salt budget.** Each feature adds one or two hash21 calls. Salts must be distinct so the same cell doesn't accidentally light up multiple features in correlation. Allocated so far (per-body multipliers on `vSeed`):
  - Worley jitter: 13/19, 23/29
  - Continent group: 113/127
  - Resource pick: 1009/2017
  - Biome stipple: 197/311
  - Cratering: 547/569
  - Inward-fade boundary dither: 829/853
  - Cloud cells (jitter + pick): 991/997, 1013/1019, 1031/1033

- **Attribute budget.** Some GPUs cap `gl_MaxVertexAttribs` at the WebGL1 minimum (16 — and in practice we've seen failures at 15). The planet/moon Points pools pack scalars aggressively to stay at 11 attributes total: `aRenderMeta: vec4` (size/mode/seed/tilt), `aCoverageScalars: vec4` (water/ice/biomeCov/hazeTint), `aAtmoStrokes: vec3` (rimWidth/cloudDensity/surfaceAge), plus `position`, `aHovered`, three `aPalette` vec3s, `aWeights`, `aBiomeColor`, `aHazeColor`. New features should pack into a spare vec4 component before adding a new attribute.

- **Browser smoke.** Each Phase entry ships with a manual verification pass against the eleven Sol bodies before moving on — the data is anchored, the visual outcome is predictable enough to eyeball.
