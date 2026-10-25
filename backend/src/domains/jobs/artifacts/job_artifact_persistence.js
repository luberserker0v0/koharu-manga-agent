const { collectWorkspaceManifestArtifacts } = require("./job_artifact_collection");

function persistTranslationSnapshotArtifacts(store, jobId, result) {
  if (result?.sourcePreflight?.manifestPath) {
    store.addArtifact(jobId, "source_preflight_manifest", result.sourcePreflight.manifestPath, {
      preflightId: result.sourcePreflight.preflightId,
      sourceFolder: result.sourcePreflight.sourceFolder,
      orderedDir: result.sourcePreflight.orderedDir,
      acceptedCount: result.sourcePreflight.summary?.acceptedCount || 0,
    });
  }
  if (result?.artifact?.path) store.addArtifact(jobId, "export", result.artifact.path, result.artifact);
  if (result?.postEditDocumentPath) {
    store.addArtifact(jobId, "post_edit_document", result.postEditDocumentPath, { jobId });
  }
  if (result?.translationMemorySnapshotPath) {
    store.addArtifact(jobId, "translation_memory_snapshot", result.translationMemorySnapshotPath, {
      fingerprint: result.translationMemoryFingerprint || null,
      translationMode: result.translationMode || null,
    });
  }
  if (result?.finalTranslationSnapshotPath) {
    store.addArtifact(jobId, "final_translation_snapshot", result.finalTranslationSnapshotPath, {
      fingerprint: result.publication?.finalTranslationSnapshotFingerprint || null,
      translationMode: result.translationMode || null,
      publicationRevisionId: result.publication?.revisionId || null,
      publicationStatus: result.publication?.status || null,
    });
  }
}

function persistLearningQualityArtifacts(store, jobId, result) {
  if (result?.learningEvidenceSnapshotPath) {
    store.addArtifact(jobId, "learning_evidence_snapshot", result.learningEvidenceSnapshotPath, {});
  }
  if (result?.qualityObservationPath) {
    store.addArtifact(jobId, "translation_quality_observation", result.qualityObservationPath, {});
  }
  if (result?.deepAuditReviewPackagePath) {
    store.addArtifact(jobId, "deep_audit_review_package", result.deepAuditReviewPackagePath, {
      status: "awaiting_decisions",
      findingCount: result.findings?.length || 0,
    });
  }
  if (result?.qualityReportPath || result?.quality?.reportPath) {
    store.addArtifact(jobId, "quality_final_report", result.qualityReportPath || result.quality.reportPath, {
      status: result.quality?.status || null,
      finalScore: result.quality?.finalScore ?? null,
    });
  }
  if (result?.publication?.registryPath) {
    store.addArtifact(jobId, "translation_publication_registry", result.publication.registryPath, {
      revisionId: result.publication.revisionId,
      status: result.publication.status,
      chapterId: result.publication.chapterId,
    });
  }
}

function persistAuditReportArtifacts(store, jobId, result) {
  if (result?.reportPath && result?.sourceTranslationJobId && result?.snapshotFingerprint) {
    store.addArtifact(jobId, "translation_deep_audit_report", result.reportPath, {
      sourceTranslationJobId: result.sourceTranslationJobId,
      windowCount: result.windowCount || 0,
    });
  }
  if (result?.output) {
    store.addArtifact(jobId, "knowledge_base", result.output, {
      mangaId: result.mangaId || null,
      translatorId: result.translatorId || null,
      chapterId: result.chapterId || null,
    });
  }
  if (result?.report) {
    store.addArtifact(jobId, "knowledge_report", result.report, {
      mangaId: result.mangaId || null,
      translatorId: result.translatorId || null,
      chapterId: result.chapterId || null,
    });
  }
}

function persistSceneArtifacts(store, jobId, result) {
  if (result?.editedScenePath) {
    store.addArtifact(jobId, "edited_scene", result.editedScenePath, { sourceJobId: result.sourceJobId || jobId });
  }
  if (result?.scenePath) {
    store.addArtifact(jobId, "reference_scene", result.scenePath, { referenceSetId: result.referenceSetId });
  }
  if (result?.textsPath) {
    store.addArtifact(jobId, "reference_texts", result.textsPath, { referenceSetId: result.referenceSetId });
  }
  if (result?.observationPath) {
    store.addArtifact(jobId, "chapter_observation", result.observationPath, {
      referenceSetId: result.referenceSetId || null,
      chapterId: result.chapterId || null,
    });
  }
}

function persistBilingualArtifacts(store, jobId, result) {
  if (result?.bilingualEvidencePath) {
    store.addArtifact(jobId, "bilingual_evidence", result.bilingualEvidencePath, {
      mangaId: result.mangaId || null,
      translatorId: result.translatorId || null,
    });
  }
  if (result?.checkpointPath) {
    store.addArtifact(jobId, "bilingual_evidence_checkpoint", result.checkpointPath, {
      planHash: result.planHash || null,
      windowId: result.windowId || null,
      purpose: result.purpose || null,
      reused: result.reused === true,
    });
  }
}

function persistReferenceTermArtifacts(store, jobId, result) {
  if (result?.glossaryPath) {
    store.addArtifact(jobId, "glossary", result.glossaryPath, {
      mangaId: result.mangaId,
      referenceSetId: result.referenceSetId,
    });
  }
  if (result?.candidateTermsPath) {
    store.addArtifact(jobId, "candidate_terms", result.candidateTermsPath, {
      mangaId: result.mangaId,
      referenceSetId: result.referenceSetId,
    });
  }
  if (result?.storyContextPath) {
    store.addArtifact(jobId, "story_context", result.storyContextPath, {
      mangaId: result.mangaId,
      referenceSetId: result.referenceSetId,
    });
  }
}

function persistReferenceStyleArtifacts(store, jobId, result) {
  if (result?.styleEvidencePath) {
    store.addArtifact(jobId, "style_evidence", result.styleEvidencePath, {
      mangaId: result.mangaId,
      referenceSetId: result.referenceSetId,
    });
  }
  if (result?.styleProfilePath) {
    store.addArtifact(jobId, "style_profile", result.styleProfilePath, {
      mangaId: result.mangaId,
      referenceSetId: result.referenceSetId,
    });
  }
}

function persistReferenceContextPaths(store, jobId, result) {
  if (result?.translationContextPath) {
    store.addArtifact(jobId, "translation_context", result.translationContextPath, {
      mangaId: result.mangaId,
      chapterId: result.chapterId || null,
      referenceSetId: result.referenceSetId,
    });
  }
  if (result?.analysisArtifactPath) {
    store.addArtifact(jobId, "reference_ingestion_analysis", result.analysisArtifactPath, {
      referenceSetId: result.referenceSetId || null,
      mangaId: result.mangaId || null,
      chapterId: result.chapterId || null,
      workflowId: result.workflowId || null,
    });
  }
  if (result?.storyArtifactPath) {
    store.addArtifact(jobId, "reference_ingestion_story_delta", result.storyArtifactPath, {
      referenceSetId: result.referenceSetId || null,
      mangaId: result.mangaId || null,
      chapterId: result.chapterId || null,
      workflowId: result.workflowId || null,
    });
  }
}

function persistReferenceRevisionArtifacts(store, jobId, result) {
  if (result?.revisionPlanPath) {
    store.addArtifact(jobId, "knowledge_revision_plan", result.revisionPlanPath, {
      workflowId: result.workflowId || null,
      revisionId: result.knowledgeRevision?.id || result.revisionId || null,
      chapterId: result.chapterId || null,
    });
  }
  if (result?.knowledgeRevision?.afterSnapshotPath) {
    store.addArtifact(jobId, "knowledge_revision_snapshot", result.knowledgeRevision.afterSnapshotPath, {
      revisionId: result.knowledgeRevision.id,
      chapterId: result.knowledgeRevision.chapterId,
      sequenceNumber: result.knowledgeRevision.sequenceNumber,
    });
  }
}

function persistQualityValidationArtifacts(store, jobId, result) {
  if (!result?.quality?.reportPath) return;
  store.addArtifact(jobId, "quality_validation_report", result.quality.reportPath, {
    mangaId: result.mangaId || null,
    chapterId: result.chapterId || null,
    coverage: result.quality.coverage || 0,
    candidateCount: result.quality.candidateCount || 0,
    windowCount: result.quality.windowCount || 0,
  });
}

function persistWorkspaceManifestArtifacts(store, jobId) {
  for (const artifact of collectWorkspaceManifestArtifacts(jobId)) {
    store.addArtifact(jobId, artifact.kind, artifact.path, artifact.metadata);
  }
}

function persistJobArtifacts(store, jobId, result) {
  persistTranslationSnapshotArtifacts(store, jobId, result);
  persistLearningQualityArtifacts(store, jobId, result);
  persistAuditReportArtifacts(store, jobId, result);
  persistSceneArtifacts(store, jobId, result);
  persistBilingualArtifacts(store, jobId, result);
  persistReferenceTermArtifacts(store, jobId, result);
  persistReferenceStyleArtifacts(store, jobId, result);
  persistReferenceContextPaths(store, jobId, result);
  persistReferenceRevisionArtifacts(store, jobId, result);
  persistQualityValidationArtifacts(store, jobId, result);
  persistWorkspaceManifestArtifacts(store, jobId);
}

module.exports = { persistJobArtifacts };
