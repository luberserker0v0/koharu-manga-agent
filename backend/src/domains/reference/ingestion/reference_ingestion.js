const { loadExtractedTexts, loadReferenceManifest } = require("../sets/reference_sets");
const fs = require("fs");
const path = require("path");
const { normalizeLanguageTag } = require("../../../language_codes");
const {
  buildReferenceIngestionReport,
  buildStoryContextChapter,
  buildTranslatorReferenceContextChapter,
  collectReferenceLines,
} = require("../story/reference_ingestion_story");
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
} = require("../../knowledge/assets/knowledge_assets");
const { resolveKnowledgePaths, syncMangaManagementBinding } = require("../../knowledge/registry/knowledge_paths");
const {
  buildRoleAwareObservationNodes,
  buildStoryNodesFromObservation,
  ensureChapterObservation,
  loadChapterObservation,
  observationAsExtractionResult,
  observationAsRoleView,
} = require("../observation/reference_observation");

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
    throw new Error(`${label} artifact binding mismatch: expected ${referenceSetId}/${chapterId}.`);
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

function buildTermGlossaryEntries(terminology, referenceKind, referenceSetId, chapterId) {
  return terminology.map((entry) => ({
    term_id: stableId(
      "term",
      `${entry.category}::${entry.source_term || entry.term || ""}::${entry.translation || entry.term || ""}`,
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
    rendering_hints: entry.rendering_hints && typeof entry.rendering_hints === "object" ? entry.rendering_hints : {},
    category: normalizeReferenceCategory(entry.term, entry.category),
    source: "reference",
    locked: false,
    updated_at: new Date().toISOString(),
    confidence: entry.confidence,
    examples: entry.examples || [],
    provenance: { referenceSetId, chapterId: chapterId || null },
  }));
}

function buildCharacterGlossaryEntries(characters, referenceKind, referenceSetId, chapterId) {
  return characters.map((entry) => ({
    term_id: stableId("term", `character_name::${entry.name}`),
    entity_type: "character",
    reference_kind: referenceKind,
    source_term: entry.source_name || entry.source_term || null,
    canonical_form: entry.source_name || entry.source_term || entry.name || null,
    target_rendering: referenceKind === "source" ? null : entry.name,
    canonical_translation: referenceKind === "source" ? null : entry.name,
    source_aliases: [...new Set((entry.source_aliases || []).filter(Boolean))],
    aliases: entry.aliases || [],
    rendering_hints: { title_forms: entry.title_forms || [] },
    category: "character_name",
    source: "reference",
    locked: false,
    updated_at: new Date().toISOString(),
    confidence: entry.confidence,
    examples: entry.example_lines || [],
    provenance: { referenceSetId, chapterId: chapterId || null },
  }));
}

function buildGlossaryCandidates(referenceKind, referenceSetId, chapterId, terminology, characters) {
  const termEntries = buildTermGlossaryEntries(terminology, referenceKind, referenceSetId, chapterId);
  const characterEntries = buildCharacterGlossaryEntries(characters, referenceKind, referenceSetId, chapterId);
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
  return { chapterId: resolvedChapterId, chapterTitle: resolvedChapterTitle };
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

  createContext(options) {
    const ctx = {
      referenceSetId: options.referenceSetId,
      mangaId: options.mangaId,
      mangaLabel: options.mangaLabel || null,
      translatorId: options.translatorId || null,
      translatorLabel: options.translatorLabel || null,
      chapterId: options.chapterId || null,
      chapterTitle: options.chapterTitle || null,
      glossaryMode: options.glossaryMode || "canonical",
      useForTerminology: options.useForTerminology === undefined ? true : options.useForTerminology,
      useForStyle: options.useForStyle === undefined ? true : options.useForStyle,
      analysisDepth: options.analysisDepth || "quick_read",
      phase: options.phase,
      analysisArtifactPath: options.analysisArtifactPath || null,
      storyArtifactPath: options.storyArtifactPath || null,
      onProgress: options.onProgress || null,
      isCanceled: options.isCanceled || null,
    };
    return ctx;
  }

  validateRun(ctx) {
    if (!["analysis", "story", "commit"].includes(ctx.phase)) {
      throw new Error("Reference ingestion requires an atomic analysis, story, or commit phase.");
    }
    if (
      ctx.phase === "analysis" &&
      (!this.aoTaskRunner || typeof this.aoTaskRunner.runChapterObservation !== "function")
    ) {
      throw new Error("ReferenceIngestionModule requires aoTaskRunner.runChapterObservation().");
    }
    if (!ctx.useForTerminology && !ctx.useForStyle) {
      throw new Error("Reference ingestion requires terminology or style usage to be enabled.");
    }
  }

  loadManifestAndBinding(ctx) {
    ctx.throwIfCanceled();
    ctx.reportProgress("reference_ingestion.memory", { percent: 2 });
    ctx.manifest = loadReferenceManifest(ctx.referenceSetId);
    ctx.resolvedBinding = resolveReferenceChapterBinding(
      ctx.referenceSetId,
      ctx.manifest,
      ctx.chapterId,
      ctx.chapterTitle,
    );
    syncMangaManagementBinding({
      mangaId: ctx.mangaId,
      label: ctx.mangaLabel || null,
      translatorId: ctx.translatorId,
      translatorLabel: ctx.translatorLabel || ctx.translatorId,
      language: ctx.manifest.language || "zh-TW",
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
    });
  }

  loadExtractedData(ctx) {
    ctx.extractedTexts = loadExtractedTexts(ctx.referenceSetId);
    ctx.preferTranslatedLines = ctx.manifest.referenceKind !== "source";
    ctx.rawReferenceLines = collectReferenceLines(ctx.extractedTexts, {
      preferTranslated: ctx.preferTranslatedLines,
      filterNoise: false,
    });
    ctx.cleanReferenceLines = collectReferenceLines(ctx.extractedTexts, {
      preferTranslated: ctx.preferTranslatedLines,
      filterNoise: true,
    });
    ctx.isSourceReference = ctx.manifest.referenceKind === "source";
  }

  loadExistingKnowledge(ctx) {
    ctx.existingGlossary =
      loadCanonicalGlossary(ctx.mangaId, ctx.translatorId) || defaultCanonicalGlossary(ctx.mangaId);
    ctx.existingCandidateTerms = loadCandidateTerms(ctx.mangaId, ctx.translatorId);
    ctx.existingSocialGraph = loadSocialGraph(ctx.mangaId, ctx.translatorId) || defaultSocialGraph(ctx.mangaId);
    ctx.existingStoryContext = loadStoryContext(ctx.mangaId, ctx.translatorId) || defaultStoryContext(ctx.mangaId);
    ctx.existingStoryGraph = loadStoryGraph(ctx.mangaId, ctx.translatorId) || defaultStoryGraph(ctx.mangaId);
    ctx.existingStyleEvidence = loadStyleEvidence(ctx.mangaId, ctx.translatorId);
    ctx.existingStyleProfile = loadStyleProfile(ctx.mangaId, ctx.translatorId) || defaultStyleProfile(ctx.mangaId);
  }

  computeEffectiveFlags(ctx) {
    ctx.effectiveGlossaryMode = ctx.useForTerminology ? ctx.glossaryMode : "disabled";
    ctx.languageContext = buildReferenceLanguageContext(ctx.manifest);
    ctx.effectiveUseForStyle =
      ctx.useForStyle &&
      !isLikelyOriginalTranslatorLabel(ctx.translatorLabel) &&
      ctx.manifest.referenceKind !== "source";
    ctx.effectiveUseForStyleEvidence = ctx.useForStyle;
    ctx.effectiveAnalysisDepth = ctx.analysisDepth === "deep_read" ? "deep_read" : "quick_read";
    ctx.chapterObservation = null;
    ctx.chapterObservationView = null;
    ctx.storySourceTexts = ctx.extractedTexts;
    ctx.taskSessionId = null;
    ctx.extractionResult = undefined;
    ctx.storyDeltaResult = null;
    ctx.observationPath = null;
  }

  attachContextHelpers(ctx) {
    ctx.reportProgress = (stage, detail = {}) => {
      if (typeof ctx.onProgress === "function") {
        ctx.onProgress({
          stage,
          referenceSetId: ctx.referenceSetId,
          ...detail,
        });
      }
    };
    ctx.throwIfCanceled = () => {
      if (typeof ctx.isCanceled === "function" && ctx.isCanceled()) {
        throw new Error("Reference ingestion canceled by user.");
      }
    };
  }

  async run(options = {}) {
    const ctx = this.createContext(options);
    this.attachContextHelpers(ctx);
    this.validateRun(ctx);
    await this.loadManifestAndBinding(ctx);
    this.loadExtractedData(ctx);
    this.loadExistingKnowledge(ctx);
    this.computeEffectiveFlags(ctx);
    if (ctx.phase === "story") return this.executeStoryPhase(ctx);
    if (ctx.phase === "commit") this.loadCommitArtifacts(ctx);
    else await this.runObservationPhase(ctx);
    if (ctx.phase === "analysis") return this.finalizeAnalysisPhase(ctx);
    return this.commitResults(ctx);
  }

  async executeStoryPhase(ctx) {
    this.loadStoryPhaseArtifacts(ctx);
    await this.runStoryTask(ctx);
    return this.finalizeStoryPhase(ctx);
  }

  loadStoryPhaseArtifacts(ctx) {
    const analysisArtifact = readPhaseArtifact(ctx.analysisArtifactPath, "Reference ingestion analysis");
    assertPhaseArtifactBinding(
      analysisArtifact,
      {
        referenceSetId: ctx.referenceSetId,
        chapterId: ctx.resolvedBinding.chapterId,
      },
      "Reference ingestion analysis",
    );
    ctx.extractionResult = analysisArtifact.extractionResult;
    ctx.chapterObservation = loadChapterObservation(ctx.referenceSetId);
    if (!ctx.chapterObservation || ctx.chapterObservation.revisionId !== analysisArtifact.observationRevisionId) {
      throw new Error("Story update requires the exact Observation revision from the observation phase.");
    }
    ctx.chapterObservationView = ctx.chapterObservation ? observationAsRoleView(ctx.chapterObservation) : null;
    if (!ctx.isSourceReference || !ctx.chapterObservation) {
      throw new Error("Story update requires a source chapter observation from the observation phase.");
    }
    if (typeof this.aoTaskRunner.runStoryContextUpdate !== "function") {
      throw new Error("Story phase requires aoTaskRunner.runStoryContextUpdate().");
    }
  }

  async runStoryTask(ctx) {
    try {
      if (typeof this.aoTaskRunner.createTaskSession === "function") {
        ctx.taskSessionId = await this.aoTaskRunner.createTaskSession(
          `reference_ingestion:${ctx.referenceSetId}:story`,
          "reference_ingestion_story",
        );
      }
      ctx.reportProgress("reference_ingestion.story", { percent: 20 });
      ctx.storyDeltaResult = await this.aoTaskRunner.runStoryContextUpdate(
        this.buildStoryUpdateArgs(ctx),
        ctx.taskSessionId ? this.buildStoryTaskOptions(ctx) : undefined,
      );
      ctx.throwIfCanceled();
    } finally {
      if (ctx.taskSessionId && typeof this.aoTaskRunner.closeTaskSession === "function") {
        await this.aoTaskRunner.closeTaskSession(ctx.taskSessionId);
      }
    }
  }

  buildStoryUpdateArgs(ctx) {
    return {
      jobId: `reference_ingestion:${ctx.referenceSetId}:story`,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      contentLanguage: ctx.languageContext.contentLanguage,
      analysisDepth: "observation_first_pass",
      sourceNodes: ctx.chapterObservation
        ? buildStoryNodesFromObservation(ctx.chapterObservation, ctx.extractedTexts)
        : [],
      storyCues: ctx.chapterObservation?.storyCues || [],
      existingMemory: buildCompactStoryMemory(ctx.existingStoryContext),
      chapterTerminology: ctx.extractionResult.terminologyEntries || [],
      chapterCharacters: ctx.extractionResult.characterEntries || [],
    };
  }

  buildStoryTaskOptions(ctx) {
    return {
      conversationId: ctx.taskSessionId,
      outputFilePath: "output/story_delta_result.txt",
      isCanceled: ctx.isCanceled,
      onProgress: (status) =>
        ctx.reportProgress("reference_ingestion.story", {
          percent: 20,
          ...status,
        }),
    };
  }

  finalizeStoryPhase(ctx) {
    writePhaseArtifact(ctx.storyArtifactPath, {
      schemaVersion: 1,
      referenceSetId: ctx.referenceSetId,
      chapterId: ctx.resolvedBinding.chapterId,
      storyDeltaResult: ctx.storyDeltaResult,
    });
    ctx.reportProgress("reference_ingestion.story.completed", { percent: 100 });
    return {
      phase: "story",
      referenceSetId: ctx.referenceSetId,
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      storyArtifactPath: ctx.storyArtifactPath,
      semanticResult: ctx.storyDeltaResult?.semanticResult || null,
    };
  }

  loadCommitArtifacts(ctx) {
    const analysisArtifact = readPhaseArtifact(ctx.analysisArtifactPath, "Reference ingestion analysis");
    assertPhaseArtifactBinding(
      analysisArtifact,
      {
        referenceSetId: ctx.referenceSetId,
        chapterId: ctx.resolvedBinding.chapterId,
      },
      "Reference ingestion analysis",
    );
    ctx.extractionResult = analysisArtifact.extractionResult;
    ctx.chapterObservation = loadChapterObservation(ctx.referenceSetId);
    if (!ctx.chapterObservation || ctx.chapterObservation.revisionId !== analysisArtifact.observationRevisionId) {
      throw new Error("Knowledge commit requires the exact Observation revision from the observation phase.");
    }
    ctx.chapterObservationView = ctx.chapterObservation ? observationAsRoleView(ctx.chapterObservation) : null;
    if (ctx.isSourceReference) {
      const storyArtifact = readPhaseArtifact(ctx.storyArtifactPath, "Reference ingestion story");
      assertPhaseArtifactBinding(
        storyArtifact,
        {
          referenceSetId: ctx.referenceSetId,
          chapterId: ctx.resolvedBinding.chapterId,
        },
        "Reference ingestion story",
      );
      ctx.storyDeltaResult = storyArtifact.storyDeltaResult || null;
    }
  }

  applyObservationResult(ctx, observationResult) {
    ctx.chapterObservation = observationResult.observation;
    ctx.observationPath = observationResult.observationPath;
    ctx.chapterObservationView = observationAsRoleView(ctx.chapterObservation);
    ctx.extractionResult = ctx.useForTerminology
      ? observationAsExtractionResult(ctx.chapterObservation)
      : {
          terminologyEntries: [],
          characterEntries: [],
          candidateEntries: [],
          rejectedEntries: [],
          observationRevisionId: ctx.chapterObservation.revisionId,
        };
  }

  async runObservationPhase(ctx) {
    ctx.reportProgress("reference_ingestion.observation", { percent: 8 });
    const observationResult = await ensureChapterObservation({
      aoTaskRunner: this.aoTaskRunner,
      referenceSetId: ctx.referenceSetId,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      glossary: ctx.existingGlossary,
      storyContext: ctx.existingStoryContext,
      isCanceled: ctx.isCanceled,
      onProgress: (status) =>
        ctx.reportProgress("reference_ingestion.observation", {
          percent: 8,
          ...status,
        }),
    });
    this.applyObservationResult(ctx, observationResult);
    ctx.reportProgress(
      observationResult.reused ? "reference_ingestion.observation.reused" : "reference_ingestion.observation.completed",
      { percent: 68 },
    );
    ctx.reportProgress("reference_ingestion.terminology_from_observation", {
      percent: 70,
    });
  }

  finalizeAnalysisPhase(ctx) {
    writePhaseArtifact(ctx.analysisArtifactPath, {
      schemaVersion: 1,
      referenceSetId: ctx.referenceSetId,
      chapterId: ctx.resolvedBinding.chapterId,
      referenceKind: ctx.manifest.referenceKind || "translator",
      analysisDepth: ctx.effectiveAnalysisDepth,
      extractionResult: ctx.extractionResult,
      observationRevisionId: ctx.chapterObservation.revisionId,
      observationPath: ctx.observationPath,
    });
    ctx.reportProgress("reference_ingestion.analysis.completed", {
      percent: 100,
    });
    return {
      phase: "analysis",
      referenceSetId: ctx.referenceSetId,
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      analysisArtifactPath: ctx.analysisArtifactPath,
      observationPath: ctx.observationPath,
      semanticResult: ctx.chapterObservation?.semanticResult || null,
    };
  }

  async commitResults(ctx) {
    this.prepareMerge(ctx);
    this.buildFilteredTerminology(ctx);
    this.buildCharacterCandidates(ctx);
    this.buildGlossaryCandidateSet(ctx);
    this.buildTargetOnlyCandidateEntries(ctx);
    this.buildCandidateEntries(ctx);
    this.buildChapterStoryContext(ctx);
    this.mergeTerminologyKnowledge(ctx);
    this.mergeStoryKnowledge(ctx);
    this.mergeStyleKnowledge(ctx);
    this.mergeCandidateKnowledge(ctx);
    this.writeKnowledge(ctx);
    this.buildCandidateSummary(ctx);
    this.writeReport(ctx);
    ctx.reportProgress("reference_ingestion.completed", { percent: 100 });
    return this.buildFinalResult(ctx);
  }

  prepareMerge(ctx) {
    ctx.throwIfCanceled();
    ctx.reportProgress("reference_ingestion.merge", { percent: 82 });
    ctx.extraction = ctx.storyDeltaResult
      ? {
          ...ctx.extractionResult,
          observedEvents: ctx.storyDeltaResult.observedEvents,
          observedRelations: ctx.storyDeltaResult.observedRelations,
          keyLines: [],
          characterStates: ctx.storyDeltaResult.characterStates,
          openThreads: ctx.storyDeltaResult.openThreads,
          storyDeltaApplied: true,
          storyDeltaNotes: ctx.storyDeltaResult.notes,
        }
      : ctx.extractionResult;
  }

  buildFilteredTerminology(ctx) {
    ctx.filteredTerminology = (ctx.extraction.terminologyEntries || [])
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
          !(ctx.isSourceReference && isBlockedGenericSourceTerm(entry)),
      );
  }

  buildCharacterCandidates(ctx) {
    ctx.characterCandidates = (ctx.extraction.characterEntries || []).filter(
      (entry) => (entry.confidence || 0) >= 0.68,
    );
  }

  buildGlossaryCandidateSet(ctx) {
    ctx.hasTrustedSourceIdentity = ctx.isSourceReference;
    ctx.glossaryCandidates = ctx.hasTrustedSourceIdentity
      ? buildGlossaryCandidates(
          ctx.manifest.referenceKind || "translator",
          ctx.referenceSetId,
          ctx.resolvedBinding.chapterId,
          ctx.filteredTerminology,
          ctx.characterCandidates,
        )
      : { termEntries: [], characterEntries: [], mergedEntries: [] };
  }

  buildTargetOnlyCandidateEntries(ctx) {
    if (ctx.isSourceReference || ctx.hasTrustedSourceIdentity) {
      ctx.targetOnlyCandidateEntries = [];
      return;
    }
    ctx.targetOnlyCandidateEntries = [
      ...buildTargetOnlyTermCandidates(ctx.filteredTerminology),
      ...buildTargetOnlyCharacterCandidates(ctx.characterCandidates),
    ];
  }

  buildCandidateEntries(ctx) {
    ctx.candidateEntries = [
      ...ctx.targetOnlyCandidateEntries,
      ...mapCandidateEntries(ctx.extraction.candidateEntries, ctx.isSourceReference, ctx.manifest),
      ...mapRejectedEntries(ctx.extraction.rejectedEntries, ctx.isSourceReference, ctx.manifest),
    ];
  }

  buildChapterStoryContext(ctx) {
    ctx.chapterKey = ctx.resolvedBinding.chapterId;
    ctx.chapterStoryContext =
      ctx.manifest.referenceKind === "source"
        ? buildStoryContextChapter(
            {
              chapterId: ctx.resolvedBinding.chapterId,
              referenceSetId: ctx.referenceSetId,
              referenceKind: ctx.manifest.referenceKind || "translator",
              termEntries: ctx.glossaryCandidates.termEntries,
              characterEntries: ctx.characterCandidates,
              extractedEvidence: ctx.extraction,
            },
          )
        : buildTranslatorReferenceContextChapter(
            ctx.resolvedBinding.chapterId,
            ctx.referenceSetId,
            ctx.manifest.referenceKind || "translator",
            ctx.glossaryCandidates.termEntries,
            ctx.characterCandidates,
          );
  }

  mergeTerminologyKnowledge(ctx) {
    ctx.nextGlossary =
      ctx.useForTerminology && ctx.isSourceReference
        ? mergeCanonicalGlossary(
            ctx.existingGlossary,
            ctx.glossaryCandidates.mergedEntries,
            ctx.resolvedBinding.chapterId,
            ctx.referenceSetId,
          )
        : ctx.existingGlossary;
  }

  mergeStoryKnowledge(ctx) {
    if (ctx.useForTerminology && ctx.isSourceReference) {
      this.mergeSourceStoryKnowledge(ctx);
      return;
    }
    ctx.nextStoryContext = ctx.existingStoryContext;
    ctx.nextStoryGraph = ctx.existingStoryGraph;
    ctx.nextSocialGraph = ctx.existingSocialGraph;
  }

  mergeSourceStoryKnowledge(ctx) {
    const chapterId = ctx.resolvedBinding.chapterId;
    ctx.nextStoryContext = mergeStoryContext(
      ctx.existingStoryContext, ctx.chapterStoryContext, ctx.chapterKey, chapterId, ctx.referenceSetId,
    );
    ctx.nextStoryGraph = mergeStoryGraph(
      ctx.existingStoryGraph,
      createStoryGraphFromContext({
        mangaId: ctx.mangaId, chapterId, referenceSetId: ctx.referenceSetId,
        referenceKind: ctx.manifest.referenceKind || "translator", chapterContext: ctx.chapterStoryContext,
      }),
      chapterId,
      ctx.referenceSetId,
    );
    ctx.nextSocialGraph = deriveSocialGraphFromStoryGraph(ctx.nextStoryGraph, {
      mangaId: ctx.mangaId, chapterId, referenceSetId: ctx.referenceSetId,
    });
  }

  mergeStyleKnowledge(ctx) {
    ctx.nextStyleEvidence = ctx.effectiveUseForStyleEvidence
      ? mergeStyleEvidence(
          ctx.existingStyleEvidence,
          deriveStyleEvidenceStable(
            ctx.manifest.referenceKind || "translator",
            ctx.extractedTexts,
            ctx.referenceSetId,
            ctx.resolvedBinding.chapterId,
            ctx.translatorLabel,
            ctx.chapterObservationView,
          ),
          ctx.resolvedBinding.chapterId,
          ctx.referenceSetId,
          ctx.manifest.referenceKind || "translator",
        )
      : ctx.existingStyleEvidence;
    ctx.nextStyleProfile = ctx.effectiveUseForStyle
      ? buildStyleProfileFromEvidence(ctx.mangaId, ctx.nextStyleEvidence)
      : ctx.existingStyleProfile;
  }

  mergeCandidateKnowledge(ctx) {
    ctx.nextCandidateTerms = ctx.useForTerminology
      ? mergeCandidateTerms(
          ctx.existingCandidateTerms,
          ctx.candidateEntries,
          ctx.resolvedBinding.chapterId,
          ctx.referenceSetId,
        )
      : ctx.existingCandidateTerms;
  }

  writeKnowledge(ctx) {
    ctx.glossaryPath = writeCanonicalGlossary(ctx.mangaId, ctx.nextGlossary, ctx.translatorId);
    ctx.candidateTermsPath = writeCandidateTerms(ctx.mangaId, ctx.nextCandidateTerms, ctx.translatorId);
    ctx.storyContextPath = writeStoryContext(ctx.mangaId, ctx.nextStoryContext, ctx.translatorId);
    ctx.storyGraphPath = writeStoryGraph(ctx.mangaId, ctx.nextStoryGraph, ctx.translatorId);
    ctx.socialGraphPath = writeSocialGraph(ctx.mangaId, ctx.nextSocialGraph, ctx.translatorId);
    ctx.styleEvidencePath = writeStyleEvidence(ctx.mangaId, ctx.nextStyleEvidence, ctx.translatorId);
    ctx.styleProfilePath = writeStyleProfile(ctx.mangaId, ctx.nextStyleProfile, ctx.translatorId);
    ctx.translationContext = buildTranslationContext({
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
      chapterId: ctx.resolvedBinding.chapterId,
      glossaryMode: ctx.effectiveGlossaryMode,
    });
    ctx.translationContextPath = writeTranslationContext(ctx.mangaId, ctx.translationContext, ctx.translatorId);
  }

  buildCandidateSummary(ctx) {
    ctx.candidateSummary = {
      terminology: ctx.glossaryCandidates.termEntries.length,
      characters: ctx.characterCandidates.length,
      candidateTerms: ctx.nextCandidateTerms.entries.filter(
        (entry) => entry.kind === "term" && entry.status === "candidate",
      ).length,
      candidateCharacters: ctx.nextCandidateTerms.entries.filter(
        (entry) => entry.kind === "character" && entry.status === "candidate",
      ).length,
    };
  }

  buildReportPayload(ctx) {
    return {
      referenceSetId: ctx.referenceSetId,
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      manifestLabel: ctx.manifest.label,
      referenceKind: ctx.manifest.referenceKind || "translator",
      analysisDepth: ctx.effectiveAnalysisDepth,
      useForTerminology: ctx.useForTerminology,
      useForStyle: ctx.effectiveUseForStyle,
      rawLineCount: ctx.rawReferenceLines.length,
      cleanLineCount: ctx.cleanReferenceLines.length,
      candidateSummary: ctx.candidateSummary,
      glossary: ctx.nextGlossary,
      candidateTerms: ctx.nextCandidateTerms,
      storyContext: ctx.nextStoryContext,
      styleEvidence: ctx.nextStyleEvidence,
      styleProfile: ctx.nextStyleProfile,
      chapterObservation: ctx.chapterObservation,
    };
  }

  writeReport(ctx) {
    const { reportPath } = resolveKnowledgePaths({
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
    });
    ctx.reportPath = reportPath;
    ensureParentDir(reportPath);
    fs.writeFileSync(reportPath, JSON.stringify(buildReferenceIngestionReport(this.buildReportPayload(ctx)), null, 2));
  }

  buildFinalResult(ctx) {
    return {
      referenceSetId: ctx.referenceSetId,
      mangaId: ctx.mangaId,
      translatorId: ctx.translatorId,
      chapterId: ctx.resolvedBinding.chapterId,
      chapterTitle: ctx.resolvedBinding.chapterTitle,
      manifestLabel: ctx.manifest.label,
      candidateSummary: ctx.candidateSummary,
      useForTerminology: ctx.useForTerminology,
      useForStyle: ctx.effectiveUseForStyle,
      analysisDepth: ctx.effectiveAnalysisDepth,
      glossaryPath: ctx.glossaryPath,
      candidateTermsPath: ctx.candidateTermsPath,
      storyContextPath: ctx.storyContextPath,
      storyGraphPath: ctx.storyGraphPath,
      socialGraphPath: ctx.socialGraphPath,
      styleProfilePath: ctx.styleProfilePath,
      styleEvidencePath: ctx.styleEvidencePath,
      reportPath: ctx.reportPath,
      translationContextPath: ctx.translationContextPath,
      systemPrompt: formatTranslationSystemPrompt(ctx.translationContext),
      semanticResult: ctx.chapterObservation?.semanticResult || ctx.storyDeltaResult?.semanticResult || null,
    };
  }
}

const STYLE_FULL_WIDTH_PUNCTUATION_PATTERN = /[，。！？；：]/u;
const STYLE_ASCII_PUNCTUATION_PATTERN = /[,!?;:]/;

function classifyStyleLinesStable(roleAwareNodes = []) {
  const classifiedNodes = (roleAwareNodes || []).filter(
    (node) => ["dialogue", "monologue", "narration"].includes(node?.textRole) && String(node?.text || "").trim(),
  );
  const nonEmpty = classifiedNodes.map((node) => String(node.text).trim());
  const total = nonEmpty.length;
  const dialogueLines = classifiedNodes
    .filter((node) => node.textRole === "dialogue")
    .map((node) => String(node.text).trim());
  const narrationLines = classifiedNodes
    .filter((node) => node.textRole === "narration")
    .map((node) => String(node.text).trim());
  const monologueLines = classifiedNodes
    .filter((node) => node.textRole === "monologue")
    .map((node) => String(node.text).trim());
  const fullWidthPunctuation = nonEmpty.filter((line) => STYLE_FULL_WIDTH_PUNCTUATION_PATTERN.test(line)).length;
  const asciiPunctuation = nonEmpty.filter((line) => STYLE_ASCII_PUNCTUATION_PATTERN.test(line)).length;
  const averageLength = total > 0 ? nonEmpty.reduce((sum, line) => sum + line.length, 0) / total : 0;
  return {
    total,
    dialogueLines,
    narrationLines,
    monologueLines,
    fullWidthPunctuation,
    asciiPunctuation,
    averageLength,
  };
}

function buildCharacterSpeech(roleAwareNodes) {
  return roleAwareNodes
    .filter((node) => node.speakerRef && ["dialogue", "monologue"].includes(node.textRole))
    .slice(0, 12)
    .map((node) => ({
      character: node.speakerRef,
      textRole: node.textRole,
      styleChannel: node.styleChannel,
      example: node.text,
      confidence: node.speakerConfidence,
    }));
}

function buildPunctuationEvidence(referenceKind, metrics) {
  if (!(referenceKind === "translator" && metrics.total > 0)) return [];
  return [
    {
      preferFullWidth: metrics.fullWidthPunctuation >= metrics.asciiPunctuation,
      confidence: Number((Math.max(metrics.fullWidthPunctuation, metrics.asciiPunctuation) / metrics.total).toFixed(2)),
      sampleSize: metrics.total,
    },
  ];
}

function buildDialogueNarrationEvidence(metrics) {
  if (!(metrics.total > 0)) return [];
  return [
    {
      dialogueRatio: Number((metrics.dialogueLines.length / metrics.total).toFixed(2)),
      narrationRatio: Number((metrics.narrationLines.length / metrics.total).toFixed(2)),
      monologueRatio: Number((metrics.monologueLines.length / metrics.total).toFixed(2)),
      dialogueCount: metrics.dialogueLines.length,
      narrationCount: metrics.narrationLines.length,
      monologueCount: metrics.monologueLines.length,
      sampleSize: metrics.total,
    },
  ];
}

function buildStyleEvidenceResult(referenceKind, referenceSetId, chapterId, translatorLabel, metrics, characterSpeech) {
  return {
    chapterId: chapterId || null,
    referenceKind,
    referenceSetIds: [referenceSetId],
    targetStyleAllowed: referenceKind === "translator",
    translatorLabel: translatorLabel || null,
    registerEvidence: [],
    punctuationEvidence: buildPunctuationEvidence(referenceKind, metrics),
    honorificEvidence: [],
    dialogueNarrationEvidence: buildDialogueNarrationEvidence(metrics),
    dialogueSamples: metrics.dialogueLines.slice(0, 5),
    narrationSamples: metrics.narrationLines.slice(0, 5),
    monologueSamples: metrics.monologueLines.slice(0, 5),
    characterSpeech,
    notes: referenceKind === "translator" ? [] : ["Source reference contributes structural pacing evidence only."],
  };
}

function deriveStyleEvidenceStable(
  referenceKind,
  texts,
  referenceSetId,
  chapterId,
  translatorLabel = null,
  chapterObservationView = null,
) {
  const roleAwareNodes = chapterObservationView
    ? buildRoleAwareObservationNodes(texts, {
        referenceKind,
        nodes: chapterObservationView.records,
      })
    : [];
  const metrics = classifyStyleLinesStable(roleAwareNodes);
  const characterSpeech = buildCharacterSpeech(roleAwareNodes);
  return buildStyleEvidenceResult(referenceKind, referenceSetId, chapterId, translatorLabel, metrics, characterSpeech);
}

function buildTargetOnlyTermCandidates(filteredTerminology) {
  return filteredTerminology.map((entry) => ({
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
  }));
}

function buildTargetOnlyCharacterCandidates(characterCandidates) {
  return characterCandidates.map((entry) => ({
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
  }));
}

function mapCandidateEntries(entries, isSourceReference, manifest) {
  return (entries || []).map((entry) => ({
    ...entry,
    reference_kind: entry.reference_kind || manifest.referenceKind || "translator",
    target_rendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering")
      ? entry.target_rendering
      : isSourceReference
        ? null
        : entry.canonical_translation || entry.translation || entry.term || entry.candidate || null,
    status: "candidate",
  }));
}

function mapRejectedEntries(entries, isSourceReference, manifest) {
  return (entries || []).map((entry) => ({
    ...entry,
    reference_kind: entry.reference_kind || manifest.referenceKind || "translator",
    target_rendering: Object.prototype.hasOwnProperty.call(entry, "target_rendering")
      ? entry.target_rendering
      : isSourceReference
        ? null
        : entry.canonical_translation || entry.translation || entry.term || entry.candidate || null,
    status: "rejected",
  }));
}

module.exports = {
  ReferenceIngestionModule,
  buildGlossaryCandidates,
  buildStoryContextChapter,
  deriveStyleEvidence: deriveStyleEvidenceStable,
};
