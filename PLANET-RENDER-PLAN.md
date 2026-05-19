# Planet render plan

Multi-phase roadmap for enriching the planet/moon disc renderer in the system view. Captures durable design intent — kept distinct from `README.md` (which documents the steady-state architecture) and from ephemeral session-scoped refactor docs (which stay out of the repo via `.git/info/exclude`).

Implementation lands incrementally; expect each phase to ship as one or two commits with a working browser smoke before moving on.

## Premise

Make planets and moons feel like *places* — distinct, beautiful, enticing — while preserving the pixel-crisp aesthetic and the primary-attributes-only data philosophy. Visual character emerges from the same fields gameplay reads. No separate "appearance" enum, no derived weights stacked on top of an already-emergent signal.

## Current state

Surface mode reads `worldClass`, `axialTiltDeg`, the six-scalar resource grid, atmosphere (top three gases + chromophore), `waterFraction`, `iceFraction`, `surfaceAge`, plus `biosphereArchetype × biosphereTier × hostStar.cls`. Banded mode reads the same gases + chromophore + `axialTiltDeg`. Both share parity-aware pixel snap and the same sphere-projection foreshortening (`RING_MINOR_OVER_MAJOR` pole tilt) so a ringed body's bands and ring share one vantage.

Most-recent landings:
- **Phase 1.5c — discrete crater features with layered resource model** (done). The surface-age visual signal is now *features* rather than *noise*. Each land-branch fragment scans a 3×3 neighborhood of crater seed cells in the same sphere-projected `(lon, lat)` frame as 1.5a/b; existence per cell scales with `(1 − surfaceAge)²` so Mercury / Luna / Callisto saturate while Earth-class bodies show only rare craters. A winning crater paints solid-color from the **subsurface mask** — the complement of the 1.5b bucket the crater's center lies in — so a metals-surface region with rare-earth subsurface shows pink-grey craters, a silicate-surface region with metals subsurface shows iron-grey. Surface features carry the body's own resource palette. `CRATER_PATCH_FACTOR = 2.0`, `CRATER_DENSITY_MAX = 0.8`, radius range `[0.2, 0.9]` with `hash²` bias toward small. Salts 547/569/587.
- **Per-cell mottling pass removed.** The earlier surface-age mechanism (uniform-RGB lightness perturbation per worley cell, amplitude tapered by `1 − surfaceAge`) was a stopgap that read as noise rather than as planetary features. Removed cleanly; the "old surface" visual signal moves to Phase 1.5c (discrete crater features) where surface age drives crater *density* instead of cell *noise*.
- **Phase 1.5a inset (`SPHERE_VISIBLE_FRAC`)**. The surface-mode `(nxs, nys)` are scaled by 0.85 before computing `nzs`, so the disc edge maps to `asin(0.85) = 58°` from the band-aligned pole rather than to the true limb at `nzs = 0`. Cells at the disc rim are bounded to ~53% of disc-center size instead of pinching to sub-pixel widths under the unscaled full-hemisphere projection. The disc still reads as a globe; the pixel-art aesthetic stays coherent at every rim pixel.
- **Phase 1.5b — per-region resource-subset selection** (done). A coarser super-cell pass aggregates `REGION_PATCH_FACTOR² = 36` fine worley cells per region; each super-cell hash discretizes into one of `REGION_BUCKET_COUNT = 7` non-empty subsets of `{palette0, palette1, palette2}`. That subset masks the body's natural weights and the fine cell pick within the super-cell paints from the masked palette — so each region carries a distinct combination of the body's top-3 resource colors. Land-only: oceans and ice caps stay flat because their color isn't from the resource palette. Mercury's iron-grey, rare-earth rose, and silicate rust now separate into spatial regions rather than mixing uniformly across the disc.
- **Phase 1.5a — sphere-projected surface worley** (done). The surface-mode cell pass now lives in `(lon, lat)` on the band-aligned sphere rather than in screen-space `d`. Every fragment derives `lat = asin(latSinS)` and `lon = atan2(nxs, nzs·POLE_COS − nys·POLE_SIN)` once (one asin + one atan2 added to the surface branch); cell coords are `(lon, lat) × vRadius / SURFACE_PATCH_PX` so disc-center cells stay at `SURFACE_PATCH_PX` while limb cells compress under foreshortening. Terrestrials read as globes — features near the limb shrink and elongate parallel to the horizon — without any per-feature projection cost. Foundation for the multi-scale and crater passes below; both inherit the same sphere-space metric.
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

### 1.4 Cratering — removed

The original implementation of cratering was a per-cell uniform-RGB lightness perturbation in the surface branch, amplitude `(1 − vSurfaceAge) × CRATER_MAX_AMPLITUDE`. It restored the Ganymede/Enceladus brightness distinction when albedo left the render path, but it read as cell-level *noise* rather than as planetary *features* — an ancient moon and a young moon differed by mottling amplitude on the same texture instead of by visible geological signatures. Surface age moved to Phase 1.5c (discrete crater features), where age drives crater density and craters paint with the body's own resource palette via the layered resource model. The 547/569 hash salts are reserved for the new crater pass.

---

## Phase 1.5 — Terrestrial surfaces feel like *places*, not noise

Goal: real moons read by their *signature features* (Callisto's bright impact dots, Ganymede's dark/light terrain split, Europa's near-uniform pale base), not by per-cell color noise. Today every body uses the same 4-px worley pass tinted by its resource palette and age-perturbed by `(1 − surfaceAge)`, so an ancient ice moon and an ancient rocky moon are *the same texture in different colors*. The three sub-phases below decompose "surface" into three distinct rendering mechanisms at three spatial scales — sphere-projected cells (existing pass, now globe-aware), terrain regions (large-scale composition variation), and discrete crater features (point features replacing the lightness-perturbation noise). Gas giants already read as spheres via banded latitude arcs; this phase brings terrestrials into the same sphere-aware regime.

### 1.5a Sphere-projected surface worley (DONE)

The surface-mode worley cell pass moves from screen-space (`d / SURFACE_PATCH_PX`) to sphere-space (`(lon, lat) × vRadius / SURFACE_PATCH_PX`). Foundation for 1.5b and 1.5c — both inherit the same metric.

Sphere-space derivation reuses the band-aligned frame already used by the cap test:
- Pole `P = (0, POLE_COS, POLE_SIN)`, prime meridian `F = (0, −POLE_SIN, POLE_COS)`, east `E = (1, 0, 0)`.
- `sin(lat) = dot(n, P) = latSinS` (unchanged).
- `cos(lat) cos(lon) = dot(n, F) = nzs·POLE_COS − nys·POLE_SIN` → `lonF`.
- `lat = asin(latSinS)`, `lon = atan2(nxs, lonF)`. One `asin` + one `atan2` added to the surface branch per fragment.

Cell coords scale by `vRadius / SURFACE_PATCH_PX` so disc-center cells stay at `SURFACE_PATCH_PX` (same density as the prior screen-space pass); cells toward the limb compress along the natural foreshortening curve. The worley loop body is unchanged — same 3×3 neighborhood, same jitter salts (13/19, 23/29), same hash → winnerCell pick. Cap, continent, resource pick, biome stipple, cratering, cloud, and haze passes downstream are all unchanged; they consume `winnerCell` and `latSinS` exactly as before.

**Sphere-projection inset (`SPHERE_VISIBLE_FRAC`).** Before computing `nzs`, the disc-normalized `(nxs, nys)` are scaled by `SPHERE_VISIBLE_FRAC` (= 0.85), so the disc edge maps to the point on the sphere where `nxs² + nys² = FRAC²` rather than to the true limb at `nzs = 0`. Without this, cells at the disc rim pinch to sub-pixel widths under full foreshortening and read as noise rather than wrapped texture — wrong both physically (we're rendering pixel-art, not retina-resolution Galileo plates) and aesthetically (the chunky aesthetic wants coherent cells, not aliased rim noise). At 0.85, the disc edge sits at `asin(0.85) = 58°` from the band-aligned pole; edge cells are `sqrt(1 − 0.85²) ≈ 53%` of disc-center size; the disc still reads as a globe but stays pixel-coherent at every rim pixel. Side effect: disc-center cells are ~17% larger than the unscaled mapping (one cell ≈ `SURFACE_PATCH_PX / FRAC` screen-pixels) and the cap region also insets slightly from the disc rim — both acceptable. Banded mode keeps the full `FRAC = 1.0` projection because its arched latitude bands need the strong foreshortening to look spherical.

Pole singularity: `lon` is ill-defined at `latSin = ±1` (the visible pole). The inset bounds the max `latSinS` to `FRAC × POLE_COS + sqrt(1 − FRAC²) × POLE_SIN`, so the singularity is never reached on the visible disc; the cap test (`|latSinS| > 1 − vIceFrac`) covers the pole region for any body with `iceFrac > 0.03`, and airless capless bodies have no visible singularity by construction.

**Tuning anchors.** All 11 Sol bodies should read identifiably the same as before at disc center, with bounded foreshortening at the limb: cells near the rim should appear thinner perpendicular to the horizon and elongated parallel to it, but no thinner than ~half their disc-center width. Most visible on the largest discs (Earth, Mars). Mercury/Luna stay clearly textured. Banded bodies (Jupiter, Saturn, Uranus, Neptune, Venus, Titan) are unaffected.

### 1.5b Per-region resource-subset selection (DONE)

A second hash pass in the same `(lon, lat)` frame as 1.5a, derived by floor-dividing `winnerCell` into `REGION_PATCH_FACTOR = 6` super-cells — so super-cell boundaries inherit the fine worley pass's jittered shapes (region edges are organic curves, not grid-aligned). Per-super-cell hash discretizes into one of `REGION_BUCKET_COUNT = 7` non-empty subsets of `{palette0, palette1, palette2}`. That subset is the *mask* — `regionWeights = vWeights × mask`, and the fine cell pick uses those region weights. Each super-cell therefore paints from a different combination of the body's top-3 resource colors.

**Why subset masking over lightness shifts.** An earlier version of 1.5b applied a uniform-RGB lightness modifier (±18%) on top of whatever cap/ocean/land/biome paint produced. The mechanism worked but the result was *muddy* — a multi-resource body got dim/bright regions that all shared the same blended underlying texture, so the regional variation read as shading rather than as composition. Resource-subset selection swaps shading for *palette switching*: a Mercury region paints only metals, the next region paints only silicates, the next paints a mix of metals + rare-earths. Each region keeps the pixel-crisp resource colors intact; surface variance comes from spatial redistribution of the body's existing composition, not from darkening or brightening it.

**Land-only.** Ocean and ice-cap cells are flat colors (`OCEAN_COLOR`, `ICE_COLOR`), not from the resource palette, so the region pass is gated to the land branch. Biome stipple paints over land cells unaffected — the biome layer reads as biology against whatever resource the region picked. The pipeline order inside the land branch is: continent test → **region mask → resource pick** → biome stipple → (close land branch) → cratering.

Hash salts (401, 419) are distinct primes from worley jitter (13/19, 23/29), continent (113/127), resource (1009/2017), biome (197/311), cratering (547/569), cloud (991/...), and inward-fade dither (829/853).

**Bucket layout.** With three palette slots, the 7 non-empty subsets are:

| Bucket | Mask | Region content |
|---|---|---|
| 0 | (1, 0, 0) | pure palette0 |
| 1 | (0, 1, 0) | pure palette1 |
| 2 | (0, 0, 1) | pure palette2 |
| 3 | (1, 1, 0) | palette0 + palette1, weighted by body weights |
| 4 | (1, 0, 1) | palette0 + palette2 |
| 5 | (0, 1, 1) | palette1 + palette2 |
| 6 | (1, 1, 1) | natural body composition (all three) |

Pure-palette buckets boost minor resources past their natural weights — a body weighted (0.7, 0.2, 0.1) still shows palette2-dominant regions even though palette2 is the trace resource. That's intentional: it gives multi-resource bodies more visible regional character than their bulk composition alone would suggest. If a body has any palette slot weighted zero (only top 2 resources contribute), pure-slot buckets for the empty slot fall through to the `pickFromPalette` palette0 fallback — that region just blends in with palette0-dominated neighbors.

**Tuning anchors.**
- Mercury / Luna — visibly distinct regions of iron-grey, rare-earth rose, silicate rust, with the body's full composition reading as the *aggregate* of the regions rather than a uniform blend.
- Ganymede / Callisto — large-scale composition regions in ice-grey vs. tinted-volatile color, layered with cratering on top for the multi-scale "old surface" read.
- Earth — continents show regional resource variation (oceans and ice caps stay uniform; biome stipple still paints over land regions in temperate latitudes).
- Io / Europa — smooth bodies show coherent regional composition variance, no cratering on top to fragment it.

**Risk.**
- Region cells at the limb compress under sphere-projection (same as the fine cells, scaled by `REGION_PATCH_FACTOR`). At small disc sizes (~20px moons) region cells may project to 1-2 px wide at the limb. Acceptable for now; if it reads as noise we'll revisit with a min-screen-px clamp.
- Bodies with only one significant resource (single-palette-slot weighted past ~0.95) show minimal regional variation — most buckets degenerate to that single palette. Accepted tradeoff: surface variance is genuinely tied to composition, so a near-pure-iron body reads as nearly uniform iron-grey, which is correct.

### 1.5c Discrete crater features + layered resource model (DONE)

**Why.** A real ancient surface (Callisto, Mercury, Luna) is saturated with discrete bright impact dots at a power-law size distribution — the dots ARE the visual signature. Surface age should manifest as *more craters*, not as cell-level noise on the same texture.

**Layered resource model — the load-bearing design.** Craters and their ejecta paint from a *different* subset of the body's three resource palette slots than the surface region they punch through. Geologically: each surface region (1.5b) is the top layer of regional stratigraphy; the layer underneath is the rest of the body's composition. An impact excavates through the top layer and exposes the subsurface — so crater color is the body's own palette, just a different combination than what shows on the surface. Net visual: a metals-surface region with rare-earth subsurface shows pink-grey craters on a dark grey region; a silicate-surface region with metals subsurface shows iron-grey craters on a rust-orange region. Crater features carry the body's identity without needing a new color attribute.

**Subsurface mask derivation.** Each region already picks a `mask` (1.5b bucket → one of 7 non-empty subsets of `{palette0, palette1, palette2}`). The subsurface mask is the *complement*: subset bits that are zero in the surface mask. Examples:

| Surface mask (bucket) | Subsurface mask |
|---|---|
| (1, 0, 0) bucket 0 — pure palette0 | (0, 1, 1) palette1 + palette2 |
| (0, 1, 0) bucket 1 | (1, 0, 1) palette0 + palette2 |
| (0, 0, 1) bucket 2 | (1, 1, 0) palette0 + palette1 |
| (1, 1, 0) bucket 3 | (0, 0, 1) palette2 |
| (1, 0, 1) bucket 4 | (0, 1, 0) palette1 |
| (0, 1, 1) bucket 5 | (1, 0, 0) palette0 |
| (1, 1, 1) bucket 6 — natural | (1, 1, 1) — fall back to natural (no contrast) |

The bucket-6 fallback case (region uses all three resources, no complement available) paints craters in the natural body palette — same as the surface — losing crater visibility in those regions. Acceptable: bucket 6 is the "least region-y" case; bodies whose regions dominate it weren't going to read as regionally varied anyway.

**Pipeline.** Per crater-seed cell (coarser `(lon, lat)` grid in the same sphere-projected frame as 1.5a/b — `CRATER_PATCH_FACTOR = 2.0` × the fine cell pitch), hash decides:
- (a) is there a crater? `existH < (1 − surfaceAge)² × CRATER_DENSITY_MAX`. Squared scaling makes the age signal steep — Mercury (age=0.05) hits ~0.72 existence; Mars (age=0.4) hits ~0.29; Earth (age=0.7) hits ~0.07; Io (age=1.0) hits 0. Matches the real impact-rate decline over geologic time without modeling it explicitly.
- (b) where in the cell? Two independent jitter hashes for the crater center inside its cell.
- (c) what angular radius? `CRATER_RADIUS_MIN + (CRATER_RADIUS_MAX − CRATER_RADIUS_MIN) × hash²` — `hash²` bias produces a power-law-ish distribution toward small radii (most craters small, occasional large).

Each fragment scans the 3×3 neighborhood of crater seed cells, accepts the *closest* crater containing it (smallest `dist`), and paints that crater's color. Closest-wins handles overlap correctly: when two craters share a fragment, the one whose center is nearer takes the pixel — geologically plausible for the chunky aesthetic. Solid-color paint per crater — no internal rim/floor brightness variation, intentionally avoided to preserve the pixel-crisp palette character and not regress to the muddy-shading failure mode that derailed 1.5b's first attempt.

**Hash salts.** Crater hashes use primes 547, 569, 587 (added 587 vs. the original 547/569 reservation to give enough distinct salt pairs for 5 independent draws). Salt pairs in shader: existence `(547, 569)`, jitter X `(587, 547)`, jitter Y `(569, 587)`, radius `(569, 547)` (reversed pair distinct from existence), palette `(587, 569)`.

**Tuning anchors.**
- Mercury / Luna — heavy saturation of small craters; surface regions read as the "skin," ejecta dots reveal the body's other resources.
- Callisto — densest possible cratering; ice-grey surface with darker-volatile crater floors and ejecta.
- Earth / Io — near-zero crater density (surface age ~ 0.7-1.0).
- A region in bucket 6 (natural mix) — craters read as same-color spots, low contrast. Side effect of the complement scheme; visually acceptable because such regions are already "neutral."

**Risk.**
- Crater rendering cost — 9 distance tests per fragment in the surface branch. Early-rejection on cells with no crater keeps the average cost low; large crater radii relative to seed-cell pitch are the worst case.
- Subsurface complement of a body with one zero-weight resource (e.g. weights (0.7, 0.3, 0.0)) can produce an effective subsurface of pure-zero-weight, which falls through to the `pickFromPalette` palette0 fallback. Craters in those regions paint as palette0 — visible against a non-palette0 surface, invisible against a palette0 surface. Edge case; tolerable.
- Crater overlap pattern (later impacts overlay earlier ones) is not modeled; first-pass is "if any crater contains me, paint it." Real Callisto shows overlapping crater rings; we render the union.

### 1.5d Linea (deferred)

Surface linea — Europa's red cracks, Enceladus's tiger stripes — would emerge from the same layered-resource model. A linea is a thin stair-stepped path painted from the region's subsurface mask, drawn across the surface where `worldClass = ice` and `surfaceAge` is high (the cracks are *young* features on icy crust, the opposite signal from craters). One mechanism — point features for craters, line features for linea — both colored by the body's own subsurface palette. Defer until 1.5c is shipped and the layered model is proven. (Phase 1.6 retires the `worldClass='ice'` gate; the trigger updates to `iceCoverage × surfaceAge` as part of that work — see below.)

---

## Phase 1.6 — Ice as a contextual surface state

Retire `'ice'` from `WorldClass`. Ice becomes a surface state composed on top of whatever the body is actually made of — Europa is fundamentally `ocean`, Callisto and Ganymede are `rocky`, an ice-age Earth is still `ocean`. Ice presence, distribution, and role in the layer stack emerge from `iceFraction`, `avgSurfaceTempK`, and `surfaceAge` rather than a class enum. Composes with the existing 1.5b region / 1.5c crater machinery — the layered resource model already does the structural work; this phase just gives ice a position in the stack.

**Why.** Today's renderer treats `iceFraction` as polar-cap latitude band geometry only (`|latSinS| > 1 - iceFrac` flips to flat `ICE_COLOR`). That matches one physical regime — a warm body where ice persists only at the coldest latitudes (Earth, Mars) — but breaks for cold-body global ice (Europa, Ganymede, Callisto, Enceladus). The cap branch is also a *terminator* in the pipeline: regions, resources, biome stipple, and craters all skip — so an ice moon's defining features (Callisto's impact dots, Europa's lineae character) can't render even when the data is right. And `worldClass='ice'` carries overlapping meaning with `iceFraction`: Callisto's CSV today says `iceFraction=0.05` *and* `worldClass='ice'`, an ambiguous combination on its face. `worldClass` should describe what the body is *made of*; ice is a surface property the body *has*.

**Three-layer surface stack.** Per fragment, three values compose:
- `resourceSurface` — 1.5b region pick (`pickFromPalette` over `vWeights × regionMask`).
- `resourceSubsurface` — 1.5c subsurface pick (`pickFromPalette` over `vWeights × complementMask`).
- `iceLayer` — flat `ICE_COLOR`, present when `iceCoverageAt > 0`.

Stack order is chosen by `surfaceAge`:
- Young (high age) → `[ice, resourceSurface, resourceSubsurface]`. Fresh resurfacing keeps ice on top; craters cut through to expose underlying resources. Europa pattern.
- Old (low age) → `[resourceSurface, ice, resourceSubsurface]`. Accumulated impact regolith + radiation darkening buries the ice; craters punch through and reveal it. Callisto pattern.

Per-fragment composition reads:

```glsl
youngTop = mix(resourceSurface, iceLayer, iceCoverage);
oldTop   = resourceSurface;
col      = mix(oldTop, youngTop, surfaceAge);

if (inCrater) {
  youngCrater = resourceSubsurface;
  oldCrater   = mix(iceLayer, resourceSubsurface, 1.0 - iceCoverage);
  col         = mix(oldCrater, youngCrater, surfaceAge);
}
```

A mid-age body mixes both stacks — the body reads as a hybrid, no hard switch. Future 1.5d linea slot in as crack-shaped windows that always paint `resourceSubsurface`, gated on `iceCoverage × surfaceAge`. Europa's lineae fall out of the same machinery without new attributes.

**`iceCoverageAt(latSinS, iceFraction, avgSurfaceTempK)` — geometry decider.** Continuous lerp between cap and global patterns, indexed by temperature rather than class:

```glsl
float capPattern    = step(abs(latSinS), 1.0 - vIceFrac);  // 1 inside cap latitude band
float globalPattern = vIceFrac;                             // uniform fraction
float globalness    = smoothstep(WARM_TEMP_K, COLD_TEMP_K, vAvgTempK);
float iceCoverage   = mix(capPattern, globalPattern, globalness);
```

`WARM_TEMP_K` / `COLD_TEMP_K` straddle ~250 K. Earth (288 K) → caps; Europa (102 K) → global; an ice-age Earth analog at ~260 K crosses through "caps expanding to merge across mid-latitudes" rather than snapping between modes. CPU-side packs `globalness ∈ [0, 1]` as a normalized scalar on a spare attribute component so the shader doesn't plumb the thresholds.

### 1.6a Data migration — retire `'ice'` from `WorldClass`

One commit; touches procgen tables, the world-class cascade, the Sol body CSV, and a few `WorldClass`-keyed lookup tables.

**Type + tables (`src/data/stars.ts`).** Drop `'ice'` from the `WorldClass` union. Remove `WORLD_CLASS_COLOR['ice']`, any `WORLD_CLASS_TINT['ice']` entry, and `GAS_VISIBILITY_FILTER['ice']`.

**Procgen routing (`scripts/lib/procgen.mjs`, `scripts/lib/procgen-priors.mjs`).**
- `worldClass` cascade — cases that flipped to `'ice'` now stay on their primary class with `iceFraction` sourced from a temperature-driven prior. `OCEAN_MIN_MASS_EARTH` sub-Mars gate stops routing would-be-oceans to `'ice'`; they flip to `'rocky'` (mass too low to retain liquid surface water; body is fundamentally rocky with frozen surface volatiles).
- `SURFACE_AGE_BY_CLASS['ice']` → deleted. Cold-rocky / cold-ocean bodies pick from their primary class entries; the `SURFACE_AGE_TIDAL_LIFT` branch for eccentric giant moons continues to drive Europa/Enceladus-young-surface.
- `ATMOSPHERE_GASES_BY_CLASS['ice']` → deleted. Cold-class atmospheres come from rocky/ocean branches plus an insolation-keyed bias for outgassed N2/CH4 retention.
- `ICE_THICK_ATM_PROBABILITY` / `ICE_THICK_ATM_PRESSURE_BAR` → re-keyed on `insolation < ICE_THICK_ATM_INSOLATION_THRESHOLD` (rather than class). Titan-class thick atmospheres emerge on cold rocky/ocean worlds.
- `PLANET_RESOURCE_PRIORS_BY_CLASS['ice']` → deleted; volatile-heavy distributions roll into cold branches of rocky/ocean via insolation gating.
- `CHROMOPHORE_BY_CLASS['ice']` (CH4 tholin) → moved to a gated rule on `(rocky | ocean) + cold-insolation + (surfacePressureBar ≥ CHROMOPHORE_THIN_ATM_MIN_BAR)`.
- `iceFraction` prior — from class-keyed to insolation-driven. Cold rocky → moderate; cold ocean → high; warm → low (cap-band fraction).

**Sol bodies (`src/data/bodies.csv`).** Reclassify the affected anchors:
- Europa: `ice` → `ocean`. Bulk is "ocean covered with ice". Keep `iceFraction=0.85`.
- Ganymede: `ice` → `ocean`. Differentiated body with subsurface ocean. Bump `iceFraction` to ~0.6 (globally icy with rocky exposures).
- Callisto: `ice` → `rocky`. Bulk silicate body. Bump `iceFraction` to ~0.7 (surface globally icy but heavily impact-mixed; the dark surface emerges from low `surfaceAge` aging the ice underneath).
- Enceladus: `ice` → `ocean`. Subsurface ocean with cryovolcanic resurfacing; iceFraction stays high.
- Titan: `ice` → `rocky`. Bulk character is rocky+icy mantle; banded mode renders the tholin haze regardless of surface `iceFraction`.
- Future Pluto/Triton: `rocky` with very high `iceFraction`.

**Smoke pass after 1.6a.** Re-run `build:catalog` and load the renderer. Non-ice bodies should look unchanged. Ice bodies render cap-pattern geometry against the migrated `iceFraction` values — visually "wrong but consistent" (Europa stays approximately white via the bumped cap; Callisto reads bare-rocky since its cap pattern won't fire globally yet — 1.6b's job).

### 1.6b Render — continuous `iceCoverage` + surfaceAge-driven layer stack

Touches `src/scene/materials/system.ts` (the planet shader) and `src/scene/system-diagram/disc-palette.ts` (attribute plumbing).

**Attribute additions.** `surfaceAge` already plumbed (1.5c). `globalness` (the temperature-derived 0..1 scalar from `iceCoverageAt`) packs into a spare component of an existing vec — `aAtmoStrokes: vec3` (rimWidth / cloudDensity / surfaceAge) expands to a `vec4` with `globalness` as the fourth. No new attribute slot; stays under the `gl_MaxVertexAttribs` budget called out in `README.md`.

**Shader (`makePlanetMaterial`).** Replace the cap branch with the three-layer composition. Compute `iceCoverage` from `(latSinS, vIceFrac, vGlobalness)` per fragment. Compute `resourceSurface` and `resourceSubsurface` once each (region pick + complement pick — both already exist in the surface branch), then `mix` per the stack-order rule. The crater branch keeps its existing closest-wins geometry; the *color* it paints now branches on stack order. The cloud (1.3c) and biome (1.2) gates change from "not in cap latitude" to "ice doesn't fully cover this fragment", so a patchy mid-coverage Ganymede analog still gets cloud/biome passes where ice is sparse.

**`disc-palette.ts`.** Drop any `worldClass === 'ice'` special cases. Banded-mode triggers (gas/ice giant, pressure ≥ banded threshold, haze chromophore + Titan-class pressure) are already class-agnostic outside the 'ice' branch. Plumb `globalness` into `DiscProps`; null `avgSurfaceTempK` (shouldn't happen for surface bodies post-Filler) falls back to `0` (cap pattern, safest default).

**Tuning anchors (Sol bodies after 1.6a + 1.6b).**
- Europa — bright global ice with rare resource-revealing craters (`surfaceAge` high × `iceCoverage` high). Top of stack is ice. Lineae (future 1.5d) are the natural payoff.
- Callisto — dark resource-color surface with bright ice-revealing crater dots (`surfaceAge` low × `iceCoverage` ~0.7). Top of stack is resource regions.
- Ganymede — hybrid; body-level surfaceAge averages out real Ganymede's regional young/old dichotomy. Craters appear in *both* ice and resource colors depending on which surface layer they cut through. See Risk.
- Enceladus — bright global ice, high surfaceAge; cryovolcanic plumes out of scope.
- Earth — warm body → cap pattern. Low `iceFraction` → small caps. Continents + oceans + biome stipple unchanged.
- Mars — warm-ish + low `iceFraction` → small caps. No visual change.
- Mercury / Luna / Io — zero `iceFraction` → no ice layer; three-layer stack collapses to today's two-layer rocky pipeline. No visual change.
- Titan — banded mode; surface `iceFraction` doesn't render under banded.
- A procgen ice-age Earth analog (cold rocky with `iceFraction > 0.5`) — smoothly transitions through globalness rather than stepping. Verify the visual reads as physically motivated.

**Risk.**
- **Ganymede's regional dichotomy is averaged out.** A body whose surface is half young (grooved, ice-on-top) and half old (cratered, ice-buried) reads as a body-level mix rather than a spatial split. Acceptable for v1; if disappointing, fold an age-bias into the 1.5b region bucket so each region picks its own ice-role independently of the body-level value.
- **Determinism + `avgSurfaceTempK`.** Keying shader behavior off a Filler-derived field means a `PROCGEN_VERSION` bump can flip borderline bodies' geometry from cap to global as temperatures recompute. The smoothstep absorbs most of the visual shift; both `globalness` and `iceFraction` derive from the same upstream anchors so internal consistency holds.
- **Off-distribution hand-edits.** A CSV with mismatched `(T, iceFraction, surfaceAge)` — e.g. a hot body with high `iceFraction` — falls into a parameter region procgen wouldn't generate. The rule still produces *something* (`globalness ≈ 0` → small cap regardless of `iceFraction`), so no crash, just a body that reads as physically nonsensical. CSV is the source of truth; cross-field plausibility isn't validated today and won't be here either.
- **Data migration before render lands.** Between 1.6a and 1.6b shipping, Callisto and Ganymede render with cap-pattern geometry against their bumped `iceFraction` values, which looks wrong. Ship together if possible; otherwise the intermediate state is brief and recoverable.

### Phasing

1. **1.6a — data migration.** Retire `'ice'` from `WorldClass`. Update procgen tables and cascade. Migrate Sol body CSV. Regenerate catalog. Smoke-render: confirm no non-ice body changes; ice bodies look "wrong but consistent."
2. **1.6b — render.** Replace cap branch with the three-layer stack + continuous `iceCoverage`. Plumb `vGlobalness`. Update cloud and biome gates to read ice coverage instead of cap latitude. Smoke-render the eleven Sol anchors.
3. **1.5d — linea (still deferred but unblocked by 1.6's layered model).** Surface linea become a small extension: trigger gates on `iceCoverage × surfaceAge`, paint `resourceSubsurface`. Defer until 1.6 ships and the model is proven.

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
  ice cap override (latitude past 1 − iceFrac)
    → ocean override (continent-cell hash < waterFrac)
    → land branch:
        region mask (1.5b — pick subset of body weights)
        → resource pick (worley winner cell → palette via masked weights)
        → biome stipple
        → crater features (1.5c — closest-wins, paints subsurface mask)
    → cloud patches (1.3c, H2O only)
    → haze surface tint (1.3a, non-H2O haze chromophores)
    → INWARD fade (1.3a/b rim color × bandIdx alpha)
  ```
  Banded fragments skip everything before the inward fade — their disc-interior pass is the banded-strip paint, and the inward fade lerps that toward the rim color near the limb. The outward halo (1.3a/b) paints at fragments where `r > vRadius` regardless of mode, as alpha-blended `vec4(vHazeColor, rimA)` with the planet material `transparent: true`. Hover rim (1-px white stamp at `r > vRadius - 1`) is the final per-fragment override on the disc-interior pass.

  The region pass *and* the crater pass are both gated to the land branch (oceans and caps don't carry resource composition). Craters overwrite the underlying surface color (region pick + optional biome stipple) entirely — they don't blend, since the layered resource model is "the impact reveals the layer underneath," not "the impact tints the surface."

- **Hash-salt budget.** Each feature adds one or two hash21 calls. Salts must be distinct so the same cell doesn't accidentally light up multiple features in correlation. Allocated so far (per-body multipliers on `vSeed`):
  - Worley jitter: 13/19, 23/29
  - Continent group: 113/127
  - Resource pick: 1009/2017
  - Biome stipple: 197/311
  - Region modifier: 401/419
  - Crater features (1.5c): 547/569/587 (5 distinct salt pairs needed for existence + jitter X/Y + radius + palette)
  - Inward-fade boundary dither: 829/853
  - Cloud cells (jitter + pick): 991/997, 1013/1019, 1031/1033

- **Attribute budget.** Some GPUs cap `gl_MaxVertexAttribs` at the WebGL1 minimum (16 — and in practice we've seen failures at 15). The planet/moon Points pools pack scalars aggressively to stay at 11 attributes total: `aRenderMeta: vec4` (size/mode/seed/tilt), `aCoverageScalars: vec4` (water/ice/biomeCov/hazeTint), `aAtmoStrokes: vec3` (rimWidth/cloudDensity/surfaceAge), plus `position`, `aHovered`, three `aPalette` vec3s, `aWeights`, `aBiomeColor`, `aHazeColor`. New features should pack into a spare vec4 component before adding a new attribute.

- **Browser smoke.** Each Phase entry ships with a manual verification pass against the eleven Sol bodies before moving on — the data is anchored, the visual outcome is predictable enough to eyeball.
