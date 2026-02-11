import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      // Custom-runner tests that use process.exit() — not vitest-compatible yet
      "tests/executionModeMatch.test.ts",
      "tests/hardFlagEngine.test.ts",
      "tests/roleShapeClassifier.test.ts",
      "tests/scoreReport.test.ts",
      "tests/scoringWeights.test.ts",
      "tests/specInflationPenalty.test.ts",
      "tests/verifyTruth5Layer.test.ts",
      // Manual automation scripts
      "tests/testCronAutomation.ts",
      "tests/testWebhookAutomation.ts",
    ],
    testTimeout: 30000,
  },
});
