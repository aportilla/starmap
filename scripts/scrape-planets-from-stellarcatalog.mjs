#!/usr/bin/env node
//
// Bootstrap src/data/bodies.csv from cached stellarcatalog.com star pages.
//
// Every cached `.cache/stellarcatalog/stars-<slug>.html` whose slug matches
// an id in our star CSVs is scanned for its "system structure" table. Each
// <a href='exoplanet.php?planetID=…'> row inside that table becomes one
// planet row. Per-planet detail pages are NOT fetched — the inline block
// already carries semi-major axis, mass (M⊕), radius (R⊕), and period
// (days), which is everything Helio's v1 needs from observation. Discovery
// year, atmosphere composition, equilibrium temperature etc. live on the
// per-planet page and stay deferred to procgen.
//
// Read-only: the script never re-fetches; cache misses are skipped with a
// warning. Run scripts/fill-from-stellarcatalog.mjs first if the cache is
// thin.
//
// Source-of-truth policy: the catalog is canonical for the fields it
// provides; this script's --apply rewrites bodies.csv from scratch. Once
// hand-curated rows land (Sol's moons, procgen output), the merge story
// gets revisited — for the bootstrap pass there's nothing to preserve.
//
// Usage:
//   node scripts/scrape-planets-from-stellarcatalog.mjs            # dry-run
//   node scripts/scrape-planets-from-stellarcatalog.mjs --apply
//   node scripts/scrape-planets-from-stellarcatalog.mjs --force    # overwrite existing bodies.csv

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv, normalize } from './lib/catalog-index.mjs';

const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] ?? '1';
}
const APPLY = 'apply' in argv;
const FORCE = 'force' in argv;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const CACHE_DIR = resolve(REPO_ROOT, '.cache/stellarcatalog');
const OUT_PATH = resolve(DATA_DIR, 'bodies.csv');

// =============================================================================
// Schema — every column Helio's v1 cares about. Most stay empty on a
// catalog-sourced row; procgen and hand-curation fill them later.
// =============================================================================

const HEADER = [
  'id', 'host_id', 'kind', 'formal_name', 'name', 'source',
  'semi_major_au', 'eccentricity', 'inclination_deg', 'period_days',
  'orbital_phase_deg', 'rotation_period_hours', 'axial_tilt_deg',
  'mass_earth', 'radius_earth',
  'world_class', 'avg_surface_temp_k', 'surface_temp_min_k', 'surface_temp_max_k',
  'water_fraction', 'ice_fraction', 'surface_age',
  'magnetic_field_gauss', 'tectonic_activity',
  'surface_pressure_bar', 'atm1', 'atm1_frac', 'atm2', 'atm2_frac', 'atm3', 'atm3_frac',
  'res_metals', 'res_silicates', 'res_volatiles', 'res_rare_earths', 'res_radioactives', 'res_exotics',
  'biosphere_archetype', 'biosphere_tier',
];
const COL = Object.fromEntries(HEADER.map((c, i) => [c, i]));
const emptyRow = () => Array(HEADER.length).fill('');

// =============================================================================
// Star index — the universe of valid host_ids. Built from the union of
// every star CSV. We need two lookups:
//   - by id (matches the cache filename slug for filename-derived hosts)
//   - by display name (so "Proxima Centauri b" resolves to alpha-centauri-c
//     even though the planet's slug-stem is `proxima-centauri`).
// =============================================================================

function loadStarIndex() {
  const ids = new Set();
  const byName = new Map();
  for (const f of readdirSync(DATA_DIR)) {
    if (!f.endsWith('.csv') || f === 'bodies.csv') continue;
    const rows = parseCsv(readFileSync(resolve(DATA_DIR, f), 'utf8'));
    const header = rows.shift();
    if (!header) continue;
    const idCol = header.indexOf('id');
    const nameCol = header.indexOf('name');
    if (idCol < 0) continue;
    for (const row of rows) {
      if (!row.length || (row.length === 1 && !row[0])) continue;
      const id = (row[idCol] ?? '').trim();
      if (!id) continue;
      ids.add(id);
      if (nameCol >= 0) {
        const name = (row[nameCol] ?? '').trim();
        if (name) byName.set(normalize(name), id);
      }
    }
  }
  return { ids, byName };
}

// =============================================================================
// Per-page parser
// =============================================================================

// Slug → planet id. Reuses stellarcatalog's component-letter convention
// (TRAPPIST-1 e → trappist-1-e) so ids line up with their host_id stem.
function planetSlugFromName(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Cell values are wrapped as `<span class='value'>X</span> UNIT`. Unit
// identifies which CSV column the value belongs to; positional parsing
// breaks on rows that omit radius (e.g. Gliese 581 b/c/g leave R⊕ blank).
const AU_RE      = /<span class='value'>([^<]+)<\/span>\s*AU\b/;
const MASS_RE    = /<span class='value'>([^<]+)<\/span>\s*M<span[^>]*>&oplus;/;
const RADIUS_RE  = /<span class='value'>([^<]+)<\/span>\s*R<span[^>]*>&oplus;/;
const PERIOD_RE  = /<span class='value'>([^<]+)<\/span>\s*days\b/;
// One row per planet inside the system-structure table. The <a href=
// exoplanet.php> link is the gate — the table also carries a header row for
// the star itself (linked as stars/…) which we skip.
const ROW_RE     = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const PLANET_RE  = /<a href='exoplanet\.php\?planetID=(\d+)'>([^<]+)<\/a>/;

// Discriminator for planets vs debris disks/belts. Disks share the
// exoplanet.php link convention but carry a belt icon instead of the
// exoplanet_icon div. Vega's inner/outer disks and the 10 Tauri belt are
// the cases this filters out.
const PLANET_ICON_RE = /class='exoplanet_icon'/;

// Resolve the actual host star for a planet from its formal name. The cache
// filename can lie — Alpha Centauri A's page lists Proxima's planets,
// 55 Cancri A's page lists 55 Cancri B's planets, and so on. The IAU
// convention is `<Star designation> <component?><planet letter>` or
// `<Star designation> <ProperName>`, so we peel from the right.
//
// Returns null when no candidate matches a known star id; caller falls
// back to the filename-derived host so we still emit a row.
function resolveHostFromName(formalName, starIndex) {
  const tryAll = (cands) => cands.find(c => c && starIndex.ids.has(c)) ?? null;
  const slug = planetSlugFromName;

  // Slug-derived candidates win over display-name lookup because slugs are
  // unique by construction; display names aren't (the CSV carries duplicate
  // "Gliese 49" entries — last-write-wins on byName would route the planet
  // to the wrong star).

  // Tier 1: "<Star> <UpperLower>" — component letter + planet letter
  // (e.g. "55 Cancri Bb" → component B). Most specific; check first so it
  // wins over Tier 2's looser "trailing single letter" rule.
  let m = /^(.*?)\s+([A-Z])([a-z])$/.exec(formalName);
  if (m) {
    const stem = m[1].trim();
    const comp = m[2].toLowerCase();
    const hit = tryAll([
      `${slug(stem)}-${comp}`,
      starIndex.byName.get(normalize(`${stem} ${m[2]}`)),
    ]);
    if (hit) return hit;
  }

  // Tier 2: "<Star> <lowercase letter>" — bare planet letter, e.g.
  // "TRAPPIST-1 e", "Proxima Centauri b".
  m = /^(.*?)\s+([a-z])$/.exec(formalName);
  if (m) {
    const stem = m[1].trim();
    const hit = tryAll([
      slug(stem),
      `${slug(stem)}-a`,
      starIndex.byName.get(normalize(stem)),
    ]);
    if (hit) return hit;
  }

  // Tier 3: "<Star> <ProperName>" — IAU-given proper names like
  // "Fomalhaut Dagon". Strip the last word; what remains is the host's
  // designation.
  m = /^(.*?)\s+([A-Za-z][A-Za-z0-9]*)$/.exec(formalName);
  if (m) {
    const stem = m[1].trim();
    const hit = tryAll([
      slug(stem),
      `${slug(stem)}-a`,
      starIndex.byName.get(normalize(stem)),
    ]);
    if (hit) return hit;
  }

  return null;
}

function parsePlanetRows(html, filenameHost, starIndex, unresolved) {
  const tableStart = html.search(/<table[^>]*class='starlist2'/);
  if (tableStart < 0) return [];
  const tableEnd = html.indexOf('</table>', tableStart);
  if (tableEnd < 0) return [];
  const block = html.slice(tableStart, tableEnd);
  const out = [];
  for (let m; (m = ROW_RE.exec(block)); ) {
    const inner = m[1];
    const planet = PLANET_RE.exec(inner);
    if (!planet) continue;
    // Drop debris disks: they share the exoplanet.php link convention but
    // use ico_belt.webp instead of the exoplanet_icon div. Both Vega disks
    // and the 10 Tauri belt fall out here.
    if (!PLANET_ICON_RE.test(inner)) continue;
    const formalName = planet[2].trim();
    const resolvedHost = resolveHostFromName(formalName, starIndex);
    if (!resolvedHost) unresolved.push(`${formalName} (on page ${filenameHost})`);
    const host = resolvedHost ?? filenameHost;
    const semi = AU_RE.exec(inner);
    const mass = MASS_RE.exec(inner);
    const radius = RADIUS_RE.exec(inner);
    const period = PERIOD_RE.exec(inner);
    const row = emptyRow();
    row[COL.id] = planetSlugFromName(formalName);
    row[COL.host_id] = host;
    row[COL.kind] = 'planet';
    row[COL.formal_name] = formalName;
    row[COL.name] = formalName;
    row[COL.source] = 'catalog';
    if (semi)   row[COL.semi_major_au] = semi[1].trim();
    if (mass)   row[COL.mass_earth]    = mass[1].trim();
    if (radius) row[COL.radius_earth]  = radius[1].trim();
    if (period) row[COL.period_days]   = period[1].trim();
    out.push(row);
  }
  return out;
}

// =============================================================================
// Walk the cache, build the table.
// =============================================================================

function main() {
  if (existsSync(OUT_PATH) && APPLY && !FORCE) {
    console.error(`refusing to overwrite ${OUT_PATH} — pass --force to allow`);
    process.exit(1);
  }
  const starIndex = loadStarIndex();
  const files = readdirSync(CACHE_DIR).filter(f => f.startsWith('stars-') && f.endsWith('.html'));
  let pagesWithPlanets = 0;
  let pagesSkippedNotInCatalog = 0;
  const rows = [];
  const unresolved = [];
  for (const f of files) {
    const slug = f.replace(/^stars-/, '').replace(/\.html$/, '');
    if (!starIndex.ids.has(slug)) {
      pagesSkippedNotInCatalog++;
      continue;
    }
    const html = readFileSync(resolve(CACHE_DIR, f), 'utf8');
    const planets = parsePlanetRows(html, slug, starIndex, unresolved);
    if (planets.length === 0) continue;
    pagesWithPlanets++;
    for (const p of planets) rows.push(p);
    if (!APPLY) {
      for (const p of planets) {
        const fromTag = p[COL.host_id] === slug ? '' : ` [page=${slug}]`;
        const summary = [
          p[COL.id].padEnd(28),
          `→ ${p[COL.host_id]}`.padEnd(28),
          `${p[COL.semi_major_au] || '?'} AU`.padStart(12),
          `${p[COL.mass_earth] || '?'} M⊕`.padStart(10),
          `${p[COL.radius_earth] || '?'} R⊕`.padStart(10),
          `${p[COL.period_days] || '?'} d`.padStart(10),
        ].join(' ') + fromTag;
        console.log(summary);
      }
    }
  }

  // Stable sort: host, then by orbital distance ascending (planets we have
  // no semi-major axis for sink to the end of their host's block).
  rows.sort((a, b) => {
    if (a[COL.host_id] !== b[COL.host_id]) return a[COL.host_id] < b[COL.host_id] ? -1 : 1;
    const aa = Number(a[COL.semi_major_au]);
    const bb = Number(b[COL.semi_major_au]);
    const aOk = Number.isFinite(aa), bOk = Number.isFinite(bb);
    if (aOk && bOk) return aa - bb;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });

  if (APPLY) {
    const out = serializeCsv([HEADER, ...rows]);
    writeFileSync(OUT_PATH, out);
    console.log(`wrote ${rows.length} planets across ${pagesWithPlanets} systems → ${OUT_PATH}`);
  } else {
    console.log('');
    console.log(`${rows.length} planets parsed from ${pagesWithPlanets} systems`);
    console.log(`${pagesSkippedNotInCatalog} cached pages skipped (host not in src/data/*.csv)`);
    console.log(`(dry run — pass --apply to write ${OUT_PATH})`);
  }
  if (unresolved.length) {
    console.log('');
    console.log(`${unresolved.length} planets whose host could not be resolved by name (using page filename as host):`);
    for (const s of unresolved) console.log(`  ${s}`);
  }
}

main();
