const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, paths } = require("../config");
const { DEFAULT_LANGUAGE_TAG, normalizeLanguageTag } = require("../language_codes");
const { PostEditWorkspaceModule } = require("./post_edit_workspace");

const DEFAULT_TRANSLATOR_ID = "translator_default";
const DEFAULT_TRANSLATOR_LABEL = "Default Translator";

const DEFAULT_INDEX = {
  series: [],
};

const postEditWorkspaceModule = new PostEditWorkspaceModule();

function knowledgeBaseRoot() {
  return path.join(PROJECT_ROOT, "knowledge_base");
}

function knowledgeIndexPath() {
  return path.join(knowledgeBaseRoot(), "index.json");
}

function isValidMangaId(mangaId) {
  return typeof mangaId === "string" && /^[a-z0-9_]+$/.test(mangaId);
}

function isValidTranslatorId(translatorId) {
  return typeof translatorId === "string" && /^[a-z0-9_]+$/.test(translatorId);
}

function isValidChapterId(chapterId) {
  return typeof chapterId === "string" && /^[a-z0-9_]+$/.test(chapterId);
}

function assertValidMangaId(mangaId) {
  if (!isValidMangaId(mangaId)) {
    throw new Error(
      `Invalid mangaId: ${mangaId}. Use lowercase ASCII letters, numbers, and underscores only.`
    );
  }
}

function assertValidTranslatorId(translatorId) {
  if (!isValidTranslatorId(translatorId)) {
    throw new Error(
      `Invalid translatorId: ${translatorId}. Use lowercase ASCII letters, numbers, and underscores only.`
    );
  }
}

function assertValidChapterId(chapterId) {
  if (!isValidChapterId(chapterId)) {
    throw new Error(
      `Invalid chapterId: ${chapterId}. Use lowercase ASCII letters, numbers, and underscores only.`
    );
  }
}

function toRelativeProjectPath(targetPath) {
  return path.relative(PROJECT_ROOT, targetPath).replace(/\\/g, "/");
}

function ensureKnowledgeIndex() {
  const indexPath = knowledgeIndexPath();
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, JSON.stringify(DEFAULT_INDEX, null, 2));
  }
  return indexPath;
}

function normalizeSystemId(prefix, value) {
  const normalized = String(value || "").trim().normalize("NFKC");
  if (!normalized) {
    return null;
  }

  const asciiSlug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (asciiSlug) {
    return `${prefix}_${asciiSlug}`;
  }

  const codePointSlug = Array.from(normalized)
    .map((character) => character.codePointAt(0)?.toString(16) || "")
    .filter(Boolean)
    .join("_");
  return `${prefix}_${codePointSlug.slice(0, 48)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function normalizeChapter(entry, sortOrder = 0) {
  const createdAt = entry?.createdAt || nowIso();
  const updatedAt = entry?.updatedAt || createdAt;
  const resolvedChapterId =
    typeof entry?.chapterId === "string" && entry.chapterId
      ? entry.chapterId
      : normalizeSystemId("chapter", entry?.chapterTitle || `chapter_${sortOrder + 1}`);
  assertValidChapterId(resolvedChapterId);

  return {
    chapterId: resolvedChapterId,
    chapterTitle:
      typeof entry?.chapterTitle === "string" && entry.chapterTitle.trim()
        ? entry.chapterTitle.trim()
        : null,
    sortOrder: typeof entry?.sortOrder === "number" ? entry.sortOrder : sortOrder,
    createdAt,
    updatedAt,
  };
}

function buildTranslatorPaths(mangaId, translatorId) {
  const baseDir = path.join(knowledgeBaseRoot(), "self", mangaId, translatorId);
  return {
    baseDir,
    knowledgeBasePath: path.join(baseDir, "knowledge.json"),
    glossaryPath: path.join(baseDir, "canonical_glossary.json"),
    candidateTermsPath: path.join(baseDir, "candidate_terms.json"),
    storyContextPath: path.join(baseDir, "story_context.json"),
    storyGraphPath: path.join(baseDir, "story_graph.json"),
    socialGraphPath: path.join(baseDir, "social_graph.json"),
    styleEvidencePath: path.join(baseDir, "style_evidence.json"),
    styleProfilePath: path.join(baseDir, "style_profile.json"),
    translationContextPath: path.join(baseDir, "translation_context.json"),
    bilingualEvidencePath: path.join(baseDir, "bilingual_evidence.json"),
    bilingualRunsDir: path.join(baseDir, "bilingual_runs"),
    bilingualCheckpointStoreDir: path.join(baseDir, "bilingual_runs", "checkpoints"),
    bilingualEvidenceLedgerPath: path.join(baseDir, "bilingual_evidence_ledger.json"),
    bilingualLedgerRevisionsDir: path.join(baseDir, "bilingual_ledger_revisions"),
    reportPath: path.join(knowledgeBaseRoot(), "reports", mangaId, translatorId, "extract_report.json"),
  };
}

function buildMangaPaths(mangaId) {
  return {
    selfDir: path.join(knowledgeBaseRoot(), "self", mangaId),
    reportsDir: path.join(knowledgeBaseRoot(), "reports", mangaId),
  };
}

function normalizeTranslatorProfile(entry, mangaId) {
  const translatorId =
    typeof entry?.translatorId === "string" && entry.translatorId
      ? entry.translatorId
      : DEFAULT_TRANSLATOR_ID;
  assertValidTranslatorId(translatorId);
  const createdAt = entry?.createdAt || nowIso();
  const updatedAt = entry?.updatedAt || createdAt;
  const normalizedPaths = buildTranslatorPaths(mangaId, translatorId);
  const chapters = Array.isArray(entry?.chapters)
    ? entry.chapters.map((chapter, index) => normalizeChapter(chapter, index))
    : [];

  chapters.sort((left, right) => left.sortOrder - right.sortOrder);
  const normalizedChapters = chapters.map((chapter, index) => ({
    ...chapter,
    sortOrder: index,
  }));

  return {
    translatorId,
    label:
      typeof entry?.label === "string" && entry.label.trim()
        ? entry.label.trim()
        : DEFAULT_TRANSLATOR_LABEL,
    language: entry?.language || "zh-TW",
    profileKind: entry?.profileKind === "learning_clone" ? "learning_clone" : "standard",
    styleSourceTranslatorId:
      typeof entry?.styleSourceTranslatorId === "string" && entry.styleSourceTranslatorId
        ? entry.styleSourceTranslatorId
        : null,
    createdAt,
    updatedAt,
    knowledgePath:
      typeof entry?.knowledgePath === "string" && entry.knowledgePath
        ? entry.knowledgePath
        : toRelativeProjectPath(normalizedPaths.knowledgeBasePath),
    reportPath:
      typeof entry?.reportPath === "string" && entry.reportPath
        ? entry.reportPath
        : toRelativeProjectPath(normalizedPaths.reportPath),
    chapters: normalizedChapters,
  };
}

function normalizeLegacySeriesEntry(entry) {
  const mangaId = typeof entry?.mangaId === "string" ? entry.mangaId : null;
  assertValidMangaId(mangaId);
  const createdAt = entry?.createdAt || entry?.updatedAt || nowIso();
  const updatedAt = entry?.updatedAt || createdAt;
  const translatorPaths = buildTranslatorPaths(mangaId, DEFAULT_TRANSLATOR_ID);

  return {
    mangaId,
    label: entry.label || mangaId,
    language: entry.language || "zh-TW",
    createdAt,
    updatedAt,
    translators: [
      {
        translatorId: DEFAULT_TRANSLATOR_ID,
        label: DEFAULT_TRANSLATOR_LABEL,
        language: entry.language || "zh-TW",
        profileKind: "standard",
        styleSourceTranslatorId: null,
        createdAt,
        updatedAt,
        knowledgePath: entry.knowledgePath || toRelativeProjectPath(translatorPaths.knowledgeBasePath),
        reportPath: entry.reportPath || toRelativeProjectPath(translatorPaths.reportPath),
        chapters: [],
      },
    ],
  };
}

function normalizeSeriesEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (!Array.isArray(entry.translators)) {
    return normalizeLegacySeriesEntry(entry);
  }

  const mangaId = typeof entry.mangaId === "string" ? entry.mangaId : null;
  assertValidMangaId(mangaId);
  const createdAt = entry.createdAt || entry.updatedAt || nowIso();
  const updatedAt = entry.updatedAt || createdAt;

  return {
    mangaId,
    label: entry.label || mangaId,
    language: entry.language || "zh-TW",
    createdAt,
    updatedAt,
    translators: entry.translators
      .map((translator) => normalizeTranslatorProfile(translator, mangaId))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-Hant")),
  };
}

function normalizeKnowledgeIndex(index) {
  const series = Array.isArray(index?.series)
    ? index.series
        .map((entry) => normalizeSeriesEntry(entry))
        .filter(Boolean)
        .sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"))
    : [];

  return { series };
}

function loadKnowledgeIndex() {
  const indexPath = ensureKnowledgeIndex();
  const raw = fs.readFileSync(indexPath, "utf-8");
  const trimmed = raw.trim();

  if (!trimmed) {
    writeKnowledgeIndex(DEFAULT_INDEX);
    return normalizeKnowledgeIndex(DEFAULT_INDEX);
  }

  try {
    const parsed = JSON.parse(trimmed);
    return normalizeKnowledgeIndex(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeKnowledgeIndex(DEFAULT_INDEX);
      return normalizeKnowledgeIndex(DEFAULT_INDEX);
    }
    throw error;
  }
}

function writeKnowledgeIndex(index) {
  const indexPath = ensureKnowledgeIndex();
  const normalized = normalizeKnowledgeIndex(index);
  const payload = JSON.stringify(normalized, null, 2);
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tempPath, payload);
  try {
    fs.renameSync(tempPath, indexPath);
  } catch (error) {
    if (
      error &&
      (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES")
    ) {
      fs.writeFileSync(indexPath, payload);
      fs.unlinkSync(tempPath);
    } else {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore cleanup failures and surface the original write error below.
      }
      throw error;
    }
  }
  return indexPath;
}

function getSeriesEntry(index, mangaId) {
  return index.series.find((entry) => entry.mangaId === mangaId) || null;
}

function getTranslatorEntry(index, mangaId, translatorId) {
  const series = getSeriesEntry(index, mangaId);
  if (!series) {
    return null;
  }
  return series.translators.find((entry) => entry.translatorId === translatorId) || null;
}

function resolveReferenceManifestLabel(referenceSetId) {
  if (!referenceSetId) {
    return null;
  }

  const manifestPath = path.join(paths.referenceManifests, `${referenceSetId}.json`);
  const manifest = readJsonIfExists(manifestPath);
  const label =
    typeof manifest?.label === "string" && manifest.label.trim()
      ? manifest.label.trim()
      : null;
  return label;
}

function recoverTranslatorChaptersFromAssets(series, translator) {
  if (!series?.mangaId || !translator?.translatorId) {
    return false;
  }

  const translatorPaths = buildTranslatorPaths(series.mangaId, translator.translatorId);
  const storyContext = readJsonIfExists(translatorPaths.storyContextPath);
  const chapterEntries = Object.entries(storyContext?.chapters || {});
  if (chapterEntries.length === 0) {
    return false;
  }

  const existingIds = new Set((translator.chapters || []).map((entry) => entry.chapterId));
  let changed = false;

  for (const [chapterKey, chapterValue] of chapterEntries) {
    const chapter = chapterValue && typeof chapterValue === "object" ? chapterValue : {};
    const referenceSetId =
      Array.isArray(chapter.referenceSetIds) && chapter.referenceSetIds.length > 0
        ? chapter.referenceSetIds[0]
        : chapterKey.startsWith("reference_")
          ? chapterKey.slice("reference_".length)
          : null;
    const chapterTitle =
      typeof chapter.chapterTitle === "string" && chapter.chapterTitle.trim()
        ? chapter.chapterTitle.trim()
        : resolveReferenceManifestLabel(referenceSetId) || chapterKey;
    const chapterId =
      typeof chapter.chapterId === "string" && isValidChapterId(chapter.chapterId)
        ? chapter.chapterId
        : normalizeSystemId("chapter", referenceSetId || chapterTitle || chapterKey);

    if (!chapterId || existingIds.has(chapterId)) {
      continue;
    }

    translator.chapters.push(
      normalizeChapter(
        {
          chapterId,
          chapterTitle,
          sortOrder: (translator.chapters || []).length,
          createdAt: chapter.updatedAt || nowIso(),
          updatedAt: chapter.updatedAt || nowIso(),
        },
        (translator.chapters || []).length
      )
    );
    existingIds.add(chapterId);
    changed = true;
  }

  if (changed) {
    translator.chapters = (translator.chapters || [])
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((chapter, indexNumber) => ({
        ...chapter,
        sortOrder: indexNumber,
      }));
    translator.updatedAt = nowIso();
    series.updatedAt = nowIso();
  }

  return changed;
}

function recoverKnowledgeIndexChapters(index) {
  let changed = false;
  for (const series of index.series || []) {
    for (const translator of series.translators || []) {
      if (recoverTranslatorChaptersFromAssets(series, translator)) {
        changed = true;
      }
    }
  }

  if (changed) {
    writeKnowledgeIndex(index);
  }

  return changed;
}

function listKnowledgeSeries() {
  const index = loadKnowledgeIndex();
  recoverKnowledgeIndexChapters(index);
  return index.series.map((entry) => ({
    mangaId: entry.mangaId,
    label: entry.label,
    language: entry.language || "zh-TW",
    updatedAt: entry.updatedAt || null,
    translators: entry.translators.map((translator) => ({
      translatorId: translator.translatorId,
      label: translator.label,
      language: translator.language || entry.language || "zh-TW",
      profileKind: translator.profileKind || "standard",
      styleSourceTranslatorId: translator.styleSourceTranslatorId || null,
      updatedAt: translator.updatedAt || null,
      chapterCount: Array.isArray(translator.chapters) ? translator.chapters.length : 0,
      chapters: (translator.chapters || [])
        .slice()
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((chapter) => ({
          chapterId: chapter.chapterId,
          chapterTitle: chapter.chapterTitle,
          sortOrder: chapter.sortOrder,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt,
        })),
    })),
  }));
}

function resolveKnowledgePaths({ mangaId = null, translatorId = null } = {}) {
  if (!mangaId) {
    return {
      mangaId: null,
      translatorId: null,
      knowledgeBasePath: paths.knowledgeBase,
      reportPath: paths.reports,
      indexPath: knowledgeIndexPath(),
      mode: "legacy",
    };
  }

  assertValidMangaId(mangaId);

  if (!translatorId) {
    return {
      mangaId,
      translatorId: null,
      knowledgeBasePath: path.join(knowledgeBaseRoot(), "self", mangaId, "knowledge.json"),
      reportPath: path.join(knowledgeBaseRoot(), "reports", mangaId, "extract_report.json"),
      indexPath: knowledgeIndexPath(),
      mode: "scoped",
    };
  }

  assertValidTranslatorId(translatorId);
  const translatorPaths = buildTranslatorPaths(mangaId, translatorId);

  return {
    mangaId,
    translatorId,
    knowledgeBasePath: translatorPaths.knowledgeBasePath,
    reportPath: translatorPaths.reportPath,
    indexPath: knowledgeIndexPath(),
    mode: "translator_scoped",
  };
}

function resolveKnowledgeAssetPaths({ mangaId, translatorId = null }) {
  assertValidMangaId(mangaId);

  if (!translatorId) {
    const baseDir = path.join(knowledgeBaseRoot(), "self", mangaId);
    return {
      mangaId,
      translatorId: null,
      baseDir,
      glossaryPath: path.join(baseDir, "canonical_glossary.json"),
      candidateTermsPath: path.join(baseDir, "candidate_terms.json"),
      storyContextPath: path.join(baseDir, "story_context.json"),
      storyGraphPath: path.join(baseDir, "story_graph.json"),
      socialGraphPath: path.join(baseDir, "social_graph.json"),
      styleEvidencePath: path.join(baseDir, "style_evidence.json"),
      styleProfilePath: path.join(baseDir, "style_profile.json"),
      translationContextPath: path.join(baseDir, "translation_context.json"),
      bilingualEvidencePath: path.join(baseDir, "bilingual_evidence.json"),
      bilingualRunsDir: path.join(baseDir, "bilingual_runs"),
      bilingualCheckpointStoreDir: path.join(baseDir, "bilingual_runs", "checkpoints"),
      bilingualEvidenceLedgerPath: path.join(baseDir, "bilingual_evidence_ledger.json"),
      bilingualLedgerRevisionsDir: path.join(baseDir, "bilingual_ledger_revisions"),
    };
  }

  assertValidTranslatorId(translatorId);
  const translatorPaths = buildTranslatorPaths(mangaId, translatorId);
  return {
    mangaId,
    translatorId,
    baseDir: translatorPaths.baseDir,
    glossaryPath: translatorPaths.glossaryPath,
    candidateTermsPath: translatorPaths.candidateTermsPath,
    storyContextPath: translatorPaths.storyContextPath,
    storyGraphPath: translatorPaths.storyGraphPath,
    socialGraphPath: translatorPaths.socialGraphPath,
    styleEvidencePath: translatorPaths.styleEvidencePath,
    styleProfilePath: translatorPaths.styleProfilePath,
    translationContextPath: translatorPaths.translationContextPath,
    bilingualEvidencePath: translatorPaths.bilingualEvidencePath,
    bilingualRunsDir: translatorPaths.bilingualRunsDir,
    bilingualCheckpointStoreDir: translatorPaths.bilingualCheckpointStoreDir,
    bilingualEvidenceLedgerPath: translatorPaths.bilingualEvidenceLedgerPath,
    bilingualLedgerRevisionsDir: translatorPaths.bilingualLedgerRevisionsDir,
  };
}

function ensureSeriesEntry(index, { mangaId, label = null, language = DEFAULT_LANGUAGE_TAG }) {
  assertValidMangaId(mangaId);
  const resolvedLanguage = normalizeLanguageTag(language);
  let series = getSeriesEntry(index, mangaId);
  if (!series) {
    series = {
      mangaId,
      label: label || mangaId,
      language: resolvedLanguage,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      translators: [],
    };
    index.series.push(series);
    index.series.sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));
  } else {
    if (label && label !== mangaId) {
      series.label = label;
    }
    if (language) {
      series.language = resolvedLanguage;
    }
    series.updatedAt = nowIso();
  }
  return series;
}

function ensureTranslatorProfile(index, { mangaId, translatorId, label = null, language = DEFAULT_LANGUAGE_TAG, profileKind = null, styleSourceTranslatorId = null }) {
  const resolvedLanguage = normalizeLanguageTag(language);
  const series = ensureSeriesEntry(index, { mangaId, language: resolvedLanguage });
  assertValidTranslatorId(translatorId);

  let translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    const translatorPaths = buildTranslatorPaths(mangaId, translatorId);
    translator = {
      translatorId,
      label: label || translatorId,
      language: resolvedLanguage,
      profileKind: profileKind === "learning_clone" ? "learning_clone" : "standard",
      styleSourceTranslatorId: styleSourceTranslatorId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      knowledgePath: toRelativeProjectPath(translatorPaths.knowledgeBasePath),
      reportPath: toRelativeProjectPath(translatorPaths.reportPath),
      chapters: [],
    };
    series.translators.push(translator);
    series.translators.sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));
  } else {
    if (label) {
      translator.label = label;
    }
    if (language) {
      translator.language = resolvedLanguage;
    }
    if (profileKind === "learning_clone") translator.profileKind = "learning_clone";
    if (styleSourceTranslatorId) translator.styleSourceTranslatorId = styleSourceTranslatorId;
    translator.updatedAt = nowIso();
  }

  series.updatedAt = nowIso();
  return translator;
}

function createMangaRecord({ label, language = DEFAULT_LANGUAGE_TAG }) {
  const mangaId = normalizeSystemId("manga", label);
  assertValidMangaId(mangaId);
  const index = loadKnowledgeIndex();
  if (getSeriesEntry(index, mangaId)) {
    const existing = ensureSeriesEntry(index, {
      mangaId,
      label,
      language: normalizeLanguageTag(language),
    });
    writeKnowledgeIndex(index);
    return existing;
  }

  const created = ensureSeriesEntry(index, { mangaId, label, language: normalizeLanguageTag(language) });
  writeKnowledgeIndex(index);
  return created;
}

function reconcileReferenceBindings(bindings) {
  const ordered = (Array.isArray(bindings) ? bindings : [])
    .filter((entry) => entry?.mangaId && entry?.translatorId && entry?.chapterId)
    .slice()
    .sort((left, right) => {
      const scope = `${left.mangaId}/${left.translatorId}`.localeCompare(
        `${right.mangaId}/${right.translatorId}`
      );
      if (scope !== 0) return scope;
      return String(left.chapterTitle || left.chapterId).localeCompare(
        String(right.chapterTitle || right.chapterId),
        undefined,
        { numeric: true, sensitivity: "base" }
      );
    });
  for (const binding of ordered) {
    syncMangaManagementBinding({
      mangaId: binding.mangaId,
      label: binding.mangaLabel && binding.mangaLabel !== binding.mangaId
        ? binding.mangaLabel
        : null,
      language: binding.language || DEFAULT_LANGUAGE_TAG,
      translatorId: binding.translatorId,
      translatorLabel: binding.translatorLabel || binding.translatorId,
      chapterId: binding.chapterId,
      chapterTitle: binding.chapterTitle || null,
    });
  }
  return listKnowledgeSeries();
}

function createTranslatorProfile({ mangaId, label, language = DEFAULT_LANGUAGE_TAG, styleSourceTranslatorId = null }) {
  assertValidMangaId(mangaId);
  const translatorId = normalizeSystemId("translator", label);
  assertValidTranslatorId(translatorId);
  const index = loadKnowledgeIndex();
  const existing = getTranslatorEntry(index, mangaId, translatorId);
  if (existing) {
    if (
      styleSourceTranslatorId &&
      (existing.profileKind !== "learning_clone" ||
        existing.styleSourceTranslatorId !== styleSourceTranslatorId)
    ) {
      throw new Error(
        `Translator profile ${translatorId} already exists and is not the requested learning clone.`
      );
    }
    return existing;
  }
  if (styleSourceTranslatorId) {
    assertValidTranslatorId(styleSourceTranslatorId);
    if (!getTranslatorEntry(index, mangaId, styleSourceTranslatorId)) {
      throw new Error(`Style source translator profile not found: ${styleSourceTranslatorId}`);
    }
    if (styleSourceTranslatorId === translatorId) {
      throw new Error("A learning clone cannot use itself as its style source.");
    }
  }

  const created = ensureTranslatorProfile(index, {
    mangaId,
    translatorId,
    label,
    language: normalizeLanguageTag(language),
    profileKind: styleSourceTranslatorId ? "learning_clone" : "standard",
    styleSourceTranslatorId,
  });
  writeKnowledgeIndex(index);
  return created;
}

function listTranslatorProfiles(mangaId) {
  assertValidMangaId(mangaId);
  const entry = getSeriesEntry(loadKnowledgeIndex(), mangaId);
  return entry ? entry.translators : [];
}

function listChapterRegistry({ mangaId, translatorId }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  const translator = getTranslatorEntry(loadKnowledgeIndex(), mangaId, translatorId);
  return translator ? (translator.chapters || []).slice().sort((left, right) => left.sortOrder - right.sortOrder) : [];
}

function createChapterRecord({ mangaId, translatorId, chapterTitle = null }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  const chapterId = normalizeSystemId("chapter", chapterTitle || `chapter_${Date.now()}`);
  assertValidChapterId(chapterId);
  const index = loadKnowledgeIndex();
  const translator = ensureTranslatorProfile(index, {
    mangaId,
    translatorId,
  });
  const existing = (translator.chapters || []).find((chapter) => chapter.chapterId === chapterId);
  if (existing) {
    return existing;
  }

  const nextChapter = normalizeChapter(
    {
      chapterId,
      chapterTitle,
      sortOrder: (translator.chapters || []).length,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    (translator.chapters || []).length
  );
  translator.chapters.push(nextChapter);
  translator.chapters = translator.chapters
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((chapter, indexNumber) => ({
      ...chapter,
      sortOrder: indexNumber,
    }));
  translator.updatedAt = nowIso();
  const series = getSeriesEntry(index, mangaId);
  if (series) {
    series.updatedAt = nowIso();
  }
  writeKnowledgeIndex(index);
  return nextChapter;
}

function updateChapterRecord({ mangaId, translatorId, chapterId, chapterTitle = null }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  assertValidChapterId(chapterId);
  const index = loadKnowledgeIndex();
  const translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    throw new Error(`Translator profile not found: ${translatorId}`);
  }
  const chapter = (translator.chapters || []).find((entry) => entry.chapterId === chapterId);
  if (!chapter) {
    throw new Error(`Chapter not found: ${chapterId}`);
  }
  chapter.chapterTitle =
    typeof chapterTitle === "string" && chapterTitle.trim() ? chapterTitle.trim() : null;
  chapter.updatedAt = nowIso();
  translator.updatedAt = nowIso();
  const series = getSeriesEntry(index, mangaId);
  if (series) {
    series.updatedAt = nowIso();
  }
  writeKnowledgeIndex(index);
  return chapter;
}

function reorderChapterRegistry({ mangaId, translatorId, orderedChapterIds }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  if (!Array.isArray(orderedChapterIds) || orderedChapterIds.length === 0) {
    throw new Error("orderedChapterIds must be a non-empty array.");
  }

  const index = loadKnowledgeIndex();
  const translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    throw new Error(`Translator profile not found: ${translatorId}`);
  }

  const current = translator.chapters || [];
  const currentIds = current.map((chapter) => chapter.chapterId);
  if (
    currentIds.length !== orderedChapterIds.length ||
    currentIds.some((chapterId) => !orderedChapterIds.includes(chapterId))
  ) {
    throw new Error("orderedChapterIds must contain the same chapter ids as the current registry.");
  }

  const chapterMap = new Map(current.map((chapter) => [chapter.chapterId, chapter]));
  translator.chapters = orderedChapterIds.map((chapterId, indexNumber) => ({
    ...chapterMap.get(chapterId),
    sortOrder: indexNumber,
    updatedAt: nowIso(),
  }));
  translator.updatedAt = nowIso();
  const series = getSeriesEntry(index, mangaId);
  if (series) {
    series.updatedAt = nowIso();
  }
  writeKnowledgeIndex(index);
  return translator.chapters;
}

function deleteChapterRecord({ mangaId, translatorId, chapterId }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  assertValidChapterId(chapterId);
  const index = loadKnowledgeIndex();
  const translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    throw new Error(`Translator profile not found: ${translatorId}`);
  }
  const nextChapters = (translator.chapters || []).filter((entry) => entry.chapterId !== chapterId);
  if (nextChapters.length === (translator.chapters || []).length) {
    throw new Error(`Chapter not found: ${chapterId}`);
  }
  translator.chapters = nextChapters.map((chapter, indexNumber) => ({
    ...chapter,
    sortOrder: indexNumber,
    updatedAt: nowIso(),
  }));
  translator.updatedAt = nowIso();
  const series = getSeriesEntry(index, mangaId);
  if (series) {
    series.updatedAt = nowIso();
  }
  writeKnowledgeIndex(index);
  postEditWorkspaceModule.deleteByBinding({ mangaId, translatorId, chapterId });
  return {
    mangaId,
    translatorId,
    chapterId,
    deleted: true,
  };
}

function deleteTranslatorProfile({ mangaId, translatorId }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  const index = loadKnowledgeIndex();
  const series = getSeriesEntry(index, mangaId);
  if (!series) {
    throw new Error(`Manga not found: ${mangaId}`);
  }
  const translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    throw new Error(`Translator profile not found: ${translatorId}`);
  }
  series.translators = (series.translators || []).filter((entry) => entry.translatorId !== translatorId);
  series.updatedAt = nowIso();
  writeKnowledgeIndex(index);
  const deletedPostEditDocuments = postEditWorkspaceModule.deleteByBinding({ mangaId, translatorId });

  const translatorPaths = buildTranslatorPaths(mangaId, translatorId);
  fs.rmSync(translatorPaths.baseDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(translatorPaths.reportPath), { recursive: true, force: true });

  return {
    mangaId,
    translatorId,
    label: translator.label,
    deletedPostEditDocuments,
    deleted: true,
  };
}

function clearTranslatorIngestionData({ mangaId, translatorId }) {
  assertValidMangaId(mangaId);
  assertValidTranslatorId(translatorId);
  const index = loadKnowledgeIndex();
  const series = getSeriesEntry(index, mangaId);
  if (!series) {
    throw new Error(`Manga not found: ${mangaId}`);
  }
  const translator = getTranslatorEntry(index, mangaId, translatorId);
  if (!translator) {
    throw new Error(`Translator profile not found: ${translatorId}`);
  }

  const translatorPaths = buildTranslatorPaths(mangaId, translatorId);
  fs.rmSync(translatorPaths.baseDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(translatorPaths.reportPath), { recursive: true, force: true });

  translator.updatedAt = nowIso();
  series.updatedAt = nowIso();
  writeKnowledgeIndex(index);

  return {
    mangaId,
    translatorId,
    label: translator.label,
    deleted: true,
    clearedKnowledgeBaseDir: translatorPaths.baseDir,
    clearedReportDir: path.dirname(translatorPaths.reportPath),
  };
}

function deleteMangaRecord({ mangaId }) {
  assertValidMangaId(mangaId);
  const index = loadKnowledgeIndex();
  const series = getSeriesEntry(index, mangaId);
  if (!series) {
    throw new Error(`Manga not found: ${mangaId}`);
  }
  index.series = index.series.filter((entry) => entry.mangaId !== mangaId);
  writeKnowledgeIndex(index);
  const deletedPostEditDocuments = postEditWorkspaceModule.deleteByBinding({ mangaId });

  const mangaPaths = buildMangaPaths(mangaId);
  fs.rmSync(mangaPaths.selfDir, { recursive: true, force: true });
  fs.rmSync(mangaPaths.reportsDir, { recursive: true, force: true });

  return {
    mangaId,
    label: series.label,
    deletedPostEditDocuments,
    deleted: true,
  };
}

function upsertKnowledgeIndexEntry({
  mangaId,
  translatorId = null,
  label = null,
  translatorLabel = null,
  language = "zh-TW",
  knowledgeBasePath,
  reportPath,
  chapterId = null,
  chapterTitle = null,
}) {
  assertValidMangaId(mangaId);
  const index = loadKnowledgeIndex();
  const resolvedTranslatorId = translatorId || DEFAULT_TRANSLATOR_ID;
  const translator = ensureTranslatorProfile(index, {
    mangaId,
    translatorId: resolvedTranslatorId,
    label: translatorLabel || (resolvedTranslatorId === DEFAULT_TRANSLATOR_ID ? DEFAULT_TRANSLATOR_LABEL : resolvedTranslatorId),
    language,
  });
  const series = ensureSeriesEntry(index, { mangaId, label, language });

  if (knowledgeBasePath) {
    translator.knowledgePath = toRelativeProjectPath(knowledgeBasePath);
  }
  if (reportPath) {
    translator.reportPath = toRelativeProjectPath(reportPath);
  }
  translator.updatedAt = nowIso();
  series.updatedAt = nowIso();

  if (chapterId) {
    assertValidChapterId(chapterId);
    const existingChapter = (translator.chapters || []).find((entry) => entry.chapterId === chapterId);
    if (existingChapter) {
      if (chapterTitle && chapterTitle.trim()) {
        existingChapter.chapterTitle = chapterTitle.trim();
      }
      existingChapter.updatedAt = nowIso();
    } else {
      translator.chapters.push(
        normalizeChapter(
          {
            chapterId,
            chapterTitle,
            sortOrder: (translator.chapters || []).length,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
          (translator.chapters || []).length
        )
      );
    }
  }

  translator.chapters = (translator.chapters || [])
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((chapter, indexNumber) => ({
      ...chapter,
      sortOrder: indexNumber,
    }));

  writeKnowledgeIndex(index);
  return {
    mangaId,
    label: series.label,
    translatorId: translator.translatorId,
    translatorLabel: translator.label,
    language: translator.language,
    knowledgePath: translator.knowledgePath,
    reportPath: translator.reportPath,
    updatedAt: translator.updatedAt,
  };
}

function syncMangaManagementBinding({
  mangaId,
  label = null,
  language = "zh-TW",
  translatorId = null,
  translatorLabel = null,
  chapterId = null,
  chapterTitle = null,
  profileKind = null,
  styleSourceTranslatorId = null,
}) {
  assertValidMangaId(mangaId);
  const index = loadKnowledgeIndex();
  const series = ensureSeriesEntry(index, { mangaId, label, language });

  let translator = null;
  if (translatorId) {
    translator = ensureTranslatorProfile(index, {
      mangaId,
      translatorId,
      label: translatorLabel || translatorId,
      language,
      profileKind,
      styleSourceTranslatorId,
    });

    if (chapterId) {
      assertValidChapterId(chapterId);
      const existingChapter = (translator.chapters || []).find((entry) => entry.chapterId === chapterId);
      if (existingChapter) {
        if (chapterTitle && chapterTitle.trim()) {
          existingChapter.chapterTitle = chapterTitle.trim();
        }
        existingChapter.updatedAt = nowIso();
      } else {
        translator.chapters.push(
          normalizeChapter(
            {
              chapterId,
              chapterTitle,
              sortOrder: (translator.chapters || []).length,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            },
            (translator.chapters || []).length
          )
        );
      }
      translator.chapters = (translator.chapters || [])
        .slice()
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((chapter, indexNumber) => ({
          ...chapter,
          sortOrder: indexNumber,
        }));
      translator.updatedAt = nowIso();
    }
  }

  series.updatedAt = nowIso();
  writeKnowledgeIndex(index);
  return {
    mangaId,
    label: series.label,
    translatorId: translator?.translatorId || null,
    translatorLabel: translator?.label || null,
    chapterId: chapterId || null,
    chapterTitle: chapterTitle || null,
  };
}

module.exports = {
  DEFAULT_TRANSLATOR_ID,
  DEFAULT_TRANSLATOR_LABEL,
  assertValidChapterId,
  assertValidMangaId,
  assertValidTranslatorId,
  createChapterRecord,
  createMangaRecord,
  createTranslatorProfile,
  clearTranslatorIngestionData,
  deleteChapterRecord,
  deleteMangaRecord,
  deleteTranslatorProfile,
  ensureKnowledgeIndex,
  isValidChapterId,
  isValidMangaId,
  isValidTranslatorId,
  knowledgeIndexPath,
  listChapterRegistry,
  listKnowledgeSeries,
  listTranslatorProfiles,
  loadKnowledgeIndex,
  normalizeSystemId,
  reorderChapterRegistry,
  reconcileReferenceBindings,
  resolveKnowledgeAssetPaths,
  resolveKnowledgePaths,
  syncMangaManagementBinding,
  toRelativeProjectPath,
  updateChapterRecord,
  upsertKnowledgeIndexEntry,
  writeKnowledgeIndex,
};
