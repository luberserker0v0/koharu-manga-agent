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
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

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

function createParseContext(input) {
  const sourceNodes = collectSourceNodes(input);
  const quickRead = input?.analysisDepth === "quick_read";
  const limits = quickRead
    ? { events: 1, relations: 2, states: 1, threads: 1 }
    : { events: 3, relations: 3, states: 3, threads: 2 };
  return {
    sourceNodes,
    quickRead,
    limits,
    observedEvents: [],
    observedRelations: [],
    characterStates: [],
    openThreads: [],
    notes: [],
    collector: createSemanticCollector(),
    noUpdate: false,
    completed: false,
  };
}

function resolveEvidence(sourceNodes, nodeId, allowedRoles) {
  const node = sourceNodes.get(nodeId);
  if (!node || !allowedRoles.has(node.textRole)) {
    return null;
  }
  return node;
}

function resolveEvidences(sourceNodes, anchorText, allowedRoles) {
  const anchors = parseEvidenceAnchors(anchorText);
  if (anchors.length === 0 || anchors.length > 6) {
    return [];
  }
  const evidences = anchors.map((nodeId) => {
    const node = resolveEvidence(sourceNodes, nodeId, allowedRoles);
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
}

function withEvidenceFields(record, evidences) {
  return {
    ...record,
    evidences,
    pageName: evidences[0].pageName,
    nodeId: evidences[0].nodeId,
    evidenceLine: evidences[0].evidenceLine,
    textRole: evidences[0].textRole,
    styleChannel: evidences[0].styleChannel,
    roleConfidence: evidences[0].roleConfidence,
  };
}

function resolveConfidence(quickRead, value) {
  const confidence = parseConfidence(value);
  return quickRead ? Math.min(confidence, 0.75) : confidence;
}

function getRecordLimit(ctx, kind) {
  const limits = {
    STORY_EVENT: [6, ctx.observedEvents.length, ctx.limits.events],
    RELATION_DELTA: [7, ctx.observedRelations.length, ctx.limits.relations],
    CHARACTER_STATE: [7, ctx.characterStates.length, ctx.limits.states],
    OPEN_THREAD: [6, ctx.openThreads.length, ctx.limits.threads],
  };
  return limits[kind];
}

function enforceRecordLimit(ctx, kind, parts) {
  const limit = getRecordLimit(ctx, kind);
  if (!limit) return;
  const [minimumFields, currentCount, maximumCount] = limit;
  if (parts.length < minimumFields) throw new Error(`${kind} is malformed.`);
  if (currentCount >= maximumCount) throw new Error(`${kind} exceeds the record budget of ${maximumCount}.`);
}

function handleStoryEvent(ctx, parts) {
  const [, anchorText, confidenceText, participantText, summary, ...impactParts] = parts;
  const evidences = resolveEvidences(ctx.sourceNodes, anchorText, EVENT_ROLES);
  const confidence = resolveConfidence(ctx.quickRead, confidenceText);
  const translationImpact = impactParts.join("|");
  if (evidences.length > 0 && confidence >= 0.65 && summary && translationImpact) {
    ctx.observedEvents.push(
      withEvidenceFields(
        {
          summary,
          participants: parseParticipants(participantText),
          confidence,
          translationImpact,
        },
        evidences,
      ),
    );
    acceptRecord(ctx.collector);
  }
}

function handleRelationDelta(ctx, parts) {
  const [, relationType, subject, object, anchorText, confidenceText, ...impactParts] = parts;
  const evidences = resolveEvidences(ctx.sourceNodes, anchorText, STORY_ROLES);
  const confidence = resolveConfidence(ctx.quickRead, confidenceText);
  const translationImpact = impactParts.join("|");
  if (
    evidences.length > 0 &&
    confidence >= 0.65 &&
    RELATION_TYPES.has(relationType) &&
    subject &&
    object &&
    translationImpact
  ) {
    ctx.observedRelations.push(
      withEvidenceFields(
        {
          relationType,
          subject,
          object,
          confidence,
          translationImpact,
        },
        evidences,
      ),
    );
    acceptRecord(ctx.collector);
  }
}

function handleCharacterState(ctx, parts) {
  const [, character, attribute, value, anchorText, confidenceText, ...impactParts] = parts;
  const evidences = resolveEvidences(ctx.sourceNodes, anchorText, STORY_ROLES);
  const confidence = resolveConfidence(ctx.quickRead, confidenceText);
  const translationImpact = impactParts.join("|");
  if (evidences.length > 0 && confidence >= 0.65 && character && attribute && value && translationImpact) {
    ctx.characterStates.push(
      withEvidenceFields(
        {
          character,
          attribute,
          value,
          confidence,
          translationImpact,
        },
        evidences,
      ),
    );
    acceptRecord(ctx.collector);
  }
}

function handleOpenThread(ctx, parts) {
  const [, anchorText, confidenceText, participantText, summary, ...impactParts] = parts;
  const evidences = resolveEvidences(ctx.sourceNodes, anchorText, EVENT_ROLES);
  const confidence = resolveConfidence(ctx.quickRead, confidenceText);
  const translationImpact = impactParts.join("|");
  if (evidences.length > 0 && confidence >= 0.6 && summary && translationImpact) {
    ctx.openThreads.push(
      withEvidenceFields(
        {
          summary,
          participants: parseParticipants(participantText),
          confidence,
          translationImpact,
        },
        evidences,
      ),
    );
    acceptRecord(ctx.collector);
  }
}

const STORY_RECORD_HANDLERS = {
  STORY_EVENT: handleStoryEvent,
  RELATION_DELTA: handleRelationDelta,
  CHARACTER_STATE: handleCharacterState,
  OPEN_THREAD: handleOpenThread,
};

function handleStoryControlRecord(ctx, kind, parts) {
  if (kind === "STORY_DELTA_DONE") {
    if (parts.length !== 1) throw new Error("STORY_DELTA_DONE must not contain fields.");
    ctx.completed = true;
    return true;
  }
  if (kind === "NO_UPDATE") {
    ctx.noUpdate = true;
    ctx.notes.push(parts.slice(1).join("|") || "No durable translation-relevant update.");
    acceptRecord(ctx.collector);
    return true;
  }
  if (kind === "NOTES") {
    ctx.notes.push(parts.slice(1).join("|"));
    acceptRecord(ctx.collector);
    return true;
  }
  return false;
}

function processRecord(ctx, line, rawLine, index) {
  const parts = line.split("|").map((part) => part.trim());
  const kind = parts[0];
  if (ctx.completed) throw new Error("STORY_DELTA_DONE must be the final record.");
  if (kind === "EVIDENCE_ROLE") throw new Error("EVIDENCE_ROLE is obsolete; use Chapter Observation role fields.");
  if (handleStoryControlRecord(ctx, kind, parts)) return;
  enforceRecordLimit(ctx, kind, parts);
  const handler = STORY_RECORD_HANDLERS[kind];
  if (handler) return handler(ctx, parts);
  throw new Error(`Unsupported or malformed record ${kind || "empty"}.`);
}

function processLine(ctx, rawLine, index) {
  const line = rawLine.trim();
  if (!line) return;
  try {
    processRecord(ctx, line, rawLine, index);
  } catch (error) {
    quarantineRecord(ctx.collector, {
      lineNumber: index + 1,
      raw: rawLine,
      kind: line.split("|", 1)[0] || null,
      reason: error.message,
    });
  }
}

function finalizeParse(ctx) {
  if (!ctx.completed) {
    const error = new Error("Story delta output is missing STORY_DELTA_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const acceptedDeltaCount =
    ctx.observedEvents.length + ctx.observedRelations.length + ctx.characterStates.length + ctx.openThreads.length;
  if (acceptedDeltaCount === 0 && !ctx.noUpdate) {
    ctx.noUpdate = true;
    ctx.notes.push("No valid durable story update was produced.");
    addSemanticWarning(ctx.collector, "Story update completed without valid durable evidence.");
  } else if (acceptedDeltaCount > 0 && ctx.noUpdate) {
    ctx.noUpdate = false;
    addSemanticWarning(ctx.collector, "NO_UPDATE was ignored because valid story records were accepted.");
  }
}

function buildResult(ctx) {
  return {
    observedEvents: ctx.observedEvents,
    observedRelations: ctx.observedRelations,
    characterStates: ctx.characterStates,
    openThreads: ctx.openThreads,
    notes: ctx.notes.filter(Boolean).join("\n"),
    noUpdate: ctx.noUpdate,
    semanticResult: finalizeSemanticResult(ctx.collector),
  };
}

function parseLineBasedStoryDelta(content, input) {
  const ctx = createParseContext(input);
  const lines = String(content || "").split(/\r?\n/);
  lines.forEach((rawLine, index) => processLine(ctx, rawLine, index));
  finalizeParse(ctx);
  return buildResult(ctx);
}

function validateStoryDeltaResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Story delta output is invalid.");
  }
  return result;
}

module.exports = {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
};
