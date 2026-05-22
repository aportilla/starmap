// Public runtime API for the star catalog. The catalog data itself is
// precomputed by scripts/build-catalog.mjs (parses src/data/*.csv, runs
// normalization, hierarchical multi-star layout, cluster detection,
// COM computation) and lives in catalog.generated.json. That JSON is
// gitignored — the npm scripts (build:catalog, prebuild, predev,
// pretypecheck) keep it in sync with the CSVs.
//
// This module:
//   - Re-exports the precomputed STARS and STAR_CLUSTERS as immutable arrays.
//   - Owns the runtime k-d trees over both (rebuilt fresh on each module
//     load — the trees are mutable index instances, not catalog data).
//   - Owns the type definitions other modules consume.
//   - Owns runtime-only constants (CLASS_COLOR for the stars shader,
//     WAYPOINT_STAR_IDS for the labels module).
//
// Adding a new CSV column? Update parseCsvCatalog in build-catalog.mjs
// and add the field to the Star interface here. The two have to agree —
// there's no type bridge between the build script and the runtime.

import { Color } from 'three';
import { KDTree3 } from './kdtree';
import catalog from './catalog.generated.json';

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'BD';

export interface Star {
  // Stable identifier — the stellarcatalog.com slug (e.g. `fomalhaut-a`,
  // `sirius-a`, `gliese-1`), or `sol` for the Sun. Survives display-name
  // edits, so consumers like WAYPOINT_STAR_IDS key on this rather than name.
  readonly id: string;
  readonly name: string;
  // IAU canonical designation (e.g. "Alpha Centauri B" for the row whose
  // display `name` is "Toliman"). Empty when it would duplicate `name` —
  // the renderer treats empty as "no separate IAU line to draw," which is
  // the case for ~95% of catalog rows where `name` already IS the IAU
  // form (`Sirius A`, `Capella Aa`, `61 Cygni A`). Populated only for
  // hand-curated colloquial entries.
  readonly iauName: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cls: SpectralClass;
  // Raw spectral string from the CSV (e.g. "G2V", "M4.0Ve", "DA1.9"). Kept
  // alongside the normalized single-letter `cls` because the raw form
  // carries luminosity class + variability flags that the info card wants
  // to surface; `cls` stays internal to color/font lookups.
  readonly rawClass: string;
  // Catalog-stated distance from Sun in ly. The CSV's distance is the
  // upstream Wikipedia value (parallax-derived); √(x²+y²+z²) is computed
  // from the same distance × the unit RA/Dec direction, so the two agree by
  // construction except for floating-point rounding.
  readonly distLy: number;
  // Solar masses. Used for primary determination within a cluster
  // (heaviest member becomes the label anchor) and for mass-weighted
  // barycenters in the post-processor. Approximate (catalog quality).
  readonly mass: number;
  // Stellar radius in solar radii (R☉). Wikipedia's nearest-stars table
  // doesn't carry a radius column, so this is always derived at build
  // time from class + mass — Chandrasekhar M^(-1/3) for WDs, ~Jupiter-radius
  // constant for BDs, and a rough main-sequence M^0.8 elsewhere. The
  // visualization-side pxSize is computed from radiusSolar.
  readonly radiusSolar: number;
  // Reference visual disc size in pixels at the default zoom (the shader
  // applies depth-attenuation on top of this). Derived from radiusSolar
  // via a cube-root mapping in build-catalog.mjs.
  readonly pxSize: number;
  // Indices into BODIES of every planet that directly orbits this star,
  // sorted by semi-major axis ascending. Empty for stars with no known or
  // procgen-assigned planets. Moons of those planets are not in this list —
  // they live on each planet's own `moons` array.
  readonly planets: readonly number[];
  // Indices into BODIES of every belt that orbits this star (asteroid
  // belt, Kuiper analog, debris disk), sorted by semi-major axis. Parallel
  // to `planets`; belts are kept on their own list so consumers can iterate
  // structural bands without inspecting every body's `kind`.
  readonly belts: readonly number[];
}

export type WorldClass =
  // Terrestrial taxonomy
  | 'rocky' | 'solid_giant' | 'desert' | 'ocean' | 'ice'
  | 'iron' | 'lava' | 'magma_ocean' | 'chthonian'
  // Gaseous taxonomy
  | 'gas_dwarf' | 'hycean' | 'helium' | 'ice_giant' | 'gas_giant';
// Biosphere is two orthogonal axes:
//   - archetype: what kind of life (carbon/water, methane/cryogenic, etc.)
//   - tier: how developed (prebiotic → microbial → complex → gaian)
// Sterile bodies carry tier='none' and archetype=null. Anything else is
// guaranteed to have both axes set.
export type BiosphereArchetype =
  | 'carbon_aqueous'      // Earth-standard, water + carbon
  | 'subsurface_aqueous'  // ice-shell ocean (Europa, Enceladus)
  | 'aerial'              // gas-giant atmospheric
  | 'cryogenic'           // methane/ethane solvent (Titan-hypothesized)
  | 'silicate'            // crystalline mineral metabolism
  | 'sulfur';             // sulfur-cycle / thermal-vent biology
export type BiosphereTier =
  | 'none'        // sterile
  | 'prebiotic'   // organic chemistry, no replicating life
  | 'microbial'   // simple unicellular
  | 'complex'     // multicellular ecosystems
  | 'gaian';      // life has reshaped planet chemistry (Earth post-GOE)
export type BodyKind = 'planet' | 'moon' | 'belt' | 'ring';
export type BodySource = 'catalog' | 'procgen';

// One planet or moon. Catalog-sourced rows come from
// scripts/scrape-planets-from-stellarcatalog.mjs; hand-seeded Sol bodies and
// (later) procgen output share the same shape. `kind` discriminates whether
// `hostStarIdx` or `hostBodyIdx` is populated — never both — and whether
// `moons` is meaningful (only planets have moons).
//
// Nullable fields encode two CSV-side states that collapse here: an empty
// cell ("unknown, fill at build-time procgen") and `n/a` ("not applicable,
// never has a value"). Once procgen ships, empties get synthesized and only
// genuine n/a values remain null at runtime.
export interface Body {
  readonly id: string;
  readonly hostId: string;
  readonly kind: BodyKind;
  readonly formalName: string;
  readonly name: string;
  readonly source: BodySource;
  // Discriminated by `kind`: planet bodies set `hostStarIdx`, moon bodies set
  // `hostBodyIdx`. The other is always null.
  readonly hostStarIdx: number | null;
  readonly hostBodyIdx: number | null;
  // Orbit (around the host star for planets/belts; around the host
  // planet for moons/rings).
  readonly semiMajorAu: number | null;
  // Orbital distance the planet formed at, before any Type II disk
  // migration. Usually equals semiMajorAu (in-situ formation); a hot
  // Jupiter has formationAu past the H2O frost line and semiMajorAu
  // inside ~0.1 AU. Bulk composition (waterFraction / metalFraction)
  // samples on formationAu insolation, not current — a migrated giant
  // keeps its outer-zone water budget despite its hot current orbit.
  // Set on planets only (architect samples + persists); null on moons,
  // belts, and rings — they inherit formation context from their host.
  readonly formationAu: number | null;
  readonly eccentricity: number | null;
  readonly inclinationDeg: number | null;
  readonly periodDays: number | null;
  readonly orbitalPhaseDeg: number | null;
  readonly rotationPeriodHours: number | null;
  readonly axialTiltDeg: number | null;
  // Belt (kind='belt') extent in AU. Ring (kind='ring') extent in
  // multiples of the host planet's radius. All four are null for
  // planet / moon kinds.
  readonly innerAu: number | null;
  readonly outerAu: number | null;
  readonly innerPlanetRadii: number | null;
  readonly outerPlanetRadii: number | null;
  // Physical. radiusEarth is null for belt/ring kinds; massEarth is
  // meaningful (total belt mass) for belts but null for rings.
  readonly massEarth: number | null;
  readonly radiusEarth: number | null;
  // 0..1 mass fraction of body that is H₂O (and other condensable
  // volatiles). Earth ≈ 0.00023 (ocean mass / Earth mass); Europa /
  // Titan / Callisto ≈ 0.5 (water-ice mantle); Mercury ≈ 0; Hycean-
  // world candidate ≈ 0.1. Sampled at Architect time from a formation-
  // zone prior gated on insolation, then persists — used by the Filler
  // to derive surface water/ice cover (Phase 3+). Null on belt/ring
  // kinds (no body mass).
  readonly bulkWaterFraction: number | null;
  // 0..1 mass fraction of body that is iron / metallic. Mercury ≈ 0.70
  // (huge iron core); Earth/Venus ≈ 0.32 (canonical 32% iron core);
  // Mars ≈ 0.24; Moon ≈ 0.03 (silicate-dominant, tiny core); Europa
  // ≈ 0.10 (silicate mantle); gas giants ≈ 0.02-0.05 (mostly H/He
  // envelope). Sampled at Architect time from a four-zone prior keyed
  // on formationAu vs the host star's H2O/NH3/CH4 snow lines, then
  // persists. Inside_H2O is metal-rich; each successive zone dilutes
  // the metal fraction as more volatiles join the solid budget. Used
  // by resource priors and downstream cloud / haze / atmosphere variety
  // (iron-world, carbon-world). Null on belt/ring kinds.
  readonly bulkMetalFraction: number | null;
  // 0..1 mass fraction of body that is non-water condensable volatiles
  // — NH3, CH4, CO, CO2, N2, organics. Captures what bulkWater doesn't:
  // the inventory that drives ammonia/methane-world variety and the
  // CO2/N2 outgassing budget for inner rockies (replaces the implicit
  // OUTGASSING.volatileFloor proxy). Sampled at Architect time from
  // the same four-zone formation gate as bulkWater/bulkMetal; values
  // climb past each successive snow line as NH3 then CH4 condense.
  //
  // Anchors (Sol):
  //   Mercury  ~0.001  (trace mineralized CO2)
  //   Earth    0.005   (CO2/N2 carbonate inventory)
  //   Venus    0.01    (CO2-dominated atmosphere + crustal carbonate)
  //   Mars     0.003   (CO2 + trace N2)
  //   Galilean ~0.02   (trace CO2/organics in water-ice mantle)
  //   Titan    0.05    (methane + nitrogen)
  //   Saturn   0.02
  //   Uranus   0.30    (large NH3/CH4 component in ice mantle)
  //   Neptune  0.30
  //   Triton   0.10    (NH3 + N2 surface ices)
  //
  // Null on belt/ring kinds.
  readonly bulkVolatileFraction: number | null;
  // Diameter of the largest body in the belt, in km. Shepherded
  // belts (anchored to a giant via the architect's BELT_GIANT_ADJACENCY)
  // sample from the parent-body range — Sol Main Belt's Ceres = 940 km,
  // Kuiper Belt's Pluto = 2376 km. Free-float belts sample from the
  // dust-cascade range (tens of km max — debris disks have no
  // Vesta-equivalent because their existence implies the
  // collision cascade hasn't run out of material yet, which requires
  // many small parents rather than a few large ones). Null on planets,
  // moons, rings.
  readonly largestBodyKm: number | null;
  // Index into BODIES of the gas/ice giant that dynamically shepherds
  // this belt — mean-motion resonance stabilizer (analog of Jupiter
  // for Sol's Main Belt, Neptune for the Kuiper Belt). Null on belts
  // that formed without a giant in the system (free-float belts pull
  // smaller largestBodyKm to reflect their dust-cascade character)
  // and on planet/moon/ring kinds.
  readonly shepherdBodyIdx: number | null;
  // Surface character. All null for belt / ring kinds (no surface).
  readonly worldClass: WorldClass | null;
  readonly avgSurfaceTempK: number | null;
  readonly surfaceTempMinK: number | null;
  readonly surfaceTempMaxK: number | null;
  readonly waterFraction: number | null;
  readonly iceFraction: number | null;
  // 0..1 fraction of the surface that is geologically young. 1.0 = perpetually
  // refreshed (Io lava, Enceladus plumes); 0.0 = ancient unmodified (Mercury,
  // Luna, Callisto). null for bodies with no solid surface (gas/ice giants,
  // gas dwarfs, belts, rings).
  readonly surfaceAge: number | null;
  readonly magneticFieldGauss: number | null;
  readonly tectonicActivity: number | null;
  // Atmosphere — top three gases by fraction. atm1 is the dominant species.
  readonly surfacePressureBar: number | null;
  readonly atm1: string | null;
  readonly atm1Frac: number | null;
  readonly atm2: string | null;
  readonly atm2Frac: number | null;
  readonly atm3: string | null;
  readonly atm3Frac: number | null;
  // Cloud layer — condensed species that forms the body's visible cloud
  // deck. Independent of atm1/atm2/atm3 (which carry the gas-phase mix
  // for gameplay). cloudGas names the condensate (H2O ice/droplets, NH3
  // ice, CH4 ice, H2SO4 droplets, SILICATE condensate, etc.).
  // cloudCoverage is the rendered fraction of the disc covered by clouds
  // (Earth ≈ 0.4 patchy, Jupiter = 1.0 full deck). cloudStructure is the
  // pattern scalar: 0 = patchy cellular (Earth, Mars), 1 = banded zonal
  // (Venus, gas giants). Null when the body has no visible cloud layer
  // (Mercury, airless moons).
  readonly cloudGas: string | null;
  readonly cloudCoverage: number | null;
  readonly cloudStructure: number | null;
  // Haze layer — photochemical or lifted aerosol sitting above the cloud
  // deck (or above the surface when no cloud deck exists). Always uniform
  // at planetary scale (no condensation latent heat to drive structure).
  // hazeGas names the aerosol species (CH4 → tholin, SO2 → sulfate,
  // SILICATE, DUST). hazeOpacity is the uniform alpha [0..1] of the
  // overlay — Titan ≈ 0.85, Venus ≈ 0.7, Mars dust ≈ 0.15. Null when
  // no haze layer is present (Earth, gas giants, airless bodies).
  readonly hazeGas: string | null;
  readonly hazeOpacity: number | null;
  // Resources — 0..10 indices, calibrated against Earth (5/6/7/5/4/0).
  readonly resMetals: number | null;
  readonly resSilicates: number | null;
  readonly resVolatiles: number | null;
  readonly resRareEarths: number | null;
  readonly resRadioactives: number | null;
  readonly resExotics: number | null;
  // Life — two-axis. archetype is null on sterile bodies (tier='none') and
  // on bodies where the Filler skipped the roll (gas giants in curated
  // systems, etc.). When tier ≠ 'none', archetype is guaranteed non-null.
  readonly biosphereArchetype: BiosphereArchetype | null;
  readonly biosphereTier: BiosphereTier | null;
  // Indices into BODIES of moons orbiting this body, sorted by semi-major
  // axis ascending. Always empty when `kind === 'moon'` (no sub-moons modeled).
  readonly moons: readonly number[];
  // Index into BODIES of this body's ring system, or null. Only planet
  // kinds can carry a ring; the catalog enforces at most one ring per
  // planet — multi-band ring systems (Saturn's A/B/C, Uranus's epsilon /
  // delta / etc.) collapse into a single ring row with bounding
  // inner/outer radii.
  readonly ring: number | null;
}

export interface StarCluster {
  // Index into STARS of the heaviest member (the cluster's "primary").
  readonly primary: number;
  // All member star indices, primary first.
  readonly members: readonly number[];
  // Mass-weighted center of mass (Σmᵢ·rᵢ / Σmᵢ) in galactic ly, computed
  // at build time. The selection reticle, dropline anchor, and left-click
  // focus animation all use this so a multi-star system reads as one
  // entity rather than as its individually-selectable members. For
  // single-member clusters, com === primary's position by construction.
  readonly com: { readonly x: number; readonly y: number; readonly z: number };
}

// JSON imports are typed as `any` by default; assert to the precomputed
// shape. The build script is the only writer; any drift between the JSON
// and these interfaces shows up at usage sites, not here.
export const STARS: readonly Star[] = catalog.stars as readonly Star[];
export const STAR_CLUSTERS: readonly StarCluster[] = catalog.clusters as readonly StarCluster[];
export const BODIES: readonly Body[] = catalog.bodies as readonly Body[];

// =============================================================================
// Visual properties
// =============================================================================

// Stellar colors approximated from blackbody spectra at each spectral class's
// typical surface temperature (Mitchell Charity table).
//   O ~30000K  blue            B ~15000K  blue-white      A ~9000K   white
//   F ~6800K   pale yellow     G ~5800K   yellow (Sun)    K ~4500K   pale orange
//   M ~3300K   orange-red      WD ~10000K very pale blue  BD ~1500K  deep red
export const CLASS_COLOR: Record<SpectralClass, Color> = {
  O:  new Color(0x9bb0ff),
  B:  new Color(0xaabfff),
  A:  new Color(0xcad8ff),
  F:  new Color(0xf8f7ff),
  G:  new Color(0xfff4e8),
  K:  new Color(0xffd2a1),
  M:  new Color(0xffb56c),
  WD: new Color(0xc8d2ff),
  BD: new Color(0xa64633),
};

// Diagrammatic disc color per WorldClass. Used by SystemDiagram (and any
// future planet-rendering consumer). Bodies whose worldClass is still null
// (catalog rows the scraper couldn't classify, awaiting build-time procgen)
// render in WORLD_CLASS_UNKNOWN_COLOR so they read as "TBD" rather than
// ambiguously slotting into one of the real classes.
export const WORLD_CLASS_COLOR: Record<WorldClass, Color> = {
  // Terrestrial
  rocky:       new Color(0xc4956a),  // brown-tan
  solid_giant: new Color(0xb88560),  // large rocky terrestrial, slightly darker than rocky
  desert:      new Color(0xe4a854),  // dust-tan (Mars-like)
  ocean:       new Color(0x4a9fd9),  // blue (Earth/Europa)
  ice:         new Color(0xb8d8e8),  // pale cyan-white (Callisto/Triton)
  iron:        new Color(0x9a6660),  // dark grey-red (Mercury-like)
  lava:        new Color(0xd64a3a),  // molten red-orange
  magma_ocean: new Color(0xb04030),  // dark red, denser than lava
  chthonian:   new Color(0x705048),  // dark stripped-core grey-red
  // Gaseous
  gas_dwarf:   new Color(0xa090c8),  // lavender
  hycean:      new Color(0x3a8090),  // deep blue-green (water through H2)
  helium:      new Color(0xd4c08c),  // pale yellow
  ice_giant:   new Color(0x5a9ad6),  // CH4-blue (Uranus/Neptune)
  gas_giant:   new Color(0xc4a878),  // Jovian cream
};
export const WORLD_CLASS_UNKNOWN_COLOR = new Color(0x808080);

// Optional per-class warm/cool tint applied to every palette entry by
// the planet/moon shader's palette derivation. Compensates for the
// gas-mix model's inability to represent condensed-phase chemistry on
// gas-giant cloud decks (NH4SH on Jupiter, etc.) — gas giants tint warm so they
// read as ruddy Jovian rather than pale Saturnian-cream, even when H2
// dominates the atm fractions and shares with Saturn. Bodies whose
// class isn't in the table get no tint.
//
// `amount` lerps each palette entry by that fraction toward `color` —
// 0 = no shift, 1 = palette entry replaced by tint. Keep amounts small
// (≤0.3) so the gas-mix signal still reads through the tint.
export const WORLD_CLASS_TINT: Partial<Record<WorldClass, { color: Color; amount: number }>> = {
  gas_giant: { color: new Color(0xc88848), amount: 0.25 },  // warm amber → Jovian ruddy
};

// =============================================================================
// Biome paint — archetype × stellar class drives a pixel-stipple color
// =============================================================================

// Base pigment hue assuming G-class (Sun-like) starlight. The archetype
// captures the *chemistry* of the biosphere; BIOME_STELLAR_SHIFT below
// then rotates the hue to reflect the host star's actual spectrum.
//
// `null` archetypes don't paint a surface stipple: subsurface_aqueous
// life is under ice (Europa/Enceladus) so it never reaches the visible
// surface; aerial biospheres only appear on banded bodies, which take a
// different render path entirely.
export const BIOME_TINT_COLOR: Record<BiosphereArchetype, Color | null> = {
  carbon_aqueous:     new Color(0x3a8a3a),   // Earth's chlorophyll forest green
  subsurface_aqueous: null,                  // under-ice; no visible surface signal
  aerial:             null,                  // banded mode only
  cryogenic:          new Color(0x8b6f3f),   // hydrocarbon-cycle ochre (Titan-style)
  silicate:           new Color(0x6b8070),   // mineral-metabolism sage-grey
  sulfur:             new Color(0xa07020),   // sulfur-cycle mustard-brown
};

// Stellar-class hue rotation. Photosynthetic pigments evolve to absorb
// the wavelengths the host star delivers most strongly; the *reflected*
// color shifts accordingly (Kiang et al. on alien photosynthesis).
// Earth at G is the calibration anchor (identity); cooler stars push
// reflectance redder, hotter stars push it gold.
//
// Applied uniformly across archetypes for simplicity — sulfur/cryogenic
// biospheres aren't photosynthetic, but their characteristic hues still
// look "alien" when shifted by host class, and the alternative would
// collapse 60% of catalog (M-dwarf systems) to indistinguishable color.
//
// `null` suppresses biome render entirely:
//   - O, B: stellar lifetimes too short for biosphere evolution
//   - WD, BD: insufficient luminosity for a surface biosphere
export const BIOME_STELLAR_SHIFT: Record<SpectralClass, { color: Color; amount: number } | null> = {
  O:  null,
  B:  null,
  A:  { color: new Color(0xd4a050), amount: 0.40 },   // warm gold — reflect red/orange under blue input
  F:  { color: new Color(0xc8a868), amount: 0.25 },   // subtle warm shift from G baseline
  G:  { color: new Color(0xffffff), amount: 0.00 },   // identity — Earth baseline
  K:  { color: new Color(0xa04030), amount: 0.50 },   // rust-red under K-dwarf reddening
  M:  { color: new Color(0x6a3088), amount: 0.70 },   // "Purple Earth" under M-dwarf red/IR
  WD: null,
  BD: null,
};

// Coverage density of the biome stipple keyed to biosphere tier. The
// shader treats this as the probability that any individual land-cell
// pixel flips to biome color. microbial reads as sparse moss patches;
// gaian reads as dense canopy. prebiotic/none don't paint at all.
export const BIOME_COVERAGE_BY_TIER: Record<BiosphereTier, number> = {
  none:      0,
  prebiotic: 0,
  microbial: 0.20,
  complex:   0.50,
  gaian:     0.80,
};

// Channel-lerp helper local to the biome-paint pipeline. Mirrors the
// `applyTint` pattern in disc-palette.ts but lives here so the helper
// below is self-contained (stars.ts is the data layer; disc-palette
// shouldn't have to re-implement the lerp).
function lerpColor(base: Color, target: Color, amount: number): Color {
  return new Color(
    base.r + (target.r - base.r) * amount,
    base.g + (target.g - base.g) * amount,
    base.b + (target.b - base.b) * amount,
  );
}

// Resolve a body's biome stipple paint: pigment hue (archetype) shifted
// by host star spectral class, paired with the coverage density driven
// by biosphereTier. Returns null when no stipple should render — sterile
// bodies, prebiotic-only worlds, archetypes with no visible surface
// signal, or hosts whose stellar class can't support a biosphere.
//
// Resolves through the host chain: planet → its host star; moon → its
// host planet → that planet's host star. Hostless bodies (procgen edge)
// return null rather than guessing.
export function biomePaintFor(body: Body): { color: Color; coverage: number } | null {
  if (body.biosphereArchetype === null) return null;
  if (body.biosphereTier === null) return null;
  const coverage = BIOME_COVERAGE_BY_TIER[body.biosphereTier];
  if (coverage <= 0) return null;
  const base = BIOME_TINT_COLOR[body.biosphereArchetype];
  if (base === null) return null;

  let starIdx: number | null = null;
  if (body.kind === 'planet' && body.hostStarIdx !== null) {
    starIdx = body.hostStarIdx;
  } else if (body.kind === 'moon' && body.hostBodyIdx !== null) {
    const host = BODIES[body.hostBodyIdx];
    if (host !== undefined && host.hostStarIdx !== null) starIdx = host.hostStarIdx;
  }
  if (starIdx === null) return null;
  const shift = BIOME_STELLAR_SHIFT[STARS[starIdx].cls];
  if (shift === null) return null;

  const color = shift.amount > 0 ? lerpColor(base, shift.color, shift.amount) : base;
  return { color, coverage };
}

// Endpoints of the rocky↔icy palette lerp shared by belts and rings.
// `bodyIcyness` returns a 0..1 scalar from a body's resource grid
// (resVolatiles vs. rocky resources); the renderer lerps between these.
export const BELT_RING_COLOR_ICY   = new Color(0xb8d8e8);  // pale cyan (Saturn/KBO ice)
export const BELT_RING_COLOR_ROCKY = new Color(0xa89060);  // brown-tan (Main Belt rocky)
export const RING_ALPHA_ICY   = 1.0;
export const RING_ALPHA_DUSTY = 0.55;

// Map a body's resource grid to a 0..1 icyness scalar. Volatiles drive
// the bright icy end; metals + silicates + rare earths drive the rocky
// end. Returns 0.5 when the body carries no resource signal at all
// (defensive fallback — every architect/CSV emit should set the grid).
// Used by both ring and belt rendering to read composition off the same
// data that drives mining yields.
export function bodyIcyness(body: Body): number {
  const v = body.resVolatiles ?? 0;
  const rocky = (body.resMetals ?? 0) + (body.resSilicates ?? 0) + (body.resRareEarths ?? 0);
  const denom = v + rocky;
  if (denom <= 0) return 0.5;
  return v / denom;
}

// All gases the procgen vocabulary can emit. Mirrors the keys of
// ATMOSPHERE_GASES_BY_CLASS in scripts/lib/procgen-priors.mjs; any new
// gas added there needs a hue here or planet rendering silently drops
// it from the palette.
//
// SILICATE, DUST, THOLIN, and NH4SH are condensable aerosols / reaction
// products rather than gas-phase species. They never appear in
// ATMOSPHERE_GASES_BY_CLASS — only via the cloud or haze layer paths,
// emitted by procgen when chemistry gates support them. They share the
// AtmGas type so the cloud / haze gas fields don't need a separate
// vocabulary.
//   SILICATE — refractive Mg-Si-O cloud particles (hot Jupiters)
//   DUST     — suspended ferric-oxide aerosols (Mars-class surface lift)
//   THOLIN    — CnHmN photolysis polymers (Titan tholin, needs N2+CH4+UV+cold)
//   NH4SH    — ammonium hydrosulfide condensate (Jovian belt brown)
export type AtmGas =
  | 'N2' | 'O2' | 'CO2' | 'H2O' | 'CH4' | 'NH3'
  | 'SO2' | 'Ar' | 'CO'  | 'H2'  | 'He'
  | 'H2SO4'
  | 'SILICATE' | 'DUST'
  | 'THOLIN' | 'NH4SH';

// Archetypal hue per atmospheric gas. Picked to read at small disc sizes
// as "what's in the air" rather than as photoreal sky color — the
// rendering target is pixel-banded discs at 40-120 px, not a globe.
export const GAS_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0xb8c4d8),  // pale slate (mostly transparent in reality)
  O2:  new Color(0x8ec0e4),  // cool blue
  CO2: new Color(0xd8a878),  // dusty ochre (Venus)
  H2O: new Color(0xe4ecf0),  // near-white cloud
  CH4: new Color(0x6890d8),  // blue-cyan (Uranus/Neptune)
  NH3: new Color(0xc89860),  // warm amber — Jovian NH3 ice cloud
  SO2: new Color(0xc8a448),  // sulfurous yellow
  Ar:  new Color(0xa8b0b8),  // grey neutral
  CO:  new Color(0x988478),  // smoky brown
  H2:  new Color(0xf0e4c8),  // pale Jovian
  He:  new Color(0xf4e8d4),  // Jovian cream
  // Aerosol / reaction-product species — only emitted via cloudGas or
  // hazeGas, never via atm priors. The color is what the visible
  // condensate / aerosol actually looks like as a layer; procgen runs
  // the chemistry gates that decide whether the species forms (so the
  // renderer paints exactly what procgen says — no chemistry magic).
  H2SO4:    new Color(0xd8c474),  // yellow-cream — Venus sulfuric acid deck
  SILICATE: new Color(0x788098),  // refractive silicate-cloud grey-blue
  DUST:     new Color(0xa86040),  // ferric oxide rust — Mars-class dust
  THOLIN:    new Color(0xc88040),  // orange — Titan tholin (CH4+N2+UV photolysis)
  NH4SH:    new Color(0xc88250),  // warm tan-orange — Jovian belt chromophore (NH4SH + photolysis products)
};

// Condensed-phase ice / frost colors — used when a gas is the body's
// cloud species. Sparse: only species whose ice/frost form reads
// visibly different from GAS_COLOR get an entry. CH4 gas is cyan-blue
// (Uranus absorption) but CH4 ICE is pale frost (Triton, Pluto polar
// caps). NH3 gas is amber but NH3 ICE is pale off-white. Species not
// listed fall back to GAS_COLOR (the species is already an aerosol
// like H2SO4/SILICATE/DUST/THOLIN/NH4SH — its color IS its visible
// form, no separate condensate appearance).
export const CONDENSATE_COLOR: Partial<Record<AtmGas, Color>> = {
  CH4: new Color(0xdce8ec),  // pale methane frost
  NH3: new Color(0xf5f0e4),  // bright cream-white ammonia ice — Jovian zones
  N2:  new Color(0xe4e8eb),  // pale nitrogen frost (Triton)
  H2O: new Color(0xe4ecf0),  // water ice / cloud droplets
};

// Per-gas "visual potency" — how much each gas contributes to the disc's
// apparent color *per unit molar fraction*. Decoupled from abundance
// because the two correlate poorly: Uranus and Neptune are 95%+ H2/He
// (transparent) and read as blue *because of* 1.5-2.3% CH4, which is a
// strong red-light absorber. Mass-fraction-weighted color would paint
// them as cream-and-trace-blue (wrong); potency-weighted color paints
// them as mostly CH4 with cream accents (right).
//
// cloudBandPalette() multiplies each gas's fraction by its potency before
// renormalizing, so the displayed weights reflect visual contribution
// rather than abundance. Tunable.

// Multipliers applied to a body's `cloudCoverage` / `hazeOpacity`
// before folding the species into cloudBandPalette. Both species are
// condensed-phase chemistry layered onto the gas column — neither
// dominates the other structurally now that the chromophore is a band
// accent (not a uniform overlay), so they share the same boost. The
// remaining 1× / 1× distinction comes from the body's own `coverage`
// and `opacity` scalars (e.g. Jupiter NH3=1.0 / NH4SH=0.7).
//
// Calibrated so on Jupiter the resulting weights land roughly at
// parity with the dominant atm gas (H2 × potency 0.1 ≈ 0.09), so
// each accent claims roughly a third of the (1 - BASE_BLEND_WEIGHT)
// budget — comparable cell areas for the cream zones and tan belts.
export const CLOUD_VISUAL_BOOST = 0.03;
export const HAZE_VISUAL_BOOST  = 0.03;

// Per-class set of gases that are present in the atmosphere but not
// visible from above — buried under a cloud deck at the photic depth
// the disc renderer is modeling. Gas-giant CH4 is the canonical case:
// real Jupiter and Saturn carry CH4 at 0.3-0.5% by mass, but it sits
// below the NH3 ice cloud layer, so the disc's apparent color comes
// from the cloud tops + condensed-phase chemistry, not from CH4
// absorption. Ice giants have thinner / higher cloud cover and CH4 IS
// the visible signal, so they're intentionally absent from the filter.
//
// cloudBandPalette drops filtered gases from the candidate list before
// scoring. The gas stays in atm1..3 for gameplay (CH4 really is in
// Jupiter's atmosphere and can be mined as a deep-atmosphere resource)
// — only the disc renderer ignores it.
export const GAS_VISIBILITY_FILTER: Partial<Record<WorldClass, ReadonlySet<AtmGas>>> = {
  gas_giant: new Set(['CH4']),
  gas_dwarf: new Set(['CH4']),
  // ice_giant intentionally absent — CH4 is the Uranus/Neptune blue.
};

// Molecular weight per atmospheric gas (amu). Used historically for
// altitude-stratification pickers; current renderer doesn't read it
// but the table is kept for analytical scripts + future use.
export const GAS_MOLECULAR_WEIGHT: Record<AtmGas, number> = {
  H2:   2,
  He:   4,
  CH4: 16,
  NH3: 17,
  H2O: 18,
  N2:  28,
  CO:  28,
  O2:  32,
  Ar:  40,
  CO2: 44,
  SO2: 64,
  H2SO4: 98,
  SILICATE: 100,
  DUST:     100,
  THOLIN:    100,  // CnHmN mixed polymer mass
  NH4SH:     51,
};

// Per-gas clear-air scattering color — the visible tint of an
// atmosphere viewed edge-on through a long column with no haze layer
// to obscure it. Used by the disc rim's clear-air branch in
// disc-palette.ts (formerly a fixed THEME_RAYLEIGH_COLOR token).
//
// Rayleigh-blue is the canonical case (N2/O2/Ar bulk atmospheres),
// but CH4-absorbing columns tint cyan-blue (the Uranus/Neptune signal,
// also relevant for any deep-atm window through a methane-rich
// terrestrial), CO2-thick columns tint warmer, and SO2-tinted air
// goes yellow-orange.
//
// Aerosol-only species (H2SO4, SILICATE, DUST) never appear in the
// clear-air gas list — their entries are placeholders.
export const SCATTERING_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0x8cb4f0),  // pale sky cyan-blue — Rayleigh anchor (Earth)
  O2:  new Color(0x70a0e8),  // cool sky blue
  CO2: new Color(0x90a8c8),  // slightly warmer cyan
  CH4: new Color(0x6090d8),  // cyan-blue — selective red absorber
  H2O: new Color(0xc0d0e0),  // pale cool — water vapor scatters weakly
  NH3: new Color(0xd8c890),  // pale cream
  SO2: new Color(0xc8b478),  // yellow — sulfur-tinted air
  Ar:  new Color(0xa8b0b8),  // neutral grey
  CO:  new Color(0x9c8c7c),  // brown-grey
  H2:  new Color(0xe8d8b8),  // pale cream — weak scattering
  He:  new Color(0xece0c4),  // pale cream
  // Aerosol / product-only species don't enter the clear-air scattering
  // blend — they're handled exclusively by the haze layer.
  H2SO4:    new Color(0xc0c0c0),
  SILICATE: new Color(0xa0a0a0),
  DUST:     new Color(0xa86040),
  THOLIN:    new Color(0xc88040),
  NH4SH:    new Color(0xc88250),
};

// Per-gas weight in the clear-air scattering blend. Different from
// GAS_POTENCY (which captures cloud-band visibility): scattering is
// driven by Rayleigh efficiency + selective absorption, not condensate
// chemistry. Bulk gases (N2/O2/CO2) dominate via fraction × Rayleigh
// strength; selective absorbers (CH4, SO2) get amplified weights so
// they color the column even at low fractions; H2/He/Ar are weak.
//
// Aerosol species have potency 0 — they never appear in the clear-air
// blend (haze layer takes over before they could).
export const SCATTERING_POTENCY: Record<AtmGas, number> = {
  N2:  1.0,  // Rayleigh anchor
  O2:  1.2,  // slightly stronger Rayleigh than N2
  CO2: 0.8,  // weaker Rayleigh, warmer tint
  Ar:  0.3,  // monatomic, weak scatterer
  CH4: 4.0,  // strong red absorber — cyan signal dominates at low frac
  SO2: 2.0,  // yellow-orange tint
  H2O: 0.5,  // mostly clouds, weak gas-phase scattering
  NH3: 0.5,
  CO:  0.5,
  H2:  0.3,  // nearly transparent
  He:  0.3,
  H2SO4:    0,
  SILICATE: 0,
  DUST:     0,
  THOLIN:    0,
  NH4SH:    0,
};

export const GAS_POTENCY: Record<AtmGas, number> = {
  // Transparent / weakly-scattering — present in the atmosphere but
  // contribute little to the apparent color even at high fractions.
  H2:  0.1,
  He:  0.1,
  N2:  0.1,
  Ar:  0.1,
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
  CH4: 6.0,
  SO2: 8.0,
  // Condensate / aerosol / product species — only enter rendering via
  // cloudGas or hazeGas paths. Potency 3 matches the cloud-former
  // magnitude so each species contributes meaningfully when emitted.
  H2SO4:    3.0,
  SILICATE: 3.0,
  DUST:     3.0,
  THOLIN:    3.0,
  NH4SH:    3.0,
};

export type ResourceKey =
  | 'resMetals' | 'resSilicates' | 'resVolatiles'
  | 'resRareEarths' | 'resRadioactives' | 'resExotics';

// Archetypal hue per resource. Surface texturing picks the 2 dominant
// resources per body and speckles them over the world-class base color
// so a metals-rich rocky reads visibly different from a volatiles-rich
// ice world even though both share an underlying class.
export const RESOURCE_COLOR: Record<ResourceKey, Color> = {
  resMetals:       new Color(0x6c6c70),  // iron-grey
  resSilicates:    new Color(0x9c7c5c),  // rust-tan
  resVolatiles:    new Color(0xc8e0e8),  // pale ice
  resRareEarths:   new Color(0xb46c8c),  // rose
  resRadioactives: new Color(0xa8c460),  // yellow-green
  resExotics:      new Color(0xa468c8),  // magenta
};

const RESOURCE_KEYS: readonly ResourceKey[] = [
  'resMetals', 'resSilicates', 'resVolatiles',
  'resRareEarths', 'resRadioactives', 'resExotics',
];

// Atmospheric contributions for the banded cloud palette. Four slots,
// modeling two distinct physical mechanisms:
//
//   • **Atm gases — column absorption (uniform).** Every line of
//     sight passes through the same gas column, so atm species tint
//     the disc uniformly (CH4 pulls Uranus toward cyan; H2/He warm
//     Jupiter toward cream). They feed the BASE BLEND only — never
//     spatial accents — because column absorption doesn't paint
//     patches.
//
//   • **Cloud + haze species — photic-depth chemistry (spatial).**
//     The visible cloud deck genuinely varies across latitudes: NH3
//     zones with NH4SH brown belts on Jupiter; banded chromophore
//     features on Saturn. These drive the ACCENT slots (and fold into
//     the base blend too, at reduced weight via CLOUD_VISUAL_BOOST /
//     HAZE_VISUAL_BOOST, so their species warms or cools the ground
//     tone).
//
// **The four slots:**
//
//   • **Slot 0 — base blend.** Weighted average across atm + cloud +
//     haze. Atm species dominate by weight (full potency, no visual
//     boost) — the base reads as the column-tint with cloud chemistry
//     warming or cooling it. Always assigned `BASE_BLEND_WEIGHT` in
//     the picker so it dominates by frequency.
//
//   • **Slots 1-3 — accent species.** Top three cloud + haze entries
//     by `frac × potency × boost`, sorted descending. Each paints at
//     its natural pigment saturation — no mixing toward a common
//     tone. Together they share the remaining `(1 - BASE_BLEND_WEIGHT)`
//     of the picker weight, renormalized across however many were
//     emitted.
//
// **Why this shape:** Earlier revisions blended the column tint into
// each accent slot, which preserved physics but desaturated every band
// — Jupiter went from belt-brown-on-cream to muted tan. The base+accent
// shape solves the same "column character should dominate" problem by
// frequency-weighting in the picker instead of mixing in the colors,
// keeping each accent slot at full pigment saturation while the base
// blend carries the holistic character on ~half the cells.
//
// Renderer rule: paint exactly what procgen emits. Jupiter shows NH4SH
// brown bands because procgen emitted `hazeGas='NH4SH'` — no chromophore
// inference inside this function.
//
// Used by the banded-cloud branch of `buildDiscPalette` for no-surface
// bodies (gas / ice giants). Surface bodies with banded clouds (Venus)
// skip this and paint a single condensate color because their cloud
// deck obscures the deeper atm.

// Default share of the cloud-band picker weight assigned to slot 0
// (the perceptual base blend) for bodies without a stronger signal to
// pick a per-body weight. Tunable: higher → smoother disc dominated
// by the holistic blend with accents as occasional highlights; lower
// → more visible band variety at the cost of perceived unity. 0.5
// calibrated to land Jupiter at "cream-tan with belt-brown
// highlights" rather than "alternating stripes" or "muddy single
// tone."
export const BASE_BLEND_WEIGHT = 0.5;

// World classes whose body has no accessible surface — gas/ice giants,
// gas dwarfs, hycean (deep ocean under thick H2/He), helium giants.
// `cloudBandPalette` reads this to apply a temperature-driven base-
// blend weight (colder no-surface bodies show more uniform discs);
// `disc-palette.ts` reads it to short-circuit the surface paint pass.
export const NO_SURFACE_WORLD_CLASSES: ReadonlySet<string> = new Set([
  'gas_giant', 'gas_dwarf', 'ice_giant', 'hycean', 'helium',
]);

// Per-body slot-0 weight for no-surface bodies, derived from cloud-top
// temperature. Colder gas/ice giants have thicker, more obscuring
// cloud decks (more NH3 / CH4 condensed out of the gas phase) AND
// more high-altitude photochemical haze sitting above the deck
// (longer aerosol residence time under slower atmospheric dynamics).
// Both effects mute the band chemistry that would otherwise show
// through.
//
// We don't have a stratospheric-haze data slot — only one `hazeGas`
// slot per body, used for the chromophore — so this heuristic uses
// `avgSurfaceTempK` (cloud-top temperature on gas giants) as a proxy
// that captures the trend cleanly across the four Sol gas giants:
//
//   • 800 K → 0.35  (hot Jupiter — bold contrast)
//   • 165 K → 0.50  (Jupiter — strong zone/belt structure)
//   • 134 K → 0.78  (Saturn — heavily muted bands)
//   •  60 K → 0.85  (Uranus / Neptune — mostly uniform)
//
// The Jupiter→Saturn jump is deliberately steep (28 weight points
// across 31 K) — it models the rapid transition out of the "warm
// enough to keep chromophore chemistry visible" regime into the
// "cold enough that the stratospheric haze + thicker NH3 deck obscure
// it" regime. Without that steep step, Saturn looks like a slightly
// paler Jupiter; with it, Saturn reads as visibly hazier with only
// ghost traces of belt structure. The lower portion of the curve
// (Uranus/Neptune) intentionally only moves a few more points
// because the cloud chemistry differs there (CH4 frost, no haze) so
// they read as cyan-uniform from their accent set alone.
//
// Piecewise linear between anchors, clamped at the extremes. Bodies
// with null temperature fall back to `BASE_BLEND_WEIGHT`. Atm
// composition is unchanged — only the cell-frequency split between
// base and accents shifts with temperature.
const NO_SURFACE_WEIGHT_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [60, 0.85],
  [134, 0.78],
  [165, 0.50],
  [800, 0.35],
];

function baseBlendWeightForNoSurface(tCloudTopK: number | null): number {
  if (tCloudTopK == null) return BASE_BLEND_WEIGHT;
  const first = NO_SURFACE_WEIGHT_ANCHORS[0];
  const last = NO_SURFACE_WEIGHT_ANCHORS[NO_SURFACE_WEIGHT_ANCHORS.length - 1];
  if (tCloudTopK <= first[0]) return first[1];
  if (tCloudTopK >= last[0]) return last[1];
  for (let i = 0; i < NO_SURFACE_WEIGHT_ANCHORS.length - 1; i++) {
    const [t0, w0] = NO_SURFACE_WEIGHT_ANCHORS[i];
    const [t1, w1] = NO_SURFACE_WEIGHT_ANCHORS[i + 1];
    if (tCloudTopK >= t0 && tCloudTopK <= t1) {
      const a = (tCloudTopK - t0) / (t1 - t0);
      return w0 + (w1 - w0) * a;
    }
  }
  return BASE_BLEND_WEIGHT;
}

export interface CloudBandPalette {
  // Four colors: slot 0 = base blend (atm + cloud + haze), slots 1-3 =
  // top cloud + haze accent species sorted by weight descending. Empty
  // trailing accent slots are ZERO_COLOR with weight 0 and the shader
  // picker skips them.
  readonly palette: readonly [Color, Color, Color, Color];
  // Weights sum to 1. Slot 0's share is `BASE_BLEND_WEIGHT` on surface
  // bodies, or a temperature-derived value on no-surface bodies (see
  // `baseBlendWeightForNoSurface`) — colder gas/ice giants get a
  // larger slot-0 share so the disc reads as more uniform. If every
  // accent is empty, slot 0 absorbs the full 1.0.
  readonly weights: readonly [number, number, number, number];
}

const ZERO_COLOR = new Color(0, 0, 0);

export function cloudBandPalette(body: Body): CloudBandPalette {
  type Contrib = { color: Color; weight: number };
  // Two pools modeling two distinct physics:
  //   • `atm` — gas-phase column absorption. Uniform across the disc,
  //     so these species feed the BASE BLEND only. CH4 on Uranus
  //     pulls the whole disc toward cyan; H2/He on Jupiter brighten
  //     it toward cream. Never appears as a spatial accent because the
  //     absorption acts on every line of sight equally.
  //   • `cloudHaze` — condensed-phase chemistry at the photic depth.
  //     Genuinely varies across the disc (NH3 ice deck punctuated by
  //     NH4SH brown belts at specific latitudes), so these species
  //     drive the ACCENT slots. The base blend folds them in too so
  //     bodies with strong cloud chemistry shift their ground tone
  //     accordingly (Jupiter's NH3 deck warming the H2/He cream).
  const atm: Contrib[] = [];
  const cloudHaze: Contrib[] = [];

  const filtered: ReadonlySet<AtmGas> | undefined =
    body.worldClass !== null ? GAS_VISIBILITY_FILTER[body.worldClass] : undefined;

  const addAtm = (name: string | null, frac: number | null) => {
    if (name === null || frac === null) return;
    const gas = name as AtmGas;
    if (filtered?.has(gas)) return;
    const col = GAS_COLOR[gas];
    if (!col) return;
    atm.push({ color: col, weight: frac * (GAS_POTENCY[gas] ?? 1) });
  };
  addAtm(body.atm1, body.atm1Frac);
  addAtm(body.atm2, body.atm2Frac);
  addAtm(body.atm3, body.atm3Frac);

  if (body.cloudGas !== null && body.cloudCoverage !== null) {
    const gas = body.cloudGas as AtmGas;
    const col = CONDENSATE_COLOR[gas] ?? GAS_COLOR[gas];
    if (col) cloudHaze.push({
      color: col,
      weight: body.cloudCoverage * (GAS_POTENCY[gas] ?? 1) * CLOUD_VISUAL_BOOST,
    });
  }
  if (body.hazeGas !== null && body.hazeOpacity !== null) {
    const gas = body.hazeGas as AtmGas;
    const col = GAS_COLOR[gas];
    if (col) cloudHaze.push({
      color: col,
      weight: body.hazeOpacity * (GAS_POTENCY[gas] ?? 1) * HAZE_VISUAL_BOOST,
    });
  }

  // Base blend — weighted average across both pools. Atm species
  // dominate by weight on most bodies (full potency, no visual-boost
  // damping), so the base reads as the column tint with the cloud
  // chemistry warming or cooling it.
  const blendInputs: Contrib[] = [...atm, ...cloudHaze];
  const blendTotal = blendInputs.reduce((s, e) => s + e.weight, 0);
  let baseBlend: Color = ZERO_COLOR;
  if (blendTotal > 0) {
    let r = 0, g = 0, b = 0;
    for (const { color, weight } of blendInputs) {
      r += color.r * weight;
      g += color.g * weight;
      b += color.b * weight;
    }
    baseBlend = new Color(r / blendTotal, g / blendTotal, b / blendTotal);
  }

  // Accent slots — top 3 cloud + haze species by visual weight. Atm
  // gases are deliberately excluded here: column absorption is a
  // uniform effect and doesn't produce spatial accents on real bodies.
  cloudHaze.sort((a, b) => b.weight - a.weight);
  const accents = cloudHaze.slice(0, 3);
  const accentTotal = accents.reduce((s, e) => s + e.weight, 0);

  // Per-body slot-0 share. Gas/ice giants pick a temperature-derived
  // weight so colder bodies render more uniformly (Saturn mutes vs
  // Jupiter; Uranus / Neptune nearly featureless). Surface bodies and
  // bodies with no world class fall back to the default.
  const isNoSurface = body.worldClass !== null
    && NO_SURFACE_WORLD_CLASSES.has(body.worldClass);
  const slot0Target = isNoSurface
    ? baseBlendWeightForNoSurface(body.avgSurfaceTempK)
    : BASE_BLEND_WEIGHT;

  // Slot 0 reserves `slot0Target` when any accent is present;
  // otherwise it absorbs the full 1.0 (a body with no cloud-haze
  // chemistry still needs a visible color).
  const accentBudget = accentTotal > 0 ? 1 - slot0Target : 0;
  const slot0Weight = accentTotal > 0 ? slot0Target : (blendTotal > 0 ? 1 : 0);

  // Accent desaturation — models stratospheric haze physically paling
  // the cloud chemistry visible below it. Same temperature signal that
  // drove the cell-frequency curve: as slot0Target climbs above the
  // default, the body is "hazier" and the chromophore species reads
  // softer when it does appear. Jupiter (slot0=0.50) → mute=0, full
  // pigment punch. Saturn (slot0=0.78) → mute=0.56, accents drift
  // strongly toward the base. Uranus / Neptune saturate at the upper
  // clamp (only one accent — CH4 frost — which barely contrasts
  // anyway, so the mute is mostly cosmetic there).
  const accentMute = Math.max(0, Math.min(1, (slot0Target - BASE_BLEND_WEIGHT) * 2));
  const muteAccent = (c: Color): Color => accentMute <= 0 || blendTotal <= 0 ? c : new Color(
    c.r + (baseBlend.r - c.r) * accentMute,
    c.g + (baseBlend.g - c.g) * accentMute,
    c.b + (baseBlend.b - c.b) * accentMute,
  );

  const palette: [Color, Color, Color, Color] = [
    baseBlend,
    muteAccent(accents[0]?.color ?? ZERO_COLOR),
    muteAccent(accents[1]?.color ?? ZERO_COLOR),
    muteAccent(accents[2]?.color ?? ZERO_COLOR),
  ];
  const weights: [number, number, number, number] = [
    slot0Weight,
    accentTotal > 0 ? ((accents[0]?.weight ?? 0) / accentTotal) * accentBudget : 0,
    accentTotal > 0 ? ((accents[1]?.weight ?? 0) / accentTotal) * accentBudget : 0,
    accentTotal > 0 ? ((accents[2]?.weight ?? 0) / accentTotal) * accentBudget : 0,
  ];

  return { palette, weights };
}

// Top `count` resources (default 2) by value, with weights renormalized
// to sum to 1. Empty when every res scalar is null/zero — caller falls
// back to a solid world-class color.
export function dominantResources(
  body: Body,
  count = 2,
): Array<{ color: Color; weight: number }> {
  const scored = RESOURCE_KEYS
    .map(k => ({ key: k, value: body[k] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, count);
  const total = scored.reduce((s, e) => s + e.value, 0);
  if (total <= 0) return [];
  return scored.map(e => ({
    color: RESOURCE_COLOR[e.key],
    weight: e.value / total,
  }));
}

// =============================================================================
// Runtime spatial indices
// =============================================================================

// Spatial index over STAR_CLUSTERS keyed by COM. Backs nearestClusterIdxTo
// (called per-frame from scene.tick). Rebuilt at module load — the tree is
// a mutable index instance, not data.
const CLUSTER_TREE = new KDTree3(STAR_CLUSTERS, c => c.com);

const STAR_TO_CLUSTER = (() => {
  const m = new Int32Array(STARS.length);
  STAR_CLUSTERS.forEach((cluster, idx) => {
    for (const member of cluster.members) m[member] = idx;
  });
  return m;
})();

export function clusterIndexFor(starIdx: number): number {
  return STAR_TO_CLUSTER[starIdx];
}

// Nearest cluster (by COM) to (x, y, z). Returns -1 only if STAR_CLUSTERS is
// empty (defensive — in practice the catalog always has Sol).
export function nearestClusterIdxTo(x: number, y: number, z: number): number {
  return CLUSTER_TREE.nearest(x, y, z);
}

// Curated waypoint stars — bright, well-known anchors distributed across the
// catalog's 0–50 ly range. The galaxy view fades their cluster labels in as
// the camera moves away from Sol, so the player has named landmarks to
// orient by once they've left home territory (every other label has been
// culled by the focus/camera-distance ramps in labels.ts by that point).
//
// Keyed by stable slug id rather than display name, so display-name edits
// (e.g. swapping "Alpha Piscis Austrini" → "Fomalhaut") don't break
// waypoint membership. The id matches the cluster *primary* — the heaviest
// member, which the label is anchored on.
export const WAYPOINT_STAR_IDS: ReadonlySet<string> = new Set([
  'sol',
  'altair',
  'vega',
  'arcturus',
  'pollux',
  'iota-persei',
  'eta-leporis',
  'nu-phoenicis',
  'fomalhaut-a'
]);
