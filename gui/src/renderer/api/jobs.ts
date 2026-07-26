import { apiFetch, buildApiUrl } from "./client";
import type { SourcePreflightResult } from "../types/settings";

export type GuiJob = {
  id: string;
  type: string;
  status: string;
  stage: string;
  payload: Record<string, unknown>;
  result: unknown;
  error: string | null;
  retryOf?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  executionKind?: "job" | "workflow";
  workflowId?: string | null;
  parentJobId?: string | null;
  dependencyIds?: string[];
  laneKey?: string | null;
  sequenceNumber?: number | null;
  blockedReason?: string | null;
  events: Array<{ id: number; type: string; payload: unknown; createdAt: string }>;
  artifacts: Array<{ id: number; kind: string; path: string; metadata: unknown; createdAt: string }>;
  children?: GuiJob[];
};

export type GuiJobEvent = {
  id?: number;
  type: string;
  payload: unknown;
  createdAt?: string;
};

export type GuiArtifact = {
  id: number;
  kind: string;
  path: string;
  metadata: unknown;
  createdAt: string;
};

export type QualityReviewItem = {
  nodeId: string;
  original: string;
  currentTranslation: string;
  proposedTranslation: string | null;
  riskTypes: string[];
  confidence: number | null;
  reason: string | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  blocking: boolean;
  allowedDecisions: Array<"accept_proposal" | "manual_edit" | "confirm_current" | "ignore_and_publish">;
};

export type QualityReviewPackage = {
  schemaVersion: number;
  status: "waiting_user_review" | "passed" | "failed";
  generatedAt: string;
  pages: Array<{
    pageId: string | null;
    pageName: string;
    items: QualityReviewItem[];
    sequenceRisks: Array<{ startNodeId: string; endNodeId: string; nodeIds: string[]; reason: string }>;
  }>;
  summary: { blocking: number; warnings: number; pages: number };
};

export type QualityReviewDecision = {
  nodeId: string;
  action: "accept_proposal" | "manual_edit" | "confirm_current" | "ignore_and_publish";
  translation?: string;
};

export type EditedSceneNode = {
  nodeId: string;
  originalText: string;
  originalTranslation: string;
  editedTranslation: string;
  anchor: {
    pageName: string;
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
};

export type EditedScenePage = {
  pageId: string;
  pageName: string;
  nodeOrder: string[];
  nodes: Record<string, EditedSceneNode>;
};

export type EditedSceneDocument = {
  jobId: string;
  sourcePreflightId: string | null;
  mangaId: string | null;
  translatorId: string | null;
  chapterId: string | null;
  createdAt: string;
  updatedAt: string;
  sourcePageOrder: string[];
  pageOrder: string[];
  pages: Record<string, EditedScenePage>;
  stats: {
    pageCount: number;
    textNodeCount: number;
  };
};

export type ReferenceSetSummary = {
  id: string;
  label: string;
  source: string;
  referenceKind?: "source" | "translator";
  language: string;
  pageCount: number;
  extractionAvailable: boolean;
  extractionUpdatedAt: string | null;
  reviewStatus: ExtractionReviewStatus | null;
  activeReviewSessionId?: string | null;
  reviewRevision: number;
  reviewedAt: string | null;
  koharuProjectAvailable: boolean;
  rawNodeCount: number;
  currentNodeCount: number;
  reviewDiff: ExtractionReviewDiff | null;
  extractionFingerprint: string | null;
  observationStatus?: "missing" | "complete" | "stale";
  observationRevision?: string | null;
  observationCoverage?: {
    expected: number;
    observed: number;
    uncertain: number;
    invalid: number;
  } | null;
  observationUpdatedAt?: string | null;
  mangaId?: string | null;
  mangaLabel?: string | null;
  translatorId?: string | null;
  translatorLabel?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  enabled: boolean;
};

export type ExtractionReviewStatus =
  | "awaiting_review"
  | "editing"
  | "awaiting_order_review"
  | "reviewed"
  | "project_missing";

export type ExtractionReviewDiff = { added: number; deleted: number; changed: number };

export type ExtractionReviewTextNode = {
  nodeId: string;
  text: string;
  sourceText: string;
  translatedText: string | null;
  bbox: { x: number; y: number; width: number; height: number };
  originalIndex?: number | null;
  changeType?: "unchanged" | "added" | "modified" | "deleted";
};

export type ExtractionReviewPage = {
  pageId: string;
  pageName: string;
  texts: ExtractionReviewTextNode[];
  removedTexts?: ExtractionReviewTextNode[];
};

export type ExtractionReviewDocument = {
  referenceSetId: string;
  status: ExtractionReviewStatus;
  projectId: string | null;
  projectName: string | null;
  reviewRevision: number;
  reviewedAt: string | null;
  rawSummary: { pageCount: number; nodeCount: number };
  currentSummary: { pageCount: number; nodeCount: number };
  draftSummary: { pageCount: number; nodeCount: number } | null;
  reviewDiff: ExtractionReviewDiff;
  orderDraft: Array<{ pageId: string; nodeIds: string[] }> | null;
  pages: ExtractionReviewPage[];
  activeSessionId?: string | null;
  sessionId?: string;
  editorUrl?: string;
};

export type ImportedReferenceSet = ReferenceSetSummary & {
  imageDir: string;
  extractedDir: string;
  importedFrom?: string;
  createdAt?: string;
  sourceFolder?: string;
  textsPath?: string;
};

export type MangaSeriesSummary = {
  mangaId: string;
  label: string;
  language: string;
  updatedAt: string | null;
  translators: TranslatorProfileSummary[];
};

export type TranslatorProfileSummary = {
  translatorId: string;
  label: string;
  language: string;
  profileKind: "standard" | "learning_clone";
  styleSourceTranslatorId: string | null;
  updatedAt: string | null;
  chapterCount: number;
  chapters: ChapterSummary[];
};

export type ChapterSummary = {
  chapterId: string;
  chapterTitle: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type IngestionKnowledgeReport = {
  mangaId: string;
  translatorId: string | null;
  referenceKind?: "source" | "translator";
  ingestionAvailable: boolean;
  ingestionUpdatedAt: string | null;
  ingestionStale: boolean;
  assets: {
    glossaryPath: string;
    candidateTermsPath: string;
    storyContextPath: string;
    styleEvidencePath: string;
    styleProfilePath: string;
    translationContextPath: string;
  };
  summary: {
    glossaryEntries: number;
    acceptedTerminology: number;
    acceptedCharacters: number;
    candidateTerms: number;
    candidateCharacters: number;
    storyChapters: number;
    storyMentions: number;
    storyRelations: number;
    storyEvents: number;
    storyKeyLines: number;
    styleEvidenceChapters: number;
    styleDialogueSamples: number;
    styleNarrationSamples: number;
    styleCharacters: number;
  };
  glossary: Record<string, unknown>;
  candidateTerms: Record<string, unknown>;
  storyContext: Record<string, unknown>;
  styleEvidence: Record<string, unknown>;
  styleProfile: Record<string, unknown>;
  translationContext: Record<string, unknown>;
};

export type BilingualTermLink = {
  termLinkId: string;
  sourceMentionId: string;
  sourceSurface?: string;
  sourceNodeKeys: string[];
  targetNodeKeys: string[];
  sourceTexts: string[];
  targetTexts: string[];
  sourceChapterIds: string[];
  targetChapterIds: string[];
  targetSurface: string;
  category: string;
  confidence: number;
  status: "accepted" | "provisional" | "review" | "rejected";
  reason: string;
  manual?: boolean;
  observationCount?: number;
};

export type BilingualStylePair = {
  stylePairId: string;
  anchorId: string;
  sourceNodeKeys: string[];
  targetNodeKeys: string[];
  sourceTexts: string[];
  targetTexts: string[];
  sourceChapterIds: string[];
  targetChapterIds: string[];
  textRole: "dialogue" | "monologue" | "narration";
  styleChannel: "character_voice" | "inner_voice" | "narrator_voice";
  confidence: number;
  status: "accepted" | "provisional" | "review";
  reason: string;
};

export type BilingualActiveRun = {
  planHash: string;
  status: "running" | "failed" | "stopped" | "complete";
  totalWindows: number;
  completedWindows: number;
  reusedWindows: number;
  failedWindowId: string | null;
  resumeAvailable: boolean;
  error?: string;
  updatedAt: string;
};

export type BilingualEvidenceDocument = {
  schemaVersion: number;
  mangaId: string;
  translatorId: string;
  status: "missing" | "waiting_prerequisite" | "generating" | "partial" | "complete" | "stale";
  generatedAt?: string;
  updatedAt?: string;
  planHash?: string;
  contractHash?: string;
  termLinks: BilingualTermLink[];
  stylePairs: BilingualStylePair[];
  unmatchedAnchors: Array<{
    windowId: string;
    anchorType: "terminology" | "style";
    anchorId: string;
    reason: string;
  }>;
  activeRun?: BilingualActiveRun | null;
  totalWindows?: number;
  completedWindows?: number;
  reusedWindows?: number;
  failedWindowId?: string | null;
  resumeAvailable?: boolean;
  staleReasons?: string[];
  promotedTerminology?: number;
  ledgerRevision?: number;
  conflicts?: Array<{
    conflictId: string;
    sourceSurface: string;
    targetSurfaces: string[];
    status: "review";
  }>;
  confidenceChanges?: Array<{
    evidenceId: string;
    sourceSurface: string;
    targetSurface: string;
    previousConfidence: number;
    currentConfidence: number;
  }>;
  history?: Array<{
    planHash: string;
    committedAt: string;
    model?: string | null;
    termEvidenceCount: number;
    styleEvidenceCount: number;
  }>;
  chapterGroups?: Array<{
    chapterId: string;
    chapterTitle: string;
    termLinkIds: string[];
    stylePairIds: string[];
  }>;
  summary?: {
    totalWindows: number;
    completedWindows: number;
    terminologyWindows: number;
    styleWindows: number;
    accepted: number;
    provisional: number;
    review: number;
    unmatched: number;
  };
};

export function getJobs(): Promise<{ jobs: GuiJob[] }> {
  return apiFetch("/jobs?includeDeleted=1");
}

export function getReferenceSets(): Promise<{ referenceSets: ReferenceSetSummary[] }> {
  return apiFetch("/references");
}

export function getExtractionReview(referenceSetId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review`);
}

export function runReferenceDeepReview(
  referenceSetId: string,
  payload: { nodeKeys?: string[]; reviewReason?: string } = {}
): Promise<GuiJob> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/deep-review`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function startExtractionReview(referenceSetId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/session`, { method: "POST" });
}

export function syncExtractionReview(referenceSetId: string, sessionId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/session/sync`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function finishExtractionReviewEditor(referenceSetId: string, sessionId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/session/finish`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export function cancelExtractionReview(referenceSetId: string, sessionId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/session`, {
    method: "DELETE",
    body: JSON.stringify({ sessionId }),
  });
}

export function saveExtractionReviewOrder(
  referenceSetId: string,
  pages: Array<{ pageId: string; nodeIds: string[] }>
): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/order`, {
    method: "PUT",
    body: JSON.stringify({ pages }),
  });
}

export function confirmExtractionReview(referenceSetId: string): Promise<{ review: ExtractionReviewDocument }> {
  return apiFetch(`/references/${encodeURIComponent(referenceSetId)}/extraction-review/confirm`, { method: "POST" });
}

export function importReferenceFolder(payload: {
  sourceFolder: string;
  label?: string;
  language?: string;
  referenceKind?: "source" | "translator";
  mangaId?: string;
  mangaLabel?: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
}): Promise<{ referenceSet: ImportedReferenceSet }> {
  return apiFetch("/references/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteReferenceSet(referenceSetId: string): Promise<{
  deleted: { id: string; label: string; deleted: boolean };
  deletedJobs: Array<{ id: string; status: string; type: string }>;
}> {
  return apiFetch(`/references/${referenceSetId}`, {
    method: "DELETE",
  });
}

export function deleteReferenceExtraction(referenceSetId: string): Promise<{
  deletedExtraction: { id: string; label: string; deleted: boolean; deletedExtraction: boolean };
  deletedJobs: Array<{ id: string; status: string; type: string }>;
}> {
  return apiFetch(`/references/${referenceSetId}/extraction`, {
    method: "DELETE",
  });
}

export function getMangaSeries(): Promise<{ series: MangaSeriesSummary[] }> {
  return apiFetch("/manga");
}

export function createManga(payload: {
  label: string;
  language?: string;
}): Promise<{ manga: MangaSeriesSummary }> {
  return apiFetch("/manga", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createTranslatorProfile(
  mangaId: string,
  payload: { label: string; language?: string; styleSourceTranslatorId?: string }
): Promise<{ translator: TranslatorProfileSummary }> {
  return apiFetch(`/manga/${mangaId}/translators`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteManga(mangaId: string): Promise<{
  deleted: { mangaId: string; label: string; deleted: boolean };
  deletedReferences: Array<{ id: string; label: string; deleted: boolean }>;
  deletedJobs: Array<{ id: string; status: string; type: string }>;
  deletedRevisionCount: number;
}> {
  return apiFetch(`/manga/${mangaId}`, {
    method: "DELETE",
  });
}

export function deleteTranslatorProfileRecord(
  mangaId: string,
  translatorId: string
): Promise<{
  deleted: { mangaId: string; translatorId: string; label: string; deleted: boolean };
  deletedReferences: Array<{ id: string; label: string; deleted: boolean }>;
  deletedJobs: Array<{ id: string; status: string; type: string }>;
  deletedRevisionCount: number;
}> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}`, {
    method: "DELETE",
  });
}

export function getChapters(
  mangaId: string,
  translatorId: string
): Promise<{ chapters: ChapterSummary[] }> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}/chapters`);
}

export function createChapter(
  mangaId: string,
  translatorId: string,
  payload: { chapterTitle?: string | null }
): Promise<{ chapter: ChapterSummary }> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}/chapters`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateChapter(
  mangaId: string,
  translatorId: string,
  chapterId: string,
  payload: { chapterTitle?: string | null }
): Promise<{ chapter: ChapterSummary }> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}/chapters/${chapterId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteChapter(
  mangaId: string,
  translatorId: string,
  chapterId: string
): Promise<{
  deleted: { mangaId: string; translatorId: string; chapterId: string; deleted: boolean };
}> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}/chapters/${chapterId}`, {
    method: "DELETE",
  });
}

export function reorderChapters(
  mangaId: string,
  translatorId: string,
  orderedChapterIds: string[]
): Promise<{ chapters: ChapterSummary[] }> {
  return apiFetch(`/manga/${mangaId}/translators/${translatorId}/chapters/reorder`, {
    method: "POST",
    body: JSON.stringify({ orderedChapterIds }),
  });
}

export function getJob(jobId: string): Promise<GuiJob> {
  return apiFetch(`/jobs/${jobId}`);
}

export function getJobEvents(jobId: string): Promise<{ events: GuiJobEvent[] }> {
  return apiFetch(`/jobs/${jobId}/events`);
}

export function getJobArtifacts(jobId: string): Promise<{ artifacts: GuiArtifact[] }> {
  return apiFetch(`/jobs/${jobId}/artifacts`);
}

export function getIngestionKnowledgeReport(
  mangaId: string,
  translatorId: string
): Promise<IngestionKnowledgeReport> {
  return apiFetch(
    `/knowledge/${mangaId}/ingestion-report?translatorId=${encodeURIComponent(translatorId)}`
  );
}

export function getBilingualEvidence(
  mangaId: string,
  translatorId: string
): Promise<BilingualEvidenceDocument> {
  return apiFetch(
    `/knowledge/${encodeURIComponent(mangaId)}/bilingual-evidence?translatorId=${encodeURIComponent(translatorId)}`
  );
}

export function runBilingualEnrichment(payload: {
  mangaId: string;
  translatorId: string;
}): Promise<GuiJob> {
  return apiFetch(
    `/knowledge/${encodeURIComponent(payload.mangaId)}/bilingual-enrichment?translatorId=${encodeURIComponent(payload.translatorId)}`,
    {
    method: "POST",
    }
  );
}

export function updateBilingualEvidenceLink(payload: {
  mangaId: string;
  translatorId: string;
  linkId: string;
  action: "accept" | "unbind";
}): Promise<BilingualEvidenceDocument> {
  return apiFetch(
    `/knowledge/${encodeURIComponent(payload.mangaId)}/bilingual-evidence/links/${encodeURIComponent(payload.linkId)}` +
      `?translatorId=${encodeURIComponent(payload.translatorId)}`,
    {
    method: "PUT",
    body: JSON.stringify({
      action: payload.action,
    }),
    }
  );
}

export function deleteIngestionKnowledgeReport(
  mangaId: string,
  translatorId: string
): Promise<{
  deletedIngestion: {
    mangaId: string;
    translatorId: string;
    label: string;
    deleted: boolean;
    clearedKnowledgeBaseDir: string;
    clearedReportDir: string;
  };
  deletedJobs: Array<{ id: string; status: string; type: string }>;
}> {
  return apiFetch(`/knowledge/${mangaId}/ingestion?translatorId=${encodeURIComponent(translatorId)}`, {
    method: "DELETE",
  });
}

export type TranslationJobPayload = {
  translationMode: "quick" | "reference_style" | "local_style" | "learning_style";
  sourceFolder?: string;
  sourcePreflightId?: string;
  targetLanguage?: string;
  baseUrl?: string;
  outputDir?: string;
  qualityCheck?: boolean;
  exportFormat?: string;
  mangaId?: string;
  mangaLabel?: string;
  translatorId?: string;
  translatorLabel?: string;
  referenceTranslatorId?: string;
  referenceTranslatorLabel?: string;
  chapterId?: string;
  sourceChapterId?: string;
  chapterTitle?: string;
  chapterLabel?: string;
  glossaryMode?: "canonical" | "reference_only" | "disabled";
};

export type TranslationMemoryInspection = {
  ready: boolean;
  blockingReason: string | null;
  translationMode: TranslationJobPayload["translationMode"];
  policy: {
    useReferenceMemory: boolean;
    useLocalMemory: boolean;
    runQuality: boolean;
    commitKnowledge: boolean;
  };
  fingerprint: string;
  chapterMapping: {
    sourceChapterId: string | null;
    sourceChapterTitle: string | null;
    method: "explicit" | "chapter_number" | "sort_order" | "global_only" | null;
  } | null;
  readiness: { reference: boolean; local: boolean };
  usage: Record<string, number>;
  warnings: string[];
};

export type ReferenceExtractionPayload = {
  referenceSetId: string;
  baseUrl?: string;
  targetLanguage?: string;
  translator?: string;
  mangaId?: string;
  mangaLabel?: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
  chapterLabel?: string;
  referenceKind?: "source" | "translator";
};

export type ReferenceIngestionPayload = {
  referenceSetId: string;
  mangaId: string;
  mangaLabel?: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
  chapterLabel?: string;
  referenceKind: "source" | "translator";
  glossaryMode?: "canonical" | "reference_only" | "disabled";
  useForTerminology?: boolean;
  useForStyle?: boolean;
  analysisDepth?: "quick_read" | "deep_read";
  translator?: string;
};

export type PostEditExportPayload = {
  sourceJobId: string;
  baseUrl?: string;
  exportFormat?: string;
  outputDir?: string;
};

export function createTranslationJob(payload: TranslationJobPayload): Promise<GuiJob> {
  return apiFetch("/jobs/translation", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createTranslationDeepAuditJob(jobId: string): Promise<GuiJob> {
  return apiFetch(`/jobs/${encodeURIComponent(jobId)}/deep-audit`, { method: "POST" });
}

export function inspectTranslationMemory(
  payload: Pick<
    TranslationJobPayload,
    | "translationMode"
    | "qualityCheck"
    | "mangaId"
    | "translatorId"
    | "referenceTranslatorId"
    | "targetLanguage"
    | "chapterId"
    | "sourceChapterId"
    | "chapterTitle"
    | "glossaryMode"
  >
): Promise<TranslationMemoryInspection> {
  return apiFetch("/translation/memory/inspect", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createSourcePreflight(payload: {
  sourceFolder: string;
}): Promise<SourcePreflightResult> {
  return apiFetch("/source-preflight", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getSourcePreflight(preflightId: string): Promise<SourcePreflightResult> {
  return apiFetch(`/source-preflight/${preflightId}`);
}

export function reorderSourcePreflight(
  preflightId: string,
  orderedImageIds: string[]
): Promise<SourcePreflightResult> {
  return apiFetch(`/source-preflight/${preflightId}/reorder`, {
    method: "POST",
    body: JSON.stringify({ orderedImageIds }),
  });
}

export function createReferenceExtractionJob(payload: ReferenceExtractionPayload): Promise<GuiJob> {
  return apiFetch("/jobs/reference-extraction", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createReferenceIngestionJob(payload: ReferenceIngestionPayload): Promise<GuiJob> {
  return apiFetch("/jobs/reference-ingestion", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createReferenceIngestionJobs(
  items: ReferenceIngestionPayload[]
): Promise<{ jobs: GuiJob[] }> {
  return apiFetch("/jobs/reference-ingestion/batch", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

export function getEditedScene(jobId: string): Promise<{
  exists: boolean;
  editedScene: EditedSceneDocument | null;
}> {
  return apiFetch(`/post-edit/${jobId}`);
}

export function saveEditedScene(
  jobId: string,
  payload: EditedSceneDocument
): Promise<{ editedScene: EditedSceneDocument }> {
  return apiFetch(`/post-edit/${jobId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createPostEditReferenceSet(
  jobId: string,
  payload: {
    label: string;
    language?: string;
    referenceKind?: "source" | "translator";
    mangaId?: string;
    mangaLabel?: string;
    translatorId?: string;
    translatorLabel?: string;
    chapterId?: string;
    chapterTitle?: string;
  }
): Promise<{ referenceSet: ImportedReferenceSet }> {
  return apiFetch(`/post-edit/${jobId}/reference-set`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createPostEditExportJob(payload: PostEditExportPayload): Promise<GuiJob> {
  return apiFetch("/jobs/post-edit-export", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getQualityReview(jobId: string): Promise<QualityReviewPackage> {
  return apiFetch<QualityReviewPackage>(`/jobs/${encodeURIComponent(jobId)}/quality-review`);
}

export function confirmQualityReview(jobId: string, decisions: QualityReviewDecision[]): Promise<GuiJob> {
  return apiFetch<GuiJob>(`/jobs/${encodeURIComponent(jobId)}/quality-review/confirm`, {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
}

export function createQualityRepairJob(jobId: string): Promise<GuiJob> {
  return apiFetch<GuiJob>(`/jobs/${encodeURIComponent(jobId)}/quality-repair`, { method: "POST" });
}

export function retryJob(jobId: string): Promise<GuiJob> {
  return apiFetch(`/jobs/${jobId}/retry`, {
    method: "POST",
  });
}

export function cancelJob(jobId: string): Promise<GuiJob> {
  return apiFetch(`/jobs/${jobId}/cancel`, {
    method: "POST",
  });
}

export function deleteJob(jobId: string): Promise<{ deleted: { id: string; status: string; type: string } }> {
  return apiFetch(`/jobs/${jobId}`, {
    method: "DELETE",
  });
}

export function deleteJobsBatch(jobIds: string[]): Promise<{
  deleted: Array<{ id: string; status: string; type: string }>;
  missing: string[];
}> {
  return apiFetch("/jobs/delete-batch", {
    method: "POST",
    body: JSON.stringify({ jobIds }),
  });
}

export function restoreJob(jobId: string): Promise<{ restored: { id: string; status: string; type: string } }> {
  return apiFetch(`/jobs/${jobId}/restore`, {
    method: "POST",
  });
}

export function restoreJobsBatch(jobIds: string[]): Promise<{
  restored: Array<{ id: string; status: string; type: string }>;
  missing: string[];
}> {
  return apiFetch("/jobs/restore-batch", {
    method: "POST",
    body: JSON.stringify({ jobIds }),
  });
}

export function purgeJob(jobId: string): Promise<{ purged: { id: string; status: string; type: string } }> {
  return apiFetch(`/jobs/${jobId}/permanent`, {
    method: "DELETE",
  });
}

export function purgeJobsBatch(jobIds: string[]): Promise<{
  purged: Array<{ id: string; status: string; type: string }>;
  missing: string[];
}> {
  return apiFetch("/jobs/purge-batch", {
    method: "POST",
    body: JSON.stringify({ jobIds }),
  });
}
