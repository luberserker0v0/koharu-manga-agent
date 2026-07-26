const path = require("path");

// Set project root for all tests
global.PROJECT_ROOT = path.join(__dirname, "..");

// Helper to require modules relative to project root
global.requireFromProject = function (relativePath) {
  return require(path.join(PROJECT_ROOT, relativePath));
};

// Skip E2E tests if Koharu is not running
beforeAll(() => {
  global.KOHARU_AVAILABLE = false;
});

// Utility to check if Koharu service is available
global.checkKoharu = async function () {
  try {
    const { config } = require("../backend/src/config");
    const res = await fetch(`${String(config.api.baseUrl).replace(/\/+$/, "")}/api/v1/projects`);
    if (res.ok) {
      global.KOHARU_AVAILABLE = true;
      return true;
    }
  } catch {
    // Koharu not available
  }
  global.KOHARU_AVAILABLE = false;
  return false;
};
