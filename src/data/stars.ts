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
  | 'rocky' | 'ocean' | 'ice' | 'desert' | 'lava'
  | 'gas_dwarf' | 'gas_giant' | 'ice_giant';
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

// Procgen mass/radius taxonomy used by the Architect when sampling a
// planet's physical spec and ring/moon priors. Persisted on the body so
// downstream consumers don't have to reverse-engineer it from the
// many-to-one `worldClass` mapping (a 2 M⊕ super_earth and a 2 M⊕ rocky
// can both land at worldClass='desert' but carry different priors).
// Null for non-planet kinds and for curated-system planets where the
// Architect/backfill didn't run.
export type PlanetType =
  | 'hot_rocky' | 'rocky' | 'super_earth'
  | 'sub_neptune' | 'neptune' | 'jupiter';

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
  // Architect's mass/radius taxonomy. See `PlanetType` for semantics.
  readonly planetType: PlanetType | null;
  // Surface character. All null for belt / ring kinds (no surface).
  readonly worldClass: WorldClass | null;
  readonly avgSurfaceTempK: number | null;
  readonly surfaceTempMinK: number | null;
  readonly surfaceTempMaxK: number | null;
  readonly waterFraction: number | null;
  readonly iceFraction: number | null;
  readonly albedo: number | null;
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
  // Visually-dominant trace species — a gas whose chromophore or
  // condensate signature paints the body's apparent color out of
  // proportion to its molar fraction (Jupiter's NH3 ice clouds at
  // ~0.03%, Earth's H2O clouds at <1%). Independent of atm1/atm2/atm3
  // which stay top-by-mass for gameplay (terraforming, breathability,
  // mining yields). The renderer folds chromophoreGas into its palette
  // selection with a visibility boost; gameplay should treat it as a
  // small additional resource present at its real fraction, not as a
  // top-3 species. Null when the body has no notable chromophore.
  readonly chromophoreGas: string | null;
  readonly chromophoreFrac: number | null;
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
  rocky:     new Color(0xc4956a),
  ocean:     new Color(0x4a9fd9),
  ice:       new Color(0xd6e8f0),
  desert:    new Color(0xe4a854),
  lava:      new Color(0xd64a3a),
  gas_dwarf: new Color(0xa090c8),
  gas_giant: new Color(0xc4a878),
  ice_giant: new Color(0x5a9ad6),
};
export const WORLD_CLASS_UNKNOWN_COLOR = new Color(0x808080);

// Optional per-class warm/cool tint applied to every palette entry by
// the planet/moon shader's palette derivation. Compensates for the
// gas-mix model's inability to represent chromophores (NH3 ice clouds +
// tholin chromophores on Jupiter, etc.) — gas giants tint warm so they
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
// SILICATE and DUST are condensable aerosols rather than true gases —
// they only ever appear via the chromophore path (CHROMOPHORE_BY_CLASS),
// never in ATMOSPHERE_GASES_BY_CLASS. SILICATE represents refractive
// silicate cloud particles in hot-Jupiter / hot-sub-Neptune atmospheres
// (Mg-Si-O condensates dredged from deep layers). DUST represents
// suspended ferric-oxide aerosols on Mars-class desert worlds. Both
// remain in the AtmGas type so the chromophore field doesn't need a
// separate type — the bounded vocabulary stays bounded.
export type AtmGas =
  | 'N2' | 'O2' | 'CO2' | 'H2O' | 'CH4' | 'NH3'
  | 'SO2' | 'Ar' | 'CO'  | 'H2'  | 'He'
  | 'SILICATE' | 'DUST';

// Archetypal hue per atmospheric gas. Picked to read at small disc sizes
// as "what's in the air" rather than as photoreal sky color — the
// rendering target is pixel-banded discs at 40-120 px, not a globe.
export const GAS_COLOR: Record<AtmGas, Color> = {
  N2:  new Color(0xb8c4d8),  // pale slate (mostly transparent in reality)
  O2:  new Color(0x8ec0e4),  // cool blue
  CO2: new Color(0xd8a878),  // dusty ochre (Venus)
  H2O: new Color(0xe4ecf0),  // near-white cloud
  CH4: new Color(0x6890d8),  // blue-cyan (Uranus/Neptune)
  NH3: new Color(0xc89860),  // warm amber — Jovian NH3 ice / chromophore
  SO2: new Color(0xc8a448),  // sulfurous yellow
  Ar:  new Color(0xa8b0b8),  // grey neutral
  CO:  new Color(0x988478),  // smoky brown
  H2:  new Color(0xf0e4c8),  // pale Jovian
  He:  new Color(0xf4e8d4),  // Jovian cream
  // Aerosol-only species — these never appear via atm priors, but the
  // GAS_COLOR fallback exists in case CHROMOPHORE_COLOR drift leaves a
  // null lookup.
  SILICATE: new Color(0x788098),  // refractive silicate-cloud grey-blue
  DUST:     new Color(0xa86040),  // ferric oxide rust (Mars dust)
};

// Per-gas "visual potency" — how much each gas contributes to the disc's
// apparent color *per unit molar fraction*. Decoupled from abundance
// because the two correlate poorly: Uranus and Neptune are 95%+ H2/He
// (transparent) and read as blue *because of* 1.5-2.3% CH4, which is a
// strong red-light absorber. Mass-fraction-weighted color would paint
// them as cream-and-trace-blue (wrong); potency-weighted color paints
// them as mostly CH4 with cream accents (right).
//
// topGases() multiplies each gas's fraction by its potency before
// renormalizing, so the displayed weights reflect visual contribution
// rather than abundance. Tunable.
// Multiplier applied to a body's `chromophoreFrac` before folding it
// into topGases. Reflects that condensed-phase species (NH3 ice clouds,
// H2O cloud decks, tholin aerosols) punch above their gas-phase fraction
// — the visible signal is the cloud or aerosol surface, not the bulk
// gas. Separate from GAS_POTENCY (per-molecule absorption strength)
// because the two are independent physics:
//   - potency       = how much one molecule of this gas absorbs
//   - visual boost  = how much this trace species condenses into a
//                     visually-dominant phase
// A gas can be high in one and low in the other (CH4 absorbs strongly
// as gas; NH3 condenses strongly into clouds). Tunable; ~75 gets Jupiter
// to ~37% NH3 weight (~2 of 6 bands rendering as belt-brown) while
// leaving Saturn's lower NH3 fraction at ~18% (one subtle band).
export const CHROMOPHORE_VISUAL_BOOST = 75;

// Color override when a gas appears via the chromophore path rather
// than via atm1/2/3. Distinct because the chromophore signal is the
// *condensed-phase product*, not the pure gas: Jupiter's brown belts
// are NH4SH + tholin chromophores on NH3 ice clouds, not transparent
// NH3 gas. Gases without an entry fall back to GAS_COLOR (clouds are
// white either way; SO2 aerosols read similar to SO2 gas).
//
// Bodies where the same gas appears in both atm and chromophore slots
// resolve via topGases' dedupe: the higher-weight entry wins, and the
// chromophore boost makes that nearly always the chromophore path —
// so the condensed-product color is what renders.
export const CHROMOPHORE_COLOR: Partial<Record<AtmGas, Color>> = {
  NH3: new Color(0xa05028),  // NH4SH + tholin brown — Jovian belt color
  CH4: new Color(0xc88040),  // tholin orange — Titan haze (CH4 photolysis product)
  // SILICATE + DUST are chromophore-only species; CHROMOPHORE_COLOR is
  // their only render path so the value here is what actually paints.
  SILICATE: new Color(0x788098),  // refractive silicate-cloud grey-blue — hot Jupiters / hot sub-Neptunes
  DUST:     new Color(0xa86040),  // ferric oxide rust — Mars-class dust haze
  // H2O defaults to GAS_COLOR (clouds are white)
  // SO2 defaults to GAS_COLOR (sulfuric aerosols read similar to SO2 gas)
};

// Chromophores whose condensed-phase product forms an opaque aerosol
// haze that visually occludes the surface, even at modest pressures.
// Titan's CH4 → tholin haze and Venus's SO2 → sulfuric aerosols are
// the canonical cases. H2O is intentionally absent — water cloud decks
// allow surface visibility (Earth from space shows continents); we want
// "ocean-like rocky with surface texture" not "opaque banded disc."
export const HAZE_FORMING_CHROMOPHORES: ReadonlySet<AtmGas> = new Set(['CH4', 'SO2']);

// Pressure threshold (bar) above which a haze-forming chromophore flips
// the body into banded mode. Titan sits at 1.45 bar; this needs to be
// below that. Set conservatively at 0.5 so an outlier sub-1-bar Titan-
// analog still gets the right treatment, while Mars-class thin atms
// (0.006 bar) stay in surface mode regardless of chromophore.
const HAZE_BANDED_PRESSURE_BAR = 0.5;

// Per-class set of gases that are present in the atmosphere but not
// visible from above — buried under a cloud deck at the photic depth
// the disc renderer is modeling. Gas-giant CH4 is the canonical case:
// real Jupiter and Saturn carry CH4 at 0.3-0.5% by mass, but it sits
// below the NH3 ice cloud layer, so the disc's apparent color comes
// from the cloud tops + chromophores, not from CH4 absorption. Ice
// giants have thinner / higher cloud cover and CH4 IS the visible
// signal, so they're intentionally absent from the filter.
//
// topGases drops filtered gases from the candidate list before
// scoring. The gas stays in atm1..3 for gameplay (CH4 really is in
// Jupiter's atmosphere and can be mined as a deep-atmosphere resource)
// — only the disc renderer ignores it.
export const GAS_VISIBILITY_FILTER: Partial<Record<WorldClass, ReadonlySet<AtmGas>>> = {
  gas_giant: new Set(['CH4']),
  gas_dwarf: new Set(['CH4']),
  // ice_giant intentionally absent — CH4 is the Uranus/Neptune blue.
};

// Molecular weight per atmospheric gas (amu). Lighter gases concentrate
// at high altitude in equilibrium atmospheres — useful for picking the
// gas most visible at the LIMB of banded bodies whose chromophore is
// deep cloud chemistry (NH3 on gas giants) rather than a high-altitude
// haze. Aerosol species (SILICATE, DUST) get a "heavy particulate"
// weight that keeps them out of the lightest-gas pick — they enter the
// limb color via the chromophore path, not via this table.
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
  SILICATE: 100,
  DUST:     100,
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
  // Aerosol-only — only meaningful via the chromophore path. Potency
  // of 3 lets a 0.1% silicate/dust frac match a 3% H2O cloud-deck
  // signal at the same boost level.
  SILICATE: 3.0,
  DUST:     3.0,
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

// Pressure (bar) above which a non-giant world's atmosphere visually
// occludes its surface. Venus sits at ~90 bar so it clears easily;
// Earth's 1 bar and Mars's 0.006 bar stay below. Tunable.
const ATMOSPHERE_BANDED_PRESSURE_BAR = 10;

// True when the body's atmosphere replaces its surface in the disc
// render. Three triggers, in priority order:
//   1. Gas/ice giants by class — no surface exists.
//   2. Venus-class thick atmosphere (≥10 bar) — any composition.
//   3. Titan-class haze-forming chromophore (CH4 → tholin, SO2 →
//      sulfuric aerosol) at modest pressure (≥0.5 bar) — even though
//      the bulk gas is transparent (Titan is mostly N2), the
//      photochemistry product is opaque and obscures the surface.
//      H2O is intentionally not in the haze-forming set; Earth's
//      surface is visible through its cloud decks.
export function isBandedAtmosphere(body: Body): boolean {
  const wc = body.worldClass;
  if (wc === 'gas_giant' || wc === 'gas_dwarf' || wc === 'ice_giant') return true;
  const pressure = body.surfacePressureBar ?? 0;
  if (pressure >= ATMOSPHERE_BANDED_PRESSURE_BAR) return true;
  if (
    pressure >= HAZE_BANDED_PRESSURE_BAR &&
    body.chromophoreGas !== null &&
    HAZE_FORMING_CHROMOPHORES.has(body.chromophoreGas as AtmGas)
  ) {
    return true;
  }
  return false;
}

// Top 1-3 atmospheric gases for rendering, with each gas's contribution
// computed as `fraction × potency`. The chromophore (if any) folds in
// as an additional candidate with weight `chromophoreFrac × potency ×
// CHROMOPHORE_VISUAL_BOOST` — see the const for why. The full candidate
// list is then sorted by weight and trimmed to the top 3, so a body
// whose chromophore outweighs its by-mass third gas (Jupiter: NH3
// chromophore vs CH4 atm3) gets the chromophore in the palette.
//
// The output may reorder vs the CSV's atm1/atm2/atm3 ordering when a
// low-fraction high-potency gas (CH4 on ice giants) outweighs a high-
// fraction transparent gas (H2). Unknown gas names (procgen vocabulary
// drift) are silently skipped; an empty result means the caller should
// fall back to a solid world-class color.
export function topGases(body: Body): Array<{ color: Color; weight: number }> {
  // Tuple: [gas, frac, boost, isChromophore]. The chromophore path uses
  // CHROMOPHORE_COLOR (condensed-product hue) where defined; atm slots
  // use GAS_COLOR (clear-gas hue).
  const candidates: Array<[string | null, number | null, number, boolean]> = [
    [body.atm1, body.atm1Frac, 1, false],
    [body.atm2, body.atm2Frac, 1, false],
    [body.atm3, body.atm3Frac, 1, false],
    [body.chromophoreGas, body.chromophoreFrac, CHROMOPHORE_VISUAL_BOOST, true],
  ];
  // Visibility filter — gases physically present but buried under a
  // cloud deck at this world class don't contribute to the rendered
  // color. See GAS_VISIBILITY_FILTER for the canonical case (gas-giant
  // CH4 hidden beneath the NH3 ice layer).
  const filtered: ReadonlySet<AtmGas> | undefined =
    body.worldClass !== null ? GAS_VISIBILITY_FILTER[body.worldClass] : undefined;

  // Dedupe by gas name so a body whose chromophore already appears in
  // atm1..3 (e.g. an ice giant with CH4 as both top-by-mass and listed
  // chromophore) doesn't get double-counted — keep the higher-weight
  // entry, which will be the chromophore boost (and so will carry the
  // condensed-product color, not the gas color).
  const byGas = new Map<string, { color: Color; weight: number }>();
  for (const [name, frac, boost, isChromophore] of candidates) {
    if (name === null || frac === null) continue;
    const gas = name as AtmGas;
    if (filtered?.has(gas)) continue;
    const col = (isChromophore ? CHROMOPHORE_COLOR[gas] : undefined) ?? GAS_COLOR[gas];
    if (!col) continue;
    const potency = GAS_POTENCY[gas] ?? 1;
    const visualWeight = frac * potency * boost;
    const prev = byGas.get(name);
    if (!prev || visualWeight > prev.weight) {
      byGas.set(name, { color: col, weight: visualWeight });
    }
  }
  // Sort by visual weight, take top 3, renormalize. Putting the strongest
  // visual signal at index 0 keeps "the solid-color fallback reads the
  // body" honest — see buildDiscPalette's palette0 handling.
  const out = [...byGas.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  const total = out.reduce((s, e) => s + e.weight, 0);
  if (total > 0) for (const e of out) e.weight /= total;
  return out;
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
