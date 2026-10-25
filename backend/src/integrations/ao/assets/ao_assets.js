const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT } = require("../../../config");

const AO_ASSETS_ROOT = path.join(PROJECT_ROOT, "backend", "ao");
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let current = i;
    for (let j = 0; j < 8; j += 1) {
      current = (current & 1) !== 0 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[i] = current >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function writeUInt16(buffer, value, offset) {
  buffer.writeUInt16LE(value & 0xffff, offset);
}

function writeUInt32(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function zipEntryData(file) {
  const name = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
  const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
  const { dosTime, dosDate } = toDosTime(file.mtime || new Date());
  return { name, content, checksum: crc32(content), dosTime, dosDate };
}

function createLocalHeader(entry) {
  const header = Buffer.alloc(30);
  writeUInt32(header, 0x04034b50, 0);
  writeUInt16(header, 20, 4);
  writeUInt16(header, 0, 6);
  writeUInt16(header, 0, 8);
  writeUInt16(header, entry.dosTime, 10);
  writeUInt16(header, entry.dosDate, 12);
  writeUInt32(header, entry.checksum, 14);
  writeUInt32(header, entry.content.length, 18);
  writeUInt32(header, entry.content.length, 22);
  writeUInt16(header, entry.name.length, 26);
  writeUInt16(header, 0, 28);
  return header;
}

function createCentralHeader(entry, localOffset) {
  const header = Buffer.alloc(46);
  writeUInt32(header, 0x02014b50, 0);
  writeUInt16(header, 20, 4);
  writeUInt16(header, 20, 6);
  writeUInt16(header, 0, 8);
  writeUInt16(header, 0, 10);
  writeUInt16(header, entry.dosTime, 12);
  writeUInt16(header, entry.dosDate, 14);
  writeUInt32(header, entry.checksum, 16);
  writeUInt32(header, entry.content.length, 20);
  writeUInt32(header, entry.content.length, 24);
  writeUInt16(header, entry.name.length, 28);
  writeUInt32(header, localOffset, 42);
  return header;
}

function createEndRecord(fileCount, centralSize, localOffset) {
  const record = Buffer.alloc(22);
  writeUInt32(record, 0x06054b50, 0);
  writeUInt16(record, fileCount, 8);
  writeUInt16(record, fileCount, 10);
  writeUInt32(record, centralSize, 12);
  writeUInt32(record, localOffset, 16);
  return record;
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const file of files) {
    const entry = zipEntryData(file);
    const localHeader = createLocalHeader(entry);
    localParts.push(localHeader, entry.name, entry.content);
    centralParts.push(createCentralHeader(entry, localOffset), entry.name);
    localOffset += localHeader.length + entry.name.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = createEndRecord(files.length, centralDirectory.length, localOffset);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function ensureAoAssetFolders() {
  for (const dir of [
    AO_ASSETS_ROOT,
    path.join(AO_ASSETS_ROOT, "agents"),
    path.join(AO_ASSETS_ROOT, "docs"),
    path.join(AO_ASSETS_ROOT, "skills"),
    path.join(AO_ASSETS_ROOT, "opencode"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readOptionalFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function readRequiredJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`AO opencode.json not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listAgentFiles(agentsRoot = path.join(AO_ASSETS_ROOT, "agents")) {
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  return fs
    .readdirSync(agentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => ({
      name: entry.name.replace(/\.md$/i, ""),
      content: fs.readFileSync(path.join(agentsRoot, entry.name), "utf8"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function collectTextFiles(rootDir, prefix = "") {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(absolutePath, relativePath));
      continue;
    }
    files.push({
      path: relativePath.replace(/\\/g, "/"),
      content: fs.readFileSync(absolutePath, "utf8"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function listDocFiles(docsRoot = path.join(AO_ASSETS_ROOT, "docs")) {
  return collectTextFiles(docsRoot);
}

function collectSkillFiles(skillDir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
    const absolutePath = path.join(skillDir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(absolutePath, relativePath));
      continue;
    }
    files.push({
      name: relativePath,
      content: fs.readFileSync(absolutePath),
      mtime: fs.statSync(absolutePath).mtime,
    });
  }
  return files;
}

function listSkillArchives(skillsRoot = path.join(AO_ASSETS_ROOT, "skills")) {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillDir = path.join(skillsRoot, entry.name);
      const files = collectSkillFiles(skillDir);
      // Removed skills can leave empty directories in development workspaces.
      // They are not uploadable AO assets and should not break unrelated tasks.
      if (files.length === 0) {
        return null;
      }
      if (!files.some((file) => file.name === "SKILL.md")) {
        throw new Error(`AO skill ${entry.name} must contain SKILL.md at the root.`);
      }
      return {
        name: entry.name,
        zipBuffer: createZipBuffer(files),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function loadAoAssets() {
  ensureAoAssetFolders();
  return {
    root: AO_ASSETS_ROOT,
    agentsMd: readOptionalFile(path.join(AO_ASSETS_ROOT, "AGENTS.md")),
    opencodeConfig: readRequiredJson(path.join(AO_ASSETS_ROOT, "opencode", "opencode.json")),
    agentFiles: listAgentFiles(),
    docFiles: listDocFiles(),
    skillArchives: listSkillArchives(),
  };
}

module.exports = {
  AO_ASSETS_ROOT,
  createZipBuffer,
  ensureAoAssetFolders,
  listAgentFiles,
  listDocFiles,
  listSkillArchives,
  loadAoAssets,
};
