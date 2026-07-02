import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedEntry = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@acs/shared": sharedEntry,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
  },
});
