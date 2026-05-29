// hash32 (FNV-1a 32-bit) + mulberry32 — the deterministic seeding pair the
// system diagram uses to roll each planet's moon angles, each belt's chunk
// pattern, and each ring's tilt off a `${kind}:${body.id}` seed (identical
// seed in → identical hash out → identical PRNG stream).
//
// The implementation lives once in scripts/lib/prng.mjs (plain JS, runnable by
// the Node build with no TS toolchain) and is re-exported here for the browser
// bundle. Single source by construction: the layouts the runtime rolls use the
// same code that baked the seeds into catalog.generated.json, so there is no
// second copy that can silently drift. Types come from the sibling prng.d.mts.
export { hash32, mulberry32 } from '../../../../scripts/lib/prng.mjs';
