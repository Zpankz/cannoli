import { defineConfig } from "tsup";

// The AI SDK packages are ESM-only, so they are bundled in; otherwise
// dist/index.cjs would require() them and fail.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  treeshake: true,
  clean: true,
  target: "es2022",
  noExternal: ["ai", /^@ai-sdk\//, "@openrouter/ai-sdk-provider"],
});
