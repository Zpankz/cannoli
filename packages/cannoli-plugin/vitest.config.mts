import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // The real "obsidian" package is types only; tests get a small in-memory mock.
      {
        find: /^obsidian$/,
        replacement: fileURLToPath(
          new URL("./test/mocks/obsidian.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
