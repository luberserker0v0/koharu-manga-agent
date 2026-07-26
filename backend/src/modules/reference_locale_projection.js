const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../config");

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function localeProjectionContractHash() {
  return hash([
    fs.readFileSync(path.join(__dirname, "..", "reference_locale_projection_contract.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "ao", "agents", "reference-locale-projector.md"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "ao", "skills", "reference-locale-projection-contract", "SKILL.md"), "utf8"),
  ]);
}

async function ensureReferenceLocaleProjection({ translationMemory, aoTaskRunner, jobId, isCanceled = null }) {
  const referenceLanguage = translationMemory?.languages?.referenceLanguage || null;
  const targetLanguage = translationMemory?.languages?.targetLanguage || null;
  if (!referenceLanguage || !targetLanguage || referenceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
    return { translationMemory, projection: null, projectionPath: null, reused: false };
  }
  const glossary = translationMemory.effective?.glossary || [];
  const lockedConflicts = glossary.filter((entry) => {
    if (entry.locked !== true && entry.source !== "manual") return false;
    const declaredLanguage = entry.target_language || entry.targetLanguage || entry.language || null;
    return !declaredLanguage || String(declaredLanguage).toLowerCase() !== targetLanguage.toLowerCase();
  });
  if (lockedConflicts.length > 0) {
    throw new Error(`Manual or locked terminology conflicts with target locale ${targetLanguage}.`);
  }
  const terms = glossary.filter((entry) => entry.locked !== true && entry.source !== "manual").map((entry, index) => ({
    entryId: `term_${String(index + 1).padStart(3, "0")}`,
    sourceTerm: entry.source_term || entry.term,
    currentRendering: entry.canonical_translation || entry.translation,
  }));
  const styleExamples = (translationMemory.effective?.style?.chapters || []).flatMap((chapter, chapterIndex) =>
    [["dialogueSamples", "dialogue"], ["narrationSamples", "narration"], ["monologueSamples", "monologue"]].flatMap(([field, role]) =>
      (chapter[field] || []).slice(0, 3).map((text, index) => ({
        exampleId: `style_${chapterIndex}_${role}_${index}`,
        chapterId: chapter.chapterId || null,
        role,
        text,
      }))
    )
  );
  if (terms.length === 0 && styleExamples.length === 0) return { translationMemory, projection: null, projectionPath: null, reused: false };
  const model = aoTaskRunner?.settings?.model || null;
  const contractHash = localeProjectionContractHash();
  const projectionId = hash({ memory: translationMemory.fingerprint, referenceLanguage, targetLanguage, terms, styleExamples, model, contractHash }).slice(0, 24);
  const projectionPath = path.join(paths.workspaceRoot, "locale-projections", `${projectionId}.json`);
  let result;
  let reused = false;
  if (fs.existsSync(projectionPath)) {
    result = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
    reused = true;
  } else {
    result = await aoTaskRunner.runReferenceLocaleProjection({
      jobId,
      projectionId,
      referenceLanguage,
      targetLanguage,
      model,
      contractHash,
      terms,
      styleExamples,
    }, { isCanceled });
    result = { schemaVersion: 1, projectionId, referenceLanguage, targetLanguage, model, contractHash, generatedAt: new Date().toISOString(), ...result };
    result.fingerprint = hash(result);
    writeJsonAtomic(projectionPath, result);
  }
  const termById = new Map(result.projectedTerms.map((entry) => [entry.entryId, entry]));
  let inferredIndex = 0;
  const projectedGlossary = glossary.map((entry) => {
    if (entry.locked === true || entry.source === "manual") return entry;
    const projected = termById.get(`term_${String(++inferredIndex).padStart(3, "0")}`);
    return projected ? { ...entry, canonical_translation: projected.targetRendering, localeProjectionConfidence: projected.confidence } : entry;
  });
  const styleById = new Map(result.projectedStyleExamples.map((entry) => [entry.exampleId, entry]));
  const projectedChapters = (translationMemory.effective?.style?.chapters || []).map((chapter, chapterIndex) => {
    const projected = { ...chapter };
    for (const [field, role] of [["dialogueSamples", "dialogue"], ["narrationSamples", "narration"], ["monologueSamples", "monologue"]]) {
      projected[field] = (chapter[field] || []).map((text, index) => styleById.get(`style_${chapterIndex}_${role}_${index}`)?.targetText || text);
    }
    return projected;
  });
  const memory = {
    ...translationMemory,
    effective: {
      ...translationMemory.effective,
      glossary: projectedGlossary,
      style: translationMemory.effective?.style ? { ...translationMemory.effective.style, chapters: projectedChapters } : null,
    },
    localeProjection: { projectionId, fingerprint: result.fingerprint, path: projectionPath, referenceLanguage, targetLanguage, reused },
  };
  delete memory.fingerprint;
  memory.fingerprint = hash(memory);
  return { translationMemory: memory, projection: result, projectionPath, reused };
}

module.exports = { ensureReferenceLocaleProjection };
