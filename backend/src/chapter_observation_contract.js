const crypto = require("crypto");

const TEXT_ROLES = new Set([
  "dialogue",
  "monologue",
  "narration",
  "label_or_system",
  "sfx_like",
  "mixed",
  "uncertain",
]);
const SPEAKER_TYPES = new Set(["character", "narrator", "none", "uncertain"]);
const STYLE_CHANNELS = new Set([
  "character_voice",
  "inner_voice",
  "narrator_voice",
  "label_text",
  "sfx",
  "unknown",
]);
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

function parseLineBasedChapterObservation(content, input) {
  const expectedNodes = collectExpectedNodes(input);
  const nodes = [];
  const mentions = [];
  const storyCues = [];
  const notes = [];
  const seenNodeKeys = new Set();
  const seenIds = new Set();

  for (const [index, rawLine] of String(content || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("|").map((part) => part.trim());
    try {
      if (parts[0] === "NODE") {
        const record = parseNode(parts, expectedNodes);
        const key = nodeKey(record.pageName, record.nodeId);
        if (seenNodeKeys.has(key)) throw new Error(`Duplicate NODE ${record.pageName}/${record.nodeId}.`);
        seenNodeKeys.add(key);
        nodes.push(record);
      } else if (parts[0] === "MENTION") {
        if (parts.length < 7) throw new Error("MENTION requires 7 fields.");
        const [, mentionId, evidenceValue, surfaceForm, entityType, confidenceValue] = parts;
        if (!mentionId || seenIds.has(mentionId)) throw new Error(`Duplicate or empty id ${mentionId}.`);
        if (!ENTITY_TYPES.has(entityType)) throw new Error(`Unknown entityType ${entityType}.`);
        seenIds.add(mentionId);
        mentions.push({
          mentionId,
          evidenceNodeKeys: parseEvidenceNodeKeys(evidenceValue, expectedNodes, "MENTION"),
          surfaceForm,
          entityType,
          confidence: parseConfidence(confidenceValue, "mention confidence"),
          reason: parts.slice(6).join("|").trim(),
        });
      } else if (parts[0] === "STORY_CUE") {
        if (parts.length < 6) throw new Error("STORY_CUE requires 6 fields.");
        const [, cueId, evidenceValue, cueType, confidenceValue] = parts;
        if (!cueId || seenIds.has(cueId)) throw new Error(`Duplicate or empty id ${cueId}.`);
        if (!STORY_CUE_TYPES.has(cueType)) throw new Error(`Unknown cueType ${cueType}.`);
        seenIds.add(cueId);
        storyCues.push({
          cueId,
          evidenceNodeKeys: parseEvidenceNodeKeys(evidenceValue, expectedNodes, "STORY_CUE"),
          cueType,
          confidence: parseConfidence(confidenceValue, "story cue confidence"),
          reason: parts.slice(5).join("|").trim(),
        });
      } else if (parts[0] === "NOTES") {
        notes.push(parts.slice(1).join("|").trim());
      } else {
        throw new Error(`Unsupported record ${parts[0] || "empty"}.`);
      }
    } catch (error) {
      throw new Error(`Chapter observation line ${index + 1}: ${error.message}`);
    }
  }

  if (nodes.length !== expectedNodes.size) {
    const missing = [...expectedNodes.keys()].filter((key) => !seenNodeKeys.has(key));
    throw new Error(`Chapter observation is incomplete; missing ${missing.length} NODE records.`);
  }
  const warnings = [];
  if (storyCues.length > 12) {
    warnings.push(`story_cue_budget_exceeded:${storyCues.length}/12`);
  }
  return {
    schemaVersion: 1,
    nodes,
    mentions,
    storyCues,
    notes,
    warnings,
    coverage: {
      expected: expectedNodes.size,
      observed: nodes.length,
      uncertain: nodes.filter((node) => node.textRole === "uncertain").length,
      invalid: 0,
    },
  };
}

function validateChapterObservation(result) {
  if (!result || result.schemaVersion !== 1) throw new Error("Invalid chapter observation schema.");
  if (!Array.isArray(result.nodes) || !Array.isArray(result.mentions) || !Array.isArray(result.storyCues)) {
    throw new Error("Chapter observation arrays are required.");
  }
  if (result.coverage?.expected !== result.nodes.length || result.coverage?.observed !== result.nodes.length) {
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
