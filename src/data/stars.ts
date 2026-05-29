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
  // Stellar age in gigayears (10⁹ yr). Drives biosphere productivity
  // factors (life needs time to develop) and indirectly drives surface
  // ages for the planets via system formation. Populated by the build
  // step via priority chain: catalog age_gyr CSV cell → class-keyed
  // Gaussian prior (AGE_BY_CLASS in build-catalog.mjs) with per-star
  // hash jitter so siblings differ. Always non-null after build.
  // Clamped to [0.001, min(13.8, 0.4 × MS_lifetime_max)] so an O-class
  // star can't end up at 10 Gyr.
  readonly ageGyr: number;
}

export type WorldClass =
  // Terrestrial taxonomy
  | 'rocky' | 'solid_giant' | 'desert' | 'ocean' | 'ice' | 'carbon'
  | 'iron' | 'lava' | 'magma_ocean' | 'chthonian'
  // Gaseous taxonomy
  | 'gas_dwarf' | 'hycean' | 'helium' | 'ice_giant' | 'gas_giant';
// Biosphere is three orthogonal fields:
//   - archetype: what kind of life (carbon/water, methane/cryogenic, etc.)
//   - complexity: how structured the life is (prebiotic → microbial → complex)
//   - surfaceImpact: how visibly the biosphere alters the body [0..1]
// Sterile bodies carry complexity='none', archetype=null, impact=0.
// Anything else has all three fields set.
//
// Complexity and surfaceImpact are split because they pull apart at the
// edges. Earth between the GOE and the Cambrian was chemically dominant
// in atmosphere for ~2 Gyr on entirely microbial life — high impact,
// low complexity. A complex Europa subsurface biosphere never touches
// the surface — high complexity, no impact. One ladder can't represent
// both. See procgen-priors.mjs biosphere section for the full model.
export type BiosphereArchetype =
  | 'carbon_aqueous'      // Earth-standard, water + carbon
  | 'subsurface_aqueous'  // ice-shell ocean (Europa, Enceladus)
  | 'aerial'              // gas-giant atmospheric
  | 'cryogenic'           // methane/ethane solvent (Titan-hypothesized)
  | 'silicate'            // crystalline mineral metabolism
  | 'sulfur';             // sulfur-cycle / thermal-vent biology
export type BiosphereComplexity =
  | 'none'        // sterile — no replicating life
  | 'prebiotic'   // organic chemistry, no replication
  | 'microbial'   // simple unicellular
  | 'complex';    // multicellular ecosystems
export type BiosphereImpactLevel =
  | 'none'        // < 0.05 — sterile or undetectable
  | 'trace'       // 0.05–0.20 — faint biomarkers (Enceladus-class plumes)
  | 'modifying'   // 0.20–0.50 — biosphere alters chemistry (Venus clouds, K2-18b)
  | 'dominant';   // ≥ 0.50 — biosphere runs the planetary system (Earth post-GOE)
export type BodyKind = 'planet' | 'moon' | 'belt' | 'ring';
export type BodySource = 'catalog' | 'procgen';

// One cloud deck on a body. Up to 3 per body, stratified by
// altitudeNorm — the deepest deck composites first, the top deck last.
// `windSpeedMS` drives both the patchy ↔ banded interpolant (low wind →
// cellular cumulus, high wind → lat-aligned bands) and the east-west
// cell stretching beyond the bandness saturation point, so Neptune-scale
// (~600 m/s) wind speeds out-stretch Jupiter-scale (~130 m/s). Anchored
// in m/s rather than 0..1 so the value is physically meaningful and
// procgen can derive it from rotation + insolation gradient.
export interface CloudLayer {
  readonly gas: string;
  readonly coverage: number;    // 0..1 — fraction of disc covered
  readonly windSpeedMS: number; // m/s — cloud-top peak zonal winds
  readonly altitudeNorm: number;// 0..1 — deep → top
}

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
  // Cloud layers — up to 3 stratified decks per body, sorted ascending
  // by altitudeNorm (deep first, top last). Each deck names its
  // condensate gas (H2O ice/droplets, NH3 ice, CH4 ice, H2SO4 droplets,
  // SILICATE condensate, etc.), the fraction of disc covered, the peak
  // cloud-top zonal wind speed in m/s (drives patchy↔banded rendering +
  // east-west cell stretching — see CloudLayer doc), and a normalized
  // altitude. Empty array for bodies with no visible cloud cover
  // (Mercury, airless moons).
  readonly cloudLayers: readonly CloudLayer[];
  // Surface opacity [0..1]. 1 = solid surface visible underneath the
  // atmospheric layers (terrestrials). 0 = no visible surface, the
  // bulk atm column shows through cloud rents instead (gas / ice giants
  // / hycean / helium / gas_dwarf). The disc shader runs the surface
  // pass regardless; this scalar controls how much it contributes to
  // the composition.
  readonly surfaceOpacity: number;
  // Haze contributor list — per-aerosol-species formation strength
  // (0..1, post-gate, pre-potency) from procgen's chemistry gates. Disc
  // palette blends these with bulk atm gases × pressure (Rayleigh +
  // selective absorption) and lifted dust into one hazeColor +
  // hazeOpacity for the unified haze pass. Species keys: THOLIN, NH4SH,
  // CHROMOPHORE, SALT, H2SO4, SULFUR, SILICATE. Only firing species
  // appear in the record. Null on bodies with no atmosphere.
  readonly hazeAerosols: Readonly<Record<string, number>> | null;
  // Lifted mineral dust strength [0..1], post-gate. Body resource grid
  // supplies the color when this folds into the haze blend (iron-grey
  // on metal-dominant, rust on Mars-class, tan on silicate-dominant).
  // Null = no atmosphere data (gaseous bodies, airless).
  readonly dustStrength: number | null;
  // Resources — 0..10 indices, calibrated against Earth (5/6/7/5/4/0).
  readonly resMetals: number | null;
  readonly resSilicates: number | null;
  readonly resVolatiles: number | null;
  readonly resRareEarths: number | null;
  readonly resRadioactives: number | null;
  readonly resExotics: number | null;
  // Biotic productivity — six continuous scalars in [0..1], one per
  // archetype, derived from the body's underlying physics (temperature,
  // water, atmosphere, age, stellar PAR, tectonic activity, …). A body
  // can carry non-zero productivity across multiple archetypes
  // simultaneously: Titan has both cryogenic surface chemistry AND a
  // possible subsurface aqueous reservoir. The render path reads these
  // scalars directly for biome coverage, atmospheric O2 lift, biotic
  // chromophore enrichment, etc. — no discrete tier/archetype label
  // gates anything in the renderer.
  //
  // Null on bodies where the archetype is physically impossible (gas
  // giants get null for carbon_aqueous; airless rocky worlds get null
  // for aerial). Curated bodies may pin specific values via CSV; the
  // Filler computes from physics where the cell is empty.
  readonly bioticCarbonAqueous: number | null;
  readonly bioticSubsurfaceAqueous: number | null;
  readonly bioticAerial: number | null;
  readonly bioticCryogenic: number | null;
  readonly bioticSilicate: number | null;
  readonly bioticSulfur: number | null;
  // Biosphere display fields — DERIVED from the productivity scalars
  // above (archetype = argmax; complexity = per-archetype thresholds;
  // surfaceImpact = productivity × per-body coupling). Decouples
  // biological complexity from visible planetary signature so a
  // sealed-Europa complex biosphere reads as no surface impact while
  // remaining biologically distinct from a microbial ocean. Info card
  // displays both axes; renderer reads surfaceImpact for biotic O₂
  // lift / biome cover decisions.
  readonly biosphereArchetype: BiosphereArchetype | null;
  readonly biosphereComplexity: BiosphereComplexity | null;
  readonly biosphereSurfaceImpact: number | null;
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
  ice:         new Color(0xb8d8e8),  // pale cyan-white (Callisto, water-ice shell)
  carbon:      new Color(0xb07a58),  // tholin orange-brown (Pluto/Triton/Eris methane-frost)
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

// Surface-impact threshold below which biome stipple doesn't render at
// all — eliminates noise from worlds with trace biotic signature
// (surfaceImpact ≈ 0.01) that would paint a few stray pixels and read
// as a bug. Matches the lower bound of the BIOME_RENDER 'trace'
// impact bucket so card label and rendered stipple flip on together.
const BIOME_RENDER_THRESHOLD = 0.05;

// Coverage scale factor — multiplies the body's surfaceImpact to
// produce the stipple coverage fraction. Earth at surfaceImpact ≈ 0.85
// × scale=0.94 lands at ~0.80 coverage, preserving Earth's visual
// identity. Subsurface-dominant worlds collapse to zero coverage via
// the archetype filter below (no surface pigment defined) regardless
// of their surfaceImpact tail.
const BIOME_COVERAGE_SCALE = 0.94;

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

// Resolve a body's biome stipple paint by reading the body's derived
// biosphere fields. The body's dominant archetype + its surfaceImpact
// scalar already encode "what kind of life" and "how much it shows" —
// the renderer just looks up the pigment hue × stellar shift and
// scales coverage by surfaceImpact.
//
// Returns null when no stipple should render — sterile bodies (impact
// below threshold), bodies whose dominant archetype is pigment-null
// (subsurface, aerial), or hosts whose stellar class can't support a
// biosphere.
//
// Resolves through the host chain: planet → its host star; moon → its
// host planet → that planet's host star. Hostless bodies (procgen edge)
// return null rather than guessing.
export function biomePaintFor(body: Body): { color: Color; coverage: number } | null {
  const arch = body.biosphereArchetype;
  const impact = body.biosphereSurfaceImpact;
  if (arch === null || impact === null || impact < BIOME_RENDER_THRESHOLD) return null;

  const base = BIOME_TINT_COLOR[arch];
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
  const coverage = Math.min(1, impact * BIOME_COVERAGE_SCALE);
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
//   SILICATE    — refractive Mg-Si-O cloud particles (hot Jupiters)
//   DUST        — suspended ferric-oxide aerosols (Mars-class surface lift)
//   THOLIN      — CnHmN photolysis polymers (Titan tholin, needs N2+CH4+UV+cold)
//   NH4SH       — ammonium hydrosulfide condensate (Jovian belt brown)
//   CHROMOPHORE — PH3-photolysis red pigment (Jovian Great Red Spot)
//   SALT        — KCl + ZnS condensate (warm sub-Neptune haze, GJ 1214 b class)
//   SULFUR      — S8 elemental sulfur aerosol (Io-class volcanic terrestrial)
export type AtmGas =
  | 'N2' | 'O2' | 'CO2' | 'H2O' | 'CH4' | 'NH3'
  | 'SO2' | 'Ar' | 'CO'  | 'H2'  | 'He'
  | 'H2SO4'
  | 'SILICATE' | 'DUST'
  | 'THOLIN' | 'NH4SH'
  | 'CHROMOPHORE' | 'SALT' | 'SULFUR';

// Archetypal hue per atmospheric gas. Picked to read at small disc sizes
// as "what's in the air" rather than as photoreal sky color — the
// rendering target is pixel-banded discs at 40-120 px, not a globe.
export const GAS_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0xb8c4d8),  // pale slate (mostly transparent in reality)
  O2:  new Color(0x8ec0e4),  // cool blue
  CO2: new Color(0xd8a878),  // dusty ochre (Venus)
  H2O: new Color(0xe4ecf0),  // near-white cloud
  CH4: new Color(0x5cb4d0),  // CH4-absorption cyan (Uranus/Neptune). Low R
                              // (methane absorbs strongly in red 619/727/793 nm
                              // bands), high G (less absorbed), high B. Calibrated
                              // for thin CH4 columns (1-3% atm fraction) — Neptune
                              // pale cyan rather than deep saturated azure.
  NH3: new Color(0xc89860),  // warm amber — Jovian NH3 ice cloud
  SO2: new Color(0xc8a448),  // sulfurous yellow
  Ar:  new Color(0xa8b0b8),  // grey neutral
  CO:  new Color(0x988478),  // smoky brown
  H2:  new Color(0xf0e4c8),  // pale Jovian
  He:  new Color(0xf4e8d4),  // Jovian cream
  // Aerosol / reaction-product species — only emitted via cloudGas or
  // the hazeAerosols contributor list, never via atm priors. The color
  // is what the visible condensate / aerosol actually looks like as a
  // layer; procgen runs the chemistry gates that decide whether the
  // species forms (so the renderer paints exactly what procgen says —
  // no chemistry magic).
  H2SO4:       new Color(0xd8c474),  // yellow-cream — Venus sulfuric acid deck
  SILICATE:    new Color(0x788098),  // refractive silicate-cloud grey-blue
  DUST:        new Color(0xa86040),  // ferric oxide rust — Mars-class dust
  THOLIN:      new Color(0xc88040),  // orange — Titan tholin (CH4+N2+UV photolysis)
  NH4SH:       new Color(0xc88250),  // warm tan-orange — Jovian belt brown (NH4SH condensate)
  CHROMOPHORE: new Color(0xc04830),  // deep brick-red — Jovian Great Red Spot pigment (PH3 photolysis)
  SALT:        new Color(0xc0d4d8),  // pale blue-white — KCl/ZnS sub-Neptune haze
  SULFUR:      new Color(0xe8d048),  // bright yellow — S8 elemental sulfur (Io-class volcanic)
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

// Universal scales for the unified haze blend — Σ (per-species weight
// × GAS_POTENCY) × scale, summed across the four contributor channels,
// then soft-capped via 1 - exp(-Σ) to land in [0, 1).
//
// Every contributor's weight is multiplied by `atmColumnFactor(body)`
// in `surfaceHazeContributors` — log10(P/g_norm + 1), the true
// Earth-normalized vertical column-mass density. Low-gravity bodies
// (Titan, Pluto) accumulate more atmospheric mass per unit surface
// pressure than Earth, so their haze saturates at lower P than the raw
// surface-pressure model implied. These scales are calibrated against
// thick-column anchors (Titan-class for aerosol, Venus-class for bulk
// gas). Tune these globals, not per-species coefficients, if anchors
// drift. Mirror of HAZE_*_SCALE in procgen-priors.mjs — kept in sync
// by hand (a future refactor could ship them via the catalog JSON so
// there's one source of truth).
export const HAZE_BULK_GAS_SCALE = 0.2;
export const HAZE_AEROSOL_SCALE  = 1.25;
export const HAZE_DUST_SCALE     = 3.0;
export const HAZE_RAYLEIGH_SCALE = 0.15;

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
  H2SO4:        98,
  SILICATE:    100,
  DUST:        100,
  THOLIN:      100,  // CnHmN mixed polymer mass
  NH4SH:        51,
  CHROMOPHORE: 100,  // PH3-derived phosphorus polymers, mass placeholder
  SALT:         85,  // averaged across KCl (74) + ZnS (97)
  SULFUR:      256,  // S8 elemental sulfur ring
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
  H2SO4:       new Color(0xc0c0c0),
  SILICATE:    new Color(0xa0a0a0),
  DUST:        new Color(0xa86040),
  THOLIN:      new Color(0xc88040),
  NH4SH:       new Color(0xc88250),
  CHROMOPHORE: new Color(0xc04830),
  SALT:        new Color(0xc0d4d8),
  SULFUR:      new Color(0xe8d048),
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
  H2SO4:       0,
  SILICATE:    0,
  DUST:        0,
  THOLIN:      0,
  NH4SH:       0,
  CHROMOPHORE: 0,
  SALT:        0,
  SULFUR:      0,
};

export const GAS_POTENCY: Record<AtmGas, number> = {
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

export type ResourceKey =
  | 'resMetals' | 'resSilicates' | 'resVolatiles'
  | 'resRareEarths' | 'resRadioactives' | 'resExotics';

// Archetypal hue per resource — saturated brand colors used wherever the
// renderer needs a direct gameplay signal (atmospheric dust takes its
// color from the body's mineralogy via `dustColorFor`, future mining-
// yield UI panels, etc.). NOT used directly for the rocky disc surface
// — the surface path passes the body's top resources through the rock-
// archetype LUT below so realistic mineralogies (basalt, iron oxide,
// permafrost) emerge from pairs rather than blending saturated hues.
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

// Desaturated single-resource colors for the rocky-surface palette path.
// These are what a region paints when only one resource dominates it (no
// pair lookup fires). Pulled toward neutral / earth tones AND toward the
// upper-middle of the lightness range so the disc reads as bright pixel-
// art pastel rather than dark realism. The pair LUT below handles the
// common mineralogical combinations.
const ROCK_ARCHETYPE_SINGLE: Record<ResourceKey, Color> = {
  resMetals:       new Color(0x9899a0),  // light cold grey (Mercury, iron asteroids)
  resSilicates:    new Color(0xbca884),  // warm light tan (Luna highlands, dust)
  resVolatiles:    new Color(0xdceaf0),  // pale ice-cyan (Europa, polar caps)
  resRareEarths:   new Color(0xb89498),  // light dusty rose (trace stain)
  resRadioactives: new Color(0xb8b080),  // light olive-ochre (uraninite-ore)
  resExotics:      new Color(0x7e7484),  // lifted obsidian (lavender-grey anomaly)
};

// Rock-archetype pair LUT — when a region's resource subset contains two
// resources both above threshold, look up the named mineralogy here
// instead of RGB-blending the two single colors. Keyed by a
// "resA|resB" string in RESOURCE_KEYS canonical order (metals →
// silicates → volatiles → rare-earths → radioactives → exotics);
// `rockArchetypeFor` normalizes its two inputs to that same order so the
// lookup is direction-independent. All 15 resource pairs are covered, so
// the RGB-blend branch in `rockArchetypeFor` is now a defensive fallback
// rather than a routine path.
//
// Each color is a real-world mineral analog so a player can learn to
// read the disc: basalt = mafic crust, hematite = iron oxide rust,
// permafrost = cold rocky, sulfur deposits = Io-class warm, obsidian =
// volcanic glass, etc.
const ROCK_ARCHETYPE_PAIR: Record<string, Color> = {
  'resMetals|resSilicates':       new Color(0x988668),  // basalt (mafic crust: Earth ocean, lunar maria, Mars plains)
  'resMetals|resVolatiles':       new Color(0xb0b8bc),  // cryo-rock (Callisto, dark icy moons)
  'resMetals|resRareEarths':      new Color(0xa87868),  // iron oxide / hematite (weathered dusty rust — saturated lava reds reserved for future molten-surface effect)
  'resMetals|resRadioactives':    new Color(0x9c947c),  // uranium-iron metallic (light olive)
  'resMetals|resExotics':         new Color(0x706878),  // lifted obsidian glass
  'resSilicates|resVolatiles':    new Color(0xc8c8c0),  // permafrost (tundra, Mars high lat.)
  'resSilicates|resRareEarths':   new Color(0xd8945a),  // ferric sandstone / ochre desert (Mars rust)
  'resSilicates|resRadioactives': new Color(0xd8c084),  // sulfur deposits (Io-class warm yellow)
  'resSilicates|resExotics':      new Color(0x988494),  // mineralized vein-rock (light purple-brown)
  'resVolatiles|resRareEarths':   new Color(0xdcc4bc),  // reddish ice (tholin-stained outer moons)
  'resVolatiles|resRadioactives': new Color(0xc8ccb8),  // brine ice (pale sage)
  'resVolatiles|resExotics':      new Color(0x9c9cac),  // dark ice (slate)
  'resRareEarths|resRadioactives':  new Color(0xb89868),  // monazite ore (rare-earth phosphate, mildly radioactive — warm yellow-tan)
  'resRareEarths|resExotics':       new Color(0xb488ac),  // exotic pegmatite vein (rose-lavender crystal)
  'resRadioactives|resExotics':     new Color(0x9c8ca4),  // irradiated anomaly (muted violet-grey)
};

// Shade-by-balance magnitude. Inside a pair archetype, the base color is
// lerped toward each contributing resource's single-presence color by
// `(ratioA − 0.5) × SHADE_AMOUNT` so a 70/30 basalt reads visibly more
// iron-grey than a 50/50, and a 30/70 reads tan. Kept small so the
// archetype's identity dominates the visual.
const ROCK_ARCHETYPE_SHADE_AMOUNT = 0.3;

// Neutral barren rock — the base regolith color before any per-body
// resource tinting. Muted warm grey: readable as "weathered surface"
// without leaning toward any of the six resource archetypes. Used by
// the disc-palette grey-lerp on the archetype slots (low-abundance
// resources fade toward this) AND by barrenTintFor below as the base
// the body's mineralogy nudges away from. Exported so disc-palette.ts
// can share one source of truth.
export const BARREN_ROCK_COLOR = new Color(0x6c6864);

// Body-tinted barren regolith — ordered (k0|k1) so a metals-dominant
// world's barren patches differ from a silicates-dominant one's. Only
// the named pairs below get hand-tuned colors; everything else falls
// through to the formula-weighted mix in `barrenTintFor`. Each entry is
// a muted regolith hue with a clear hint of the body's top-2 mineralogy.
//
// Convention: `${dominant}|${secondary}` — keyA is the higher-abundance
// resource. Reversing the order picks a different LUT entry, which is
// the whole point of having an ordered table: Mars-dust over a metals
// crust reads different from iron-stained silicate plains.
const ROCK_ARCHETYPE_BARREN: Record<string, Color> = {
  'resMetals|resSilicates':     new Color(0x847468), // iron-dominant tan regolith (Mars dust on a metals crust)
  'resSilicates|resMetals':     new Color(0x8e7c68), // silicate-dominant rust dust (Luna-Mars warm)
  'resMetals|resVolatiles':     new Color(0x747880), // cold iron grey (asteroid surface)
  'resVolatiles|resMetals':     new Color(0x8c9498), // dusty frozen grey (Callisto regolith)
  'resSilicates|resVolatiles':  new Color(0x8c8478), // permafrost tan (Mars high lat.)
  'resVolatiles|resSilicates':  new Color(0x94948c), // dirty ice grey (rocky inclusions in ice)
  'resSilicates|resRareEarths': new Color(0xa07a54), // ferric desert regolith (Mars rust over silicate crust)
};

// Formula weights for the barren-tint fallback. `BARREN` carries the
// neutral regolith base; `PRIMARY` and `SECONDARY` add the resource hue.
// Order matters because PRIMARY > SECONDARY — a metals|silicates body
// (metals primary) leans toward iron-grey; a silicates|metals body
// (silicates primary) leans toward tan. Weights sum to 1 so the output
// stays in the valid color range without further clamping.
const BARREN_TINT_BASE_WEIGHT      = 0.55;
const BARREN_TINT_PRIMARY_WEIGHT   = 0.30;
const BARREN_TINT_SECONDARY_WEIGHT = 0.15;

// Derive the body-tinted barren regolith color for a (k0, k1) pair. The
// disc-palette renders this as the third paint slot alongside the two
// archetype slots, so a Mars-class body's barren patches read as rust-
// hinted regolith rather than a uniform neutral grey across every world.
// Ordered: k0 is the higher-abundance resource. The LUT short-circuits
// for curated pairs; the formula handles the rest.
export function barrenTintFor(
  k0: ResourceKey,
  k1: ResourceKey | null,
): Color {
  if (k1 !== null && k0 !== k1) {
    const lutHit = ROCK_ARCHETYPE_BARREN[`${k0}|${k1}`];
    if (lutHit) return lutHit;
  }
  const c0 = RESOURCE_COLOR[k0];
  const c1 = (k1 !== null && k0 !== k1) ? RESOURCE_COLOR[k1] : c0;
  return new Color(
    BARREN_ROCK_COLOR.r * BARREN_TINT_BASE_WEIGHT
      + c0.r * BARREN_TINT_PRIMARY_WEIGHT
      + c1.r * BARREN_TINT_SECONDARY_WEIGHT,
    BARREN_ROCK_COLOR.g * BARREN_TINT_BASE_WEIGHT
      + c0.g * BARREN_TINT_PRIMARY_WEIGHT
      + c1.g * BARREN_TINT_SECONDARY_WEIGHT,
    BARREN_ROCK_COLOR.b * BARREN_TINT_BASE_WEIGHT
      + c0.b * BARREN_TINT_PRIMARY_WEIGHT
      + c1.b * BARREN_TINT_SECONDARY_WEIGHT,
  );
}

// Look up the rock archetype for one or two resources, applying shade-
// by-balance for pair entries.
//   - `keyA` alone (keyB = null) → the single-presence color.
//   - `keyA + keyB` with a pair entry → the LUT color, lerped toward
//     keyA's single color by `(ratioA − 0.5) × SHADE_AMOUNT`.
//   - `keyA + keyB` with NO pair entry → straight RGB blend of the two
//     single-presence colors weighted by ratioA / (1 − ratioA). Catches
//     rare/radioactive/exotic combinations that don't have a curated
//     mineralogy.
export function rockArchetypeFor(
  keyA: ResourceKey,
  keyB: ResourceKey | null,
  ratioA: number,
): Color {
  const singleA = ROCK_ARCHETYPE_SINGLE[keyA];
  if (keyB === null) return singleA;
  const singleB = ROCK_ARCHETYPE_SINGLE[keyB];
  // Normalize to RESOURCE_KEYS order — the order the PAIR table is keyed
  // in — so the lookup is direction-independent (a string compare would
  // disagree with the table's order for pairs like silicates+rare-earths).
  const lutKey = RESOURCE_KEYS.indexOf(keyA) <= RESOURCE_KEYS.indexOf(keyB)
    ? `${keyA}|${keyB}`
    : `${keyB}|${keyA}`;
  const pair = ROCK_ARCHETYPE_PAIR[lutKey];
  if (!pair) {
    return new Color(
      singleA.r * ratioA + singleB.r * (1 - ratioA),
      singleA.g * ratioA + singleB.g * (1 - ratioA),
      singleA.b * ratioA + singleB.b * (1 - ratioA),
    );
  }
  const shade = (ratioA - 0.5) * ROCK_ARCHETYPE_SHADE_AMOUNT;
  const towardKey = shade >= 0 ? keyA : keyB;
  const toward = ROCK_ARCHETYPE_SINGLE[towardKey];
  const amount = Math.abs(shade);
  return new Color(
    pair.r + (toward.r - pair.r) * amount,
    pair.g + (toward.g - pair.g) * amount,
    pair.b + (toward.b - pair.b) * amount,
  );
}

// Per-deck cloud palette derivation. Each cloud deck is one condensate
// species (NH3 ice, H2O ice, H2SO4 droplets, CH4 frost, ...) suspended
// at one altitude. Its visible color is THAT condensate, plus whatever
// chromophore aerosols physically associate with it — nothing else.
//
// No atm-gas folding here. Transparent atm species (N2, O2, H2, He)
// don't form clouds and don't tint cloud cells. Atm-column absorption
// is a separate concept that paints the void between cloud cells on
// no-surface bodies (see `atmColumnColor` in disc-palette.ts), not the
// cloud itself.
//
// Multi-deck bodies (Jupiter) get one palette per deck: NH3 deck reads
// white + brown + red because procgen emits NH4SH + CHROMOPHORE that
// stain NH3; the H2O deck below stays plain white because no chromophore
// stains H2O. Renderer paints exactly what procgen + this mapping emit.

const ZERO_COLOR = new Color(0, 0, 0);

// Aerosol species the renderer should not paint into the haze blanket
// even if procgen emits a non-zero strength. CHROMOPHORE (PH3 photolysis
// red) is parked here: its visible signal lives in narrow lat-bands and
// can't be honestly represented by a body-wide haze tint, so a future
// pass will reintroduce it as a thin sparse-coverage top deck. Until
// then, ignore renderer-side.
export const RENDERER_SKIP_AEROSOLS: ReadonlySet<AtmGas> = new Set<AtmGas>(['CHROMOPHORE']);

// Gas species present as cloud decks on this body. The haze blanket
// walk should skip aerosols whose species matches one of these — they
// already paint as a deck and shouldn't also blanket the disc.
export function deckGasesFor(body: Body): ReadonlySet<AtmGas> {
  if (body.cloudLayers.length === 0) return new Set<AtmGas>();
  return new Set<AtmGas>(body.cloudLayers.map(l => l.gas as AtmGas));
}

export interface CloudDeckPalette {
  // One color per deck — the condensate (CONDENSATE_COLOR with GAS_COLOR
  // fallback). Multi-color character on banded bodies emerges from
  // coverage rents in upper decks revealing the next-deeper deck, not
  // from in-deck palette mixing.
  readonly color: Color;
}

// Stratospheric haze strength for no-surface bodies (gas / ice giants
// / hycean / helium). Photochemical haze accumulates above the cloud
// decks; colder bodies hold thicker stratospheric haze under their
// slower atmospheric dynamics. Consumed by `hazeBlendFor`
// (disc-palette.ts) to weight the atm column color as a haze
// contributor, so the haze blanket pre-tint inside the per-deck loop
// has a non-zero signal on gas giants. Anchors are temperature, value
// pairs. Piecewise linear; clamped at extremes. Null temperature →
// 0.30 (mild default).
const STRATOSPHERIC_HAZE_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [60, 0.85],
  [134, 0.55],
  [165, 0.15],
  [800, 0.10],
];

export function stratosphericHazeStrengthFor(tempK: number | null): number {
  if (tempK == null) return 0.30;
  const first = STRATOSPHERIC_HAZE_ANCHORS[0];
  const last = STRATOSPHERIC_HAZE_ANCHORS[STRATOSPHERIC_HAZE_ANCHORS.length - 1];
  if (tempK <= first[0]) return first[1];
  if (tempK >= last[0]) return last[1];
  for (let i = 0; i < STRATOSPHERIC_HAZE_ANCHORS.length - 1; i++) {
    const [t0, s0] = STRATOSPHERIC_HAZE_ANCHORS[i];
    const [t1, s1] = STRATOSPHERIC_HAZE_ANCHORS[i + 1];
    if (tempK >= t0 && tempK <= t1) {
      const a = (tempK - t0) / (t1 - t0);
      return s0 + (s1 - s0) * a;
    }
  }
  return 0.30;
}

// Per-deck color. One condensate per deck — multi-color character on a
// gas giant emerges from coverage rents revealing the deeper deck, not
// from in-deck palette mixing. Species without a CONDENSATE_COLOR
// entry (H2SO4 droplets, SILICATE particles, etc.) fall back to
// GAS_COLOR — their visible aerosol form is the condensate.
export function cloudDeckPalette(_body: Body, layerGas: string): CloudDeckPalette {
  const gas = layerGas as AtmGas;
  return {
    color: CONDENSATE_COLOR[gas] ?? GAS_COLOR[gas] ?? ZERO_COLOR,
  };
}

// Top `count` resources (default 2) by value, with `abundance` = value/10
// (absolute 0..1 scale, NOT renormalized across the picks). Two callers
// rely on this: the disc-palette lerps each archetype slot toward a
// neutral barren grey by (1 − abundance) so resource-poor worlds read
// as muted regolith, and dustColorFor renormalizes internally to blend
// dust mineralogy. Empty when every res scalar is null/zero — caller
// falls back to a solid world-class color. `key` is exposed so callers
// can look the resource up in any of the parallel tables (RESOURCE_COLOR
// for the saturated gameplay signal, ROCK_ARCHETYPE_SINGLE / _PAIR for
// the realistic surface mineralogy).
export function dominantResources(
  body: Body,
  count = 2,
): Array<{ key: ResourceKey; color: Color; abundance: number }> {
  return RESOURCE_KEYS
    .map(k => ({ key: k, value: body[k] ?? 0 }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
    .map(e => ({
      key: e.key,
      color: RESOURCE_COLOR[e.key],
      abundance: Math.min(1, e.value / 10),
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
