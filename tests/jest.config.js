const path = require("path");

module.exports = {
  rootDir: path.join(__dirname, ".."),
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.js"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  testTimeout: 30000,
  collectCoverageFrom: [
    ".opencode/skills/shared/*.js",
    ".opencode/skills/*/scripts/*.js",
    "!**/node_modules/**",
  ],
  coverageDirectory: "<rootDir>/tests/coverage",
  coverageReporters: ["text", "lcov"],
};
