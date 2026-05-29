// Type surface for the runtime-consumed exports of prng.mjs.
//
// prng.mjs is plain JS so the Node build scripts can import it with no TS
// toolchain in their path; this declaration lets the browser bundle re-export
// the same implementation under strict type-checking (see
// src/scene/system-diagram/geom/prng.ts). Only the two functions the runtime
// consumes are declared — the build-only samplers (sampleNormal,
// sampleTruncated, sampleMixture, drawWeightedDeposits, …) have no runtime
// consumer and are intentionally absent here.

export function hash32(s: string): number;
export function mulberry32(seed: number): () => number;
