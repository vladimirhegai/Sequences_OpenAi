import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/web/test/**/*.test.ts", "apps/web/test/**/*.test.tsx"],
    passWithNoTests: true,
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
