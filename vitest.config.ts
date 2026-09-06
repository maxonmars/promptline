import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts исполняется только в дочернем процессе e2e-тестов, куда инструментация не доходит:
      // в отчёте он был бы нулём независимо от того, проверен запуск CLI или нет.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
