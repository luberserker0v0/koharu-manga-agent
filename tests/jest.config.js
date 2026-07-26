const path = require("path");

module.exports = {
  rootDir: path.join(__dirname, ".."),
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.js"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  testTimeout: 30000,
  collectCoverageFrom: [
    "backend/**/*.js",
    ".opencode/skills/*/scripts/*.js",
    ".opencode/skills/*/lib/*.js",
    "!**/node_modules/**",
  ],
  coverageDirectory: "<rootDir>/tests/coverage",
  coverageReporters: ["text", "lcov"],
};
