import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "burnerform-mcp": "packages/mcp/src/cli.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  splitting: false,
  sourcemap: false,
  clean: true,
  outDir: "packages/mcp/dist-executable",
  external: ["@napi-rs/keyring"],
  noExternal: [
    "@burnerform/core",
    "@burnerform/sdk",
    "@modelcontextprotocol/sdk",
    "hash-wasm",
    "zod",
  ],
});
