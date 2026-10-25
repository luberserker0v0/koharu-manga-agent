const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { isRetryableAoError } = require("../../../integrations/ao/errors/ao_error_classifier");
const { mergeSemanticResults } = require("../../../integrations/ao/contracts/semantic_result");
const { config } = require("../../../config");
const { listReferenceSets, loadExtractedTexts } = require("../sets/reference_sets");
const { inspectChapterObservation } = require("../observation/reference_observation");
const { listKnowledgeSeries, resolveKnowledgeAssetPaths } = require("../../knowledge/registry/knowledge_paths");
const {
  defaultCanonicalGlossary,
  loadCanonicalGlossary,
  mergeCanonicalGlossary,
  stableId,
  writeCanonicalGlossary,
} = require("../../knowledge/assets/knowledge_assets");

const SCHEMA_VERSION = 3;
const LEDGER_SCHEMA_VERSION = 1;
const ACCEPTED_THRESHOLD = 0.85;
const PROVISIONAL_THRESHOLD = 0.6;
const TERM_BATCH_SIZE = 5;
const TERM_EVIDENCE_LIMIT = 2;
const STYLE_SAMPLES_PER_ROLE = 3;
const SOURCE_CONTEXT_RADIUS = 2;
const TARGET_CONTEXT_RADIUS = 20;
const MAX_TARGET_CANDIDATES = 80;
const STYLE_ROLES = new Set(["dialogue", "monologue", "narration"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function orderedReferences(mangaId, translatorId, referenceKind) {
  const series = listKnowledgeSeries().find((entry) => entry.mangaId === mangaId);
  const profile =
    referenceKind === "source"
      ? (series?.translators || []).find((entry) => entry.translatorId === "translator_original")
      : (series?.translators || []).find((entry) => entry.translatorId === translatorId);
  const orderByChapter = new Map((profile?.chapters || []).map((chapter) => [chapter.chapterId, chapter.sortOrder]));
  return listReferenceSets()
    .filter(
      (entry) =>
        entry.mangaId === mangaId &&
        entry.referenceKind === referenceKind &&
        (referenceKind === "source" || entry.translatorId === translatorId),
    )
    .map((entry, index) => ({
      ...entry,
      sortOrder: orderByChapter.get(entry.chapterId) ?? index,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function buildTextByKey(extracted) {
  return new Map(
    (extracted.pages || []).flatMap((page) =>
      (page.texts || []).map((node) => [
        `${page.pageName}::${node.nodeId}`,
        String(node.sourceText || node.text || "").trim(),
      ]),
    ),
  );
}

function buildObservedNode(reference, side, chapterIndex, node, textByKey, chapterNodeIndex, streamIndex) {
  const localKey = `${node.pageName}::${node.nodeId}`;
  return {
    nodeKey: `${reference.id}::${localKey}`,
    localNodeKey: localKey,
    side,
    referenceSetId: reference.id,
    chapterId: reference.chapterId,
    chapterTitle: reference.chapterTitle,
    chapterIndex,
    chapterNodeIndex,
    pageName: node.pageName,
    nodeId: node.nodeId,
    text: textByKey.get(localKey) || "",
    textRole: node.textRole,
    styleChannel: node.styleChannel,
    roleConfidence: Number(node.roleConfidence) || 0,
    speakerRef: node.speakerRef || null,
    streamIndex,
  };
}

function buildObservedMentions(reference, observation, chapterIndex) {
  return (observation.mentions || []).map((mention) => ({
    ...mention,
    mentionId: `${reference.id}::${mention.mentionId}`,
    originalMentionId: mention.mentionId,
    referenceSetId: reference.id,
    chapterId: reference.chapterId,
    chapterIndex,
    evidenceNodeKeys: (mention.evidenceNodeKeys || []).map((key) => `${reference.id}::${key}`),
  }));
}

function buildObservedChapterRecord(reference, chapterIndex, observation, chapterNodes) {
  return {
    chapterId: reference.chapterId,
    chapterTitle: reference.chapterTitle,
    referenceSetId: reference.id,
    chapterIndex,
    fingerprint: observation.cacheKey,
    nodes: chapterNodes,
  };
}

function buildObservedChapter(reference, side, chapterIndex, startingStreamIndex) {
  const inspection = inspectChapterObservation(reference.id);
  if (inspection.status !== "complete") return null;
  const observation = inspection.observation;
  const textByKey = buildTextByKey(loadExtractedTexts(reference.id));
  const chapterNodes = [];
  for (const node of observation.nodes || []) {
    chapterNodes.push(
      buildObservedNode(
        reference,
        side,
        chapterIndex,
        node,
        textByKey,
        chapterNodes.length,
        startingStreamIndex + chapterNodes.length,
      ),
    );
  }
  return {
    chapterNodes,
    chapterMentions: buildObservedMentions(reference, observation, chapterIndex),
    chapter: buildObservedChapterRecord(reference, chapterIndex, observation, chapterNodes),
    fingerprint: observation.cacheKey,
  };
}

function buildObservedStream(references, side) {
  const nodes = [];
  const mentions = [];
  const chapters = [];
  const fingerprints = [];
  for (const [chapterIndex, reference] of references.entries()) {
    const result = buildObservedChapter(reference, side, chapterIndex, nodes.length);
    if (!result) continue;
    nodes.push(...result.chapterNodes);
    mentions.push(...result.chapterMentions);
    chapters.push(result.chapter);
    fingerprints.push(result.fingerprint);
  }
  return {
    nodes,
    mentions,
    chapters,
    fingerprint: stableId("observed_stream", fingerprints.join("::")),
  };
}

function nodesAround(nodes, indexes, radius) {
  const selected = new Map();
  for (const index of indexes) {
    for (let offset = Math.max(0, index - radius); offset <= Math.min(nodes.length - 1, index + radius); offset += 1) {
      selected.set(nodes[offset].nodeKey, nodes[offset]);
    }
  }
  return [...selected.values()].sort((left, right) => left.streamIndex - right.streamIndex);
}

function candidatesForAnchor(anchor, source, target, purpose) {
  const sourceNode = source.nodes.find((node) => anchor.sourceNodeKeys.includes(node.nodeKey));
  if (!sourceNode) return [];
  const sourceChapter = source.chapters[sourceNode.chapterIndex];
  const candidatesForAnchor = new Map();
  for (const chapterIndex of [sourceNode.chapterIndex - 1, sourceNode.chapterIndex, sourceNode.chapterIndex + 1]) {
    const targetChapter = target.chapters[chapterIndex];
    if (!targetChapter || targetChapter.nodes.length === 0) continue;
    const ratio = sourceChapter?.nodes.length > 1 ? sourceNode.chapterNodeIndex / (sourceChapter.nodes.length - 1) : 0;
    const center = Math.round(ratio * Math.max(0, targetChapter.nodes.length - 1));
    const radius = chapterIndex === sourceNode.chapterIndex ? TARGET_CONTEXT_RADIUS : 8;
    const candidates = nodesAround(targetChapter.nodes, [center], radius).filter(
      (node) => purpose !== "style" || node.textRole === anchor.textRole,
    );
    for (const node of candidates) candidatesForAnchor.set(node.nodeKey, node);
  }
  return [...candidatesForAnchor.values()].sort((left, right) => left.streamIndex - right.streamIndex);
}

function targetCandidatesForAnchors(anchors, source, target, purpose) {
  const candidateGroups = anchors.map((anchor) => candidatesForAnchor(anchor, source, target, purpose));
  const selected = new Map();
  for (let index = 0; selected.size < MAX_TARGET_CANDIDATES; index += 1) {
    let found = false;
    for (const candidates of candidateGroups) {
      const node = candidates[index];
      if (!node) continue;
      found = true;
      selected.set(node.nodeKey, node);
      if (selected.size >= MAX_TARGET_CANDIDATES) break;
    }
    if (!found) break;
  }
  return [...selected.values()].sort((left, right) => left.streamIndex - right.streamIndex);
}

function buildTerminologyAnchors(batch) {
  return batch
    .map((mention) => ({
      anchorId: mention.mentionId,
      purpose: "terminology",
      sourceMentionId: mention.mentionId,
      surfaceForm: mention.surfaceForm,
      entityType: mention.entityType,
      confidence: mention.confidence,
      sourceNodeKeys: mention.evidenceNodeKeys.slice(0, TERM_EVIDENCE_LIMIT),
    }))
    .filter((anchor) => anchor.sourceNodeKeys.length > 0);
}

function buildTerminologyWindow(chapter, batchIndex, anchors, source, target) {
  if (anchors.length === 0) return null;
  const sourceIndexes = anchors
    .flatMap((anchor) => anchor.sourceNodeKeys)
    .map((key) => source.nodes.findIndex((node) => node.nodeKey === key))
    .filter((index) => index >= 0);
  const windowKey = `terminology:${chapter.referenceSetId}:${batchIndex}`;
  return {
    windowId: `term_${sha256(windowKey).slice(0, 12)}`,
    windowKey,
    purpose: "terminology",
    chapterId: chapter.chapterId,
    chapterTitle: chapter.chapterTitle,
    anchors,
    sourceNodes: nodesAround(source.nodes, sourceIndexes, SOURCE_CONTEXT_RADIUS),
    targetNodes: targetCandidatesForAnchors(anchors, source, target, "terminology"),
  };
}

function buildTerminologyWindows(source, target) {
  const windows = [];
  const mentionsByChapter = new Map();
  for (const mention of source.mentions) {
    const entries = mentionsByChapter.get(mention.chapterId) || [];
    entries.push(mention);
    mentionsByChapter.set(mention.chapterId, entries);
  }
  for (const chapter of source.chapters) {
    const mentions = mentionsByChapter.get(chapter.chapterId) || [];
    for (let offset = 0; offset < mentions.length; offset += TERM_BATCH_SIZE) {
      const batch = mentions.slice(offset, offset + TERM_BATCH_SIZE);
      const anchors = buildTerminologyAnchors(batch);
      const window = buildTerminologyWindow(chapter, Math.floor(offset / TERM_BATCH_SIZE), anchors, source, target);
      if (window) windows.push(window);
    }
  }
  return windows;
}

function evenlySpaced(nodes, limit) {
  if (nodes.length <= limit) return nodes;
  if (limit === 1) return [nodes[Math.floor(nodes.length / 2)]];
  return Array.from({ length: limit }, (_, index) => nodes[Math.round((index * (nodes.length - 1)) / (limit - 1))]);
}

function buildStyleAnchors(chapter) {
  const anchors = [];
  for (const textRole of STYLE_ROLES) {
    const candidates = chapter.nodes.filter(
      (node) => node.textRole === textRole && node.roleConfidence >= 0.65 && node.text,
    );
    for (const node of evenlySpaced(candidates, STYLE_SAMPLES_PER_ROLE)) {
      anchors.push({
        anchorId: `style:${node.nodeKey}`,
        purpose: "style",
        sourceNodeKeys: [node.nodeKey],
        textRole: node.textRole,
        styleChannel: node.styleChannel,
        speakerRef: node.speakerRef,
      });
    }
  }
  return anchors;
}

function buildStyleWindows(source, target) {
  const windows = [];
  for (const chapter of source.chapters) {
    const anchors = buildStyleAnchors(chapter);
    if (anchors.length === 0) continue;
    const sourceIndexes = anchors.map((anchor) =>
      source.nodes.findIndex((node) => node.nodeKey === anchor.sourceNodeKeys[0]),
    );
    const windowKey = `style:${chapter.referenceSetId}`;
    windows.push({
      windowId: `style_${sha256(windowKey).slice(0, 12)}`,
      windowKey,
      purpose: "style",
      chapterId: chapter.chapterId,
      chapterTitle: chapter.chapterTitle,
      anchors,
      sourceNodes: nodesAround(source.nodes, sourceIndexes, SOURCE_CONTEXT_RADIUS),
      targetNodes: targetCandidatesForAnchors(anchors, source, target, "style"),
    });
  }
  return windows;
}

function computeContractHash() {
  const files = [
    path.join(__dirname, "..", "..", "..", "integrations", "ao", "contracts", "bilingual_evidence_contract.js"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "bilingual-evidence-builder.md"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "bilingual-evidence-contract", "SKILL.md"),
  ];
  return sha256(files.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n---\n"));
}

function stableWindowPayload(window) {
  const cleanNode = (node) => ({
    nodeKey: node.nodeKey,
    localNodeKey: node.localNodeKey || null,
    referenceSetId: node.referenceSetId || null,
    chapterId: node.chapterId || null,
    pageName: node.pageName || null,
    nodeId: node.nodeId || null,
    text: node.text || "",
    textRole: node.textRole || null,
    styleChannel: node.styleChannel || null,
    roleConfidence: Number(node.roleConfidence) || 0,
    speakerRef: node.speakerRef || null,
    chapterNodeIndex: Number(node.chapterNodeIndex) || 0,
  });
  return {
    windowKey: window.windowKey,
    purpose: window.purpose,
    chapterId: window.chapterId,
    anchors: window.anchors,
    sourceNodes: window.sourceNodes.map(cleanNode),
    targetNodes: window.targetNodes.map(cleanNode),
  };
}

function attachWindowFingerprints(windows, { contractHash, model, planner }) {
  return windows.map((window) => ({
    ...window,
    windowFingerprint: sha256(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        contractHash,
        model: model || null,
        planner,
        window: stableWindowPayload(window),
      }),
    ),
  }));
}

function buildPlanner() {
  return {
    termBatchSize: TERM_BATCH_SIZE,
    termEvidenceLimit: TERM_EVIDENCE_LIMIT,
    styleSamplesPerRole: STYLE_SAMPLES_PER_ROLE,
    sourceContextRadius: SOURCE_CONTEXT_RADIUS,
    targetContextRadius: TARGET_CONTEXT_RADIUS,
    maxTargetCandidates: MAX_TARGET_CANDIDATES,
  };
}

function buildPlanWindows(source, target, contractHash, model, planner) {
  const windows = attachWindowFingerprints(
    [...buildTerminologyWindows(source, target), ...buildStyleWindows(source, target)],
    { contractHash, model, planner },
  );
  return windows;
}

function buildPlanHash(mangaId, translatorId, source, target, contractHash, model, planner, windows) {
  return sha256(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      mangaId,
      translatorId,
      sourceFingerprint: source.fingerprint,
      targetFingerprint: target.fingerprint,
      contractHash,
      model: model || null,
      planner,
      windows: windows.map((window) => ({
        windowId: window.windowId,
        windowFingerprint: window.windowFingerprint,
      })),
    }),
  );
}

function buildPlan({ mangaId, translatorId, source, target, model }) {
  const contractHash = computeContractHash();
  const planner = buildPlanner();
  const windows = buildPlanWindows(source, target, contractHash, model, planner);
  const planHash = buildPlanHash(mangaId, translatorId, source, target, contractHash, model, planner, windows);
  return {
    schemaVersion: SCHEMA_VERSION,
    planHash,
    mangaId,
    translatorId,
    sourceFingerprint: source.fingerprint,
    targetFingerprint: target.fingerprint,
    contractHash,
    model: model || null,
    planner,
    windows,
    sourceMentions: source.mentions,
    createdAt: new Date().toISOString(),
  };
}

function runPaths(mangaId, translatorId, planHash) {
  const assets = resolveKnowledgeAssetPaths({ mangaId, translatorId });
  const runDir = path.join(assets.bilingualRunsDir, planHash);
  return {
    ...assets,
    runDir,
    planPath: path.join(runDir, "plan.json"),
    activeRunPath: path.join(assets.bilingualRunsDir, "active_run.json"),
  };
}

function validCheckpoint(checkpoint, plan, window) {
  return Boolean(
    checkpoint &&
      checkpoint.schemaVersion === SCHEMA_VERSION &&
      checkpoint.windowId === window.windowId &&
      checkpoint.windowFingerprint === window.windowFingerprint &&
      checkpoint.contractHash === plan.contractHash &&
      checkpoint.result,
  );
}

function checkpointPath(paths, window) {
  return path.join(paths.bilingualCheckpointStoreDir, `${window.windowFingerprint}.json`);
}

function transientAoError(error) {
  return isRetryableAoError(error);
}

function statusForConfidence(confidence) {
  return confidence >= ACCEPTED_THRESHOLD ? "accepted" : confidence >= PROVISIONAL_THRESHOLD ? "provisional" : "review";
}

function combinedConfidence(values) {
  return 1 - values.reduce((remaining, value) => remaining * (1 - Math.max(0, Math.min(1, value))), 1);
}

function evidenceObservationKey(entry) {
  return sha256(
    JSON.stringify({
      sourceNodeKeys: [...(entry.sourceNodeKeys || [])].sort(),
      targetNodeKeys: [...(entry.targetNodeKeys || [])].sort(),
      targetSurface: entry.targetSurface || null,
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
    }),
  );
}

function defaultEvidenceLedger(mangaId, translatorId) {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    mangaId,
    translatorId,
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    plans: [],
    termEvidence: [],
    styleEvidence: [],
    unmatchedAnchors: [],
    conflicts: [],
    confidenceChanges: [],
  };
}

function applyTermEvidenceConfidence(termEvidence) {
  for (const entry of termEvidence) {
    const confidences = entry.observations.map((observation) => observation.confidence);
    entry.confidence = combinedConfidence(confidences);
    entry.supportingChapterIds = [
      ...new Set(entry.observations.flatMap((observation) => observation.sourceChapterIds || [])),
    ];
    const direct = confidences.some((confidence) => confidence >= ACCEPTED_THRESHOLD);
    const repeated = entry.supportingChapterIds.length >= 2 && entry.confidence >= 0.8;
    entry.status = entry.manualStatus || (direct || repeated ? "accepted" : statusForConfidence(entry.confidence));
    entry.latestObservation = entry.observations.at(-1) || null;
  }
}

function pushTermConflict(conflicts, sourceSurface, viable) {
  conflicts.push({
    conflictId: `term_conflict_${sha256(sourceSurface).slice(0, 16)}`,
    sourceSurface,
    targetSurfaces: viable.map((entry) => entry.targetSurface),
    status: "review",
  });
  for (const entry of viable) {
    if (!entry.manualStatus) entry.status = "review";
  }
}

function detectTermConflicts(termEvidence) {
  const conflicts = [];
  const termsBySource = new Map();
  for (const entry of termEvidence) {
    const variants = termsBySource.get(entry.sourceSurface) || [];
    variants.push(entry);
    termsBySource.set(entry.sourceSurface, variants);
  }
  for (const [sourceSurface, variants] of termsBySource) {
    const manuallyAccepted = variants.find((entry) => entry.manualStatus === "accepted");
    if (manuallyAccepted) {
      for (const entry of variants) {
        if (entry !== manuallyAccepted && !entry.manualStatus) entry.status = "rejected";
      }
      continue;
    }
    const viable = variants.filter((entry) => entry.status !== "rejected" && entry.confidence >= PROVISIONAL_THRESHOLD);
    if (viable.length < 2) continue;
    pushTermConflict(conflicts, sourceSurface, viable);
  }
  return conflicts;
}

function resolveTermEvidenceStatuses(termEvidence) {
  applyTermEvidenceConfidence(termEvidence);
  return detectTermConflicts(termEvidence);
}

function ledgerBase(existing, plan) {
  return existing?.schemaVersion === LEDGER_SCHEMA_VERSION
    ? existing
    : defaultEvidenceLedger(plan.mangaId, plan.translatorId);
}

function cloneTermMap(base) {
  return new Map(
    (base.termEvidence || []).map((entry) => [
      entry.evidenceId,
      {
        ...entry,
        observations: [...(entry.observations || [])],
      },
    ]),
  );
}

function windowFingerprintMap(termLinks, stylePairs, unmatchedAnchors) {
  return new Map([
    ...termLinks.map((entry) => [entry.windowId, entry.windowFingerprint]),
    ...stylePairs.map((entry) => [entry.windowId, entry.windowFingerprint]),
    ...unmatchedAnchors.map((entry) => [entry.windowId, entry.windowFingerprint]),
  ]);
}

function pruneTermObservations(terms, fingerprints) {
  for (const [evidenceId, entry] of terms) {
    entry.observations = entry.observations.filter(
      (observation) =>
        !fingerprints.has(observation.windowId) ||
        fingerprints.get(observation.windowId) === observation.windowFingerprint,
    );
    if (entry.observations.length === 0 && !entry.manualStatus) terms.delete(evidenceId);
  }
}

function buildTermObservation(link, plan, committedAt) {
  return {
    observationKey: evidenceObservationKey(link),
    planHash: plan.planHash,
    windowId: link.windowId,
    windowFingerprint: link.windowFingerprint,
    sourceMentionId: link.sourceMentionId,
    sourceNodeKeys: link.sourceNodeKeys,
    targetNodeKeys: link.targetNodeKeys,
    sourceTexts: link.sourceTexts,
    targetTexts: link.targetTexts,
    sourceChapterIds: link.sourceChapterIds,
    targetChapterIds: link.targetChapterIds,
    confidence: link.confidence,
    reason: link.reason,
    observedAt: committedAt,
  };
}

function upsertTermLink(terms, link, plan, committedAt) {
  const evidenceId = `term_evidence_${sha256(`${link.sourceSurface}\u0000${link.targetSurface}`).slice(0, 16)}`;
  const current = terms.get(evidenceId) || {
    evidenceId,
    sourceSurface: link.sourceSurface,
    targetSurface: link.targetSurface,
    entityType: link.entityType || "term",
    category: link.category,
    manualStatus: null,
    observations: [],
  };
  const observation = buildTermObservation(link, plan, committedAt);
  const index = current.observations.findIndex((entry) => entry.observationKey === observation.observationKey);
  if (index >= 0) {
    const old = current.observations[index];
    current.observations[index] = old.confidence >= observation.confidence ? old : observation;
  } else {
    current.observations.push(observation);
  }
  current.category = current.category || link.category;
  current.entityType = current.entityType || link.entityType || "term";
  terms.set(evidenceId, current);
}

function buildStyleMap(base, fingerprints) {
  return new Map(
    (base.styleEvidence || [])
      .filter(
        (entry) => !fingerprints.has(entry.windowId) || fingerprints.get(entry.windowId) === entry.windowFingerprint,
      )
      .map((entry) => [entry.evidenceId, entry]),
  );
}

function upsertStylePair(styles, pair, plan, committedAt) {
  const observationKey = evidenceObservationKey(pair);
  const evidenceId = `style_evidence_${observationKey.slice(0, 16)}`;
  const current = styles.get(evidenceId);
  if (current && pair.confidence <= current.confidence) return;
  styles.set(evidenceId, {
    ...pair,
    evidenceId,
    stylePairId: evidenceId,
    observationKey,
    planHash: plan.planHash,
    observedAt: committedAt,
    status: statusForConfidence(pair.confidence),
  });
}

function buildUnmatchedMap(base) {
  return new Map(
    (base.unmatchedAnchors || []).map((entry) => [
      `${entry.windowFingerprint || entry.windowId}:${entry.anchorType}:${entry.anchorId}`,
      entry,
    ]),
  );
}

function pruneUnmatchedByWindow(unmatched, fingerprints) {
  for (const [key, entry] of unmatched) {
    if (fingerprints.has(entry.windowId) && fingerprints.get(entry.windowId) !== entry.windowFingerprint) {
      unmatched.delete(key);
    }
  }
}

function removeMatchedUnmatched(unmatched, termLinks, stylePairs) {
  for (const entry of [...termLinks, ...stylePairs]) {
    const anchorType = entry.sourceMentionId ? "terminology" : "style";
    const anchorId = entry.sourceMentionId || entry.anchorId;
    unmatched.delete(`${entry.windowFingerprint}:${anchorType}:${anchorId}`);
  }
}

function addUnmatchedEntries(unmatched, unmatchedAnchors, plan, committedAt) {
  for (const entry of unmatchedAnchors) {
    unmatched.set(`${entry.windowFingerprint || entry.windowId}:${entry.anchorType}:${entry.anchorId}`, {
      ...entry,
      planHash: plan.planHash,
      observedAt: committedAt,
    });
  }
}

function buildConfidenceChanges(terms, previousConfidence) {
  return [...terms.values()].flatMap((entry) => {
    const previous = previousConfidence.get(entry.evidenceId);
    if (previous === undefined || Math.abs(previous - entry.confidence) < 0.0001) return [];
    return [
      {
        evidenceId: entry.evidenceId,
        sourceSurface: entry.sourceSurface,
        targetSurface: entry.targetSurface,
        previousConfidence: previous,
        currentConfidence: entry.confidence,
      },
    ];
  });
}

function buildPlans(base, plan, termLinks, stylePairs, committedAt) {
  return [
    ...(base.plans || []).filter((entry) => entry.planHash !== plan.planHash),
    {
      planHash: plan.planHash,
      sourceFingerprint: plan.sourceFingerprint,
      targetFingerprint: plan.targetFingerprint,
      model: plan.model,
      committedAt,
      termEvidenceCount: termLinks.length,
      styleEvidenceCount: stylePairs.length,
    },
  ];
}

function buildLedgerResult(base, terms, styles, unmatched, conflicts, confidenceChanges, plans, committedAt) {
  return {
    ...base,
    revision: (base.revision || 0) + 1,
    updatedAt: committedAt,
    plans,
    termEvidence: [...terms.values()],
    styleEvidence: [...styles.values()],
    unmatchedAnchors: [...unmatched.values()],
    conflicts,
    confidenceChanges,
  };
}

function mergeEvidenceLedger(existing, { plan, termLinks, stylePairs, unmatchedAnchors, committedAt }) {
  const base = ledgerBase(existing, plan);
  const previousConfidence = new Map((base.termEvidence || []).map((entry) => [entry.evidenceId, entry.confidence]));
  const terms = cloneTermMap(base);
  const fingerprints = windowFingerprintMap(termLinks, stylePairs, unmatchedAnchors);
  pruneTermObservations(terms, fingerprints);
  for (const link of termLinks) upsertTermLink(terms, link, plan, committedAt);
  const conflicts = resolveTermEvidenceStatuses([...terms.values()]);
  const styles = buildStyleMap(base, fingerprints);
  for (const pair of stylePairs) upsertStylePair(styles, pair, plan, committedAt);
  const unmatched = buildUnmatchedMap(base);
  pruneUnmatchedByWindow(unmatched, fingerprints);
  removeMatchedUnmatched(unmatched, termLinks, stylePairs);
  addUnmatchedEntries(unmatched, unmatchedAnchors, plan, committedAt);
  const confidenceChanges = buildConfidenceChanges(terms, previousConfidence);
  const plans = buildPlans(base, plan, termLinks, stylePairs, committedAt);
  return buildLedgerResult(base, terms, styles, unmatched, conflicts, confidenceChanges, plans, committedAt);
}

function collectPlanNodes(plan, side) {
  const map = new Map();
  for (const window of plan.windows) {
    for (const node of side === "source" ? window.sourceNodes : window.targetNodes) {
      map.set(node.nodeKey, node);
    }
  }
  return map;
}

function buildPromotedEntries(termEvidence) {
  const acceptedEntries = [];
  for (const entry of termEvidence.filter((item) => item.status === "accepted")) {
    const latest = entry.latestObservation || entry.observations?.at(-1) || {};
    acceptedEntries.push({
      term_id: stableId("term", `${entry.sourceSurface}::${entry.targetSurface}`),
      entity_type: entry.entityType === "character" ? "character" : "term",
      reference_kind: "translator",
      source_term: entry.sourceSurface,
      canonical_form: entry.sourceSurface,
      target_rendering: entry.targetSurface,
      canonical_translation: entry.targetSurface,
      category: entry.entityType === "character" ? "character_name" : entry.category,
      aliases: [],
      source: "reference_bilingual_evidence",
      locked: false,
      confidence: entry.confidence,
      evidence_chapters: entry.supportingChapterIds,
      examples: [
        {
          source: (latest.sourceTexts || []).join(" "),
          translation: (latest.targetTexts || []).join(" "),
        },
      ],
    });
  }
  return acceptedEntries;
}

function writePromotedGlossary(mangaId, translatorId, acceptedEntries) {
  const existing = loadCanonicalGlossary(mangaId, translatorId) || defaultCanonicalGlossary(mangaId);
  const retained = {
    ...existing,
    entries: (existing.entries || []).filter(
      (entry) => entry.source !== "reference_bilingual_evidence" || entry.locked || entry.source === "manual",
    ),
  };
  writeCanonicalGlossary(
    mangaId,
    mergeCanonicalGlossary(retained, acceptedEntries, null, "bilingual_enrichment"),
    translatorId,
  );
}

function promoteTerminology({ mangaId, translatorId, termEvidence }) {
  const acceptedEntries = buildPromotedEntries(termEvidence);
  writePromotedGlossary(mangaId, translatorId, acceptedEntries);
  return acceptedEntries.length;
}

function completedWindowIdsForPlan(plan, paths) {
  return plan.windows
    .filter((window) => validCheckpoint(readJson(checkpointPath(paths, window)), plan, window))
    .map((window) => window.windowId);
}

function buildActiveRun(plan, completedWindowIds, paths) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mangaId: plan.mangaId,
    translatorId: plan.translatorId,
    planHash: plan.planHash,
    status: "running",
    totalWindows: plan.windows.length,
    completedWindows: completedWindowIds.length,
    reusedWindows: completedWindowIds.length,
    failedWindowId: null,
    resumeAvailable: completedWindowIds.length > 0,
    planPath: paths.planPath,
    updatedAt: new Date().toISOString(),
  };
}

class ReferenceBilingualEnrichmentModule {
  constructor(aoTaskRunner) {
    this.aoTaskRunner = aoTaskRunner;
  }

  inspectPrerequisites({ mangaId, translatorId }) {
    const sourceReferences = orderedReferences(mangaId, translatorId, "source");
    const targetReferences = orderedReferences(mangaId, translatorId, "translator");
    const incompleteSourceReferences = sourceReferences.filter(
      (reference) => inspectChapterObservation(reference.id).status !== "complete",
    );
    const incompleteTargetReferences = targetReferences.filter(
      (reference) => inspectChapterObservation(reference.id).status !== "complete",
    );
    const source = buildObservedStream(sourceReferences, "source");
    const target = buildObservedStream(targetReferences, "target");
    return {
      ready:
        sourceReferences.length > 0 &&
        targetReferences.length > 0 &&
        incompleteSourceReferences.length === 0 &&
        incompleteTargetReferences.length === 0 &&
        source.nodes.length > 0 &&
        target.nodes.length > 0,
      sourceReferences,
      targetReferences,
      incompleteSourceReferences,
      incompleteTargetReferences,
      source,
      target,
    };
  }

  prepareRun({ mangaId, translatorId }) {
    const prerequisites = this.inspectPrerequisites({ mangaId, translatorId });
    if (!prerequisites.ready) throw new Error("Bilingual enrichment prerequisites are not ready.");
    const plan = buildPlan({
      mangaId,
      translatorId,
      source: prerequisites.source,
      target: prerequisites.target,
      model: this.aoTaskRunner?.settings?.model || config.agent.model || null,
    });
    const paths = runPaths(mangaId, translatorId, plan.planHash);
    if (!fs.existsSync(paths.planPath)) writeJsonAtomic(paths.planPath, plan);
    const completedWindowIds = completedWindowIdsForPlan(plan, paths);
    const activeRun = buildActiveRun(plan, completedWindowIds, paths);
    writeJsonAtomic(paths.activeRunPath, activeRun);
    return { plan, paths, completedWindowIds, activeRun };
  }

  loadPlan(planPath) {
    const plan = readJson(planPath);
    if (!plan || plan.schemaVersion !== SCHEMA_VERSION || !plan.planHash) {
      throw new Error("Bilingual evidence plan is missing or invalid.");
    }
    return plan;
  }

  async runWindow(payload, { isCanceled = null, onProgress = null } = {}) {
    const plan = this.loadPlan(payload.planPath);
    const window = plan.windows.find((entry) => entry.windowId === payload.windowId);
    if (!window) throw new Error(`Unknown bilingual evidence window ${payload.windowId}.`);
    const paths = runPaths(plan.mangaId, plan.translatorId, plan.planHash);
    const existing = readJson(checkpointPath(paths, window));
    if (validCheckpoint(existing, plan, window)) {
      return {
        ...existing,
        reused: true,
        checkpointPath: checkpointPath(paths, window),
      };
    }
    const { result, attemptCount } = await runBilingualWindowWithRetry(this, window, payload, isCanceled, onProgress);
    const completedAt = new Date().toISOString();
    const checkpoint = buildRunWindowCheckpoint(plan, window, result, attemptCount, completedAt);
    const filePath = checkpointPath(paths, window);
    writeJsonAtomic(filePath, checkpoint);
    updateActiveRunAfterWindow(paths, plan, completedAt);
    return { ...checkpoint, checkpointPath: filePath, reused: false };
  }

  markRunFailed(payload, error) {
    if (!payload?.planPath) return;
    const plan = this.loadPlan(payload.planPath);
    const paths = runPaths(plan.mangaId, plan.translatorId, plan.planHash);
    const current = readJson(paths.activeRunPath) || {};
    writeJsonAtomic(paths.activeRunPath, {
      ...current,
      status: "failed",
      failedWindowId: payload.windowId || null,
      resumeAvailable: true,
      error: String(error?.message || error),
      updatedAt: new Date().toISOString(),
    });
  }

  markRunStopped(payload) {
    if (!payload?.planPath) return;
    const plan = this.loadPlan(payload.planPath);
    const paths = runPaths(plan.mangaId, plan.translatorId, plan.planHash);
    writeJsonAtomic(paths.activeRunPath, {
      ...(readJson(paths.activeRunPath) || {}),
      status: "stopped",
      failedWindowId: payload.windowId || null,
      resumeAvailable: true,
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }

  commit(payload) {
    const plan = this.loadPlan(payload.planPath);
    const paths = runPaths(plan.mangaId, plan.translatorId, plan.planHash);
    const checkpoints = loadCommitCheckpoints(plan, paths);
    const collections = buildCommitCollections(plan, checkpoints);
    const generatedAt = new Date().toISOString();
    const ledger = mergeEvidenceLedger(readJson(paths.bilingualEvidenceLedgerPath), {
      plan,
      termLinks: collections.termLinks,
      stylePairs: collections.stylePairs,
      unmatchedAnchors: collections.unmatchedAnchors,
      committedAt: generatedAt,
    });
    const document = buildCommitDocumentFromCollections(plan, generatedAt, ledger, collections, checkpoints);
    document.promotedTerminology = promoteTerminology({
      mangaId: plan.mangaId,
      translatorId: plan.translatorId,
      termEvidence: ledger.termEvidence,
    });
    writeCommitArtifacts(paths, ledger, document, generatedAt, plan);
    return { ...document, bilingualEvidencePath: paths.bilingualEvidencePath };
  }

  load({ mangaId, translatorId }) {
    const paths = resolveKnowledgeAssetPaths({ mangaId, translatorId });
    const document = readJson(paths.bilingualEvidencePath);
    const activeRun = readJson(path.join(paths.bilingualRunsDir, "active_run.json"));
    if (!document || document.schemaVersion !== SCHEMA_VERSION) {
      return buildUnsupportedLoadResult(mangaId, translatorId, document, activeRun);
    }
    const prerequisites = this.inspectPrerequisites({ mangaId, translatorId });
    const staleReasons = loadStaleReasons(document, prerequisites);
    return {
      ...document,
      status: staleReasons.length > 0 ? "stale" : document.status,
      staleReasons,
      activeRun: activeRun || null,
      planHash: document.planHash,
      totalWindows: activeRun?.totalWindows ?? document.summary?.totalWindows ?? 0,
      completedWindows: activeRun?.completedWindows ?? document.summary?.completedWindows ?? 0,
      reusedWindows: activeRun?.reusedWindows || 0,
      failedWindowId: activeRun?.failedWindowId || null,
      resumeAvailable: Boolean(activeRun?.resumeAvailable),
    };
  }

  updateLink({ mangaId, translatorId, linkId, action }) {
    const paths = resolveKnowledgeAssetPaths({ mangaId, translatorId });
    const document = readJson(paths.bilingualEvidencePath);
    const ledger = readJson(paths.bilingualEvidenceLedgerPath);
    if (!document || document.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("Bilingual evidence has not been generated with the current contract.");
    }
    if (!ledger || ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
      throw new Error("Bilingual evidence ledger is missing or invalid.");
    }
    applyUpdateAction(ledger, linkId, action);
    ledger.conflicts = resolveTermEvidenceStatuses(ledger.termEvidence);
    syncDocumentTermLinks(document, ledger);
    document.conflicts = ledger.conflicts;
    document.promotedTerminology = promoteTerminology({
      mangaId,
      translatorId,
      termEvidence: ledger.termEvidence,
    });
    document.updatedAt = new Date().toISOString();
    ledger.revision = (ledger.revision || 0) + 1;
    ledger.updatedAt = document.updatedAt;
    document.ledgerRevision = ledger.revision;
    writeUpdateArtifacts(paths, document, ledger);
    return document;
  }
}

async function runBilingualWindowWithRetry(module, window, payload, isCanceled, onProgress) {
  let result;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attemptCount = attempt;
    reportBilingualAttempt(onProgress, window.windowId, attempt);
    try {
      const jobId = `${payload.jobId || window.windowId}:attempt_${attempt}`;
      result = await module.aoTaskRunner.runBilingualEvidenceWindow(
        { jobId, ...window },
        { isCanceled, onProgress },
      );
      break;
    } catch (error) {
      if (attempt >= 2 || !transientAoError(error)) throw error;
      reportBilingualRetry(onProgress, window.windowId, attempt, error);
    }
  }
  return { result, attemptCount };
}

function reportBilingualAttempt(onProgress, windowId, attempt) {
  onProgress?.({ stage: "bilingual_evidence_window", attempt, maxAttempts: 2, windowId });
}

function reportBilingualRetry(onProgress, windowId, attempt, error) {
  onProgress?.({
    stage: "bilingual_evidence_window_retry",
    attempt,
    nextAttempt: attempt + 1,
    windowId,
    error: error.message,
  });
}

function buildRunWindowCheckpoint(plan, window, result, attemptCount, completedAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    originPlanHash: plan.planHash,
    windowId: window.windowId,
    windowKey: window.windowKey,
    windowFingerprint: window.windowFingerprint,
    purpose: window.purpose,
    contractHash: plan.contractHash,
    attemptCount,
    outcome: result.semanticResult?.outcome || "clean",
    acceptedRecordCount: result.semanticResult?.acceptedRecordCount || 0,
    quarantinedRecordCount: result.semanticResult?.quarantinedRecordCount || 0,
    semanticResult: result.semanticResult || null,
    result: {
      termLinks: result.termLinks,
      stylePairs: result.stylePairs,
      unmatchedAnchors: result.unmatchedAnchors,
      semanticResult: result.semanticResult || null,
    },
    completedAt,
  };
}

function updateActiveRunAfterWindow(paths, plan, completedAt) {
  const completedWindows = plan.windows.filter((entry) =>
    validCheckpoint(readJson(checkpointPath(paths, entry)), plan, entry),
  ).length;
  writeJsonAtomic(paths.activeRunPath, {
    ...(readJson(paths.activeRunPath) || {}),
    status: "running",
    completedWindows,
    failedWindowId: null,
    resumeAvailable: completedWindows > 0,
    updatedAt: completedAt,
  });
}

function loadCommitCheckpoints(plan, paths) {
  return plan.windows.map((window) => {
    const checkpoint = readJson(checkpointPath(paths, window));
    if (!validCheckpoint(checkpoint, plan, window)) {
      throw new Error(`Missing bilingual checkpoint ${window.windowId}.`);
    }
    return checkpoint;
  });
}

function buildCommitTermLinks(checkpoints, mentionById, sourceByKey, targetByKey) {
  const enrich = (entry, checkpoint) => ({
    ...entry,
    status: statusForConfidence(entry.confidence),
    windowId: checkpoint.windowId,
    windowFingerprint: checkpoint.windowFingerprint,
    sourceTexts: (entry.sourceNodeKeys || []).map((key) => sourceByKey.get(key)?.text || ""),
    targetTexts: (entry.targetNodeKeys || []).map((key) => targetByKey.get(key)?.text || ""),
    sourceChapterIds: [
      ...new Set((entry.sourceNodeKeys || []).map((key) => sourceByKey.get(key)?.chapterId).filter(Boolean)),
    ],
    targetChapterIds: [
      ...new Set((entry.targetNodeKeys || []).map((key) => targetByKey.get(key)?.chapterId).filter(Boolean)),
    ],
  });
  return checkpoints.flatMap((checkpoint) =>
    (checkpoint.result.termLinks || []).map((entry) => {
      const mention = mentionById.get(entry.sourceMentionId);
      return {
        ...enrich(entry, checkpoint),
        sourceSurface: mention?.surfaceForm || "",
        entityType: mention?.entityType || "term",
      };
    }),
  );
}

function buildCommitStylePairs(checkpoints, sourceByKey, targetByKey) {
  const enrich = (entry, checkpoint) => ({
    ...entry,
    status: statusForConfidence(entry.confidence),
    windowId: checkpoint.windowId,
    windowFingerprint: checkpoint.windowFingerprint,
    sourceTexts: (entry.sourceNodeKeys || []).map((key) => sourceByKey.get(key)?.text || ""),
    targetTexts: (entry.targetNodeKeys || []).map((key) => targetByKey.get(key)?.text || ""),
    sourceChapterIds: [
      ...new Set((entry.sourceNodeKeys || []).map((key) => sourceByKey.get(key)?.chapterId).filter(Boolean)),
    ],
    targetChapterIds: [
      ...new Set((entry.targetNodeKeys || []).map((key) => targetByKey.get(key)?.chapterId).filter(Boolean)),
    ],
  });
  return checkpoints.flatMap((checkpoint) =>
    (checkpoint.result.stylePairs || []).map((entry) => enrich(entry, checkpoint)),
  );
}

function buildCommitUnmatchedAnchors(checkpoints) {
  return checkpoints.flatMap((checkpoint) =>
    (checkpoint.result.unmatchedAnchors || []).map((entry) => ({
      ...entry,
      windowFingerprint: checkpoint.windowFingerprint,
    })),
  );
}

function buildCommitCollections(plan, checkpoints) {
  const sourceByKey = collectPlanNodes(plan, "source");
  const targetByKey = collectPlanNodes(plan, "target");
  const mentionById = new Map(plan.sourceMentions.map((mention) => [mention.mentionId, mention]));
  return {
    sourceByKey,
    targetByKey,
    mentionById,
    termLinks: buildCommitTermLinks(checkpoints, mentionById, sourceByKey, targetByKey),
    stylePairs: buildCommitStylePairs(checkpoints, sourceByKey, targetByKey),
    unmatchedAnchors: buildCommitUnmatchedAnchors(checkpoints),
    semanticResult: mergeSemanticResults(
      checkpoints.map((checkpoint) => checkpoint.semanticResult || checkpoint.result?.semanticResult),
    ),
  };
}

function buildLedgerTermLinks(ledger) {
  return ledger.termEvidence.map((entry) => {
    const latest = entry.latestObservation || entry.observations?.at(-1) || {};
    return {
      termLinkId: entry.evidenceId,
      sourceMentionId: latest.sourceMentionId || "",
      sourceSurface: entry.sourceSurface,
      sourceNodeKeys: latest.sourceNodeKeys || [],
      targetNodeKeys: latest.targetNodeKeys || [],
      sourceTexts: latest.sourceTexts || [],
      targetTexts: latest.targetTexts || [],
      sourceChapterIds: entry.supportingChapterIds || [],
      targetChapterIds: [...new Set(entry.observations.flatMap((observation) => observation.targetChapterIds || []))],
      targetSurface: entry.targetSurface,
      category: entry.category,
      confidence: entry.confidence,
      status: entry.status,
      reason: latest.reason || "",
      manual: Boolean(entry.manualStatus),
      observationCount: entry.observations.length,
    };
  });
}

function buildLedgerStylePairs(ledger) {
  return ledger.styleEvidence.map((entry) => ({
    ...entry,
    stylePairId: entry.evidenceId,
  }));
}

function commitStatus(ledger, ledgerTermLinks, ledgerStylePairs) {
  return ledger.unmatchedAnchors.length > 0 ||
    ledger.conflicts.length > 0 ||
    [...ledgerTermLinks, ...ledgerStylePairs].some((entry) => entry.status !== "accepted")
    ? "partial"
    : "complete";
}

function buildChapterGroups(chapterIds, chapterTitleById, ledgerTermLinks, ledgerStylePairs) {
  return chapterIds.map((chapterId) => ({
    chapterId,
    chapterTitle: chapterTitleById.get(chapterId) || chapterId,
    termLinkIds: ledgerTermLinks
      .filter((entry) => entry.sourceChapterIds.includes(chapterId))
      .map((entry) => entry.termLinkId),
    stylePairIds: ledgerStylePairs
      .filter((entry) => (entry.sourceChapterIds || []).includes(chapterId))
      .map((entry) => entry.stylePairId),
  }));
}

function buildCommitSummary(plan, checkpoints, ledgerTermLinks, ledgerStylePairs, ledger) {
  return {
    totalWindows: plan.windows.length,
    completedWindows: checkpoints.length,
    terminologyWindows: plan.windows.filter((window) => window.purpose === "terminology").length,
    styleWindows: plan.windows.filter((window) => window.purpose === "style").length,
    accepted: [...ledgerTermLinks, ...ledgerStylePairs].filter((entry) => entry.status === "accepted").length,
    provisional: [...ledgerTermLinks, ...ledgerStylePairs].filter((entry) => entry.status === "provisional").length,
    review: [...ledgerTermLinks, ...ledgerStylePairs].filter((entry) => entry.status === "review").length,
    unmatched: ledger.unmatchedAnchors.length,
  };
}

function buildCommitDocument(input) {
  const { plan, generatedAt, ledger, views, checkpoints, semanticResult } = input;
  const { ledgerTermLinks, ledgerStylePairs, chapterIds, chapterTitleById } = views;
  return {
    schemaVersion: SCHEMA_VERSION,
    mangaId: plan.mangaId,
    translatorId: plan.translatorId,
    status: commitStatus(ledger, ledgerTermLinks, ledgerStylePairs),
    planHash: plan.planHash,
    contractHash: plan.contractHash,
    sourceFingerprint: plan.sourceFingerprint,
    targetFingerprint: plan.targetFingerprint,
    generatedAt,
    updatedAt: generatedAt,
    ledgerRevision: ledger.revision,
    termLinks: ledgerTermLinks,
    stylePairs: ledgerStylePairs,
    unmatchedAnchors: ledger.unmatchedAnchors,
    conflicts: ledger.conflicts,
    confidenceChanges: ledger.confidenceChanges,
    history: ledger.plans,
    chapterGroups: buildChapterGroups(chapterIds, chapterTitleById, ledgerTermLinks, ledgerStylePairs),
    summary: buildCommitSummary(plan, checkpoints, ledgerTermLinks, ledgerStylePairs, ledger),
    semanticResult,
  };
}

function buildCommitLedgerViews(collections, ledger) {
  const ledgerTermLinks = buildLedgerTermLinks(ledger);
  const ledgerStylePairs = buildLedgerStylePairs(ledger);
  const chapterIds = [
    ...new Set([
      ...ledgerTermLinks.flatMap((entry) => entry.sourceChapterIds),
      ...ledgerStylePairs.flatMap((entry) => entry.sourceChapterIds || []),
    ]),
  ];
  const chapterTitleById = new Map(
    [...collections.sourceByKey.values()].map((node) => [node.chapterId, node.chapterTitle]),
  );
  return { ledgerTermLinks, ledgerStylePairs, chapterIds, chapterTitleById };
}

function buildCommitDocumentFromCollections(plan, generatedAt, ledger, collections, checkpoints) {
  const views = buildCommitLedgerViews(collections, ledger);
  return buildCommitDocument({
    plan,
    generatedAt,
    ledger,
    views,
    checkpoints,
    semanticResult: collections.semanticResult,
  });
}

function writeCommitArtifacts(paths, ledger, document, generatedAt, plan) {
  writeJsonAtomic(paths.bilingualEvidenceLedgerPath, ledger);
  writeJsonAtomic(
    path.join(paths.bilingualLedgerRevisionsDir, `revision_${String(ledger.revision).padStart(6, "0")}.json`),
    ledger,
  );
  writeJsonAtomic(paths.bilingualEvidencePath, document);
  writeJsonAtomic(paths.activeRunPath, {
    ...(readJson(paths.activeRunPath) || {}),
    status: "complete",
    completedWindows: plan.windows.length,
    failedWindowId: null,
    resumeAvailable: false,
    updatedAt: generatedAt,
  });
}

function buildUnsupportedLoadResult(mangaId, translatorId, document, activeRun) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mangaId,
    translatorId,
    status: activeRun?.status === "running" ? "generating" : document ? "stale" : "missing",
    staleReasons: document ? ["unsupported_schema"] : [],
    termLinks: [],
    stylePairs: [],
    unmatchedAnchors: [],
    activeRun: activeRun || null,
    planHash: activeRun?.planHash || null,
    totalWindows: activeRun?.totalWindows || 0,
    completedWindows: activeRun?.completedWindows || 0,
    reusedWindows: activeRun?.reusedWindows || 0,
    failedWindowId: activeRun?.failedWindowId || null,
    resumeAvailable: Boolean(activeRun?.resumeAvailable),
  };
}

function loadStaleReasons(document, prerequisites) {
  const staleReasons = [];
  if (!prerequisites.ready) staleReasons.push("observation_missing_or_stale");
  if (prerequisites.ready && document.sourceFingerprint !== prerequisites.source.fingerprint) {
    staleReasons.push("source_observation_changed");
  }
  if (prerequisites.ready && document.targetFingerprint !== prerequisites.target.fingerprint) {
    staleReasons.push("target_observation_changed");
  }
  return staleReasons;
}

function applyUpdateAction(ledger, linkId, action) {
  const ledgerIndex = ledger.termEvidence.findIndex((entry) => entry.evidenceId === linkId);
  if (ledgerIndex < 0) throw new Error(`Unknown bilingual terminology link ${linkId}.`);
  if (action === "unbind") {
    ledger.termEvidence[ledgerIndex] = {
      ...ledger.termEvidence[ledgerIndex],
      status: "rejected",
      manualStatus: "rejected",
    };
  } else if (action === "accept") {
    const sourceSurface = ledger.termEvidence[ledgerIndex].sourceSurface;
    ledger.termEvidence = ledger.termEvidence.map((entry, index) =>
      index !== ledgerIndex && entry.sourceSurface === sourceSurface ? { ...entry, manualStatus: null } : entry,
    );
    ledger.termEvidence[ledgerIndex] = {
      ...ledger.termEvidence[ledgerIndex],
      status: "accepted",
      manualStatus: "accepted",
    };
  } else {
    throw new Error("Bilingual evidence action must be unbind or accept.");
  }
}

function syncDocumentTermLinks(document, ledger) {
  for (const link of document.termLinks) {
    const evidence = ledger.termEvidence.find((entry) => entry.evidenceId === link.termLinkId);
    if (evidence) {
      link.status = evidence.status;
      link.manual = Boolean(evidence.manualStatus);
    }
  }
}

function writeUpdateArtifacts(paths, document, ledger) {
  writeJsonAtomic(paths.bilingualEvidenceLedgerPath, ledger);
  writeJsonAtomic(
    path.join(paths.bilingualLedgerRevisionsDir, `revision_${String(ledger.revision).padStart(6, "0")}.json`),
    ledger,
  );
  writeJsonAtomic(paths.bilingualEvidencePath, document);
}

module.exports = {
  ACCEPTED_THRESHOLD,
  PROVISIONAL_THRESHOLD,
  ReferenceBilingualEnrichmentModule,
  buildEvidencePlan: buildPlan,
  buildObservedStream,
  mergeEvidenceLedger,
  transientAoError,
};
