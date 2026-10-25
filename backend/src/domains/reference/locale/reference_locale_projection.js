const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function localeProjectionContractHash() {
  return hash([
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "integrations",
        "ao",
        "contracts",
        "reference_locale_projection_contract.js",
      ),
      "utf8",
    ),
    fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "reference-locale-projector.md"),
      "utf8",
    ),
    fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "reference-locale-projection-contract", "SKILL.md"),
      "utf8",
    ),
  ]);
}

function hasLockedConflict(entry, targetLanguage) {
  if (entry.locked !== true && entry.source !== "manual") return false;
  const declaredLanguage = entry.target_language || entry.targetLanguage || entry.language || null;
  return !declaredLanguage || String(declaredLanguage).toLowerCase() !== targetLanguage.toLowerCase();
}

function buildProjectedTerms(glossary) {
  return glossary
    .filter((entry) => entry.locked !== true && entry.source !== "manual")
    .map((entry, index) => ({
      entryId: `term_${String(index + 1).padStart(3, "0")}`,
      sourceTerm: entry.source_term || entry.term,
      currentRendering: entry.canonical_translation || entry.translation,
    }));
}

function buildStyleExamples(translationMemory) {
  return (translationMemory.effective?.style?.chapters || []).flatMap((chapter, chapterIndex) =>
    [
      ["dialogueSamples", "dialogue"],
      ["narrationSamples", "narration"],
      ["monologueSamples", "monologue"],
    ].flatMap(([field, role]) =>
      (chapter[field] || []).slice(0, 3).map((text, index) => ({
        exampleId: `style_${chapterIndex}_${role}_${index}`,
        chapterId: chapter.chapterId || null,
        role,
        text,
      })),
    ),
  );
}

async function generateProjection(options) {
  const { aoTaskRunner, isCanceled, projectionPath, ...input } = options;
  let result = await aoTaskRunner.runReferenceLocaleProjection(input, { isCanceled });
  result = {
    schemaVersion: 1,
    projectionId: input.projectionId,
    referenceLanguage: input.referenceLanguage,
    targetLanguage: input.targetLanguage,
    model: input.model,
    contractHash: input.contractHash,
    generatedAt: new Date().toISOString(),
    ...result,
  };
  result.fingerprint = hash(result);
  writeJsonAtomic(projectionPath, result);
  return result;
}

async function loadOrCreateProjection(options) {
  if (fs.existsSync(options.projectionPath)) {
    return { result: JSON.parse(fs.readFileSync(options.projectionPath, "utf8")), reused: true };
  }
  return { result: await generateProjection(options), reused: false };
}

function projectGlossary(translationMemory, result) {
  const termById = new Map(result.projectedTerms.map((entry) => [entry.entryId, entry]));
  let inferredIndex = 0;
  return (translationMemory.effective?.glossary || []).map((entry) => {
    if (entry.locked === true || entry.source === "manual") return entry;
    const projected = termById.get(`term_${String(++inferredIndex).padStart(3, "0")}`);
    return projected
      ? {
          ...entry,
          canonical_translation: projected.targetRendering,
          localeProjectionConfidence: projected.confidence,
        }
      : entry;
  });
}

function projectStyleChapters(translationMemory, result) {
  const styleById = new Map(result.projectedStyleExamples.map((entry) => [entry.exampleId, entry]));
  return (translationMemory.effective?.style?.chapters || []).map((chapter, chapterIndex) => {
    const projected = { ...chapter };
    for (const [field, role] of [
      ["dialogueSamples", "dialogue"],
      ["narrationSamples", "narration"],
      ["monologueSamples", "monologue"],
    ]) {
      projected[field] = (chapter[field] || []).map(
        (text, index) => styleById.get(`style_${chapterIndex}_${role}_${index}`)?.targetText || text,
      );
    }
    return projected;
  });
}

function applyProjection(options) {
  const { translationMemory, result, reused, projectionId, projectionPath,
    referenceLanguage, targetLanguage } = options;
  const projectedGlossary = projectGlossary(translationMemory, result);
  const projectedChapters = projectStyleChapters(translationMemory, result);
  const memory = {
    ...translationMemory,
    effective: {
      ...translationMemory.effective,
      glossary: projectedGlossary,
      style: translationMemory.effective?.style
        ? { ...translationMemory.effective.style, chapters: projectedChapters }
        : null,
    },
    localeProjection: {
      projectionId,
      fingerprint: result.fingerprint,
      path: projectionPath,
      referenceLanguage,
      targetLanguage,
      reused,
    },
  };
  delete memory.fingerprint;
  memory.fingerprint = hash(memory);
  return memory;
}

function emptyProjection(translationMemory) {
  return { translationMemory, projection: null, projectionPath: null, reused: false };
}

function createProjectionContext(translationMemory, aoTaskRunner, referenceLanguage, targetLanguage) {
  const glossary = translationMemory.effective?.glossary || [];
  if (glossary.some((entry) => hasLockedConflict(entry, targetLanguage))) {
    throw new Error(`Manual or locked terminology conflicts with target locale ${targetLanguage}.`);
  }
  const terms = buildProjectedTerms(glossary);
  const styleExamples = buildStyleExamples(translationMemory);
  if (terms.length === 0 && styleExamples.length === 0) return null;
  const model = aoTaskRunner?.settings?.model || null;
  const contractHash = localeProjectionContractHash();
  const projectionId = hash({
    memory: translationMemory.fingerprint, referenceLanguage, targetLanguage, terms, styleExamples, model, contractHash,
  }).slice(0, 24);
  const projectionPath = path.join(paths.workspaceRoot, "locale-projections", `${projectionId}.json`);
  return { projectionId, projectionPath, referenceLanguage, targetLanguage, terms, styleExamples, model, contractHash };
}

async function ensureReferenceLocaleProjection({ translationMemory, aoTaskRunner, jobId, isCanceled = null }) {
  const referenceLanguage = translationMemory?.languages?.referenceLanguage || null;
  const targetLanguage = translationMemory?.languages?.targetLanguage || null;
  if (!referenceLanguage || !targetLanguage || referenceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
    return emptyProjection(translationMemory);
  }
  const context = createProjectionContext(translationMemory, aoTaskRunner, referenceLanguage, targetLanguage);
  if (!context) return emptyProjection(translationMemory);
  const { result, reused } = await loadOrCreateProjection({
    aoTaskRunner, jobId, isCanceled, ...context,
  });
  const memory = applyProjection({ translationMemory, result, reused, ...context });
  return {
    translationMemory: memory,
    projection: result,
    projectionPath: context.projectionPath,
    reused,
  };
}

module.exports = { ensureReferenceLocaleProjection };
