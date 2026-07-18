/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "src/__tests__/governor.test.ts",
    "src/__tests__/integration.test.ts",
  ],
  maxWorkers: 1,
  coverageProvider: "v8",
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/__tests__/**",
    "!src/types/**",
    "!src/index.ts",
    "!src/events.ts",
  ],
};
