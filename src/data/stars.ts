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
//   - Owns the type definitions other modules consume (including the
//     AtmGas / ResourceKey field vocabularies).
//   - Owns runtime-only constants (CLASS_COLOR for the stars shader,
//     WAYPOINT_STAR_IDS for the labels module).
//
// Body/planet render color-science (biome, gas, rock, haze, cloud and
// resource palettes) is NOT here — it lives in
// scene/system-diagram/color-science.ts, which imports the types below.
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

// A body's type is no longer a stored category — it's derived on demand from
// physics by `classifyBody` (scripts/lib/body-archetype.mjs), the single
// source both the label and the variety audit read. Nothing persists it.
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
// The solvent a body's standing liquid is made of. Which species condenses
// is set by surface temperature against each fluid's stability window, so a
// frozen-out world can still host a deep solvent the surface H2O proxy can't
// describe (Titan's methane lakes, a cryo ammonia sea). Lets the disc shade
// non-water seas with their own optics instead of forcing every liquid to
// read as water.
export type SurfaceLiquidSpecies =
  | 'water'
  | 'hydrocarbon'
  | 'ammonia_water'
  | 'ammonia'
  | 'nitrogen'
  | 'sulfur';

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
  readonly avgSurfaceTempK: number | null;
  readonly surfaceTempMinK: number | null;
  readonly surfaceTempMaxK: number | null;
  readonly waterFraction: number | null;
  readonly iceFraction: number | null;
  // Generalized standing-liquid cover, decoupled from the H2O-specific
  // waterFraction: the fraction of surface under the dominant liquid of
  // whatever species condenses here, so methane- or ammonia-sea worlds get
  // a real liquid extent the water proxy would read as dry.
  readonly surfaceLiquidFraction: number | null;
  // Which solvent that dominant surface liquid is; null only when nothing
  // stands on the surface, since a zero-cover world has no liquid to name.
  readonly surfaceLiquidSpecies: SurfaceLiquidSpecies | null;
  // Solvent of a hidden ice-shell ocean (Europa, Enceladus), independent of
  // anything on the surface; null means no buried ocean, which is why it
  // can be set on a body whose surface is frozen solid.
  readonly subsurfaceOceanSpecies: SurfaceLiquidSpecies | null;
  // Solute load of the surface liquid as a single scalar — drives how the
  // disc tints and how reflective a sea reads — left untagged by solute
  // type; null on bodies with no surface liquid to carry solutes.
  readonly salinity: number | null;
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

// =============================================================================
// Body field vocabularies — the gas + resource enums that name the valid
// values of Body's atmosphere and resource fields (stored loosely as
// string / number on the interface). Mirror the procgen vocabulary; the
// render palette (system-diagram/color-science.ts) keys its color tables on them.
// =============================================================================

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

export type ResourceKey =
  | 'resMetals' | 'resSilicates' | 'resVolatiles'
  | 'resRareEarths' | 'resRadioactives' | 'resExotics';


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
