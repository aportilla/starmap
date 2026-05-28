#!/usr/bin/env node
//
// Pretty-print one body's post-procgen record from
// `src/data/catalog.generated.json`. Reads the same snapshot the
// runtime ships, so what's shown here is what the renderer + info card
// see. Handy when verifying that a procgen change landed the right
// values on a specific named body without grep-and-eyeball over the
// monolithic JSON.
//
// Usage:   node scripts/inspect-body.mjs <id>
// Example: node scripts/inspect-body.mjs saturn-ring
//          node scripts/inspect-body.mjs sol-main-belt
//          node scripts/inspect-body.mjs earth
//
// For each body kind the output surfaces the fields that actually
// matter — orbital geometry + worldClass + atmosphere + biosphere for
// planets and moons; extent + populationless resources + shepherd for
// belts; extent + resources + derived icyness for rings. Resources are
// rendered as a single line (M/Si/V/RE/Ra/Ex) with icyness appended
// when the kind is belt or ring (matches the renderer's derivation).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = resolve(REPO_ROOT, 'src/data/catalog.generated.json');

const id = process.argv[2];
if (!id) {
  process.stderr.write('usage: node scripts/inspect-body.mjs <id>\n');
  process.exit(2);
}

let cat;
try {
  cat = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
} catch (err) {
  process.stderr.write(`inspect-body: cannot read ${CATALOG_PATH} (${err.message}).\nRun \`npm run build:catalog\` first.\n`);
  process.exit(1);
}
const { stars, bodies } = cat;

const body = bodies.find(b => b.id === id);
if (!body) {
  process.stderr.write(`inspect-body: no body with id=${id}\n`);
  // Best-effort hint — suggest near-matches by substring so a typo finds
  // its likely intended target.
  const hints = bodies.filter(b => b.id.includes(id)).slice(0, 5).map(b => b.id);
  if (hints.length) process.stderr.write(`  did you mean: ${hints.join(', ')}?\n`);
  process.exit(1);
}

// ---- formatters ------------------------------------------------------------

function n(v, digits = 2) {
  return v == null ? '—' : Number(v).toFixed(digits);
}

function resourcesLine(b) {
  if (b.resMetals == null) return null;
  return `M:${b.resMetals} Si:${b.resSilicates} V:${b.resVolatiles} RE:${b.resRareEarths} Ra:${b.resRadioactives} Ex:${b.resExotics}`;
}

// Mirror `bodyIcyness` in src/data/stars.ts so this script doesn't need
// to depend on the runtime module.
function icyness(b) {
  const v = b.resVolatiles ?? 0;
  const rocky = (b.resMetals ?? 0) + (b.resSilicates ?? 0) + (b.resRareEarths ?? 0);
  const denom = v + rocky;
  return denom <= 0 ? 0.5 : v / denom;
}

function hostLine(b) {
  if (b.hostStarIdx != null) {
    const s = stars[b.hostStarIdx];
    return `${s.id} (${s.rawClass || s.cls || '?'})`;
  }
  if (b.hostBodyIdx != null) {
    const h = bodies[b.hostBodyIdx];
    const hostStar = h.hostStarIdx != null ? stars[h.hostStarIdx] : null;
    return `${h.id} (${h.kind}${hostStar ? ` @ ${hostStar.id}` : ''})`;
  }
  return '—';
}

function atmosphereLine(b) {
  const gases = [];
  if (b.atm1) gases.push(`${b.atm1} ${(b.atm1Frac * 100).toFixed(0)}%`);
  if (b.atm2) gases.push(`${b.atm2} ${(b.atm2Frac * 100).toFixed(0)}%`);
  if (b.atm3) gases.push(`${b.atm3} ${(b.atm3Frac * 100).toFixed(0)}%`);
  return gases.length ? gases.join('  ') : null;
}

function biosphereLine(b) {
  if (!b.biosphereComplexity || b.biosphereComplexity === 'none') return null;
  const impact = b.biosphereSurfaceImpact;
  const impactStr = impact == null ? '' : `  surfaceImpact=${impact.toFixed(3)}`;
  return `${b.biosphereArchetype ?? '?'} ${b.biosphereComplexity}${impactStr}`;
}

// ---- emit ------------------------------------------------------------------

const out = [];
out.push(`${body.id} (${body.kind})  — ${body.name}`);
out.push(`  host: ${hostLine(body)}`);
if (body.source) out.push(`  source: ${body.source}`);

if (body.kind === 'planet' || body.kind === 'moon') {
  if (body.worldClass) out.push(`  worldClass: ${body.worldClass}`);
  if (body.massEarth != null || body.radiusEarth != null) {
    out.push(`  mass: ${n(body.massEarth, 3)} M⊕    radius: ${n(body.radiusEarth, 3)} R⊕`);
  }
  if (body.semiMajorAu != null || body.periodDays != null) {
    out.push(`  orbit: ${n(body.semiMajorAu, 4)} AU    period: ${n(body.periodDays, 1)} d    ecc: ${n(body.eccentricity, 3)}`);
  }
  if (body.avgSurfaceTempK != null) {
    const range = body.surfaceTempMinK != null && body.surfaceTempMaxK != null
      ? `  (range ${body.surfaceTempMinK}–${body.surfaceTempMaxK})` : '';
    out.push(`  temp: ${body.avgSurfaceTempK} K${range}`);
  }
  if (body.surfacePressureBar != null) out.push(`  pressure: ${n(body.surfacePressureBar, 3)} bar`);
  if (body.waterFraction != null || body.iceFraction != null || body.surfaceAge != null) {
    out.push(`  surface: water ${n(body.waterFraction, 2)}    ice ${n(body.iceFraction, 2)}    age ${n(body.surfaceAge, 2)}`);
  }
  const atm = atmosphereLine(body);
  if (atm) out.push(`  atmosphere: ${atm}`);
  const bio = biosphereLine(body);
  if (bio) out.push(`  biosphere: ${bio}`);
  const res = resourcesLine(body);
  if (res) out.push(`  resources: ${res}`);
  if (body.kind === 'planet') {
    const moonNames = (body.moons ?? []).map(i => bodies[i]?.id).filter(Boolean);
    if (moonNames.length) out.push(`  moons: ${moonNames.length} (${moonNames.join(', ')})`);
    if (body.ring != null) out.push(`  ring: ${bodies[body.ring].id}`);
  }
}

if (body.kind === 'belt') {
  if (body.innerAu != null || body.outerAu != null) {
    out.push(`  extent: ${n(body.innerAu, 2)}–${n(body.outerAu, 2)} AU    center: ${n(body.semiMajorAu, 2)} AU`);
  }
  if (body.massEarth != null) out.push(`  mass: ${n(body.massEarth, 5)} M⊕`);
  if (body.largestBodyKm != null) out.push(`  largestBody: ${n(body.largestBodyKm, 0)} km`);
  if (body.shepherdBodyIdx != null) {
    const sh = bodies[body.shepherdBodyIdx];
    out.push(`  shepherd: ${sh.id} (${sh.worldClass || sh.kind})`);
  } else {
    out.push(`  shepherd: — (free-float)`);
  }
  const res = resourcesLine(body);
  if (res) out.push(`  resources: ${res}    icyness: ${icyness(body).toFixed(2)}`);
}

if (body.kind === 'ring') {
  if (body.innerPlanetRadii != null || body.outerPlanetRadii != null) {
    out.push(`  extent: ${n(body.innerPlanetRadii, 2)}–${n(body.outerPlanetRadii, 2)} R_p`);
  }
  const res = resourcesLine(body);
  if (res) out.push(`  resources: ${res}    icyness: ${icyness(body).toFixed(2)}`);
}

process.stdout.write(out.join('\n') + '\n');
