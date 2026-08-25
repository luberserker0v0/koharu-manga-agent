const fs = require("fs");
const path = require("path");

const { PROJECT_ROOT } = require("../src/config");
const { validateRegistry, writeJsonAtomic } = require("../src/domains/translation/publications/translation_publications");

function findRegistries(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name === "translation_publications.json") results.push(entryPath);
    }
  }
  return results;
}

function migrateRegistry(registryPath) {
  const originalText = fs.readFileSync(registryPath, "utf8");
  const registry = JSON.parse(originalText);
  let changed = false;
  for (const chapter of Object.values(registry.chapters || {})) {
    for (const revision of chapter.revisions || []) {
      if (revision.qualityStatus === "pending_revalidation") {
        revision.qualityStatus = "unverified";
        changed = true;
      }
    }
  }
  validateRegistry(registry, { mangaId: registry.mangaId, translatorId: registry.translatorId });
  if (!changed) return { registryPath, changed: false, backupPath: null };
  const backupPath = `${registryPath}.pre-v2-${Date.now()}.bak`;
  fs.writeFileSync(backupPath, originalText, "utf8");
  writeJsonAtomic(registryPath, registry);
  return { registryPath, changed: true, backupPath };
}

const knowledgeRoot = path.join(PROJECT_ROOT, "knowledge_base");
const results = findRegistries(knowledgeRoot).map(migrateRegistry);
process.stdout.write(`${JSON.stringify({ knowledgeRoot, results }, null, 2)}\n`);
