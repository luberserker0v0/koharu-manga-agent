const fs = require("fs");
const path = require("path");

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return typeof fallback === "function" ? fallback() : fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

module.exports = {
  readJson,
  writeJsonAtomic,
};
