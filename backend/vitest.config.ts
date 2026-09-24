import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests share one local Redis instance; parallel test files
    // would race each other's flushdb/cleanup. Serialize file execution.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
    ],
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,

    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "tests/**",
        "dist/**",
        "**/*.d.ts",
        "**/index.ts",
      ],
    },
  },
});