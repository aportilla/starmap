/// <reference types="vite/client" />

// Inline-as-string imports for BDF font sources. Vite resolves the `?raw`
// query at build time and serves the file content as a default-exported
// string; this declaration teaches TS the resulting module shape.
declare module '*.bdf?raw' {
  const content: string;
  export default content;
}
