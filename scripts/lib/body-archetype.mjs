// Body archetype — the single, physics-derived classification of a body
// into one evocative type. Replaces the stored `worldClass` field: the
// generator no longer writes a category, the renderer never needed one for
// color (disc color is already a resource/physics composition), and this
// function is computed on demand by the only two consumers that want a
// category — the body label (presentation noun) and the variety audit
// (rarity gates).
//
// Shared across the .mjs/.ts boundary via body-archetype.d.mts, the same
// pattern prng.mjs / gas-potency.mjs use: imported by `scripts/` audits
// (Node) AND `src/` UI (Vite). Pure, dependency-free, runtime-light — it
// carries its own threshold table rather than pulling the whole
// procgen-priors surface into the browser bundle.
//
// The richer enum (W-D2): the base worldClass taxonomy is preserved (under
// flavour-aligned names — glacial/frostbound/sub_neptune/super_earth) and
// the iconic types the surface-liquid data unlocks are promoted to
// first-class archetypes the audit can reason about directly:
//   gaian            living temperate water ocean (Earth)
//   tholin           hydrocarbon lakes / thick organic smog (Titan)
//   brimstone        molten-sulfur seas (Io-class)
//   ammonia_sea      full ammonia / ammonia-water ocean
//   glacial_sea      full liquid-nitrogen ocean (Triton-warm)
//   subglacial_ocean buried ice-shell ocean, frozen surface (Europa)
//   hot_jupiter      close-in scorching gas giant
//
// `classifyBody(body, S)` — `S` is insolation (Earth = 1), consulted only by
// the chthonian branch (stripped-core worlds are identified by being
// close-in). Pass it where available (the audit + build have it); when null,
// chthonian degrades to its non-chthonian classification rather than
// mis-firing.

// Classification thresholds — the single source of the gaseous/terrestrial
// radius bounds and the temperature/composition gates. procgen imports these
// for its own gaseous-bracket test (isGaseousBody), so the values live here
// once.
export const ARCHETYPE_THRESHOLDS = {
  jupiterRadius:          8,     // R⊕; gas giant lower bound
  neptuneRadius:          3.5,   // Neptune-class lower bound
  gasDwarfRadius:         2,     // rocky / sub-Neptune boundary
  iceGiantTempCeilingK:   200,   // warm-vs-cold gate in the Neptune bracket
  hotJupiterTempFloorK:   700,   // gas giant hot enough to read "Hot Jupiter"
  hyceanTempCeilingK:     300,
  hyceanBulkWaterMin:     0.05,
  lavaTempFloorK:         1000,
  magmaOceanTempFloorK:   700,
  magmaOceanTectMin:      0.5,
  chthonianMassMin:       2.0,
  chthonianMetalMin:      0.4,
  // A stripped hot-Jupiter core reads as hot (close-in) — keyed on surface
  // temperature (a stored field) rather than insolation so the classifier
  // needs no host-star lookup, and the runtime label and build agree.
  chthonianTempFloorK:    900,
  ironMetalMin:           0.5,
  iceIceMin:              0.7,
  iceWaterCeiling:        0.1,
  carbonBulkVolatileMin:  0.10,
  oceanWaterFloor:        0.5,
  solidGiantMassMin:      1.5,
  solidGiantRadiusMin:    1.3,
  desertWaterCeiling:     0.05,
  desertIceCeiling:       0.05,
};

// Minimum surface-liquid cover that makes an exotic solvent a body's
// defining feature (mirrors procgen-priors MIN_SURFACE_LIQUID_COVER —
// a trace film isn't a Tholin/Brimstone world).
const MIN_SURFACE_LIQUID_COVER = 0.05;
// Thick organic smog (Titan tholin haze) reads as a Tholin world even
// when the lakes themselves are below the cover floor.
const THOLIN_HAZE_FLOOR = 0.5;
// Gaian temperate band — the surface-liquid-water window for "living world".
// Liquid floor tracks oceanWaterFloor so a Gaian is cleanly a living,
// temperate instance of a full water ocean (Earth), never a partial-cover
// promotion out of the rocky/desert bucket.
const GAIAN_TEMP_LO = 250;
const GAIAN_TEMP_HI = 330;
// A genuinely exposed magma ocean vs a crusted, volcanically-active world.
const MAGMA_OCEAN_EXPOSED_TEMP_K = 1100;
// Tidal volcanism (Io): a perpetually-resurfaced, tectonically-active body
// whose melt is driven by tidal heating, not insolation — so it sits well
// below the temperature melt floors yet is anything but dead. Detected by a
// near-fully-young surface + strong tectonics, AND a cold surface: above
// ~400 K a dry active body already reads "Volcanic" via the label's state
// modifier (insolation-assisted), so the archetype is reserved for the
// genuinely cold-but-alive case where only tidal heat explains the activity.
// Dry/rocky only (the icy equivalent reads as a (sub)glacial body with a
// cryovolcanic surface).
const TIDAL_VOLCANISM_SURFACE_AGE = 0.9;
const TIDAL_VOLCANISM_TECT_MIN = 0.8;
const TIDAL_VOLCANISM_TEMP_CEILING_K = 400;

// Every archetype value, grouped. The label maps each to a display noun;
// the audit buckets rarity by these. Order is informational only.
export const ARCHETYPES = [
  // gaseous
  'hot_jupiter', 'gas_giant', 'ice_giant', 'sub_neptune', 'hycean', 'helium',
  // iconic surface/subsurface liquid
  'gaian', 'tholin', 'brimstone', 'ammonia_sea', 'glacial_sea', 'subglacial_ocean', 'ocean',
  // terrestrial base
  'lava', 'magma_ocean', 'volcanic', 'chthonian', 'iron', 'frostbound', 'glacial',
  'super_earth', 'desert', 'rocky',
  // unclassifiable (no radius / no temperature)
  'unknown',
];

// The gaseous-bracket archetypes (radius ≥ gasDwarfRadius) — no accessible
// solid surface. Shared so every "is this a gas/ice giant?" consumer (disc
// palette tint, atmosphere μ-factor, info-card surface gating) keys off one
// source instead of re-listing the set.
export const GASEOUS_ARCHETYPES = new Set([
  'hot_jupiter', 'gas_giant', 'ice_giant', 'sub_neptune', 'hycean', 'helium',
]);

// Classify a body into one archetype from its settled physical state. A
// radius bracket splits gaseous from terrestrial; the iconic surface-liquid
// archetypes are checked ahead of the base terrestrial cascade (they're more
// specific; none of them is ever T ≥ lavaTempFloorK, so they
// can't steal a genuine lava world).
export function classifyBody(body) {
  const W = ARCHETYPE_THRESHOLDS;
  const r = body.radiusEarth;
  if (r == null) return 'unknown';
  const T = body.avgSurfaceTempK;

  // ─── Gaseous bracket (radius ≥ gasDwarfRadius) ───
  if (r >= W.gasDwarfRadius) {
    // Hycean is a SUB-NEPTUNE (K2-18b-class): cold + H2-enveloped +
    // water-rich AND small enough (r < neptuneRadius) that a liquid
    // ocean sits at the base of the envelope. Above Neptune size the
    // envelope is too deep/massive for a surface ocean — that's an ice
    // giant, not a hycean. The size bound is as physical as the temp +
    // composition conditions; without it the gate mislabels real giants.
    if (r < W.neptuneRadius &&
        T != null && T < W.hyceanTempCeilingK &&
        (body.bulkWaterFraction ?? 0) >= W.hyceanBulkWaterMin &&
        body.atm1 === 'H2') {
      return 'hycean';
    }
    if (body.atm1 === 'He' && body.atm2 !== 'H2' && body.atm3 !== 'H2') {
      return 'helium';
    }
    if (r >= W.jupiterRadius) {
      return (T != null && T >= W.hotJupiterTempFloorK) ? 'hot_jupiter' : 'gas_giant';
    }
    if (r >= W.neptuneRadius && T != null && T <= W.iceGiantTempCeilingK) return 'ice_giant';
    return 'sub_neptune';
  }

  // ─── Terrestrial bracket (radius < gasDwarfRadius) ───
  if (T == null) return 'unknown';

  // Iconic surface/subsurface-liquid archetypes — checked first (more
  // specific than the base cascade). Each reads only settled physical
  // fields; none reaches T ≥ lavaTempFloorK so lava stays intact below.
  const sp = body.surfaceLiquidSpecies;
  const liquid = body.surfaceLiquidFraction ?? 0;
  if (sp === 'sulfur' && liquid >= MIN_SURFACE_LIQUID_COVER) return 'brimstone';
  if (sp === 'hydrocarbon' &&
      (liquid >= MIN_SURFACE_LIQUID_COVER || (body.hazeAerosols?.THOLIN ?? 0) >= THOLIN_HAZE_FLOOR)) {
    return 'tholin';
  }
  if (sp === 'water' && liquid >= W.oceanWaterFloor &&
      body.biosphereComplexity === 'complex' && T >= GAIAN_TEMP_LO && T < GAIAN_TEMP_HI) {
    return 'gaian';
  }
  if ((sp === 'ammonia_water' || sp === 'ammonia') && liquid >= W.oceanWaterFloor) return 'ammonia_sea';
  if (sp === 'nitrogen' && liquid >= W.oceanWaterFloor) return 'glacial_sea';
  // Buried ice-shell ocean with a frozen (liquid-free) surface — Europa.
  if (body.subsurfaceOceanSpecies != null && liquid < MIN_SURFACE_LIQUID_COVER) return 'subglacial_ocean';

  // ─── Base terrestrial cascade ───
  const water = body.waterFraction ?? 0;
  const ice = body.iceFraction ?? 0;
  const bulkMetal = body.bulkMetalFraction ?? 0;
  const bulkWater = body.bulkWaterFraction ?? 0;
  const bulkVolatile = body.bulkVolatileFraction ?? 0;
  const mass = body.massEarth ?? 0;
  const tect = body.tectonicActivity ?? 0;
  const surfaceAge = body.surfaceAge ?? 0;

  // Chthonian — a stripped hot-Jupiter core: hot, massive, metal-dominant.
  // Checked before lava because the stripped-core signature is more specific
  // than a generic molten surface (without it a hot stripped core just reads
  // "lava").
  if (T >= W.chthonianTempFloorK &&
      mass >= W.chthonianMassMin && bulkMetal >= W.chthonianMetalMin) {
    return 'chthonian';
  }
  if (T >= W.lavaTempFloorK) return 'lava';
  if (T >= W.magmaOceanTempFloorK && tect >= W.magmaOceanTectMin) {
    return T >= MAGMA_OCEAN_EXPOSED_TEMP_K ? 'magma_ocean' : 'volcanic';
  }
  // Tidal volcanism — internal-heat-driven, cold-surfaced (Io). Dry/rocky
  // only; an icy tidally-active body falls through to the (sub)glacial
  // branches and reads cryovolcanic instead.
  if (surfaceAge >= TIDAL_VOLCANISM_SURFACE_AGE && tect >= TIDAL_VOLCANISM_TECT_MIN
      && T < TIDAL_VOLCANISM_TEMP_CEILING_K && ice < W.iceIceMin) {
    return 'volcanic';
  }
  if (bulkMetal >= W.ironMetalMin) return 'iron';
  if (ice >= W.iceIceMin && water < W.iceWaterCeiling &&
      bulkVolatile > bulkWater && bulkVolatile >= W.carbonBulkVolatileMin) {
    return 'frostbound';
  }
  if (ice >= W.iceIceMin && water < W.iceWaterCeiling) return 'glacial';
  if (liquid >= W.oceanWaterFloor) return 'ocean';
  if (mass >= W.solidGiantMassMin && r >= W.solidGiantRadiusMin) return 'super_earth';
  if (water < W.desertWaterCeiling && ice < W.desertIceCeiling) return 'desert';
  return 'rocky';
}
