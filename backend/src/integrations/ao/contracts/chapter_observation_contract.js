const crypto = require("crypto");
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

const TEXT_ROLES = new Set(["dialogue", "monologue", "narration", "label_or_system", "sfx_like", "mixed", "uncertain"]);
const SPEAKER_TYPES = new Set(["character", "narrator", "none", "uncertain"]);
const STYLE_CHANNELS = new Set(["character_voice", "inner_voice", "narrator_voice", "label_text", "sfx", "unknown"]);
const ENTITY_TYPES = new Set([
  "character",
  "title",
  "place",
  "organization",
  "technique",
  "ability",
  "device",
  "worldbuilding",
  "other_named_entity",
]);
const STORY_CUE_TYPES = new Set([
  "event",
  "relationship",
  "character_state",
  "worldbuilding",
  "open_thread",
  "translation_ambiguity",
]);

function nodeKey(pageName, nodeId) {
  return `${pageName}::${nodeId}`;
}

function parseConfidence(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) {
    throw new Error(`${fieldName} must be a decimal number between 0 and 1.`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${fieldName} must be a decimal number between 0 and 1.`);
  }
  return parsed;
}

function collectExpectedNodes(input) {
  const nodes = new Map();
  for (const page of input?.pages || []) {
    const pageName = String(page?.pageName || "").trim();
    for (const node of page?.nodes || []) {
      const nodeId = String(node?.nodeId || "").trim();
      if (!pageName || !nodeId) continue;
      const key = nodeKey(pageName, nodeId);
      if (nodes.has(key)) throw new Error(`Duplicate input node ${pageName}/${nodeId}.`);
      nodes.set(key, {
        pageName,
        pageId: page?.pageId || pageName,
        nodeId,
        readingOrder: Number.isInteger(node?.readingOrder) ? node.readingOrder : 0,
        textFingerprint: crypto
          .createHash("sha256")
          .update(String(node?.text || ""))
          .digest("hex"),
      });
    }
  }
  return nodes;
}

function parseNode(parts, expectedNodes) {
  if (parts.length < 10) throw new Error("NODE requires 10 fields.");
  const [, pageName, nodeId, textRole, speakerType, speakerRef, styleChannel, roleValue, speakerValue] = parts;
  const expected = expectedNodes.get(nodeKey(pageName, nodeId));
  if (!expected) throw new Error(`Unknown node ${pageName}/${nodeId}.`);
  if (!TEXT_ROLES.has(textRole)) throw new Error(`Unknown textRole ${textRole}.`);
  if (!SPEAKER_TYPES.has(speakerType)) throw new Error(`Unknown speakerType ${speakerType}.`);
  if (!STYLE_CHANNELS.has(styleChannel)) throw new Error(`Unknown styleChannel ${styleChannel}.`);
  return {
    ...expected,
    textRole,
    speakerType,
    speakerRef: speakerRef || null,
    styleChannel,
    roleConfidence: parseConfidence(roleValue, "roleConfidence"),
    speakerConfidence: parseConfidence(speakerValue, "speakerConfidence"),
    reason: parts.slice(9).join("|").trim(),
  };
}

function parseEvidenceNodeKeys(value, expectedNodes, fieldName) {
  const keys = String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (keys.length === 0) throw new Error(`${fieldName} requires evidence nodes.`);
  for (const key of keys) {
    if (!expectedNodes.has(key)) throw new Error(`${fieldName} contains unknown node ${key}.`);
  }
  return [...new Set(keys)];
}

function createObservationParseState(input) {
  return {
    expectedNodes: collectExpectedNodes(input),
    nodes: [],
    mentions: [],
    storyCues: [],
    notes: [],
    seenNodeKeys: new Set(),
    seenIds: new Set(),
    collector: createSemanticCollector(),
    completed: false,
    observedNodeCount: 0,
    warnings: [],
  };
}

function handleObservationDoneRecord(state, parts) {
  if (parts.length !== 1) throw new Error("OBSERVATION_DONE must not contain fields.");
  state.completed = true;
}

function handleNodeRecord(state, parts) {
  const record = parseNode(parts, state.expectedNodes);
  const key = nodeKey(record.pageName, record.nodeId);
  if (state.seenNodeKeys.has(key)) throw new Error(`Duplicate NODE ${record.pageName}/${record.nodeId}.`);
  state.seenNodeKeys.add(key);
  state.nodes.push(record);
  acceptRecord(state.collector);
}

function handleMentionRecord(state, parts) {
  if (parts.length < 7) throw new Error("MENTION requires 7 fields.");
  const [, mentionId, evidenceValue, surfaceForm, entityType, confidenceValue] = parts;
  if (!mentionId || state.seenIds.has(mentionId)) throw new Error(`Duplicate or empty id ${mentionId}.`);
  if (!ENTITY_TYPES.has(entityType)) throw new Error(`Unknown entityType ${entityType}.`);
  state.seenIds.add(mentionId);
  state.mentions.push({
    mentionId,
    evidenceNodeKeys: parseEvidenceNodeKeys(evidenceValue, state.expectedNodes, "MENTION"),
    surfaceForm,
    entityType,
    confidence: parseConfidence(confidenceValue, "mention confidence"),
    reason: parts.slice(6).join("|").trim(),
  });
  acceptRecord(state.collector);
}

function handleStoryCueRecord(state, parts) {
  if (parts.length < 6) throw new Error("STORY_CUE requires 6 fields.");
  const [, cueId, evidenceValue, cueType, confidenceValue] = parts;
  if (!cueId || state.seenIds.has(cueId)) throw new Error(`Duplicate or empty id ${cueId}.`);
  if (!STORY_CUE_TYPES.has(cueType)) throw new Error(`Unknown cueType ${cueType}.`);
  state.seenIds.add(cueId);
  state.storyCues.push({
    cueId,
    evidenceNodeKeys: parseEvidenceNodeKeys(evidenceValue, state.expectedNodes, "STORY_CUE"),
    cueType,
    confidence: parseConfidence(confidenceValue, "story cue confidence"),
    reason: parts.slice(5).join("|").trim(),
  });
  acceptRecord(state.collector);
}

function handleNotesRecord(state, parts) {
  state.notes.push(parts.slice(1).join("|").trim());
  acceptRecord(state.collector);
}

function dispatchObservationRecord(state, parts) {
  if (state.completed) throw new Error("OBSERVATION_DONE must be the final record.");
  const kind = parts[0];
  if (kind === "OBSERVATION_DONE") return handleObservationDoneRecord(state, parts);
  if (kind === "NODE") return handleNodeRecord(state, parts);
  if (kind === "MENTION") return handleMentionRecord(state, parts);
  if (kind === "STORY_CUE") return handleStoryCueRecord(state, parts);
  if (kind === "NOTES") return handleNotesRecord(state, parts);
  throw new Error(`Unsupported record ${kind || "empty"}.`);
}

function addMissingObservationNodes(state) {
  const missing = [...state.expectedNodes.entries()].filter(([key]) => !state.seenNodeKeys.has(key));
  if (missing.length === 0) return;
  addSemanticWarning(state.collector, `Chapter observation omitted ${missing.length} node(s).`);
  for (const [, expected] of missing) {
    state.nodes.push({
      ...expected,
      textRole: "uncertain",
      speakerType: "uncertain",
      speakerRef: null,
      styleChannel: "unknown",
      roleConfidence: 0,
      speakerConfidence: 0,
      reason: "AO did not return a valid observation for this node.",
    });
  }
}

function applyStoryCueBudgetWarning(state) {
  if (state.storyCues.length <= 12) return [];
  const warning = `story_cue_budget_exceeded:${state.storyCues.length}/12`;
  addSemanticWarning(state.collector, warning);
  return [warning];
}

function sortObservationNodes(state) {
  const orderByKey = new Map([...state.expectedNodes.keys()].map((key, index) => [key, index]));
  state.nodes.sort(
    (left, right) =>
      orderByKey.get(nodeKey(left.pageName, left.nodeId)) - orderByKey.get(nodeKey(right.pageName, right.nodeId)),
  );
}

function finalizeObservationParse(state) {
  if (!state.completed) {
    const error = new Error("Chapter observation is missing OBSERVATION_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  state.observedNodeCount = state.nodes.length;
  addMissingObservationNodes(state);
  state.warnings = applyStoryCueBudgetWarning(state);
  sortObservationNodes(state);
}

function buildObservationResult(state) {
  return {
    schemaVersion: 1,
    nodes: state.nodes,
    mentions: state.mentions,
    storyCues: state.storyCues,
    notes: state.notes,
    warnings: state.warnings,
    coverage: {
      expected: state.expectedNodes.size,
      observed: state.observedNodeCount,
      uncertain: state.nodes.filter((node) => node.textRole === "uncertain").length,
      invalid: state.collector.quarantinedRecords.length,
    },
    semanticResult: finalizeSemanticResult(state.collector, {
      expectedRecords: state.expectedNodes.size,
      observedRecords: state.observedNodeCount,
    }),
  };
}

function parseLineBasedChapterObservation(content, input) {
  const state = createObservationParseState(input);
  const rawLines = String(content || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex];
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|").map((part) => part.trim());
    try {
      dispatchObservationRecord(state, parts);
    } catch (error) {
      quarantineRecord(state.collector, {
        lineNumber: lineIndex + 1,
        raw: rawLine,
        kind: parts[0] || null,
        reason: error.message,
      });
    }
  }
  finalizeObservationParse(state);
  return buildObservationResult(state);
}

function validateChapterObservation(result) {
  if (!result || result.schemaVersion !== 1) throw new Error("Invalid chapter observation schema.");
  if (!Array.isArray(result.nodes) || !Array.isArray(result.mentions) || !Array.isArray(result.storyCues)) {
    throw new Error("Chapter observation arrays are required.");
  }
  if (result.coverage?.expected !== result.nodes.length || result.coverage?.observed > result.nodes.length) {
    throw new Error("Chapter observation coverage does not match nodes.");
  }
  return result;
}

module.exports = {
  ENTITY_TYPES,
  STORY_CUE_TYPES,
  collectExpectedNodes,
  nodeKey,
  parseLineBasedChapterObservation,
  validateChapterObservation,
};
