const {
  loadExtractedTexts,
  loadReferenceManifest,
} = require("./reference_sets");
const fs = require("fs");
const path = require("path");
const { normalizeLanguageTag } = require("../language_codes");
const {
  buildReferenceIngestionReport,
  buildStoryContextChapter,
  buildTranslatorReferenceContextChapter,
  collectReferenceLines,
} = require("./reference_ingestion_story");
const {
  isBlockedGenericSourceTerm,
  isLikelyOriginalTranslatorLabel,
  normalizeReferenceCategory,
} = require("./reference_ingestion_terms");
const {
  buildTranslationContext,
  defaultCanonicalGlossary,
  defaultSocialGraph,
  defaultStoryGraph,
  defaultStoryContext,
  defaultStyleProfile,
  createStoryGraphFromContext,
  deriveSocialGraphFromStoryGraph,
  formatTranslationSystemPrompt,
  loadCanonicalGlossary,
  loadCandidateTerms,
  loadSocialGraph,
  loadStoryGraph,
  loadStoryContext,
  loadStyleProfile,
  loadStyleEvidence,
  mergeCanonicalGlossary,
  mergeCandidateTerms,
  mergeStoryGraph,
  mergeStoryContext,
  mergeStyleEvidence,
  buildStyleProfileFromEvidence,
  stableId,
  writeCanonicalGlossary,
  writeCandidateTerms,
  writeSocialGraph,
  writeStoryGraph,
  writeStoryContext,
  writeStyleProfile,
  writeStyleEvidence,
  writeTranslationContext,
} = require("./knowledge_assets");
const { resolveKnowledgePaths, syncMangaManagementBinding } = require("./knowledge_paths");
const {
  buildRoleAwareObservationNodes,
  buildStoryNodesFromObservation,
  ensureChapterObservation,
  loadChapterObservation,
  observationAsExtractionResult,
  observationAsRoleView,
} = require("./reference_observation");

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writePhaseArtifact(filePath, value) {
  if (!filePath) {
    throw new Error("Reference ingestion phase requires an artifact path.");
  }
  ensureParentDir(filePath);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

function readPhaseArtifact(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} artifact not found: ${filePath || "not configured"}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPhaseArtifactBinding(artifact, { referenceSetId, chapterId }, label) {
  if (artifact?.referenceSetId !== referenceSetId || artifact?.chapterId !== chapterId) {
    throw new Error(
      `${label} artifact binding mismatch: expected ${referenceSetId}/${chapterId}.`
    );
  }
}

function buildCompactStoryMemory(storyContext) {
  const global = storyContext?.global || {};
  const chapters = Object.values(storyContext?.chapters || {})
    .sort((left, right) => String(left?.updatedAt || "").localeCompare(String(right?.updatedAt || "")))
    .slice(-3)
    .map((chapter) => ({
      chapterId: chapter?.chapterId || null,
      events: (chapter?.events || []).slice(-3),
      relationships: (chapter?.relationships || []).slice(-3),
      characterStates: (chapter?.characterStates || []).slice(-3),
      openThreads: (chapter?.openThreads || []).slice(-2),
    }));
  return {
    characters: (global.characters || []).slice(-20),
    terminology: (global.terminology || []).slice(-20),
    relationships: (global.relationships || []).slice(-12),
    events: (global.events || []).slice(-12),
    characterStates: (global.characterStates || []).slice(-12),
    openThreads: (global.openThreads || []).slice(-8),
    recentChapters: chapters,
  };
}

function buildGlossaryCandidates(referenceKind, referenceSetId, chapterId, terminology, characters) {
  const termEntries = terminology.map((entry) => ({
    term_id: stableId(
      "term",
      `${entry.category}::${entry.source_term || entry.term || ""}::${entry.translation || entry.term || ""}`
    ),
    entity_type: "term",
    reference_kind: referenceKind,
    source_term: entry.source_term || entry.term || null,
    canonical_form:
      referenceKind === "source"
        ? entry.source_term || entry.term || null
        : entry.source_term || entry.term || entry.translation || null,
    target_rendering: referenceKind === "source" ? null : entry.translation || entry.term || null,
    canonical_translation: referenceKind === "source" ? null : entry.translation || entry.term,
    source_aliases: [...new Set((entry.source_aliases || []).filter(Boolean))],
    aliases: [...new Set((entry.aliases || []).filter(Boolean))],
    rendering_hints:
      entry.rendering_hints && typeof entry.rendering_hints === "object"
        ? entry.rendering_hints
        : {},
    category: normalizeReferenceCategory(entry.term, entry.category),
    source: "reference",
    locked: false,
    updated_at: new Date().toISOString(),
    confidence: entry.confidence,
    examples: entry.examples || [],
    provenance: {
      referenceSetId,
      chapterId: chapterId || null,
    },
  }));

  const characterEntries = characters.map((entry) => ({
    term_id: stableId("term", `character_name::${entry.name}`),
    entity_type: "character",
    reference_kind: referenceKind,
    source_term: entry.source_name || entry.source_term || null,
    canonical_form:
      referenceKind === "source"
        ? entry.source_name || entry.source_term || entry.name || null
        : entry.source_name || entry.source_term || entry.name || null,
    target_rendering: referenceKind === "source" ? null : entry.name,
    canonical_translation: referenceKind === "source" ? null : entry.name,
    source_aliases: [...new Set((entry.source_aliases || []).filter(Boolean))],
    aliases: entry.aliases || [],
    rendering_hints: {
      title_forms: entry.title_forms || [],
    },
    category: "character_name",
    source: "reference",
    locked: false,
    updated_at: new Date().toISOString(),
    confidence: entry.confidence,
    examples: entry.example_lines || [],
    provenance: {
      referenceSetId,
      chapterId: chapterId || null,
    },
  }));

  return {
    termEntries,
    characterEntries,
    mergedEntries: [...termEntries, ...characterEntries],
  };
}

function resolveReferenceChapterBinding(referenceSetId, manifest, chapterId, chapterTitle) {
  const resolvedChapterTitle =
    typeof chapterTitle === "string" && chapterTitle.trim()
      ? chapterTitle.trim()
      : typeof manifest?.label === "string" && manifest.label.trim()
        ? manifest.label.trim()
        : null;

  const resolvedChapterId =
    typeof chapterId === "string" && chapterId.trim()
      ? chapterId.trim()
      : stableId("chapter", resolvedChapterTitle || referenceSetId);

  return {
    chapterId: resolvedChapterId,
    chapterTitle: resolvedChapterTitle,
  };
}

function buildReferenceLanguageContext(manifest) {
  const referenceKind = manifest?.referenceKind === "source" ? "source" : "translator";
  const contentLanguage = normalizeLanguageTag(manifest?.language || "ja-JP");
  const sourceLanguage = referenceKind === "source" ? contentLanguage : "ja-JP";
  const targetLanguage = referenceKind === "translator" ? contentLanguage : null;

  return {
    referenceKind,
    contentLanguage,
    sourceLanguage,
    targetLanguage,
    fieldLanguagePolicy: {
      keys: "english_only",
      enums: "english_only",
      evidenceLine: "contentLanguage",
      surfaceForm: "contentLanguage",
      sourceTerm: referenceKind === "source" ? "contentLanguage" : "sourceLanguage",
      sourceName: referenceKind === "source" ? "contentLanguage" : "sourceLanguage",
      canonicalForm: referenceKind === "source" ? "contentLanguage" : "sourceLanguage",
      canonicalTranslation:
        referenceKind === "translator" ? "targetLanguage_when_supported_else_sourceLanguage" : "contentLanguage",
      targetRendering: referenceKind === "translator" ? "targetLanguage" : "null",
      notes: "english_or_contentLanguage",
    },
  };
}

class ReferenceIngestionModule {
  constructor(aoTaskRunner = null) {
    this.aoTaskRunner = aoTaskRunner;
  }

  buildTranslationContext(args) {
    return buildTranslationContext(args);
  }

  formatTranslationSystemPrompt(context) {
    return formatTranslationSystemPrompt(context);
  }

  async run({
    referenceSetId,
    mangaId,
    mangaLabel = null,
    translatorId = null,
    translatorLabel = null,
    chapterId = null,
    chapterTitle = null,
    glossaryMode = "canonical",
    useForTerminology = true,
    useForStyle = true,
    analysisDepth = "quick_read",
    phase = "full",
    analysisArtifactPath = null,
    storyArtifactPath = null,
    onProgress = null,
    isCanceled = null,
  }) {
    if (
      (phase === "analysis" || phase === "full") &&
      (!this.aoTaskRunner || typeof this.aoTaskRunner.runChapterObservation !== "function")
    ) {
      throw new Error("ReferenceIngestionModule requires aoTaskRunner.runChapterObservation().");
    }
    if (!useForTerminology && !useForStyle) {
      throw new Error("Reference ingestion requires terminology or style usage to be enabled.");
    }
    const reportProgress = (stage, detail = {}) => {
      if (typeof onProgress === "function") {
        onProgress({ stage, referenceSetId, ...detail });
      }
    };
    const throwIfCanceled = () => {
      if (typeof isCanceled === "function" && isCanceled()) {
        throw new Error("Reference ingestion canceled by user.");
      }
    };

    throwIfCanceled();
    reportProgress("reference_ingestion.memory", { percent: 2 });
    const manifest = loadReferenceManifest(referenceSetId);
    const resolvedBinding = resolveReferenceChapterBinding(
      referenceSetId,
      manifest,
      chapterId,
      chapterTitle
    );
    syncMangaManagementBinding({
      mangaId,
      label: mangaLabel || null,
      translatorId,
      translatorLabel: translatorLabel || translatorId,
      language: manifest.language || "zh-TW",
      chapterId: resolvedBinding.chapterId,
      chapterTitle: resolvedBinding.chapterTitle,
    });
    const extractedTexts = loadExtractedTexts(referenceSetId);
    const preferTranslatedLines = manifest.referenceKind !== "source";
    const rawReferenceLines = collectReferenceLines(extractedTexts, {
      preferTranslated: preferTranslatedLines,
      filterNoise: false,
    });
    const cleanReferenceLines = collectReferenceLines(extractedTexts, {
      preferTranslated: preferTranslatedLines,
      filterNoise: true,
    });
    const isSourceReference = manifest.referenceKind === "source";
    const existingGlossary = loadCanonicalGlossary(mangaId, translatorId) || defaultCanonicalGlossary(mangaId);
    const existingCandidateTerms = loadCandidateTerms(mangaId, translatorId);
    const existingSocialGraph = loadSocialGraph(mangaId, translatorId) || defaultSocialGraph(mangaId);
    const existingStoryContext = loadStoryContext(mangaId, translatorId) || defaultStoryContext(mangaId);
    const existingStoryGraph = loadStoryGraph(mangaId, translatorId) || defaultStoryGraph(mangaId);
    const existingStyleEvidence = loadStyleEvidence(mangaId, translatorId);
    const existingStyleProfile = loadStyleProfile(mangaId, translatorId) || defaultStyleProfile(mangaId);
    const effectiveGlossaryMode = useForTerminology ? glossaryMode : "disabled";
    const languageContext = buildReferenceLanguageContext(manifest);
    const effectiveUseForStyle =
      useForStyle &&
      !isLikelyOriginalTranslatorLabel(translatorLabel) &&
      manifest.referenceKind !== "source";
    const effectiveUseForStyleEvidence = useForStyle;
    const effectiveAnalysisDepth = analysisDepth === "deep_read" ? "deep_read" : "quick_read";
    let chapterObservationView = null;
    let storySourceTexts = extractedTexts;
    let taskSessionId = null;
    let extractionResult;
    let storyDeltaResult = null;
    let chapterObservation = null;
    let observationPath = null;
    if (phase === "story") {
      const analysisArtifact = readPhaseArtifact(analysisArtifactPath, "Reference ingestion analysis");
      assertPhaseArtifactBinding(analysisArtifact, {
        referenceSetId,
        chapterId: resolvedBinding.chapterId,
      }, "Reference ingestion analysis");
      extractionResult = analysisArtifact.extractionResult;
      chapterObservation = loadChapterObservation(referenceSetId);
      if (!chapterObservation || chapterObservation.revisionId !== analysisArtifact.observationRevisionId) {
        throw new Error("Story update requires the exact Observation revision from the observation phase.");
      }
      chapterObservationView = chapterObservation
        ? observationAsRoleView(chapterObservation)
        : null;
      if (!isSourceReference || !chapterObservation) {
        throw new Error("Story update requires a source chapter observation from the observation phase.");
      }
      if (typeof this.aoTaskRunner.runStoryContextUpdate !== "function") {
        throw new Error("Story phase requires aoTaskRunner.runStoryContextUpdate().");
      }
      try {
        if (typeof this.aoTaskRunner.createTaskSession === "function") {
          taskSessionId = await this.aoTaskRunner.createTaskSession(
            `reference_ingestion:${referenceSetId}:story`,
            "reference_ingestion_story"
          );
        }
        reportProgress("reference_ingestion.story", { percent: 20 });
        storyDeltaResult = await this.aoTaskRunner.runStoryContextUpdate({
          jobId: `reference_ingestion:${referenceSetId}:story`,
          chapterId: resolvedBinding.chapterId,
          chapterTitle: resolvedBinding.chapterTitle,
          contentLanguage: languageContext.contentLanguage,
          analysisDepth: "observation_first_pass",
          sourceNodes: chapterObservation
            ? buildStoryNodesFromObservation(chapterObservation, extractedTexts)
            : [],
          storyCues: chapterObservation?.storyCues || [],
          existingMemory: buildCompactStoryMemory(existingStoryContext),
          chapterTerminology: extractionResult.terminologyEntries || [],
          chapterCharacters: extractionResult.characterEntries || [],
        }, taskSessionId ? {
          conversationId: taskSessionId,
          outputFilePath: "output/story_delta_result.txt",
          isCanceled,
          onProgress: (status) => reportProgress("reference_ingestion.story", {
            percent: 20,
            ...status,
          }),
        } : undefined);
        throwIfCanceled();
      } finally {
        if (taskSessionId && typeof this.aoTaskRunner.closeTaskSession === "function") {
          await this.aoTaskRunner.closeTaskSession(taskSessionId);
        }
      }
      writePhaseArtifact(storyArtifactPath, {
        schemaVersion: 1,
        referenceSetId,
        chapterId: resolvedBinding.chapterId,
        storyDeltaResult,
      });
      reportProgress("reference_ingestion.story.completed", { percent: 100 });
      return {
        phase: "story",
        referenceSetId,
        mangaId,
        translatorId,
        chapterId: resolvedBinding.chapterId,
        chapterTitle: resolvedBinding.chapterTitle,
        storyArtifactPath,
      };
    }

    if (phase === "commit") {
      const analysisArtifact = readPhaseArtifact(analysisArtifactPath, "Reference ingestion analysis");
      assertPhaseArtifactBinding(analysisArtifact, {
        referenceSetId,
        chapterId: resolvedBinding.chapterId,
      }, "Reference ingestion analysis");
      extractionResult = analysisArtifact.extractionResult;
      chapterObservation = loadChapterObservation(referenceSetId);
      if (!chapterObservation || chapterObservation.revisionId !== analysisArtifact.observationRevisionId) {
        throw new Error("Knowledge commit requires the exact Observation revision from the observation phase.");
      }
      chapterObservationView = chapterObservation
        ? observationAsRoleView(chapterObservation)
        : null;
      if (isSourceReference) {
        const storyArtifact = readPhaseArtifact(storyArtifactPath, "Reference ingestion story");
        assertPhaseArtifactBinding(storyArtifact, {
          referenceSetId,
          chapterId: resolvedBinding.chapterId,
        }, "Reference ingestion story");
        storyDeltaResult = storyArtifact.storyDeltaResult || null;
      }
    } else try {
      reportProgress("reference_ingestion.observation", { percent: 8 });
      const observationResult = await ensureChapterObservation({
        aoTaskRunner: this.aoTaskRunner,
        referenceSetId,
        chapterId: resolvedBinding.chapterId,
        chapterTitle: resolvedBinding.chapterTitle,
        glossary: existingGlossary,
        storyContext: existingStoryContext,
        isCanceled,
        onProgress: (status) => reportProgress("reference_ingestion.observation", {
          percent: 8,
          ...status,
        }),
      });
      chapterObservation = observationResult.observation;
      observationPath = observationResult.observationPath;
      chapterObservationView = observationAsRoleView(chapterObservation);
      extractionResult = useForTerminology
        ? observationAsExtractionResult(chapterObservation)
        : {
            terminologyEntries: [],
            characterEntries: [],
            candidateEntries: [],
            rejectedEntries: [],
            observationRevisionId: chapterObservation.revisionId,
          };
      reportProgress(observationResult.reused
        ? "reference_ingestion.observation.reused"
        : "reference_ingestion.observation.completed", { percent: 68 });
      reportProgress("reference_ingestion.terminology_from_observation", { percent: 70 });
      if (
        phase === "full" &&
        isSourceReference &&
        useForTerminology &&
        chapterObservationView &&
        typeof this.aoTaskRunner.runStoryContextUpdate === "function"
      ) {
        reportProgress("reference_ingestion.story", { percent: 78 });
        storyDeltaResult = await this.aoTaskRunner.runStoryContextUpdate({
          jobId: `reference_ingestion:${referenceSetId}:story`,
          chapterId: resolvedBinding.chapterId,
          chapterTitle: resolvedBinding.chapterTitle,
          contentLanguage: languageContext.contentLanguage,
          analysisDepth: effectiveAnalysisDepth,
          sourceNodes: buildStoryNodesFromObservation(chapterObservation, extractedTexts),
          storyCues: chapterObservation.storyCues || [],
          existingMemory: buildCompactStoryMemory(existingStoryContext),
          chapterTerminology: extractionResult.terminologyEntries || [],
          chapterCharacters: extractionResult.characterEntries || [],
        }, {
          conversationId: taskSessionId,
          outputFilePath: "output/story_delta_result.txt",
          isCanceled,
        });
        throwIfCanceled();
      }
    } finally {
      if (taskSessionId && typeof this.aoTaskRunner.closeTaskSession === "function") {
        await this.aoTaskRunner.closeTaskSession(taskSessionId);
      }
    }

    if (phase === "analysis") {
      writePhaseArtifact(analysisArtifactPath, {
        schemaVersion: 1,
        referenceSetId,
        chapterId: resolvedBinding.chapterId,
        referenceKind: manifest.referenceKind || "translator",
        analysisDepth: effectiveAnalysisDepth,
        extractionResult,
        observationRevisionId: chapterObservation.revisionId,
        observationPath,
      });
      reportProgress("reference_ingestion.analysis.completed", { percent: 100 });
      return {
        phase: "analysis",
        referenceSetId,
        mangaId,
        translatorId,
        chapterId: resolvedBinding.chapterId,
        chapterTitle: resolvedBinding.chapterTitle,
        analysisArtifactPath,
        observationPath,
      };
    }

    throwIfCanceled();
    reportProgress("reference_ingestion.merge", { percent: 82 });
    const extraction = storyDeltaResult
      ? {
          ...extractionResult,
          observedEvents: storyDeltaResult.observedEvents,
          observedRelations: storyDeltaResult.observedRelations,
          keyLines: [],
          characterStates: storyDeltaResult.characterStates,
          openThreads: storyDeltaResult.openThreads,
          storyDeltaApplied: true,
          storyDeltaNotes: storyDeltaResult.notes,
        }
      : extractionResult;

    const filteredTerminology = (extraction.terminologyEntries || [])
      .map((entry) => ({
        ...entry,
        term: entry.term,
        translation: entry.translation || entry.term,
        category: normalizeReferenceCategory(entry.translation || entry.term, entry.category),
      }))
      .filter(
        (entry) =>
          (entry.confidence || 0) >= 0.67 &&
          !["general_term"].includes(normalizeReferenceCategory(entry.translation || entry.term, entry.category)) &&
          !(isSourceReference && isBlockedGenericSourceTerm(entry))
      );
    const characterCandidates = (extraction.characterEntries || []).filter(
      (entry) => (entry.confidence || 0) >= 0.68
    );

    const hasTrustedSourceIdentity = isSourceReference;
    const glossaryCandidates = hasTrustedSourceIdentity
      ? buildGlossaryCandidates(
          manifest.referenceKind || "translator",
          referenceSetId,
          resolvedBinding.chapterId,
          filteredTerminology,
          characterCandidates
        )
      : { termEntries: [], characterEntries: [], mergedEntries: [] };
    const targetOnlyCandidateEntries = !isSourceReference && !hasTrustedSourceIdentity
      ? [
          ...filteredTerminology.map((entry) => ({
            kind: "term",
            candidate: entry.translation || entry.term,
            observed_form: entry.translation || entry.term,
            canonical_translation: null,
            source_term: null,
            reference_kind: "translator",
            alignment_status: "target_only",
            target_rendering: entry.translation || entry.term,
            confidence: entry.confidence,
            notes: entry.notes || "Target-side observation without confirmed source alignment.",
            status: "candidate",
          })),
          ...characterCandidates.map((entry) => ({
            kind: "character",
            candidate: entry.name,
            observed_form: entry.name,
            canonical_translation: null,
            source_term: null,
            reference_kind: "translator",
            alignment_status: "target_only",
            target_rendering: entry.name,
            confidence: entry.confidence,
            notes: entry.notes || "Target-side character observation without confirmed source alignment.",
            status: "candidate",
          })),
        ]
      : [];
    const candidateEntries = [
      ...targetOnlyCandidateEntries,
      ...((extraction.candidateEntries || []).map((entry) => ({
        ...entry,
        reference_kind: entry.reference_kind || manifest.referenceKind || "translator",
        target_rendering:
          Object.prototype.hasOwnProperty.call(entry, "target_rendering")
            ? entry.target_rendering
            : isSourceReference
              ? null
              : entry.canonical_translation || entry.translation || entry.term || entry.candidate || null,
        status: "candidate",
      }))),
      ...((extraction.rejectedEntries || []).map((entry) => ({
        ...entry,
        reference_kind: entry.reference_kind || manifest.referenceKind || "translator",
        target_rendering:
          Object.prototype.hasOwnProperty.call(entry, "target_rendering")
            ? entry.target_rendering
            : isSourceReference
              ? null
              : entry.canonical_translation || entry.translation || entry.term || entry.candidate || null,
        status: "rejected",
      }))),
    ];

    const chapterKey = resolvedBinding.chapterId;
    const chapterStoryContext =
      manifest.referenceKind === "source"
        ? buildStoryContextChapter(
            resolvedBinding.chapterId,
            referenceSetId,
            manifest.referenceKind || "translator",
            glossaryCandidates.termEntries,
            characterCandidates,
            storySourceTexts,
            existingGlossary,
            existingStoryContext,
            extraction,
            languageContext.contentLanguage
          )
        : buildTranslatorReferenceContextChapter(
            resolvedBinding.chapterId,
            referenceSetId,
            manifest.referenceKind || "translator",
            glossaryCandidates.termEntries,
            characterCandidates
          );
    const nextGlossary = useForTerminology && isSourceReference
      ? mergeCanonicalGlossary(
          existingGlossary,
          glossaryCandidates.mergedEntries,
          resolvedBinding.chapterId,
          referenceSetId
        )
      : existingGlossary;
    const nextStoryContext = useForTerminology && isSourceReference
      ? mergeStoryContext(
          existingStoryContext,
          chapterStoryContext,
          chapterKey,
          resolvedBinding.chapterId,
          referenceSetId
        )
      : existingStoryContext;
    const nextStoryGraph = useForTerminology && isSourceReference
      ? mergeStoryGraph(
            existingStoryGraph,
            createStoryGraphFromContext({
              mangaId,
              chapterId: resolvedBinding.chapterId,
              referenceSetId,
              referenceKind: manifest.referenceKind || "translator",
              chapterContext: chapterStoryContext,
            }),
            resolvedBinding.chapterId,
            referenceSetId
          )
      : existingStoryGraph;
    const nextSocialGraph = useForTerminology && isSourceReference
      ? deriveSocialGraphFromStoryGraph(nextStoryGraph, {
            mangaId,
            chapterId: resolvedBinding.chapterId,
            referenceSetId,
          })
      : existingSocialGraph;
    const nextStyleEvidence = effectiveUseForStyleEvidence
      ? mergeStyleEvidence(
          existingStyleEvidence,
          deriveStyleEvidenceStable(
            manifest.referenceKind || "translator",
            extractedTexts,
            referenceSetId,
            resolvedBinding.chapterId,
            translatorLabel,
            chapterObservationView
          ),
          resolvedBinding.chapterId,
          referenceSetId,
          manifest.referenceKind || "translator"
        )
      : existingStyleEvidence;
    const nextStyleProfile = effectiveUseForStyle
      ? buildStyleProfileFromEvidence(mangaId, nextStyleEvidence)
      : existingStyleProfile;
    const nextCandidateTerms = useForTerminology
      ? mergeCandidateTerms(
          existingCandidateTerms,
          candidateEntries,
          resolvedBinding.chapterId,
          referenceSetId
        )
      : existingCandidateTerms;

    throwIfCanceled();
    reportProgress("reference_ingestion.write", { percent: 94 });
    const glossaryPath = writeCanonicalGlossary(mangaId, nextGlossary, translatorId);
    const candidateTermsPath = writeCandidateTerms(mangaId, nextCandidateTerms, translatorId);
    const storyContextPath = writeStoryContext(mangaId, nextStoryContext, translatorId);
    const storyGraphPath = writeStoryGraph(mangaId, nextStoryGraph, translatorId);
    const socialGraphPath = writeSocialGraph(mangaId, nextSocialGraph, translatorId);
    const styleEvidencePath = writeStyleEvidence(mangaId, nextStyleEvidence, translatorId);
    const styleProfilePath = writeStyleProfile(mangaId, nextStyleProfile, translatorId);

    const translationContext = buildTranslationContext({
      mangaId,
      translatorId,
      chapterId: resolvedBinding.chapterId,
      glossaryMode: effectiveGlossaryMode,
    });
    const translationContextPath = writeTranslationContext(mangaId, translationContext, translatorId);
    const candidateSummary = {
      terminology: glossaryCandidates.termEntries.length,
      characters: characterCandidates.length,
      candidateTerms: nextCandidateTerms.entries.filter((entry) => entry.kind === "term" && entry.status === "candidate").length,
      candidateCharacters: nextCandidateTerms.entries.filter((entry) => entry.kind === "character" && entry.status === "candidate").length,
    };
    const { reportPath } = resolveKnowledgePaths({ mangaId, translatorId });
    ensureParentDir(reportPath);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        buildReferenceIngestionReport({
          referenceSetId,
          mangaId,
          translatorId,
          chapterId: resolvedBinding.chapterId,
          chapterTitle: resolvedBinding.chapterTitle,
          manifestLabel: manifest.label,
          referenceKind: manifest.referenceKind || "translator",
          analysisDepth: effectiveAnalysisDepth,
          useForTerminology,
          useForStyle: effectiveUseForStyle,
          rawLineCount: rawReferenceLines.length,
          cleanLineCount: cleanReferenceLines.length,
          candidateSummary,
          glossary: nextGlossary,
          candidateTerms: nextCandidateTerms,
          storyContext: nextStoryContext,
          styleEvidence: nextStyleEvidence,
          styleProfile: nextStyleProfile,
          chapterObservation,
        }),
        null,
        2
      )
    );

    reportProgress("reference_ingestion.completed", { percent: 100 });
    return {
      referenceSetId,
      mangaId,
      translatorId,
      chapterId: resolvedBinding.chapterId,
      chapterTitle: resolvedBinding.chapterTitle,
      manifestLabel: manifest.label,
      candidateSummary,
      useForTerminology,
      useForStyle: effectiveUseForStyle,
      analysisDepth: effectiveAnalysisDepth,
      glossaryPath,
      candidateTermsPath,
      storyContextPath,
      storyGraphPath,
      socialGraphPath,
      styleProfilePath,
      styleEvidencePath,
      reportPath,
      translationContextPath,
      systemPrompt: formatTranslationSystemPrompt(translationContext),
    };
  }
}

const STYLE_DIALOGUE_QUOTE_PATTERN = /[「」『』"'“”]/u;
const STYLE_FULL_WIDTH_PUNCTUATION_PATTERN = /[，。！？；：]/u;
const STYLE_ASCII_PUNCTUATION_PATTERN = /[,!?;:]/;
const STYLE_HONORIFIC_PATTERN = /(\S+?(さん|君|くん|ちゃん|先輩|さま|様|氏|殿))/u;
const STYLE_FORMAL_REGISTER_PATTERN = /(です|ます|でした|ません|でしょう|請|您)/u;
const STYLE_CASUAL_REGISTER_PATTERN = /(だよ|だぜ|じゃん|なの|欸|啦|喔|耶)/u;
const STYLE_CREDIT_LINE_PATTERN =
  /(翻嵌|嵌字|校對|校对|修圖|修图|圖源|图源|漢化|汉化|翻譯|翻译|製作|制作|感謝|感谢|發布|发布|搬運|搬运|PhantomFantasy|CNM\s*[A-Z0-9]+)/iu;

function isStyleNoiseLine(line) {
  const value = String(line || "").trim();
  if (!value) {
    return true;
  }
  if (/manga\d+\.com|manhuagui|bilibili|copyright/i.test(value)) {
    return true;
  }
  if (/^page\s*\d+$/i.test(value)) {
    return true;
  }
  if (/^[\p{P}\p{S}\s_]+$/u.test(value)) {
    return true;
  }
  if (STYLE_CREDIT_LINE_PATTERN.test(value)) {
    return true;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,24}$/u.test(value) && !/[!?]/.test(value)) {
    return true;
  }
  return false;
}

function classifyStyleLinesStable(lines, roleAwareNodes = []) {
  const classifiedNodes = (roleAwareNodes || []).filter((node) =>
    ["dialogue", "monologue", "narration"].includes(node?.textRole) && String(node?.text || "").trim()
  );
  const nonEmpty = classifiedNodes.length > 0
    ? classifiedNodes.map((node) => String(node.text).trim())
    : lines.filter(Boolean);
  const total = nonEmpty.length || 1;
  const dialogueLines = classifiedNodes.length > 0
    ? classifiedNodes.filter((node) => node.textRole === "dialogue").map((node) => String(node.text).trim())
    : nonEmpty.filter((line) => STYLE_DIALOGUE_QUOTE_PATTERN.test(line));
  const narrationLines = classifiedNodes.length > 0
    ? classifiedNodes.filter((node) => node.textRole === "narration").map((node) => String(node.text).trim())
    : nonEmpty.filter((line) => !STYLE_DIALOGUE_QUOTE_PATTERN.test(line));
  const monologueLines = classifiedNodes.length > 0
    ? classifiedNodes.filter((node) => node.textRole === "monologue").map((node) => String(node.text).trim())
    : [];
  const honorificLines = nonEmpty.filter((line) => STYLE_HONORIFIC_PATTERN.test(line));
  const fullWidthPunctuation = nonEmpty.filter((line) => STYLE_FULL_WIDTH_PUNCTUATION_PATTERN.test(line)).length;
  const asciiPunctuation = nonEmpty.filter((line) => STYLE_ASCII_PUNCTUATION_PATTERN.test(line)).length;
  const formalLines = nonEmpty.filter((line) => STYLE_FORMAL_REGISTER_PATTERN.test(line)).length;
  const casualLines = nonEmpty.filter((line) => STYLE_CASUAL_REGISTER_PATTERN.test(line)).length;
  const averageLength = nonEmpty.reduce((sum, line) => sum + line.length, 0) / total;

  return {
    total,
    dialogueLines,
    narrationLines,
    monologueLines,
    honorificLines,
    fullWidthPunctuation,
    asciiPunctuation,
    formalLines,
    casualLines,
    averageLength,
  };
}

function deriveStyleEvidenceStable(
  referenceKind,
  texts,
  referenceSetId,
  chapterId,
  translatorLabel = null,
  chapterObservationView = null
) {
  const sourceLines = collectReferenceLines(texts, { preferTranslated: false, filterNoise: false }).filter(
    (line) => !isStyleNoiseLine(line)
  );
  const targetLines = collectReferenceLines(texts, { preferTranslated: true, filterNoise: false }).filter(
    (line) => !isStyleNoiseLine(line)
  );
  const activeLines = referenceKind === "translator" ? targetLines : sourceLines;
  const roleAwareNodes = chapterObservationView
    ? buildRoleAwareObservationNodes(texts, {
        referenceKind,
        nodes: chapterObservationView.records,
      })
    : [];
  const metrics = classifyStyleLinesStable(activeLines, roleAwareNodes);
  const characterSpeech = roleAwareNodes
    .filter((node) => node.speakerRef && ["dialogue", "monologue"].includes(node.textRole))
    .slice(0, 12)
    .map((node) => ({
      character: node.speakerRef,
      textRole: node.textRole,
      styleChannel: node.styleChannel,
      example: node.text,
      confidence: node.speakerConfidence,
    }));

  return {
    chapterId: chapterId || null,
    referenceKind,
    referenceSetIds: [referenceSetId],
    targetStyleAllowed: referenceKind === "translator",
    translatorLabel: translatorLabel || null,
    registerEvidence:
      referenceKind === "translator"
        ? [
            {
              register:
                metrics.formalLines > metrics.casualLines * 1.3
                  ? "formal"
                  : metrics.casualLines > metrics.formalLines * 1.3
                    ? "casual"
                    : "mixed",
              confidence: Number((Math.max(metrics.formalLines, metrics.casualLines) / metrics.total).toFixed(2)),
              sampleSize: metrics.total,
            },
          ]
        : [],
    punctuationEvidence:
      referenceKind === "translator"
        ? [
            {
              preferFullWidth: metrics.fullWidthPunctuation >= metrics.asciiPunctuation,
              confidence: Number(
                (Math.max(metrics.fullWidthPunctuation, metrics.asciiPunctuation) / metrics.total).toFixed(2)
              ),
              sampleSize: metrics.total,
            },
          ]
        : [],
    honorificEvidence:
      referenceKind === "translator"
        ? [
            {
              preserveHonorifics: metrics.honorificLines.length >= 2,
              confidence: Number((metrics.honorificLines.length / metrics.total).toFixed(2)),
              sampleSize: metrics.total,
            },
          ]
        : [],
    dialogueNarrationEvidence: [
      {
        dialogueRatio: Number((metrics.dialogueLines.length / metrics.total).toFixed(2)),
        narrationRatio: Number((metrics.narrationLines.length / metrics.total).toFixed(2)),
        monologueRatio: Number((metrics.monologueLines.length / metrics.total).toFixed(2)),
        dialogueCount: metrics.dialogueLines.length,
        narrationCount: metrics.narrationLines.length,
        monologueCount: metrics.monologueLines.length,
        sampleSize: metrics.total,
      },
    ],
    dialogueSamples: metrics.dialogueLines.slice(0, 5),
    narrationSamples: metrics.narrationLines.slice(0, 5),
    monologueSamples: metrics.monologueLines.slice(0, 5),
    characterSpeech,
    notes:
      referenceKind === "translator"
        ? []
        : ["Source reference contributes structural pacing evidence only."],
  };
}

module.exports = {
  ReferenceIngestionModule,
  buildGlossaryCandidates,
  buildStoryContextChapter,
  deriveStyleEvidence: deriveStyleEvidenceStable,
};
