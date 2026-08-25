const fs = require("fs");
const path = require("path");

const { paths } = require("../src/config");
const { observationCacheKey } = require("../src/domains/reference/observation/reference_observation");
const {
  TRANSLATION_ROLE_CONTRACT_VERSION,
  translationRoleContractHash,
} = require("../src/domains/translation/execution/translation_chapter_observation");

const cacheRoot = path.join(paths.workspaceRoot, "translation-observations");
const roleContractHash = translationRoleContractHash();
const results = [];

for (const entry of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot, { withFileTypes: true }) : []) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  const sourcePath = path.join(cacheRoot, entry.name);
  const observation = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (
    observation.observationKind !== "translation_source" ||
    !observation.extractionFingerprint ||
    !Array.isArray(observation.nodes) ||
    observation.nodes.some((node) => !node.nodeId || !node.textRole || !node.styleChannel)
  ) {
    results.push({ sourcePath, migrated: false, reason: "incompatible_observation" });
    continue;
  }
  const cacheKey = observationCacheKey({
    extractionFingerprint: observation.extractionFingerprint,
    observerContractHash: roleContractHash,
    model: observation.model || null,
    contentLanguage: observation.contentLanguage || "und",
  });
  const targetPath = path.join(cacheRoot, `${cacheKey}.json`);
  const migrated = {
    ...observation,
    cacheKey,
    translationRoleContractVersion: TRANSLATION_ROLE_CONTRACT_VERSION,
    translationRoleContractHash: roleContractHash,
    roleContractMigratedAt: new Date().toISOString(),
  };
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, JSON.stringify(migrated, null, 2), "utf8");
  }
  results.push({ sourcePath, targetPath, migrated: true });
}

process.stdout.write(`${JSON.stringify({ cacheRoot, roleContractHash, results }, null, 2)}\n`);
