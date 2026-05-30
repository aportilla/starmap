// Shared pixel-snap + z-band helpers for the system-diagram layers.
//
// Two invariants are committed across the diagram and both are easy to
// break with a copy-pasted idiom, so each lives in exactly one place
// here:
//
//  - Pixel-crisp snapping. Pools that resolve their own centers on the
//    CPU must land vertices on the same grid the disc shaders snap to,
//    or the body reads as sub-pixel-blurred. Two flavors exist on
//    purpose (see snapPx vs snapPxParity) — they are DIFFERENT
//    functions; route each call site through the one matching its body.
//  - Back/front occlusion ordering. Every layer threads its row index
//    into the vertex z via `rowIdx * Z_STRIDE + layerZ`; a wrong sign
//    there silently swaps which neighbor occludes which. bandZ is the
//    single formula all pools share.

import { Z_STRIDE } from '../layout/constants';

// Round-to-nearest-integer pixel snap. The plain idiom for pools whose
// disc is a Points sprite (moons) or a baked chunk cluster (belts):
// vertices land on integer buffer pixels regardless of disc diameter.
export function snapPx(x: number): number {
  return Math.round(x);
}

// Parity-aware pixel snap for plane-disc bodies (the stars row). An
// even-diameter disc centers on an integer (a pixel boundary); an odd
// diameter centers on integer+0.5 (a pixel center). Mirrors the
// parity-aware floor the disc vertex shaders apply via snapToPixelGrid
// (materials PIXEL_SNAP_GLSL); resolved CPU-side here for layers that
// place centers on the CPU. NOT interchangeable with snapPx — using it
// on a Math.round site would shift odd-diameter bodies by half a pixel.
export function snapPxParity(x: number, diameter: number): number {
  const oddOff = (diameter & 1) * 0.5;
  return Math.floor(x - oddOff + 0.5) + oddOff;
}

// The per-row-item z band: row index times the stride, plus the layer's
// signed sub-offset (Z_BACK_MOON … Z_FRONT_MOON). Larger row index →
// larger world z → drawn on top; negative layerZ draws under the disc,
// positive over it. See the Z_STRIDE comment block in layout/constants.
export function bandZ(rowIdx: number, layerZ: number): number {
  return rowIdx * Z_STRIDE + layerZ;
}
