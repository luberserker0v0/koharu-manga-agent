const path = require("path");

const backendConfig = require("../../backend/src/config");

describe("backend user data paths", () => {
  test("native defaults live outside the repository", () => {
    const dataRoot = backendConfig.defaultDataRoot();
    const configPath = backendConfig.defaultConfigPath();

    expect(path.isAbsolute(dataRoot)).toBe(true);
    expect(path.isAbsolute(configPath)).toBe(true);
    expect(path.relative(backendConfig.PROJECT_ROOT, dataRoot).startsWith("..")).toBe(true);
    expect(path.relative(backendConfig.PROJECT_ROOT, configPath).startsWith("..")).toBe(true);
  });

  test("test environment overrides keep fixtures in an isolated temporary root", () => {
    expect(backendConfig.DATA_ROOT).toBe(path.resolve(global.TEST_DATA_ROOT));
    expect(backendConfig.PROJECT_CONFIG_PATH).toBe(path.resolve(global.TEST_CONFIG_PATH));
    expect(path.relative(global.PROJECT_ROOT, backendConfig.DATA_ROOT).startsWith("..")).toBe(true);
  });
});
