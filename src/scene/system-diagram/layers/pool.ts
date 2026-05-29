// Shared GPU-resource teardown for the system-diagram layers. Every
// layer draws through one or more "pools" — a BufferGeometry plus the
// ShaderMaterial it renders with, and (for the body-disc pools) a
// per-body cloud DataTexture that Three.js does NOT free alongside the
// geometry. Each layer's dispose() runs on system-view exit; a pool
// resource freed by hand is one field away from a silent GPU-memory
// leak the moment a new field is added without a matching teardown
// line. Routing every teardown through this one helper closes that gap:
// the body-disc pools (planets, moons) carry the cloudTex, so a future
// texture added to buildBodyDiscGeometry is freed everywhere by adding
// one line here.

interface DisposablePool {
  geometry?: { dispose(): void } | null;
  material?: { dispose(): void } | null;
  // Only the body-disc pools (planets, moons) carry one; null/absent
  // for the plain-geometry layers (stars, belts, rings).
  cloudTex?: { dispose(): void } | null;
}

// Free a pool's geometry, material, and cloud texture if present. Safe
// to call with a null pool (a layer with no bodies of that kind).
export function disposePool(pool: DisposablePool | null | undefined): void {
  if (!pool) return;
  pool.geometry?.dispose();
  pool.material?.dispose();
  pool.cloudTex?.dispose();
}
