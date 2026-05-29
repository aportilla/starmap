// Type surface for gas-potency.mjs. The values live in plain JS so the Node
// build can import them; this declaration lets the browser bundle re-export the
// table (via src/scene/system-diagram/body-palette.ts) under strict typing.
//
// Asserted, not compiler-verified: TS trusts this Record<AtmGas, number> rather
// than checking the .mjs literal, so a newly added AtmGas without a potency
// entry won't fail the build — keep gas-potency.mjs exhaustive by hand.
import type { AtmGas } from '../../src/data/stars';

export const GAS_POTENCY: Record<AtmGas, number>;
