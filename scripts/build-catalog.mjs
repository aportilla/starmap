#!/usr/bin/env node
// Reads the catalog CSVs in src/data/, runs the full derivation pipeline
// (normalize spectral class → derive mass via M-L chain or jitter → derive
// radius and pxSize → place coincident-set members hierarchically → build
// clusters with COMs), and writes the result to src/data/catalog.generated.json.
//
// The runtime stars.ts imports the JSON; nothing in the bundle depends on
// the CSVs or this pipeline. Re-run (via prebuild/predev/pretypecheck or
// `npm run build:catalog`) whenever a CSV changes.
//
// Mirrors the algorithm that used to live in src/data/stars.ts. KDTree
// pair scans are replaced with brute-force O(n²) here — build-time, not
// per-frame, and ~1500 stars at ~2M ops still completes in milliseconds.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash32, mulberry32 } from './lib/prng.mjs';
import { fillBodies, radiusFromMass } from './lib/procgen.mjs';
import { generateSystem, generateMoons, generateRing, generateOverlay, starDiskContext, synthesizePartialAnchor, generateFloorBelt } from './lib/procgen-architect.mjs';
import { MAX_PLANETS_PER_CLUSTER, SNOW_LINE_TEMPERATURES, CURATED_SYSTEM_HOSTS } from './lib/procgen-priors.mjs';
import { frostLineAU } from './lib/astrophysics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(REPO_ROOT, 'src/data');
const OUT_PATH = resolve(DATA_DIR, 'catalog.generated.json');

const SOURCES = [
  'nearest-stars.csv',
  'stars-20-25ly.csv',
  'stars-25-30ly.csv',
  'stars-30-35ly.csv',
  'stars-35-40ly.csv',
  'stars-40-45ly.csv',
  'stars-45-50ly.csv',
];

// =============================================================================
// Coordinate + class + mass + radius helpers (ported from stars.ts)
// =============================================================================

const ICRS_TO_GAL = [
  [-0.054875539726, -0.873437108010, -0.483834985808],
  [+0.494109453312, -0.444829589425, +0.746982251810],
  [-0.867666135858, -0.198076386122, +0.455983795705],
];

function equatorialToGalactic(raDeg, decDeg, distLy) {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const cosDec = Math.cos(dec);
  const xe = cosDec * Math.cos(ra);
  const ye = cosDec * Math.sin(ra);
  const ze = Math.sin(dec);
  const M = ICRS_TO_GAL;
  return {
    x: distLy * (M[0][0] * xe + M[0][1] * ye + M[0][2] * ze),
    y: distLy * (M[1][0] * xe + M[1][1] * ye + M[1][2] * ze),
    z: distLy * (M[2][0] * xe + M[2][1] * ye + M[2][2] * ze),
  };
}

function normalizeSpectralClass(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^D[A-Z]/.test(trimmed)) return 'WD';
  const m = /[OBAFGKMLTY]/.exec(trimmed);
  if (!m) return null;
  const c = m[0];
  if (c === 'L' || c === 'T' || c === 'Y') return 'BD';
  return c;
}

const CLASS_MASS_RANGE = {
  O:  [16,    90],
  B:  [ 2.1,  16],
  A:  [ 1.4,   2.1],
  F:  [ 1.04,  1.4],
  G:  [ 0.80,  1.04],
  K:  [ 0.45,  0.80],
  M:  [ 0.08,  0.45],
  WD: [ 0.50,  1.00],
  BD: [ 0.013, 0.075],
};

function syntheticMass(cls, x, y, z) {
  const [lo, hi] = CLASS_MASS_RANGE[cls];
  const seed = hash32(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`);
  const t = mulberry32(seed)();
  return Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
}

function radiusFromClassMass(cls, mass) {
  if (cls === 'BD') return 0.10;
  if (cls === 'WD') return 0.012 * Math.pow(mass / 0.6, -1 / 3);
  return Math.pow(mass, 0.8);
}

// Stellar age priors keyed on spectral class. Mean / SD in gigayears,
// plus a hard cap roughly equal to 40% of the class's main-sequence
// lifetime so an O-class star can't end up at 10 Gyr (it would have
// exploded long ago). The thin galactic disc is ~10 Gyr old so any age
// also clamps to 13.8 (universe age). Calibrated against published
// age-class distributions: Sol's 4.6 Gyr lands solidly in the G-class
// mode, M-dwarfs skew old (long-lived population), O/B young.
//
// MS lifetime cap source: t_MS ≈ 10 Gyr × (M/M☉)^(-2.5). For O-class
// mean mass ~30 M☉ → ~2 Myr; for B ~9 M☉ → ~40 Myr; for A ~2 M☉ →
// ~1.8 Gyr; G ~1 M☉ → 10 Gyr; M ~0.3 M☉ → ~200 Gyr (capped at universe).
const AGE_BY_CLASS = {
  O:  { mean: 0.02,  sd: 0.015, maxMS: 0.005 },
  B:  { mean: 0.15,  sd: 0.10,  maxMS: 0.06  },
  A:  { mean: 0.8,   sd: 0.5,   maxMS: 2.0   },
  F:  { mean: 3.0,   sd: 1.5,   maxMS: 5.0   },
  G:  { mean: 5.0,   sd: 2.0,   maxMS: 10.0  },
  K:  { mean: 6.0,   sd: 2.5,   maxMS: 13.8  },
  M:  { mean: 7.0,   sd: 3.0,   maxMS: 13.8  },
  WD: { mean: 4.0,   sd: 2.0,   maxMS: 13.8  },
  BD: { mean: 6.0,   sd: 3.0,   maxMS: 13.8  },
};
const AGE_FLOOR_GYR = 0.001;

// Box-Muller transform — sample from a standard Normal using two
// uniforms. Used by ageFromClass and any other field that wants
// Gaussian noise rather than uniform.
function gaussianSample(rng) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = rng();   // avoid log(0)
  u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Derive a stellar age from class + an id-seeded PRNG. Truncated Gaussian
// clamped to [AGE_FLOOR_GYR, min(13.8, maxMS)]. Catalog age (when set on
// the CSV row) takes priority and skips this function entirely.
function ageFromClass(cls, id) {
  const prior = AGE_BY_CLASS[cls];
  if (!prior) return 5.0; // defensive — shouldn't fire (every class in table)
  const rng = mulberry32(hash32(`age:${id}`));
  // Two-sample average dampens long tails — a Gaussian sample × sd plus
  // mean would land outside the cap too often for short-lived classes.
  const z = (gaussianSample(rng) + gaussianSample(rng)) / 2;
  const ageRaw = prior.mean + z * prior.sd;
  const cap = Math.min(13.8, prior.maxMS);
  return Math.max(AGE_FLOOR_GYR, Math.min(cap, ageRaw));
}

const BC_BY_CLASS = { O: -4.0, B: -1.5, A: -0.3, F: -0.1, G: -0.1, K: -0.8, M: -2.5 };
const ML_ALPHA   = { O:  3.5, B:  3.8, A:  4.0, F:  4.0, G:  4.0, K:  3.0, M: 2.3 };
const PARSEC_PER_LY = 1 / 3.2615637;

function massFromMagnitude(cls, appMagRaw, distLy) {
  const bc = BC_BY_CLASS[cls];
  const alpha = ML_ALPHA[cls];
  if (bc === undefined || alpha === undefined) return null;
  if (/\bJ\b/.test(appMagRaw)) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(appMagRaw.replace(/−/g, '-'));
  if (!m) return null;
  const appMag = Number(m[0]);
  if (!Number.isFinite(appMag) || distLy <= 0) return null;
  const dPc = distLy * PARSEC_PER_LY;
  const absMag = appMag - 5 * (Math.log10(dPc) - 1);
  const bolMag = absMag + bc;
  const lum = Math.pow(10, (4.74 - bolMag) / 2.5);
  const mass = Math.pow(lum, 1 / alpha);
  const [lo, hi] = CLASS_MASS_RANGE[cls];
  if (mass < lo * 0.5 || mass > hi * 2) return null;
  return mass;
}

const PX_MIN = 3;
const PX_MAX = 18;
const SIZE_EXP = 1 / 3;
const A_MIN = Math.pow(0.0084, SIZE_EXP);
const A_MAX = Math.pow(2.048, SIZE_EXP);
const A_RANGE = A_MAX - A_MIN;

function radiusToPxSize(radiusSolar) {
  const a = Math.pow(radiusSolar, SIZE_EXP);
  const t = (a - A_MIN) / A_RANGE;
  const tc = Math.max(0, Math.min(1, t));
  return PX_MIN + tc * (PX_MAX - PX_MIN);
}

// =============================================================================
// CSV parsing
// =============================================================================

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cell += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseCsvCatalog(text, label) {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error(`${label}: empty CSV`);
  const required = (col) => {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`${label}: missing column ${col}`);
    return i;
  };
  const optional = (col) => header.indexOf(col);
  const ID = required('id');
  const NAME = required('name');
  const DIST = required('distance_ly');
  const RA = required('ra_deg');
  const DEC = required('dec_deg');
  const CLASS = required('spectral_class');
  const MASS = optional('mass_msun');
  const APP_MAG = optional('app_mag');
  const IAU_NAME = optional('iau_name');

  const out = [];
  const num = (cell) => {
    const t = (cell ?? '').trim();
    return t ? Number(t) : NaN;
  };
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const name = row[NAME];
    if (!name) continue;
    const distLy = num(row[DIST]);
    const raDeg = num(row[RA]);
    const decDeg = num(row[DEC]);
    if (![distLy, raDeg, decDeg].every(Number.isFinite)) {
      console.warn(`${label}: skipping ${name} (incomplete RA/Dec/distance)`);
      continue;
    }
    const rawClass = (row[CLASS] ?? '').trim();
    const cls = normalizeSpectralClass(rawClass);
    if (cls === null) {
      console.warn(`${label}: skipping ${name} (no spectral class)`);
      continue;
    }
    const pos = equatorialToGalactic(raDeg, decDeg, distLy);
    const massCell = MASS >= 0 ? (row[MASS] ?? '').trim() : '';
    const massRaw = massCell ? Number(massCell) : NaN;
    let mass;
    if (Number.isFinite(massRaw)) {
      mass = massRaw;
    } else {
      const appMagCell = APP_MAG >= 0 ? (row[APP_MAG] ?? '') : '';
      const ml = massFromMagnitude(cls, appMagCell, distLy);
      mass = ml ?? syntheticMass(cls, pos.x, pos.y, pos.z);
    }
    const radiusSolar = radiusFromClassMass(cls, mass);
    const id = (row[ID] ?? '').trim();
    const iauName = IAU_NAME >= 0 ? (row[IAU_NAME] ?? '').trim() : '';
    const ageGyr = ageFromClass(cls, id);
    out.push({
      id, name, iauName, ...pos, cls, rawClass, distLy, mass, radiusSolar,
      pxSize: radiusToPxSize(radiusSolar),
      ageGyr,
    });
  }
  return out;
}

function loadCatalog(sources) {
  const stars = [{
    id: 'sol',
    name: 'Sol',
    iauName: '',
    x: 0, y: 0, z: 0,
    cls: 'G',
    rawClass: 'G2V',
    distLy: 0,
    mass: 1.0,
    radiusSolar: 1.0,
    pxSize: radiusToPxSize(1.0),
    ageGyr: 4.6,   // Sol is the calibration anchor; not derived from the prior.
  }];
  const seen = new Set(['sol']);
  for (const { text, label } of sources) {
    for (const s of parseCsvCatalog(text, label)) {
      if (seen.has(s.id)) {
        console.warn(`${label}: dropping duplicate ${s.id} (${s.name}) (already loaded from earlier source)`);
        continue;
      }
      seen.add(s.id);
      stars.push(s);
    }
  }
  return stars;
}

// =============================================================================
// Hierarchical multi-star layout (ported from stars.ts expandCoincidentSets)
// =============================================================================

const R_OUTER = 0.05;
const R_INNER = 0.015;
const COINCIDENT_EPS_LY = 0.001;

function parseComponentPath(suffix) {
  if (suffix === '') return ['a'];
  if (!/^[a-z]{1,2}$/.test(suffix)) return null;
  return suffix.length === 1 ? [suffix] : [suffix[0], suffix[1]];
}

function longestCommonPrefix(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (let i = 1; i < strs.length && p.length > 0; i++) {
    while (!strs[i].startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

function buildSystemBasis(rng) {
  const theta = rng() * Math.PI * 2;
  const cosPhi = 2 * rng() - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const nx = sinPhi * Math.cos(theta);
  const ny = sinPhi * Math.sin(theta);
  const nz = cosPhi;
  let rx = 1, ry = 0, rz = 0;
  if (Math.abs(nx) > 0.9) { rx = 0; ry = 1; }
  let ux = ry * nz - rz * ny;
  let uy = rz * nx - rx * nz;
  let uz = rx * ny - ry * nx;
  const ulen = Math.hypot(ux, uy, uz);
  ux /= ulen; uy /= ulen; uz /= ulen;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  return { ux, uy, uz, vx, vy, vz };
}

function tryHierarchicalLayout(stars, out, setIndices, cx, cy, cz, rng) {
  const ids = setIndices.map(i => stars[i].id);
  let lcp = longestCommonPrefix(ids);
  if (lcp.endsWith('-')) lcp = lcp.slice(0, -1);

  const parsed = [];
  for (const idx of setIndices) {
    const after = stars[idx].id.slice(lcp.length).replace(/^-/, '');
    const path = parseComponentPath(after);
    if (path === null) return false;
    parsed.push({ idx, path });
  }

  const topByLetter = new Map();
  for (const { idx, path } of parsed) {
    let slot = topByLetter.get(path[0]);
    if (!slot) { slot = { starIdx: null, children: [] }; topByLetter.set(path[0], slot); }
    if (path.length === 1) slot.starIdx = idx;
    else slot.children.push({ letter: path[1], starIdx: idx });
  }

  const basis = buildSystemBasis(rng);
  const startOuter = rng() * Math.PI * 2;
  const topLetters = Array.from(topByLetter.keys()).sort();
  const numTop = topLetters.length;

  for (let k = 0; k < numTop; k++) {
    const slot = topByLetter.get(topLetters[k]);
    const slotR = numTop > 1 ? R_OUTER : 0;
    const angle = startOuter + (k / Math.max(1, numTop)) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ox = cx + (ca * basis.ux + sa * basis.vx) * slotR;
    const oy = cy + (ca * basis.uy + sa * basis.vy) * slotR;
    const oz = cz + (ca * basis.uz + sa * basis.vz) * slotR;

    if (slot.starIdx !== null) {
      out[slot.starIdx] = { ...stars[slot.starIdx], x: ox, y: oy, z: oz };
    }
    if (slot.children.length > 0) {
      slot.children.sort((a, b) => a.letter.localeCompare(b.letter));
      const startInner = rng() * Math.PI * 2;
      const n = slot.children.length;
      for (let j = 0; j < n; j++) {
        const ang = startInner + (j / n) * Math.PI * 2;
        const cc = Math.cos(ang), sc = Math.sin(ang);
        const childIdx = slot.children[j].starIdx;
        out[childIdx] = {
          ...stars[childIdx],
          x: ox + (cc * basis.ux + sc * basis.vx) * R_INNER,
          y: oy + (cc * basis.uy + sc * basis.vy) * R_INNER,
          z: oz + (cc * basis.uz + sc * basis.vz) * R_INNER,
        };
      }
    }
  }
  return true;
}

function evenRingLayout(stars, out, setIndices, cx, cy, cz, rng) {
  const basis = buildSystemBasis(rng);
  const startAngle = rng() * Math.PI * 2;
  const n = setIndices.length;
  setIndices.forEach((idx, k) => {
    const angle = startAngle + (k / n) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    out[idx] = {
      ...stars[idx],
      x: cx + (ca * basis.ux + sa * basis.vx) * R_OUTER,
      y: cy + (ca * basis.uy + sa * basis.vy) * R_OUTER,
      z: cz + (ca * basis.uz + sa * basis.vz) * R_OUTER,
    };
  });
}

// Brute-force replacement for KDTree.pairsWithin used at runtime. Catalog
// is ~1500 stars → ~1.1M ops; sub-millisecond at build time, and avoids
// duplicating kdtree.ts into Node-land.
function pairsWithinBrute(stars, radius, cb) {
  const r2 = radius * radius;
  const n = stars.length;
  for (let i = 0; i < n; i++) {
    const a = stars[i];
    for (let j = i + 1; j < n; j++) {
      const b = stars[j];
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) cb(i, j);
    }
  }
}

function expandCoincidentSets(stars) {
  const out = stars.map(s => ({ ...s }));
  const n = stars.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  pairsWithinBrute(stars, COINCIDENT_EPS_LY, (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  });
  const sets = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = sets.get(r);
    if (!g) { g = []; sets.set(r, g); }
    g.push(i);
  }
  for (const set of sets.values()) {
    if (set.length < 2) continue;
    set.sort((a, b) => stars[b].mass - stars[a].mass);
    const cx = stars[set[0]].x, cy = stars[set[0]].y, cz = stars[set[0]].z;
    const rng = mulberry32(hash32(stars[set[0]].id));
    const placed = tryHierarchicalLayout(stars, out, set, cx, cy, cz, rng);
    if (!placed) evenRingLayout(stars, out, set, cx, cy, cz, rng);
  }
  return out;
}

// =============================================================================
// Cluster detection (ported from stars.ts buildClusters)
// =============================================================================

const CLUSTER_THRESHOLD_LY = 0.25;

function buildClusters(stars) {
  const n = stars.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  pairsWithinBrute(stars, CLUSTER_THRESHOLD_LY, (i, j) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  });
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return Array.from(groups.values()).map(members => {
    const primary = members.reduce(
      (best, m) => {
        const mm = stars[m].mass, mb = stars[best].mass;
        if (mm > mb) return m;
        if (mm < mb) return best;
        return stars[m].pxSize > stars[best].pxSize ? m : best;
      },
      members[0],
    );
    const ordered = [primary, ...members.filter(m => m !== primary)];
    let sumM = 0, sumX = 0, sumY = 0, sumZ = 0;
    for (const m of ordered) {
      const s = stars[m];
      sumM += s.mass;
      sumX += s.mass * s.x;
      sumY += s.mass * s.y;
      sumZ += s.mass * s.z;
    }
    const com = { x: sumX / sumM, y: sumY / sumM, z: sumZ / sumM };
    return { primary, members: ordered, com };
  });
}

// =============================================================================
// Body catalog (planets + moons)
// =============================================================================
//
// bodies.csv is a separate authoring surface from the star CSVs — one row per
// planet OR moon, with `host_id` pointing to either a Star.id (planets) or
// another Body.id (moons). The build script joins them into a tree:
// Star.planets[] holds indices into BODIES of direct orbiters; Body.moons[]
// holds the same for a planet's satellites.
//
// Three cell states from the CSV collapse into two in the runtime JSON:
//   - empty cell → null (placeholder for procgen to fill in a later pass)
//   - 'n/a'      → null (not applicable — gas giants have no water_fraction,
//                        airless bodies have no atmosphere)
//   - value      → typed value
// Once procgen ships, empties become synthesized values at build time. The
// runtime API is uniform `T | null` and consumers don't need to distinguish.

const BODIES_FILE = 'bodies.csv';
const BODY_LAYERS_FILE = 'body_layers.csv';
const WORLD_CLASSES = new Set([
  // Terrestrial
  'rocky', 'solid_giant', 'desert', 'ocean', 'ice', 'carbon',
  'iron', 'lava', 'magma_ocean', 'chthonian',
  // Gaseous
  'gas_dwarf', 'hycean', 'helium', 'ice_giant', 'gas_giant',
]);
const BODY_KINDS = new Set(['planet', 'moon', 'belt', 'ring']);
const BODY_SOURCES = new Set(['catalog', 'procgen']);
// belt_class and population_model are vestigial columns kept in the
// CSV schema so column positions don't shift, but ignored at runtime.
// Composition lives in the six-resource grid; size character emerges
// from the architect's shepherding-conditional largestBodyKm draw.
// See the validators below.

// Columns split by handling: numeric cells get parsed via Number(), value
// cells stay as strings (or null). Both paths fold empty + 'n/a' to null.
const BODY_NUMERIC_FIELDS = [
  ['semi_major_au',          'semiMajorAu'],
  ['formation_au',           'formationAu'],
  ['eccentricity',           'eccentricity'],
  ['inclination_deg',        'inclinationDeg'],
  ['period_days',            'periodDays'],
  ['orbital_phase_deg',      'orbitalPhaseDeg'],
  ['rotation_period_hours',  'rotationPeriodHours'],
  ['axial_tilt_deg',         'axialTiltDeg'],
  ['mass_earth',             'massEarth'],
  ['radius_earth',           'radiusEarth'],
  ['bulk_water_fraction',    'bulkWaterFraction'],
  ['bulk_metal_fraction',    'bulkMetalFraction'],
  ['bulk_volatile_fraction', 'bulkVolatileFraction'],
  ['avg_surface_temp_k',     'avgSurfaceTempK'],
  ['surface_temp_min_k',     'surfaceTempMinK'],
  ['surface_temp_max_k',     'surfaceTempMaxK'],
  ['water_fraction',         'waterFraction'],
  ['ice_fraction',           'iceFraction'],
  ['surface_age',            'surfaceAge'],
  ['magnetic_field_gauss',   'magneticFieldGauss'],
  ['tectonic_activity',      'tectonicActivity'],
  ['surface_pressure_bar',   'surfacePressureBar'],
  ['atm1_frac',              'atm1Frac'],
  ['atm2_frac',              'atm2Frac'],
  ['atm3_frac',              'atm3Frac'],
  ['res_metals',             'resMetals'],
  ['res_silicates',          'resSilicates'],
  ['res_volatiles',          'resVolatiles'],
  ['res_rare_earths',        'resRareEarths'],
  ['res_radioactives',       'resRadioactives'],
  ['res_exotics',            'resExotics'],
  ['biotic_carbon_aqueous',     'bioticCarbonAqueous'],
  ['biotic_subsurface_aqueous', 'bioticSubsurfaceAqueous'],
  ['biotic_aerial',             'bioticAerial'],
  ['biotic_cryogenic',          'bioticCryogenic'],
  ['biotic_silicate',           'bioticSilicate'],
  ['biotic_sulfur',             'bioticSulfur'],
  ['inner_au',               'innerAu'],
  ['outer_au',               'outerAu'],
  ['inner_planet_radii',     'innerPlanetRadii'],
  ['outer_planet_radii',     'outerPlanetRadii'],
  ['largest_body_km',        'largestBodyKm'],
];
const BODY_STRING_FIELDS = [
  ['atm1', 'atm1'],
  ['atm2', 'atm2'],
  ['atm3', 'atm3'],
  ['biosphere_archetype',  'biosphereArchetype'],
  ['biosphere_complexity', 'biosphereComplexity'],
];

function cellOrNull(raw) {
  const t = (raw ?? '').trim();
  return t === '' || t === 'n/a' ? null : t;
}

function parseCsvBodies(text, label) {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error(`${label}: empty CSV`);
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${label}: missing column ${name}`);
    return i;
  };
  const ix = {
    id: colIdx('id'),
    host_id: colIdx('host_id'),
    kind: colIdx('kind'),
    formal_name: colIdx('formal_name'),
    name: colIdx('name'),
    source: colIdx('source'),
    world_class: colIdx('world_class'),
    belt_class: colIdx('belt_class'),
    population_model: colIdx('population_model'),
    shepherd_id: colIdx('shepherd_id'),
  };
  for (const [csvName] of BODY_NUMERIC_FIELDS) ix[csvName] = colIdx(csvName);
  for (const [csvName] of BODY_STRING_FIELDS)  ix[csvName] = colIdx(csvName);

  const out = [];
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const id = (row[ix.id] ?? '').trim();
    if (!id) continue;

    const kind = (row[ix.kind] ?? '').trim();
    if (!BODY_KINDS.has(kind)) throw new Error(`${label}: ${id} invalid kind=${kind}`);
    const source = (row[ix.source] ?? '').trim();
    if (!BODY_SOURCES.has(source)) throw new Error(`${label}: ${id} invalid source=${source}`);

    // Per-row tracking of which fields were literally blank in the CSV
    // (procgen targets), as distinct from cells marked 'n/a' which stay
    // null forever. Both still parse to null on the body object; the
    // unknowns list is the build-time signal that the Filler reads.
    const unknowns = [];
    const trackedCell = (csvName, jsName) => {
      const raw = (row[ix[csvName]] ?? '').trim();
      if (raw === '') { unknowns.push(jsName); return null; }
      if (raw === 'n/a') return null;
      return raw;
    };

    const worldClass = trackedCell('world_class', 'worldClass');
    if (worldClass !== null && !WORLD_CLASSES.has(worldClass)) {
      throw new Error(`${label}: ${id} invalid world_class=${worldClass}`);
    }
    // belt_class is vestigial — composition lives in the resource grid
    // for both belts and rings. Reject any value to surface stale CSV
    // rows; the column stays in the schema so column positions don't
    // shift, but it always parses to null.
    const beltClass = trackedCell('belt_class', 'beltClass');
    if (beltClass !== null) {
      throw new Error(`${label}: ${id} belt_class is vestigial; clear to n/a (composition lives in the resource grid)`);
    }
    // population_model is vestigial — belt character emerges from the
    // resource grid + largestBodyKm. Reject any value to surface stale
    // CSV rows; the column stays in the schema so positions don't shift.
    const populationModel = trackedCell('population_model', 'populationModel');
    if (populationModel !== null) {
      throw new Error(`${label}: ${id} population_model is vestigial; clear to n/a (belt character lives in the resource grid + largestBodyKm)`);
    }
    // shepherdId is a deferred reference resolved against the planet
    // index later in attachBodies. Validation here is just shape (set
    // only on belts; non-empty string). Existence-of-target check runs
    // after the planet map is built.
    const shepherdId = trackedCell('shepherd_id', 'shepherdId');
    if (shepherdId !== null && kind !== 'belt') {
      throw new Error(`${label}: ${id} shepherd_id only valid on kind='belt' (got ${kind})`);
    }
    // biosphere_archetype + biosphere_complexity ride BODY_STRING_FIELDS
    // (CSV-authored on curated rows, blank on procgen targets — the
    // Filler honors empty-vs-n/a-vs-value via _unknowns). biosphere-
    // SurfaceImpact is always derived in the Filler (never CSV-authored)
    // so per-body coupling jitter applies uniformly. Init null here so
    // the JSON shape carries the field; Filler overwrites.
    const body = {
      id,
      hostId: (row[ix.host_id] ?? '').trim(),
      kind,
      formalName: (row[ix.formal_name] ?? '').trim(),
      name: (row[ix.name] ?? '').trim(),
      source,
      hostStarIdx: null,
      hostBodyIdx: null,
      worldClass,
      shepherdId,
      shepherdBodyIdx: null,
      biosphereSurfaceImpact: null,
      moons: [],
      ring: null,
    };
    for (const [csvName, jsName] of BODY_NUMERIC_FIELDS) {
      const c = trackedCell(csvName, jsName);
      if (c === null) { body[jsName] = null; continue; }
      const n = Number(c);
      if (!Number.isFinite(n)) {
        console.warn(`${label}: ${id} non-numeric ${csvName}=${JSON.stringify(c)}; null`);
        body[jsName] = null;
        continue;
      }
      body[jsName] = n;
    }
    for (const [csvName, jsName] of BODY_STRING_FIELDS) {
      body[jsName] = trackedCell(csvName, jsName);
    }
    body._unknowns = unknowns;
    out.push(body);
  }
  return out;
}

// Parses body_layers.csv — per-body cloud-deck overrides for curated
// Sol bodies. Each row authors one deck: body_id joins back to a body,
// layer_index orders rows (also sorts ascending by altitude_norm at
// emit time). Returns Map<bodyId, CloudLayer[]>.
function parseCsvBodyLayers(text, label) {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw new Error(`${label}: empty CSV`);
  const colIdx = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${label}: missing column ${name}`);
    return i;
  };
  const ix = {
    body_id: colIdx('body_id'),
    layer_index: colIdx('layer_index'),
    gas: colIdx('gas'),
    coverage: colIdx('coverage'),
    wind_speed_ms: colIdx('wind_speed_ms'),
    altitude_norm: colIdx('altitude_norm'),
  };
  const grouped = new Map();
  for (const row of rows) {
    if (!row.length || (row.length === 1 && !row[0])) continue;
    const bodyId = (row[ix.body_id] ?? '').trim();
    if (!bodyId) continue;
    const gas = (row[ix.gas] ?? '').trim();
    if (!gas) throw new Error(`${label}: ${bodyId} layer missing gas`);
    const unitRange = (key) => {
      const v = Number((row[ix[key]] ?? '').trim());
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`${label}: ${bodyId} layer ${key}=${row[ix[key]]} out of [0,1]`);
      }
      return v;
    };
    const wind = Number((row[ix.wind_speed_ms] ?? '').trim());
    if (!Number.isFinite(wind) || wind < 0) {
      throw new Error(`${label}: ${bodyId} wind_speed_ms=${row[ix.wind_speed_ms]} must be ≥ 0 m/s`);
    }
    const layer = {
      gas,
      coverage: unitRange('coverage'),
      windSpeedMS: wind,
      altitudeNorm: unitRange('altitude_norm'),
    };
    const list = grouped.get(bodyId) ?? [];
    list.push(layer);
    grouped.set(bodyId, list);
  }
  // Sort each body's decks ascending by altitudeNorm so the shader
  // composites deep → top without re-sorting at upload time.
  for (const list of grouped.values()) list.sort((a, b) => a.altitudeNorm - b.altitudeNorm);
  return grouped;
}

// Resolves each body's host and builds parent → children index lists. Planets
// must host on a star; moons must host on a planet. Cycles impossible by those
// rules. Each parent's child list is sorted by semi_major_au ascending (nulls
// last) so renderers iterate in orbit order without re-sorting.
//
// Unresolvable hosts → warn and drop the body. The star pipeline already drops
// rows with missing spectral_class (e.g. TOI-540), and the scraper can't know
// in advance that a CSV id will be filtered out, so we mirror that posture
// here rather than failing the build on a data-quality issue downstream.
// Moons orphaned by a dropped planet are dropped in the same pass.
function attachBodies(stars, rawBodies) {
  const starIdToIdx = new Map();
  stars.forEach((s, i) => starIdToIdx.set(s.id, i));
  const planetById = new Map();
  for (const b of rawBodies) {
    if (planetById.has(b.id)) throw new Error(`bodies.csv: duplicate id ${b.id}`);
    if (b.kind === 'planet') planetById.set(b.id, b);
  }

  // Pass 1: resolve star-hosted bodies (planets + belts). Star ownership
  // is the same shape; we keep planets and belts in two parallel lists
  // so the per-star child arrays stay typed (planets[] vs belts[]).
  const planets = [];
  const belts = [];
  for (const b of rawBodies) {
    if (b.kind === 'planet' || b.kind === 'belt') {
      const idx = starIdToIdx.get(b.hostId);
      if (idx === undefined) {
        console.warn(`${BODIES_FILE}: dropping ${b.id} (host star ${b.hostId} not in catalog)`);
        if (b.kind === 'planet') planetById.delete(b.id);
        continue;
      }
      const resolved = { ...b, hostStarIdx: idx, hostBodyIdx: null };
      if (b.kind === 'planet') planets.push(resolved);
      else belts.push(resolved);
    }
  }
  const planetIdxById = new Map();
  planets.forEach((p, i) => planetIdxById.set(p.id, i));

  // Resolve belt shepherd references. shepherdId is the giant's string
  // id (set either by a hand-curated CSV row or by the architect's
  // generateBelts); shepherdBodyIdx is the giant's position in the
  // combined `bodies` array. Planets occupy [0, planets.length), so the
  // planet's local index here matches its index in the final array.
  // Unresolvable ids warn-and-drop rather than failing the build,
  // mirroring how missing star hosts are handled above.
  for (const b of belts) {
    if (!b.shepherdId) continue;
    const idx = planetIdxById.get(b.shepherdId);
    if (idx === undefined) {
      console.warn(`${BODIES_FILE}: ${b.id} shepherd_id=${b.shepherdId} not found; clearing shepherd`);
      b.shepherdId = null;
      continue;
    }
    b.shepherdBodyIdx = idx;
  }

  // Pass 2: resolve planet-hosted bodies (moons + rings). The combined
  // body array places planets first, then belts, then moons, then rings —
  // hostBodyIdx is rewritten with the planet's index in that combined
  // layout below.
  const moons = [];
  const rings = [];
  // Track which planets have already accepted a ring so we can warn-and-
  // drop duplicates rather than silently picking one.
  const ringedPlanets = new Set();
  for (const b of rawBodies) {
    if (b.kind !== 'moon' && b.kind !== 'ring') continue;
    const localPlanetIdx = planetIdxById.get(b.hostId);
    if (localPlanetIdx === undefined) {
      const host = planetById.get(b.hostId);
      if (host && host.kind !== 'planet') {
        throw new Error(`body ${b.id}: ${b.kind} must host on a planet, got kind=${host.kind}`);
      }
      console.warn(`${BODIES_FILE}: dropping ${b.kind} ${b.id} (host body ${b.hostId} not in catalog)`);
      continue;
    }
    if (b.kind === 'ring') {
      if (ringedPlanets.has(b.hostId)) {
        console.warn(`${BODIES_FILE}: dropping ${b.id} (host ${b.hostId} already has a ring)`);
        continue;
      }
      ringedPlanets.add(b.hostId);
    }
    // hostBodyIdx is the planet's index in the combined `bodies` array
    // below (planets occupy [0, planets.length), so this is just the
    // local index).
    const resolved = { ...b, hostStarIdx: null, hostBodyIdx: localPlanetIdx };
    if (b.kind === 'moon') moons.push(resolved);
    else rings.push(resolved);
  }

  // Final BODIES order: planets, then belts, then moons, then rings.
  // Planets first keeps hostBodyIdx (set above to the planet's local
  // index) stable across the concatenation; belts/moons/rings just
  // append.
  const bodies = [...planets, ...belts, ...moons, ...rings];

  const starPlanets = stars.map(() => []);
  const starBelts   = stars.map(() => []);
  const bodyMoons   = bodies.map(() => []);
  const bodyRing    = bodies.map(() => null);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.kind === 'planet')      starPlanets[b.hostStarIdx].push(i);
    else if (b.kind === 'belt')   starBelts[b.hostStarIdx].push(i);
    else if (b.kind === 'moon')   bodyMoons[b.hostBodyIdx].push(i);
    else if (b.kind === 'ring')   bodyRing[b.hostBodyIdx] = i;
  }
  const cmp = (a, b) => {
    const aa = bodies[a].semiMajorAu;
    const bb = bodies[b].semiMajorAu;
    if (aa === null && bb === null) return 0;
    if (aa === null) return 1;
    if (bb === null) return -1;
    return aa - bb;
  };
  for (const list of starPlanets) list.sort(cmp);
  for (const list of starBelts)   list.sort(cmp);
  for (const list of bodyMoons)   list.sort(cmp);

  // Strip shepherdId — it's a deferred string reference used only
  // during build-time resolution; runtime consumers read shepherdBodyIdx.
  const finalBodies = bodies.map((b, i) => {
    const { shepherdId: _shepherdId, ...rest } = b;
    return { ...rest, moons: bodyMoons[i], ring: bodyRing[i] };
  });
  const finalStars = stars.map((s, i) => ({ ...s, planets: starPlanets[i], belts: starBelts[i] }));
  return { stars: finalStars, bodies: finalBodies };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const t0 = performance.now();
  const sources = await Promise.all(SOURCES.map(async (f) => ({
    text: await readFile(resolve(DATA_DIR, f), 'utf8'),
    label: f,
  })));
  const raw = loadCatalog(sources);
  const placedStars = expandCoincidentSets(raw);
  const clusters = buildClusters(placedStars);

  const bodiesText = await readFile(resolve(DATA_DIR, BODIES_FILE), 'utf8');
  const rawBodies = parseCsvBodies(bodiesText, BODIES_FILE);
  const bodyLayersText = await readFile(resolve(DATA_DIR, BODY_LAYERS_FILE), 'utf8');
  const bodyLayersByBodyId = parseCsvBodyLayers(bodyLayersText, BODY_LAYERS_FILE);
  // Attach curated cloud-deck overrides. Bodies with entries get
  // cloudLayers populated + flagged not-unknown so the Filler skips
  // synthesis. Bodies without entries get cloudLayers=null + the
  // 'cloudLayers' unknown so Filler runs cloudDecksFor on them.
  for (const b of rawBodies) {
    const decks = bodyLayersByBodyId.get(b.id);
    if (decks && decks.length > 0) {
      b.cloudLayers = decks;
    } else {
      b.cloudLayers = null;
      b._unknowns.push('cloudLayers');
    }
  }
  // Sanity check: warn for body_layers.csv entries that reference
  // bodies missing from bodies.csv (typos, stale rows).
  const bodyIds = new Set(rawBodies.map((b) => b.id));
  for (const id of bodyLayersByBodyId.keys()) {
    if (!bodyIds.has(id)) {
      console.warn(`${BODY_LAYERS_FILE}: orphan layer for unknown body ${id}`);
    }
  }

  // Architect — generate full procgen systems for stars with no catalog
  // planets. Catalog-anchored stars go through the overlay below instead.
  const catalogPlanetsByStarId = new Map();
  for (const b of rawBodies) {
    if (b.kind !== 'planet') continue;
    const list = catalogPlanetsByStarId.get(b.hostId) ?? [];
    list.push(b);
    catalogPlanetsByStarId.set(b.hostId, list);
  }
  // Cluster-driven dispatch. Iterating clusters (rather than stars) lets a
  // single MAX_PLANETS_PER_CLUSTER budget travel through the cluster's
  // members in heaviest-first order. Catalog anchors are immovable (we
  // never prune observed planets), so we reserve every member's catalog
  // count up-front and only distribute the slack to procgen.
  //
  // Per member i, the cap passed to the generator is:
  //   max(0, MAX − usedByEarlierMembers − catalogOnLaterMembers)
  // — the "total planets allowed on this member" headroom, accounting for
  // what earlier members already took and what later members will
  // contribute via catalog. The architect treats this as its target N; the
  // overlay treats it as its target N (its `toAdd = max(0, N − existing)`
  // already handles the "catalog is keeping me at or above the cap" case
  // by adding zero).
  //
  // Per member:
  //   - architect path (no catalog planets): generateSystem with the cap.
  //   - overlay path (catalog planets present, non-curated): generateOverlay
  //     with the cap. Returned procgen additions count toward usedByEarlier
  //     alongside the catalog anchors on the same star.
  //   - curated catalog path (Sol): CSV is authoritative, no procgen runs;
  //     its catalog anchors still reserve cluster budget for any companion.
  //
  // Catalog totals exceeding MAX (no clusters today, but the algorithm
  // tolerates it) leave companions with a 0 cap and won't be pruned —
  // catalog anchors win.
  const procgenBodies = [];
  const overlayBodies = [];
  for (const cluster of clusters) {
    let catalogOnLaterMembers = 0;
    for (const idx of cluster.members) {
      const cp = catalogPlanetsByStarId.get(placedStars[idx].id);
      if (cp) catalogOnLaterMembers += cp.length;
    }
    let usedByEarlierMembers = 0;
    for (let i = 0; i < cluster.members.length; i++) {
      const star = placedStars[cluster.members[i]];
      const role = i === 0 ? 'primary' : i === 1 ? 'secondary' : 'tertiary_plus';
      const catalogPlanets = catalogPlanetsByStarId.get(star.id) ?? [];
      const existing = catalogPlanets.length;
      catalogOnLaterMembers -= existing;  // this member's catalog moves into 'used'
      const memberCap = Math.max(0, MAX_PLANETS_PER_CLUSTER - usedByEarlierMembers - catalogOnLaterMembers);
      let procgenAdded = 0;
      if (existing > 0) {
        if (!CURATED_SYSTEM_HOSTS.has(star.id)) {
          const bodies = generateOverlay(star, catalogPlanets, role, memberCap);
          overlayBodies.push(...bodies);
          procgenAdded = bodies.filter(b => b.kind === 'planet').length;
        }
      } else {
        const bodies = generateSystem(star, role, memberCap);
        procgenBodies.push(...bodies);
        procgenAdded = bodies.filter(b => b.kind === 'planet').length;
      }
      usedByEarlierMembers += existing + procgenAdded;
    }
  }

  // Universal content floor — for any star that ended up with zero
  // planets AND zero belts after the architect + overlay passes, emit
  // one trace cold belt so the gameplay invariant "no fully empty
  // systems" holds. Curated systems are exempt (Sol's authored content
  // is the source of truth). Catalog-anchored stars are exempt by
  // construction since they already have catalog planets.
  const planetHostIds = new Set();
  const beltHostIds = new Set();
  for (const b of rawBodies) {
    if (b.kind === 'planet') planetHostIds.add(b.hostId);
    if (b.kind === 'belt') beltHostIds.add(b.hostId);
  }
  for (const b of procgenBodies) {
    if (b.kind === 'planet') planetHostIds.add(b.hostId);
    if (b.kind === 'belt') beltHostIds.add(b.hostId);
  }
  for (const b of overlayBodies) {
    if (b.kind === 'planet') planetHostIds.add(b.hostId);
    if (b.kind === 'belt') beltHostIds.add(b.hostId);
  }
  const floorBelts = [];
  for (const star of placedStars) {
    if (CURATED_SYSTEM_HOSTS.has(star.id)) continue;
    if (planetHostIds.has(star.id)) continue;
    if (beltHostIds.has(star.id)) continue;
    const belt = generateFloorBelt(star);
    if (belt) floorBelts.push(belt);
  }

  const starById = new Map(placedStars.map(s => [s.id, s]));

  // Partial-anchor synthesis — catalog rows that arrived with a host
  // and a period column but no measured mass (transit-only detections,
  // direct-imaging companions whose mass is too poorly constrained to
  // record). Without this pass `radiusFromMass(null)` returns null, the
  // Filler's terrestrial branch needs T which needs S which needs mass
  // for pressure, and the body cascades to a featureless gray disc
  // with `worldClass=null`. The synthesis sits ahead of the moon and
  // ring backfill below so generateMoons / generateRing see populated
  // anchors. Curated systems (Sol) bypass this for the same reason
  // they bypass moon backfill — their CSV is authoritative.
  const diskCtxCache = new Map();
  const getDiskCtx = (starId) => {
    if (!diskCtxCache.has(starId)) {
      const s = starById.get(starId);
      diskCtxCache.set(starId, s ? starDiskContext(s) : null);
    }
    return diskCtxCache.get(starId);
  };
  for (const body of rawBodies) {
    if (body.kind !== 'planet') continue;
    if (body.source !== 'catalog') continue;
    if (body.massEarth != null) continue;
    if (CURATED_SYSTEM_HOSTS.has(body.hostId)) continue;
    const host = starById.get(body.hostId);
    if (!host) continue;
    // The synthesis needs a formation orbit. Kepler-derive semiMajorAu
    // from periodDays on the fly here (the Filler does the same a step
    // later — we just need it available now). Write through so the
    // moon + ring backfill below sees the same value.
    if (body.semiMajorAu == null && body.periodDays != null && host.mass > 0) {
      body.semiMajorAu = Number(
        Math.pow(Math.pow(body.periodDays / 365.25, 2) * host.mass, 1 / 3).toFixed(5)
      );
      const u = body._unknowns;
      if (Array.isArray(u)) {
        const idx = u.indexOf('semiMajorAu');
        if (idx >= 0) u.splice(idx, 1);
      }
    }
    const diskCtx = getDiskCtx(host.id);
    if (!diskCtx) continue;
    const synth = synthesizePartialAnchor(host, body, diskCtx);
    if (!synth) continue;
    body.massEarth = synth.massEarth;
    body.radiusEarth = synth.radiusEarth;
    // Strip from _unknowns so the Filler treats these as anchors rather
    // than re-deriving — load-bearing for radius, whose Filler path
    // (`radiusFromMass(mass)`) would overwrite the scattered radius we
    // just sampled with the plain piecewise mean.
    if (Array.isArray(body._unknowns)) {
      body._unknowns = body._unknowns.filter(f => f !== 'massEarth' && f !== 'radiusEarth');
    }
  }

  // Moon backfill — observed exoplanets almost never have moon coverage
  // in the catalog (RV/transit detection bias against picking out
  // satellite signals), so without this pass every catalog planet would
  // surface as moonless in-game, contradicting the catalog-is-incomplete
  // bias the rest of the procgen pipeline assumes. For each catalog
  // planet that arrived with no moons in the CSV, derive a transient
  // worldClass + planet type from its mass and orbital context and run
  // the Architect's moon generator. The Filler will write the planet's
  // own worldClass/temp/pressure authoritatively a step later — we only
  // derive a class here as a moon-count bucket, not to persist it.
  //
  // Curated systems (Sol today) are exempt: their CSV is authoritative,
  // so an empty moon list for Mercury / Venus is the catalog's "really
  // none" rather than a "we don't know" — backfilling would invent
  // moons that contradict the curated truth.
  const catalogMoonHosts = new Set(rawBodies.filter(b => b.kind === 'moon').map(b => b.hostId));
  const catalogRingHosts = new Set(rawBodies.filter(b => b.kind === 'ring').map(b => b.hostId));
  const backfillMoons = [];
  const backfillRings = [];
  for (const planet of rawBodies) {
    if (planet.kind !== 'planet') continue;
    if (CURATED_SYSTEM_HOSTS.has(planet.hostId)) continue;
    if (planet.massEarth == null) continue;  // no anchor → moon Kepler would NaN
    const host = starById.get(planet.hostId);
    if (!host) continue;
    // Catalog rows sometimes ship without radius. Backfill mass→radius
    // here so generateRing's R_p² roll has a number to work with — the
    // Filler will set the same value later, this just hoists it earlier.
    if (planet.radiusEarth == null) {
      const r = radiusFromMass(planet.massEarth);
      if (r == null) continue;
      planet.radiusEarth = r;
    }
    // RV-discovery catalog rows often carry periodDays but no semiMajorAu —
    // the Filler will Kepler-derive it later, but the backfill runs first,
    // so derive on the fly here to get a usable formation-zone proxy.
    let aBackfill = planet.semiMajorAu;
    if (aBackfill == null && planet.periodDays != null && host.mass > 0) {
      aBackfill = Math.pow(Math.pow(planet.periodDays / 365.25, 2) * host.mass, 1 / 3);
    }
    // Moons + rings both inherit the host planet's formation zone — moons
    // for bulk composition, rings for water-ice vs rocky-debris feed.
    // Catalog planets don't carry formationAu (architect-only); fall back
    // to the host's current semiMajorAu as the in-situ formation proxy.
    // Frost lines are deterministic from host mass.
    const hostFormationAu = planet.formationAu ?? aBackfill;
    const frostLinesAu = {
      H2O: frostLineAU(host.mass, SNOW_LINE_TEMPERATURES.H2O),
      NH3: frostLineAU(host.mass, SNOW_LINE_TEMPERATURES.NH3),
      CH4: frostLineAU(host.mass, SNOW_LINE_TEMPERATURES.CH4),
    };
    if (!catalogMoonHosts.has(planet.id)) {
      backfillMoons.push(...generateMoons(planet, host, hostFormationAu, frostLinesAu));
    }
    // Ring backfill mirrors the moon backfill: the catalog is silent on
    // rings (transit + RV detection methods don't surface them), so we
    // sample one per planet using the same per-(planet, salt) seeding
    // the architect uses for in-line rings around procgen planets.
    if (!catalogRingHosts.has(planet.id)) {
      const ring = generateRing(planet, hostFormationAu, frostLinesAu);
      if (ring) backfillRings.push(ring);
    }
  }

  const allBodies = [...rawBodies, ...procgenBodies, ...overlayBodies, ...floorBelts, ...backfillMoons, ...backfillRings];

  const { stars, bodies: resolvedBodies } = attachBodies(placedStars, allBodies);
  // Body Filler — fills `_unknowns` cells from physics + seeded PRNG;
  // strips the marker before the JSON write. Bodies whose anchors don't
  // support filling (no host star resolved, missing mass/radius) keep
  // their nulls.
  const bodies = fillBodies(resolvedBodies, stars);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify({ stars, clusters, bodies }));
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`build-catalog: ${stars.length} stars, ${clusters.length} clusters, ${bodies.length} bodies → ${OUT_PATH} (${ms} ms)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
