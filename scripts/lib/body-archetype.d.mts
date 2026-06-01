// Type surface for body-archetype.mjs. The classifier lives in plain JS so
// the Node audits can import it with no TS toolchain; this declaration lets
// the browser bundle (the body label) consume `classifyBody` under strict
// typing. Mirrors the prng.mjs / gas-potency.mjs cross-boundary pattern.

import type { Body } from '../../src/data/stars';

// The richer body taxonomy that replaces the stored `worldClass` category.
// Base worldClass types survive under flavour-aligned names; the iconic
// surface-liquid types are first-class so the variety audit can gate them.
export type Archetype =
  // gaseous
  | 'hot_jupiter' | 'gas_giant' | 'ice_giant' | 'sub_neptune' | 'hycean' | 'helium'
  // iconic surface / subsurface liquid
  | 'gaian' | 'tholin' | 'brimstone' | 'ammonia_sea' | 'glacial_sea' | 'subglacial_ocean' | 'ocean'
  // terrestrial base
  | 'lava' | 'magma_ocean' | 'volcanic' | 'chthonian' | 'iron' | 'frostbound' | 'glacial'
  | 'super_earth' | 'desert' | 'rocky'
  // unclassifiable
  | 'unknown';

export const ARCHETYPES: readonly Archetype[];
export const ARCHETYPE_THRESHOLDS: Record<string, number>;
export const GASEOUS_ARCHETYPES: ReadonlySet<Archetype>;

// Pure over stored physical fields — no insolation/host-star lookup needed
// (the chthonian branch keys on surface temperature, a stored field), so the
// runtime label and the build agree.
export function classifyBody(body: Body): Archetype;
