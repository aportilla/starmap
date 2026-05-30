# scripts/ — star catalog tooling

Scripts for seeding, repairing, and extending the per-bracket CSVs in `src/data/`, plus the procgen pipeline that builds `src/data/catalog.generated.json`. ESM scripts run with `node scripts/<name>.mjs`. The build pipeline (`build-catalog.mjs`) and validation helpers (`check.mjs`, `audit-procgen.mjs`, `inspect-body.mjs`, `inspect-csv.mjs`) have npm aliases — everything else is invoked directly.

## Source-of-truth policy

The CSVs in `src/data/` are **canonical**. Hand-edits are welcome and survive script runs.

- The Wikipedia scraper refuses to overwrite an existing CSV without `--force=1`.
- The stellarcatalog filler **only fills empty cells** — it never overwrites a populated one.
- When upstream Wikipedia data is wrong or incomplete, fix it in the CSV by hand. The CSV wins.

If a CSV gets corrupted (e.g. by a scraper bug), the recovery path is to clear the affected fields, then re-run the filler — stellarcatalog acts as the canonical remote source for re-establishing broken records.

## Scripts at a glance

| Script | Purpose |
|---|---|
| `scrape-wiki-stars.mjs` | Initial-seed a CSV from a Wikipedia "List of star systems within X-Y light-years" table. |
| `find-missing-stars.mjs` | Compare a CSV against the local stellarcatalog listing; report (or `--add`) stars present in the catalog but absent from the CSV. |
| `fill-from-stellarcatalog.mjs` | For rows missing some field, fetch the star's stellarcatalog detail page and fill empty cells. Cached on disk. |
| `sync-with-catalog.mjs` | Sweep all CSVs against the catalog: assign each row a stable `id` (catalog slug) and rewrite `name` to the catalog's primary, with component-letter preservation and a hardcoded skip-list for known regressions. Default dry-run; `--apply` to write. |
| `expand-systems-from-catalog.mjs` | For every row whose `id` is a catalog primary slug ending in `-a`, fetch the primary's detail page, parse `<h2 class='title'>` blocks for sibling components, and (a) update existing sibling rows' ids to the canonical convention or (b) add missing sibling rows with the catalog-derived spectral class + mass + the primary's RA/Dec. Default dry-run; `--apply` to write. **Largely superseded by `import-system-from-catalog.mjs`** for new system additions; kept for incremental id-suffix migrations on existing data. |
| `import-system-from-catalog.mjs` | Take a primary catalog slug and rewrite all CSV rows for that system from the catalog's detail page. The catalog is the source of truth for everything: per-component display names, spectral_class, mass, V magnitudes from each `<h2 class='title'>` section; position fields (distance/RA/Dec/parallax) from the primary's section, inherited by all siblings (so the renderer's `expandCoincidentSets` rings them as one cluster). Hand-curated names (Toliman, Guniibuu) and existing field values are preserved when the catalog is silent or wrong. Default dry-run; `--apply` to write. |
| `audit-unresolved.mjs` | Read-only report. Categorize every row whose id isn't a literal catalog slug as OVERLAP / NEAR / DISTINCT based on 3D distance to the nearest catalog-matched row. Useful for spotting truly orphaned rows after sync + expand. |
| `lookup-star.mjs` | Resolve a star name (or distance range) to a stellarcatalog URL. Useful for ad-hoc poking. |
| `scrape-planets-from-stellarcatalog.mjs` | Read-only walk over the cached star detail pages; write `src/data/bodies.csv` with one row per exoplanet listed in each system-structure table (semi-major axis, mass M⊕, radius R⊕, period days). Resolves the host star from the planet's catalog name (so Proxima's planets land on `alpha-centauri-c`, not on Alpha Cen A's page slug). Default dry-run; `--apply` to write, `--force` to overwrite. |
| `lib/catalog-index.mjs` | Shared helpers: catalog HTML parsing, name normalization + variant generation, per-component section parsing for detail pages, CSV (de)serialization. Imported by the other scripts. |
| `lib/prng.mjs` | Shared seeded-RNG primitives: FNV-1a `hash32`, `mulberry32`, Box-Muller `sampleNormal`, truncated-normal `sampleTruncated`. Lifted into one module so the procgen Architect and Filler derive identical seeds from the same id strings and sample from the same distributions. |
| `lib/astrophysics.mjs` | Shared physical-relation approximations (`luminositySun(M)`, `insolation(M, a)`) used by both the procgen Architect and Filler. Piecewise mass-luminosity (M dwarfs vs FGK+). |
| `lib/procgen-priors.mjs` | Data file — the entire tuning surface for body procgen. Per-class planet counts, orbital geometry, insolation-zone weights, type multipliers, mass/radius specs, moon counts, belt occurrence + placement, ring occurrence + extent, and the layered resource model (occurrence weights, star-type bias, scarcity tiers, pair affinity, motherlode + hostility shaping, deposit count, belt/ring differentiation). No code, just exports. Edit + re-run `npm run build:catalog`. |
| `lib/procgen-architect.mjs` | System Architect — top-down procgen. For each star with zero catalog planets, samples a full planetary system (planets + moons + rings + belts) from the priors. Also exports `generateOverlay` (partial-system overlay — adds outer procgen siblings + system belts to catalog-anchored stars) and `generateMoons` / `generateRing` (per-planet backfill on catalog rows). |
| `audit-procgen.mjs` | Procgen distribution report **+ hard-gate invariants**. Reports observed planet count per stellar class, planet-type mix, ring rates by host type, moon counts by type, belt rates by stellar class, and the resource-model distributions (presence/tier, pair coverage, abundance + hostility, per-class lean, deposit count) — each with a z-score against its prior. Ends with structural invariants (`B`-series render/procgen defects, `R`-series resource-scheme guarantees) that **exit 1** on violation, so a bad prior tweak fails the build. Run after `npm run build:catalog`. Alias: `npm run audit:procgen`. |
| `check.mjs` | Validation umbrella for the iterative edit loop. Runs `build:catalog` → `tsc --noEmit` → `audit-procgen` in sequence and fails fast on the first non-zero exit. Catches schema regressions, type errors, and out-of-envelope distribution shifts in one command. Alias: `npm run check`. |
| `inspect-body.mjs` | Pretty-print one body's post-procgen record from `catalog.generated.json` — host, orbital geometry, worldClass / extent, atmosphere, biosphere, resources, derived icyness (belts + rings), moons + ring (planets). Suggests near-matches on typo. Alias: `npm run inspect:body <id>` (e.g. `inspect:body saturn-ring`). |
| `inspect-csv.mjs` | Pretty-print one row from a CSV (`bodies.csv` by default; `--csv=<path>` overrides) with column names spelled out and the three CSV-side cell states distinguished — literal value, `(n/a)` (does-not-apply), `(empty — procgen)` (Filler target). Useful when authoring curated rows or verifying column alignment after a schema tweak. Alias: `npm run inspect:csv <id>`. |
| `lib/procgen.mjs` | Body Filler — bottom-up procgen. Walks empty cells in topological order: `radiusEarth` from a mass-radius relation, then the `worldClass` cascade (`avgSurfaceTempK`, `surfacePressureBar`), then `periodDays ↔ semiMajorAu` via Kepler's third law (bidirectional, so RV and transit discoveries both round-trip), then orbital flavor (eccentricity / inclination / axial tilt / orbital phase). Exports `radiusFromMass`, `worldClassFor`, `planetTypeFor` for the moon-and-ring backfill pass to reuse. Imported by `build-catalog.mjs`. Belts and rings bypass the Filler — their structural fields are baked at architect time, not derived from physics. |

The local stellarcatalog listing defaults to `~/Documents/catalog.html` (override with `--catalog=PATH` on any script that uses it). The cache for fetched detail pages lives at `.cache/stellarcatalog/` (gitignored).

## Validation workflow

After editing priors, the architect, the Filler, the runtime body schema, or `bodies.csv`:

```bash
npm run check               # build:catalog + tsc --noEmit + audit-procgen
```

That's the universal "did I break anything" sweep. The audit step prints z-scores per (prior × observed) cell — anomalies are marked `*` when statistically significant, so an out-of-envelope distribution surfaces above sample noise.

When validating that a *specific* body landed the right values:

```bash
npm run inspect:body saturn-ring       # post-procgen record from catalog.generated.json
npm run inspect:csv  saturn-ring       # raw CSV row (literal / n/a / empty distinguished)
```

`inspect:body` reads the snapshot the runtime ships, so what's printed is what the renderer + info card see. `inspect:csv` reads the authoring source — use it to confirm column alignment after a schema tweak or to verify that a curated row hasn't drifted into stale enum values that the validator would reject.

## Common workflows

### Bootstrap a new distance bracket from the catalog

Best when the bracket is far enough out that Wikipedia's table is sparser than stellarcatalog's coverage (true from ~30 ly outward).

```bash
# 1. Empty CSV with the canonical header
echo "id,name,distance_ly,constellation,ra_deg,dec_deg,spectral_class,mass_msun,app_mag,abs_mag,parallax_mas" \
  > src/data/stars-40-45ly.csv

# 2. Append every catalog star in [40, 45] ly (range inferred from filename;
#    populates the id column from the catalog slug)
node scripts/find-missing-stars.mjs --csv=src/data/stars-40-45ly.csv --add

# 3. Fetch each detail page and fill RA/Dec, mass, magnitudes, etc.
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-40-45ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries the bootstrap added
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Wire into src/data/stars.ts:
#    - add `import fortyFortyFiveCsv from './stars-40-45ly.csv?raw';`
#    - add `{ text: fortyFortyFiveCsv, label: 'stars-40-45ly.csv' }` to the sources array

# 6. Update README's project layout to mention the new file
```

### Bootstrap a new distance bracket from Wikipedia (closer brackets)

The 0-30 ly Wikipedia tables are well-curated and worth using as the seed. Two known table layouts are baked into the scraper as `--schema` profiles.

```bash
# 1. Scrape the upstream Wikipedia table
node scripts/scrape-wiki-stars.mjs \
  --page='List_of_star_systems_within_15–20_light-years' \
  --schema=20-25 \
  --out=src/data/stars-15-20ly.csv

# 2. Fill anything Wikipedia left blank
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 3. Sweep up catalog stars Wikipedia missed entirely
node scripts/find-missing-stars.mjs --csv=src/data/stars-15-20ly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-15-20ly.csv --needs=any

# 4. Pull in sibling rows for any multi-star primaries
node scripts/expand-systems-from-catalog.mjs --apply

# 5. Wire into stars.ts as above
```

The two known schemas are `--schema=nearest` (11-col, used by "List of nearest stars") and `--schema=20-25` (9-col, used by every "List of star systems within X-Y light-years" page). If a future Wikipedia page uses yet another column layout, add a profile to the `SCHEMAS` dict in `scrape-wiki-stars.mjs`.

### Find what's missing

```bash
# How many catalog stars in a CSV's distance bracket aren't in any of our CSVs?
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv

# Override the auto-detected range
node scripts/find-missing-stars.mjs --csv=src/data/stars-25-30ly.csv --range=20,30
```

The matcher checks against names from **all** CSVs in `src/data/` (not just the targeted one), because catalog distances are rounded to 1 decimal and a star at 25.045 ly shows up as "25" — without cross-CSV matching every boundary star false-positives.

### Fill missing fields on rows we already have

```bash
# Default: rows missing RA/Dec
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv

# Other targeting
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=mass
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-30-35ly.csv --needs=any

# Faster throttle (default is 500ms between fresh fetches; cache hits are free)
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --throttle=200

# See what would change without writing
node scripts/fill-from-stellarcatalog.mjs --csv=PATH --needs=any --dry-run
```

`--needs` accepts `radec`, `mass`, `class`, `app_mag`, `parallax`, `any`. In every mode the script fills *all* empty fillable cells once a page is fetched — `--needs=mass` will incidentally fill any missing RA/Dec on the same row. The flag controls only which rows trigger a lookup.

### Sync names + ids with the catalog

After any bracket changes (new bootstrap, hand-edits, reseeded data), run sync to canonicalize ids and align display names with the catalog's primary names.

```bash
# Dry-run across all CSVs in src/data/
node scripts/sync-with-catalog.mjs

# Apply
node scripts/sync-with-catalog.mjs --apply
```

The script:
- Adds the `id` column if missing (schema migration).
- Sets each row's id to the catalog slug (e.g. `fomalhaut-a`, `gliese-1`), with sibling components getting `<primary-stem>-<letter>` (e.g. `sirius-b`).
- Rewrites `name` to the catalog primary, preserving component letter when ours has one and the catalog primary doesn't.
- Honors a hardcoded `SKIP_RENAMES` set for known regressions (Barnard's Star, Luyten's Star, Keid, Achird, Alsafi, Guniibuu, Rigil Kentaurus, etc.) — these still get ids, just keep their display names. Add to that set in the script when a new regression is found.

### Expand multi-star systems

For each row whose `id` is a catalog primary slug, fetches the primary's detail page and uses the `<h2 class='title'>` sections as the source of truth for what siblings exist. Either updates an existing CSV row's id to the canonical convention, or appends a new sibling row populated with the catalog-derived spectral class + mass + the primary's RA/Dec.

```bash
node scripts/expand-systems-from-catalog.mjs            # dry-run
node scripts/expand-systems-from-catalog.mjs --apply
```

Run after sync, and any time you add new primaries to a CSV. The script handles three matching paths in priority order: (1) canonical id match, (2) name-variant overlap with letter-suffix equality, (3) RA/Dec proximity to the primary with letter-suffix equality. A small `KNOWN_COMPONENT_ALIASES` map covers IAU proper names like Toliman that don't carry a component letter at all.

### Audit unresolved rows

Read-only sanity check after sync + expand:

```bash
node scripts/audit-unresolved.mjs
```

Buckets every row whose id isn't a literal catalog slug into OVERLAP (within 0.05 ly of a catalog row — usually a constructed sibling id), NEAR (within 0.5 ly), or DISTINCT (further). DISTINCT is the watchlist: those rows have no nearby catalog primary at all, meaning the catalog genuinely lacks the entry.

### Repair a corrupted CSV

When a scraper bug or upstream edit produces wrong data:

```bash
# 1. Fix the underlying scraper bug if it was one
# 2. Re-scrape (the scraper refuses to overwrite without --force)
node scripts/scrape-wiki-stars.mjs --page=... --schema=... --out=src/data/stars-NN-MMly.csv --force=1

# 3. Re-run the catalog filler to repopulate (cache makes this instant)
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any

# 4. Optionally re-add stars Wikipedia missed
node scripts/find-missing-stars.mjs --csv=src/data/stars-NN-MMly.csv --add
node scripts/fill-from-stellarcatalog.mjs --csv=src/data/stars-NN-MMly.csv --needs=any
```

For partial repair (a few corrupt rows in an otherwise good CSV), hand-clear the bad cells and run `fill-from-stellarcatalog.mjs --needs=any` — only the empty cells get refilled.

When the corruption is upstream (the catalog has two slugs for the same physical star and one of them has wrong RA/Dec/distance — see `wise-2220-3628` vs `wise-j22205531-3628174` for the canonical example), add an entry to `STALE_SLUG_REDIRECTS` in `lib/catalog-index.mjs`. `loadCatalog` then drops the stale entry from the returned list and folds its primary + aliases into the canonical's alias list, so subsequent runs of every script land on the good entry.

### Ad-hoc lookups

```bash
# What's the catalog URL for these stars?
node scripts/lookup-star.mjs "Barnard's Star" "Rigil Kentaurus" "GJ 1227"

# Every catalog entry between 6 and 8 ly
node scripts/lookup-star.mjs --range=6,8

# Diff: which rows in a CSV are missing some field?
node scripts/lookup-star.mjs --csv=src/data/stars-25-30ly.csv --missing=class
```

### Bootstrap planet data

Separate data axis from the star CSVs: `src/data/bodies.csv` holds one row per planet (and later, per moon) with `host_id` joining back to a star id. The cached stellarcatalog star pages already carry a system-structure table with semi-major axis, mass (M⊕), radius (R⊕), and period (days), so the bootstrap doesn't fetch anything — it reads the cache.

```bash
# Dry-run: print every parsed planet with its resolved host and stats
node scripts/scrape-planets-from-stellarcatalog.mjs

# Write src/data/bodies.csv (refuses to overwrite without --force)
node scripts/scrape-planets-from-stellarcatalog.mjs --apply --force
```

Disks and belts are filtered out (they share the `exoplanet.php` link but use a different icon). Hosts are resolved from the planet's catalog name, not the cache filename, so a planet listed under Alpha Centauri A's page that actually orbits Proxima lands on `alpha-centauri-c`. Slug-derived candidates win over display-name lookup because the CSV carries duplicate display names ("Gliese 49" appears as the name of two different stars) but ids are unique.

Hand-curated rows (Sol's planets and moons, plus any further hand-additions) live in `bodies.csv` alongside the scraper output. **Re-running the scraper overwrites the whole file** — a merge story doesn't exist yet, so don't re-run --apply if you've hand-edited rows since the last scrape. Recovery is `git checkout` on the file. Procgen runs downstream (inside `build-catalog.mjs`, against the parsed CSV — not against `bodies.csv` directly) so it never touches the authoring surface; see `lib/procgen-priors.mjs` for the tuning knobs.

## Notes

- **Cache**: `fill-from-stellarcatalog.mjs` writes each fetched HTML page to `.cache/stellarcatalog/<slug>.html`. Subsequent runs against the same star are instant. Delete the cache to force re-fetch.
- **Throttle**: defaults to 500ms between live fetches. Cache hits don't sleep. Lower for impatience, raise to be polite to stellarcatalog.com.
- **Name matching**: the shared library generates name variants (case + diacritics + GJ↔Gliese ↔ Greek-letter spellings + possessive forms + trailing-component-letter). When a lookup fails, the matcher's variant set is the first place to look — see `variants()` in `lib/catalog-index.mjs`.
- **Catalog file**: defaults to `~/Documents/catalog.html` (a saved copy of stellarcatalog.com's "all stars" listing). All scripts that read it accept `--catalog=PATH`.
