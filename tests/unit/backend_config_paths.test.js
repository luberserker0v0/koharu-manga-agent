const path = require("path");

const backendConfig = require("../../backend/src/config");

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

describe("backend user data paths", () => {
  test("native defaults live outside the repository", () => {
    const dataRoot = backendConfig.defaultDataRoot();
    const configPath = backendConfig.defaultConfigPath();

    expect(path.isAbsolute(dataRoot)).toBe(true);
    expect(path.isAbsolute(configPath)).toBe(true);
    expect(isInside(backendConfig.PROJECT_ROOT, dataRoot)).toBe(false);
    expect(isInside(backendConfig.PROJECT_ROOT, configPath)).toBe(false);
  });

  test("test environment overrides keep fixtures in an isolated temporary root", () => {
    expect(backendConfig.DATA_ROOT).toBe(path.resolve(global.TEST_DATA_ROOT));
    expect(backendConfig.PROJECT_CONFIG_PATH).toBe(path.resolve(global.TEST_CONFIG_PATH));
    expect(isInside(global.PROJECT_ROOT, backendConfig.DATA_ROOT)).toBe(false);
  });
});
