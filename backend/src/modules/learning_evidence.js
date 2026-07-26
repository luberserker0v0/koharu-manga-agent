const crypto = require("crypto");

const LEARNING_EVIDENCE_SCHEMA_VERSION = 2;
const EVIDENCE_REASONS = new Set([
  "quality_revision", "locked_term", "canonical_term", "local_pair_conflict",
  "chapter_rendering_drift", "style_evidence", "speaker_evidence", "story_cue",
  "manual_verified",
]);

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateLearningEvidenceSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== LEARNING_EVIDENCE_SCHEMA_VERSION || !Array.isArray(snapshot.evidence)) {
    throw new Error("Invalid Learning Evidence snapshot schema.");
  }
  const ids = new Set();
  for (const entry of snapshot.evidence) {
    if (!entry?.evidenceId || ids.has(entry.evidenceId)) throw new Error("Learning Evidence IDs must be present and unique.");
    ids.add(entry.evidenceId);
    if (!entry.nodeId || typeof entry.original !== "string" || !entry.original || typeof entry.translation !== "string" || !entry.translation) {
      throw new Error(`Learning Evidence ${entry.evidenceId} requires nodeId, original, and translation.`);
    }
    if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => !EVIDENCE_REASONS.has(reason))) {
      throw new Error(`Learning Evidence ${entry.evidenceId} contains an unknown reason.`);
    }
    if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      throw new Error(`Learning Evidence ${entry.evidenceId} confidence must be between 0 and 1.`);
    }
  }
  return snapshot;
}

function buildLearningEvidenceSnapshot({
  sourceTranslationJobId = null,
  chapterId = null,
  finalTranslationSnapshotPath,
  finalTranslationSnapshotFingerprint = null,
  finalTranslations = [],
  translationMemory,
  quality = null,
}) {
  const finalById = new Map(finalTranslations.map((entry) => [entry.id || entry.nodeId, entry]));
  const candidateById = new Map((quality?.projection?.candidates || []).map((entry) => [entry.nodeId, entry]));
  const revisionById = new Map((quality?.optimizedTranslations || []).map((entry) => [entry.nodeId, entry]));
  for (const [nodeId, revision] of revisionById) {
    if (!candidateById.has(nodeId)) {
      candidateById.set(nodeId, {
        nodeId,
        pageName: revision.pageName || null,
        textRole: revision.textRole || null,
        styleChannel: revision.styleChannel || null,
        speakerRef: revision.speakerRef || null,
        reasons: [{ type: "quality_revision" }],
      });
    }
  }
  const verificationById = new Map((quality?.finalVerification?.nodes || []).map((entry) => [entry.nodeId, entry]));
  const groupedEvidence = new Map();
  for (const [nodeId, candidate] of candidateById) {
    const candidateReasons = (candidate.reasons || []).map((entry) => entry.type);
    const revision = revisionById.get(nodeId) || null;
    const reasons = [...new Set([
      revision ? "quality_revision" : null,
      ...candidateReasons.filter((reason) => EVIDENCE_REASONS.has(reason)),
    ].filter(Boolean))];
    const verification = verificationById.get(nodeId);
    if (!verification || !["clean", "revised_verified", "manual_verified"].includes(verification.finalDisposition)) continue;
    if (verification.finalDisposition === "manual_verified" && !reasons.includes("manual_verified")) reasons.push("manual_verified");
    const learnable = verification.finalDisposition === "manual_verified" ||
      Boolean(revision && verification.finalDisposition === "revised_verified") || candidateReasons.some((reason) => [
      "locked_term", "canonical_term", "local_pair_conflict", "chapter_rendering_drift", "style_evidence", "speaker_evidence", "story_cue",
    ].includes(reason));
    if (!learnable) continue;
    const final = finalById.get(nodeId);
    if (!final) continue;
    const textRole = final.textRole || candidate.textRole || null;
    const roleConfidence = final.roleConfidence ?? candidate.roleConfidence ?? null;
    const speakerConfidence = final.speakerConfidence ?? candidate.speakerConfidence ?? null;
    let speakerRef = final.speakerRef || candidate.speakerRef || null;
    if (textRole === "narration") speakerRef = null;
    const hasStyleReason = reasons.includes("style_evidence") || reasons.includes("speaker_evidence");
    if (hasStyleReason && textRole === "dialogue" && !(
      Number.isFinite(roleConfidence) && roleConfidence >= 0.85 &&
      Number.isFinite(speakerConfidence) && speakerConfidence >= 0.75
    )) {
      const filtered = reasons.filter((reason) => reason !== "style_evidence" && reason !== "speaker_evidence");
      reasons.splice(0, reasons.length, ...filtered);
      if (!revision && !reasons.some((reason) => ["locked_term", "canonical_term", "manual_verified"].includes(reason))) continue;
    }
    const groupKey = fingerprint([final.original, final.translation, textRole, speakerRef]);
    const existing = groupedEvidence.get(groupKey);
    if (existing) {
      existing.nodeIds.push(nodeId);
      existing.occurrences.push({ nodeId, pageName: final.pageName || candidate.pageName || null });
      existing.mentionCount += 1;
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      existing.confidence = Math.max(existing.confidence, revision?.confidence || (reasons.includes("locked_term") ? 1 : 0.85));
      continue;
    }
    groupedEvidence.set(groupKey, {
      evidenceId: `learning_${groupKey.slice(0, 16)}`,
      nodeId,
      nodeIds: [nodeId],
      occurrences: [{ nodeId, pageName: final.pageName || candidate.pageName || null }],
      mentionCount: 1,
      pageName: final.pageName || candidate.pageName || null,
      original: final.original,
      translation: final.translation,
      textRole,
      styleChannel: final.styleChannel || candidate.styleChannel || null,
      speakerRef,
      roleConfidence,
      speakerConfidence,
      reasons,
      qualityRevision: revision ? {
        previousTranslation: revision.currentTranslation,
        reasonType: revision.reasonType,
        confidence: revision.confidence,
        reason: revision.reason,
      } : null,
      confidence: revision?.confidence || (reasons.includes("locked_term") ? 1 : 0.85),
    });
  }
  const evidence = [...groupedEvidence.values()];
  const snapshot = {
    schemaVersion: LEARNING_EVIDENCE_SCHEMA_VERSION,
    sourceTranslationJobId,
    chapterId,
    finalTranslationSnapshotPath,
    finalTranslationSnapshotFingerprint,
    translationMemoryFingerprint: translationMemory?.fingerprint || null,
    generatedAt: new Date().toISOString(),
    evidence,
    summary: {
      total: evidence.length,
      correctedPairs: evidence.filter((entry) => entry.qualityRevision).length,
      terminologyPairs: evidence.filter((entry) => entry.reasons.some((reason) => reason === "locked_term" || reason === "canonical_term")).length,
      styleSamples: evidence.filter((entry) => entry.reasons.some((reason) => reason === "style_evidence" || reason === "speaker_evidence")).length,
      conflictEvidence: evidence.filter((entry) => entry.reasons.some((reason) => reason === "local_pair_conflict" || reason === "chapter_rendering_drift")).length,
      semanticRoles: evidence.reduce((counts, entry) => {
        const role = entry.textRole || "unknown";
        counts[role] = (counts[role] || 0) + 1;
        return counts;
      }, {}),
    },
  };
  snapshot.fingerprint = fingerprint(snapshot);
  return validateLearningEvidenceSnapshot(snapshot);
}

module.exports = { EVIDENCE_REASONS, LEARNING_EVIDENCE_SCHEMA_VERSION, buildLearningEvidenceSnapshot, validateLearningEvidenceSnapshot };
