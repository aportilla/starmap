// Lava / molten-surface emission drives. Self-luminous incandescence emerges
// from THREE physically distinct melt sources, each a continuous smoothstep —
// never a `worldClass === 'lava'` gate. The shader composes them into one
// molten sub-pass; `lavaDrivesFor` folds them down to (moltenCoverage,
// emissionTempNorm, lavaSulfurFrac):
//   - INSOLATION (heatMelt): the whole surface liquefies as T crosses the
//     silicate solidus. Hot lava worlds (CoRoT-7b class).
//   - VENT (tidal): perpetually-repaved surface exposing hot melt even when
//     the mean surface is cold. Io.
//   - MAGMA OCEAN (magma): a hot, tectonically ACTIVE interior pushes
//     partial melt to a sub-solidus surface. 70 Oph A b class.
// Vent + magma are unified as "internal melt": both expose HOT silicate at
// melt temperature regardless of the cooler mean surface (fresh upwelling),
// differing only in what triggers them. That's why a 804 K magma ocean
// still glows — the exposed magma is ~1400 K even though the crust is not.
//
// CPU→GPU split: this module folds the drives down to the three scalars the
// shader consumes; the GPU side paints them. The molten sub-pass + its
// `LAVA_*` constant block + `emberRamp` live in `materials/planet.ts` (search
// "Lava / molten-surface emission"). moltenCoverage / emissionTempNorm ride in
// as varyings; lavaSulfurFrac travels via the LAVA_TINT texel. The split is
// deliberate — CPU resolves coverage/temp, GPU resolves where on the disc.

import { Body } from '../../../data/stars';
import { atmFracOf, clamp01, smoothstep01 } from './shared';

// Silicate-solidus melt ramp for INSOLATION-driven heat. Below ~700 K
// rock is solid; by ~1500 K the surface is fully molten. A hot lava world
// (>1500 K) reads as a full molten disc.
const LAVA_SOLIDUS_LOW_K  = 700;
const LAVA_SOLIDUS_HIGH_K = 1500;
// VENT (tidal) drive — magma reaching an actively-repaved surface even when
// the surface itself is cold (Io: 110 K, tect≈1, surfaceAge=1.0). The high
// surfaceAge window is the discriminator that keeps plate-tectonic temperate
// worlds (Earth, age≈0.7) at zero while a perpetually-resurfaced body fires;
// the tect window matches the `active_volcanism` smoothstep procgen uses for
// sulfur-cycle biota.
const LAVA_VENT_AGE_LOW   = 0.9;
const LAVA_VENT_AGE_HIGH  = 1.0;
const LAVA_VENT_TECT_LOW  = 0.3;
const LAVA_VENT_TECT_HIGH = 0.9;
// MAGMA-OCEAN drive — a hot, tectonically active interior pushes partial
// surface melt below the full insolation solidus. Two-axis gate (warm AND
// active) mirrors the magma_ocean classifier's own definition, so a
// hot-but-DEAD body (Venus: 737 K, tect 0.3) stays solid while an active
// one (70 Oph A b: 804 K, tect 0.51) shows molten veins. The temperature
// window opens below the solidus floor precisely because active interiors
// surface melt the insolation-only ramp would miss.
const LAVA_MAGMA_TECT_LOW = 0.4;
const LAVA_MAGMA_TECT_HIGH = 0.6;
const LAVA_MAGMA_T_LOW    = 680;
const LAVA_MAGMA_T_HIGH   = 950;
// Internal melt (vent OR magma) is sparse, not a global melt — cap its
// coverage so even a maximally active body keeps dark crust between glowing
// lakes/veins. Coverage scales with the drive, so a marginal magma ocean
// (low drive) stays sparser than Io.
const LAVA_INTERNAL_COVERAGE_CAP = 0.35;
// How hard surface volatile abundance (resVolatiles, 0..10) damps the
// refractory fraction. Silicate volcanism only erupts glowing lava on a
// volatile-poor surface; an ice/volatile-rich body's internal heat drives
// COLD cryovolcanism (water/ammonia ~300 K, sub-Draper), and a hot WATER
// world is steam over rock — neither should read as orange silicate lava.
// < 1 so a moderately volatile-bearing but still rocky surface (Io:
// resVolatiles 2) stays refractory.
const LAVA_VOLATILE_DAMP = 0.7;
// Refractory GATE — refractory = (1-water)(1-ice)(1-DAMP·resVol) feeds a
// smoothstep that gates BOTH coverage and emission temperature on every
// melt path. Rocky/dry bodies (Io ≈ 0.86, lava/magma worlds ≈ 1) pass at
// 1; ice/volatile/water-rich bodies (Europa, hot water worlds, frost
// worlds: 0.1-0.3) are crushed to 0 so their internal heat or insolation
// never renders as silicate lava. Sharper than a linear factor so the
// rocky-vs-icy split is decisive rather than smearing a faint glow across
// half-icy worlds. Kept as a gate (not folded into the drive) because the
// emission temperature SATURATES with the drive — without a separate gate,
// a high-activity icy body's low-refractory drive would still saturate to
// hot emission (the bug that lit up cryovolcanic worlds).
const LAVA_REFRACTORY_LOW  = 0.3;
const LAVA_REFRACTORY_HIGH = 0.7;
// Intrinsic silicate-lava temperature the internal-melt paths emit at,
// regardless of a cold mean surface. The exposed-melt temperature
// SATURATES fast with the drive (any real internal melt = hot lava),
// decoupled from how MUCH reaches the surface (that's coverage) — so a
// marginal magma ocean's sparse veins still glow hot rather than dull.
// Io's calderas and 70 Oph's veins both land here.
const LAVA_INTERNAL_LAVA_T   = 1400;
const LAVA_INTERNAL_EMIT_SAT = 0.15;
// Emission-temperature normalization window for the shader's emberRamp.
// Floor at the Draper point (visible-glow onset, ~800 K); ceiling at
// white-hot. A body whose emission temperature lands below the floor maps
// to 0 → emberRamp returns ~black, so a cold cryovolcanic body (Enceladus)
// can carry a non-zero vent drive yet render no visible glow — the
// temperature self-protects against false positives with no special case.
const LAVA_EMIT_T_MIN = 800;
const LAVA_EMIT_T_MAX = 2400;

export interface LavaDrives {
  // [0..1] how much of the disc is molten — max of an insolation-driven
  // global-melt ramp and a capped internal (vent/magma) drive, gated by the
  // refractory fraction.
  readonly moltenCoverage: number;
  // [0..1] keys the shader's blackbody emberRamp (0 ≈ Draper-point dull red,
  // 1 ≈ white-hot). Heat path emits at the surface temperature, internal melt
  // at intrinsic silicate-lava temperature regardless of a cold crust.
  readonly emissionTempNorm: number;
  // [0..1] abiotic surface sulfur fraction — the shader lifts the ember's
  // green channel by this so sulfurous volcanism (Io) reads yellower.
  readonly lavaSulfurFrac: number;
}

// Two continuous drives, no gate. heatMelt: the surface approaches melt as
// avgSurfaceTempK crosses the silicate solidus. ventMelt: silicate magma
// reaches an actively-repaved surface even when the surface is cold (Io); the
// high surfaceAge window keeps Earth (age≈0.7) at zero, and the `refractory`
// factor keeps the emission off ice/volatile-rich bodies whose tidal heat
// drives cold cryovolcanism rather than glowing rock. The emission
// temperature then rides on ventMelt, so a less-refractory body erupts cooler
// material that the shader's emitNorm > 0 (Draper) guard drops to no glow —
// the suppression is continuous, not a class branch.
//
// surfaceAge is the orchestrator's resolved value (it folds the no-surface /
// tiny-disc fallback before any incandescence is sampled).
export function lavaDrivesFor(body: Body, surfaceAge: number): LavaDrives {
  const T = body.avgSurfaceTempK ?? 0;
  const tect = body.tectonicActivity ?? 0;
  const wf = body.waterFraction ?? 0;
  const iceF = body.iceFraction ?? 0;
  const resVolNorm = clamp01((body.resVolatiles ?? 0) / 10);
  const heatMelt = smoothstep01(LAVA_SOLIDUS_LOW_K, LAVA_SOLIDUS_HIGH_K, T);
  // Refractory (rock/metal vs. ice/volatile/water) surface fraction, fed
  // through a sharp gate. Io (water 0, ice 0, resVol 2) ≈ 0.86 → 1; lava /
  // magma worlds (dry) ≈ 1; Europa / frost worlds / hot water worlds
  // (0.1-0.3) → 0, so their internal heat or insolation never renders as
  // silicate lava.
  const refractory = (1 - wf) * (1 - iceF) * (1 - LAVA_VOLATILE_DAMP * resVolNorm);
  const refractoryGate = smoothstep01(LAVA_REFRACTORY_LOW, LAVA_REFRACTORY_HIGH, refractory);
  // Tidal resurfacing (Io) — perpetually-repaved surface.
  const ventDrive =
    smoothstep01(LAVA_VENT_AGE_LOW, LAVA_VENT_AGE_HIGH, surfaceAge) *
    smoothstep01(LAVA_VENT_TECT_LOW, LAVA_VENT_TECT_HIGH, tect);
  // Magma ocean — hot active interior surfacing melt below the solidus.
  const magmaDrive =
    smoothstep01(LAVA_MAGMA_TECT_LOW, LAVA_MAGMA_TECT_HIGH, tect) *
    smoothstep01(LAVA_MAGMA_T_LOW, LAVA_MAGMA_T_HIGH, T);
  const internalDrive = Math.max(ventDrive, magmaDrive);
  // Insolation fills the whole disc; internal melt stays sparse (capped)
  // so even Io / a magma ocean keeps dark crust between glowing lakes.
  // The refractory gate suppresses icy / watery bodies on every path.
  const moltenCoverage = clamp01(
    Math.max(heatMelt, internalDrive * LAVA_INTERNAL_COVERAGE_CAP) * refractoryGate,
  );
  // Insolation glows at the surface temperature; internal melt exposes hot
  // silicate at melt temperature regardless of the cooler mean surface.
  // The exposed-melt temp saturates fast with the drive (decoupled from
  // coverage), so a marginal magma ocean's sparse veins still glow hot —
  // but the refractory gate scales it back to cold (no glow) on icy
  // bodies, so a high-activity cryovolcanic world doesn't fake silicate
  // lava.
  const internalEmit = smoothstep01(0, LAVA_INTERNAL_EMIT_SAT, internalDrive) * refractoryGate;
  // The raw surface-T heat term is deliberately NOT refractory-gated here, so
  // a hot non-refractory body (icy/watery) still carries a high emissionTempNorm.
  // That's a required contract with the shader: the molten sub-pass multiplies
  // emission by moltenCoverage, which IS refractory-gated, so the un-gated heat
  // never renders on those bodies. Gating T here instead would shift their
  // emissionTempNorm; keeping the gate solely on coverage leaves it untouched.
  const emissionT = Math.max(T, internalEmit * LAVA_INTERNAL_LAVA_T);
  const emissionTempNorm = clamp01((emissionT - LAVA_EMIT_T_MIN) / (LAVA_EMIT_T_MAX - LAVA_EMIT_T_MIN));
  // Composition hue nudge — abiotic surface sulfur (Io's SO2 outgassing)
  // skews the glow yellower than pure silicate lava in the shader. A
  // composition FRACTION, not a column-mass measure: Io's atmosphere is
  // tenuous (P≈0) yet its surface is sulfur-dominated, so we read the
  // species fraction directly. Io (SO2 = 1) → 1; a silicate-vapor lava
  // world (55 Cnc e, N2/Ar) → 0. Only SO2 feeds this: the atm slots draw
  // from ATMOSPHERE_GASES_BY_REGIME, which never holds SULFUR or H2SO4
  // (those exist only as cloud/haze aerosol products), so reading them
  // here would always return 0 — the live sulfur signal is SO2 alone.
  const lavaSulfurFrac = clamp01(atmFracOf(body, 'SO2'));
  return { moltenCoverage, emissionTempNorm, lavaSulfurFrac };
}
