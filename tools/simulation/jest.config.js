/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.sim.ts"],
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  testTimeout: 120_000,
  maxWorkers: 1,
};
