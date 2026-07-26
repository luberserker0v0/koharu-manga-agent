const STORY_ROLES = new Set(["dialogue", "monologue", "narration"]);
const EVENT_ROLES = new Set(["dialogue", "narration"]);
const STORY_STYLE_CHANNELS = new Set(["character_voice", "inner_voice", "narrator_voice"]);
const RELATION_TYPES = new Set([
  "parentOf",
  "childOf",
  "siblingOf",
  "spouseOf",
  "guardianOf",
  "instructorOf",
  "studentOf",
  "retainerOf",
  "employerOf",
  "memberOf",
  "leaderOf",
  "allyOf",
  "rivalOf",
  "enemyOf",
  "knows",
]);

function parseConfidence(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) {
    throw new Error("confidence must be a decimal number between 0 and 1.");
  }
  return Number(normalized);
}

function collectSourceNodes(input) {
  const nodes = new Map();
  const ambiguousNodeIds = new Set();
  for (const node of input.sourceNodes || []) {
    const pageName = String(node?.pageName || "").trim();
    const nodeId = String(node?.nodeId || "").trim();
    if (pageName && nodeId) {
      if (nodes.has(nodeId)) {
        nodes.delete(nodeId);
        ambiguousNodeIds.add(nodeId);
      } else if (!ambiguousNodeIds.has(nodeId)) {
        nodes.set(nodeId, node);
      }
    }
  }
  return nodes;
}

function parseEvidenceAnchors(value) {
  const nodeIds = String(value || "")
    .split(",")
    .map((nodeId) => nodeId.trim())
    .filter(Boolean);
  if (nodeIds.some((nodeId) => nodeId.includes("::")) || new Set(nodeIds).size !== nodeIds.length) {
    return [];
  }
  return nodeIds;
}

function parseParticipants(value) {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("participants=")) {
    return [];
  }
  return normalized
    .slice("participants=".length)
    .split(",")
    .map((participant) => participant.trim())
    .filter(Boolean);
}

function parseLineBasedStoryDelta(content, input) {
  const sourceNodes = collectSourceNodes(input);
  const quickRead = input?.analysisDepth === "quick_read";
  const limits = quickRead
    ? { events: 1, relations: 2, states: 1, threads: 1 }
    : { events: 3, relations: 3, states: 3, threads: 2 };
  const observedEvents = [];
  const observedRelations = [];
  const characterStates = [];
  const openThreads = [];
  const notes = [];
  let noUpdate = false;
  const resolveEvidence = (nodeId, allowedRoles) => {
    const node = sourceNodes.get(nodeId);
    if (!node || !allowedRoles.has(node.textRole)) {
      return null;
    }
    return node;
  };

  const resolveEvidences = (anchorText, allowedRoles) => {
    const anchors = parseEvidenceAnchors(anchorText);
    if (anchors.length === 0 || anchors.length > 6) {
      return [];
    }
    const evidences = anchors.map((nodeId) => {
      const node = resolveEvidence(nodeId, allowedRoles);
      return node
        ? {
            pageName: String(node.pageName).trim(),
            nodeId,
            evidenceLine: node.text,
            textRole: node.textRole,
            styleChannel: node.styleChannel || "unknown",
            roleConfidence: Number.isFinite(node.roleConfidence) ? node.roleConfidence : 0,
          }
        : null;
    });
    return evidences.every(Boolean) ? evidences : [];
  };

  const withEvidenceFields = (record, evidences) => ({
    ...record,
    evidences,
    pageName: evidences[0].pageName,
    nodeId: evidences[0].nodeId,
    evidenceLine: evidences[0].evidenceLine,
    textRole: evidences[0].textRole,
    styleChannel: evidences[0].styleChannel,
    roleConfidence: evidences[0].roleConfidence,
  });

  const resolveConfidence = (value) => {
    const confidence = parseConfidence(value);
    return quickRead ? Math.min(confidence, 0.75) : confidence;
  };

  for (const [index, rawLine] of String(content || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parts = line.split("|").map((part) => part.trim());
      const kind = parts[0];
      if (kind === "EVIDENCE_ROLE") {
        throw new Error("EVIDENCE_ROLE is obsolete; use Chapter Observation role fields.");
      }
      if (kind === "NO_UPDATE") {
        noUpdate = true;
        notes.push(parts.slice(1).join("|") || "No durable translation-relevant update.");
        continue;
      }
      if (kind === "NOTES") {
        notes.push(parts.slice(1).join("|"));
        continue;
      }
      const recordLimits = {
        STORY_EVENT: [6, observedEvents.length, limits.events],
        RELATION_DELTA: [7, observedRelations.length, limits.relations],
        CHARACTER_STATE: [7, characterStates.length, limits.states],
        OPEN_THREAD: [6, openThreads.length, limits.threads],
      };
      if (recordLimits[kind]) {
        const [minimumFields, currentCount, maximumCount] = recordLimits[kind];
        if (parts.length < minimumFields) throw new Error(`${kind} is malformed.`);
        if (currentCount >= maximumCount) throw new Error(`${kind} exceeds the record budget of ${maximumCount}.`);
      }
      if (kind === "STORY_EVENT" && parts.length >= 6 && observedEvents.length < limits.events) {
      const [, anchorText, confidenceText, participantText, summary, ...impactParts] = parts;
      const evidences = resolveEvidences(anchorText, EVENT_ROLES);
      const confidence = resolveConfidence(confidenceText);
      const translationImpact = impactParts.join("|");
      if (evidences.length > 0 && confidence >= 0.65 && summary && translationImpact) {
        observedEvents.push(withEvidenceFields({
          summary,
          participants: parseParticipants(participantText),
          confidence,
          translationImpact,
        }, evidences));
      }
        continue;
      }
      if (kind === "RELATION_DELTA" && parts.length >= 7 && observedRelations.length < limits.relations) {
      const [, relationType, subject, object, anchorText, confidenceText, ...impactParts] = parts;
      const evidences = resolveEvidences(anchorText, STORY_ROLES);
      const confidence = resolveConfidence(confidenceText);
      const translationImpact = impactParts.join("|");
      if (
        evidences.length > 0 &&
        confidence >= 0.65 &&
        RELATION_TYPES.has(relationType) &&
        subject &&
        object &&
        translationImpact
      ) {
        observedRelations.push(withEvidenceFields({
          relationType,
          subject,
          object,
          confidence,
          translationImpact,
        }, evidences));
      }
        continue;
      }
      if (kind === "CHARACTER_STATE" && parts.length >= 7 && characterStates.length < limits.states) {
      const [, character, attribute, value, anchorText, confidenceText, ...impactParts] = parts;
      const evidences = resolveEvidences(anchorText, STORY_ROLES);
      const confidence = resolveConfidence(confidenceText);
      const translationImpact = impactParts.join("|");
      if (evidences.length > 0 && confidence >= 0.65 && character && attribute && value && translationImpact) {
        characterStates.push(withEvidenceFields({
          character,
          attribute,
          value,
          confidence,
          translationImpact,
        }, evidences));
      }
        continue;
      }
      if (kind === "OPEN_THREAD" && parts.length >= 6 && openThreads.length < limits.threads) {
      const [, anchorText, confidenceText, participantText, summary, ...impactParts] = parts;
      const evidences = resolveEvidences(anchorText, EVENT_ROLES);
      const confidence = resolveConfidence(confidenceText);
      const translationImpact = impactParts.join("|");
      if (evidences.length > 0 && confidence >= 0.6 && summary && translationImpact) {
        openThreads.push(withEvidenceFields({
          summary,
          participants: parseParticipants(participantText),
          confidence,
          translationImpact,
        }, evidences));
      }
        continue;
      }
      throw new Error(`Unsupported or malformed record ${kind || "empty"}.`);
    } catch (error) {
      throw new Error(`Story delta line ${index + 1}: ${error.message}`);
    }
  }

  return {
    observedEvents,
    observedRelations,
    characterStates,
    openThreads,
    notes: notes.filter(Boolean).join("\n"),
    noUpdate,
  };
}

function validateStoryDeltaResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Story delta output is invalid.");
  }
  if (!result.noUpdate &&
      result.observedEvents.length === 0 &&
      result.observedRelations.length === 0 &&
      result.characterStates.length === 0 &&
      result.openThreads.length === 0) {
    throw new Error("Story delta output contains no accepted records and no NO_UPDATE record.");
  }
  if (result.noUpdate && (
    result.observedEvents.length > 0 ||
    result.observedRelations.length > 0 ||
    result.characterStates.length > 0 ||
    result.openThreads.length > 0
  )) {
    throw new Error("Story delta output cannot combine NO_UPDATE with accepted records.");
  }
  return result;
}

module.exports = {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
};
