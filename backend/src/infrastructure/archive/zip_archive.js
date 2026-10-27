const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function commandFailure(result, fallback) {
  if (result.status === 0) return;
  throw new Error(result.stderr || result.stdout || fallback);
}

function runPowerShell(args) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", ...args], {
    encoding: "utf-8",
  });
  commandFailure(result, "PowerShell archive command failed.");
}

function expandZip(zipPath, destinationPath) {
  fs.mkdirSync(destinationPath, { recursive: true });
  if (process.platform === "win32") {
    runPowerShell(["Expand-Archive", "-LiteralPath", zipPath, "-DestinationPath", destinationPath, "-Force"]);
    return;
  }
  const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destinationPath], { encoding: "utf-8" });
  commandFailure(result, "unzip failed.");
}

function createZip(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.rmSync(destinationPath, { force: true });
  if (process.platform === "win32") {
    runPowerShell(["Compress-Archive", "-Path", path.join(sourcePath, "*"), "-DestinationPath", destinationPath, "-Force"]);
    return destinationPath;
  }
  const result = spawnSync("zip", ["-q", "-r", destinationPath, "."], {
    cwd: sourcePath,
    encoding: "utf-8",
  });
  commandFailure(result, "zip failed.");
  return destinationPath;
}

module.exports = { createZip, expandZip };
