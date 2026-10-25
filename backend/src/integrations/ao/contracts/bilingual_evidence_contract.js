const TERM_CATEGORIES = new Set([
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
const TEXT_ROLES = new Set(["dialogue", "monologue", "narration"]);
const STYLE_CHANNELS = new Set(["character_voice", "inner_voice", "narrator_voice"]);
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

function parseConfidence(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) {
    throw new Error(`${field} must be a decimal number between 0 and 1.`);
  }
  return Number(normalized);
}

function splitKeys(value, allowed, field) {
  const keys = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (keys.length === 0 || keys.length > 4) throw new Error(`${field} requires 1 to 4 nodes.`);
  if (new Set(keys).size !== keys.length) throw new Error(`${field} contains duplicate nodes.`);
  for (const key of keys) if (!allowed.has(key)) throw new Error(`${field} contains unknown node ${key}.`);
  return keys;
}

function createState(input) {
  const targetByKey = new Map((input.targetNodes || []).map((node) => [node.nodeKey, node]));
  return {
    anchors: new Map((input.anchors || []).map((anchor) => [anchor.anchorId, anchor])),
    sourceKeys: new Set((input.sourceNodes || []).map((node) => node.nodeKey)),
    targetByKey,
    targetKeys: new Set(targetByKey.keys()),
    disposed: new Set(),
    termLinks: [],
    stylePairs: [],
    unmatchedAnchors: [],
    collector: createSemanticCollector(),
    completed: false,
  };
}

function disposeAnchor(state, anchorId, expectedPurpose) {
  const anchor = state.anchors.get(anchorId);
  if (!anchor) throw new Error(`Unknown anchor ${anchorId}.`);
  if (anchor.purpose !== expectedPurpose) {
    throw new Error(`Anchor ${anchorId} is not a ${expectedPurpose} anchor.`);
  }
  if (state.disposed.has(anchorId)) throw new Error(`Anchor ${anchorId} was disposed more than once.`);
  return anchor;
}

function markDisposed(state, anchorId) {
  state.disposed.add(anchorId);
}

function findStyleAnchor(anchors, sourceNodeKeys) {
  return [...anchors.values()].find(
    (candidate) =>
      candidate.purpose === "style" &&
      candidate.sourceNodeKeys.length === sourceNodeKeys.length &&
      candidate.sourceNodeKeys.every((key, keyIndex) => key === sourceNodeKeys[keyIndex]),
  );
}

function processTermLink(state, input, parts) {
  if (parts.length < 8) throw new Error("TERM_LINK requires 8 fields.");
  const [, windowId, sourceMentionId, targetSurface, targetValue, category, score] = parts;
  if (windowId !== input.windowId) throw new Error("windowId mismatch.");
  const anchor = disposeAnchor(state, sourceMentionId, "terminology");
  if (anchor.sourceMentionId !== sourceMentionId) throw new Error("sourceMentionId mismatch.");
  if (!TERM_CATEGORIES.has(category)) throw new Error(`Unknown terminology category ${category}.`);
  const targetNodeKeys = splitKeys(targetValue, state.targetKeys, "targetNodeKeys");
  const targetText = targetNodeKeys.map((key) => state.targetByKey.get(key)?.text || "").join("\n");
  if (!targetSurface || !targetText.includes(targetSurface)) {
    throw new Error(`Target surface ${targetSurface} is not present in target evidence.`);
  }
  state.termLinks.push({
    termLinkId: `${input.windowId}_term_${state.termLinks.length + 1}`,
    windowId: input.windowId,
    sourceMentionId,
    sourceNodeKeys: anchor.sourceNodeKeys,
    targetNodeKeys,
    targetSurface,
    category,
    confidence: parseConfidence(score, "term link confidence"),
    reason: parts.slice(7).join("|").trim(),
  });
  markDisposed(state, sourceMentionId);
  acceptRecord(state.collector);
}

function processStylePair(state, input, parts) {
  if (parts.length < 8) throw new Error("STYLE_PAIR requires 8 fields.");
  const [, windowId, sourceValue, targetValue, textRole, styleChannel, score] = parts;
  if (windowId !== input.windowId) throw new Error("windowId mismatch.");
  if (!TEXT_ROLES.has(textRole)) throw new Error(`Unknown textRole ${textRole}.`);
  if (!STYLE_CHANNELS.has(styleChannel)) throw new Error(`Unknown styleChannel ${styleChannel}.`);
  const sourceNodeKeys = splitKeys(sourceValue, state.sourceKeys, "sourceNodeKeys");
  const targetNodeKeys = splitKeys(targetValue, state.targetKeys, "targetNodeKeys");
  const anchor = findStyleAnchor(state.anchors, sourceNodeKeys);
  if (!anchor) throw new Error("STYLE_PAIR does not identify a style anchor.");
  disposeAnchor(state, anchor.anchorId, "style");
  if (anchor.textRole !== textRole || anchor.styleChannel !== styleChannel) {
    throw new Error(`STYLE_PAIR role/channel does not match anchor ${anchor.anchorId}.`);
  }
  state.stylePairs.push({
    stylePairId: `${input.windowId}_style_${state.stylePairs.length + 1}`,
    windowId: input.windowId,
    anchorId: anchor.anchorId,
    sourceNodeKeys,
    targetNodeKeys,
    textRole,
    styleChannel,
    confidence: parseConfidence(score, "style pair confidence"),
    reason: parts.slice(7).join("|").trim(),
  });
  markDisposed(state, anchor.anchorId);
  acceptRecord(state.collector);
}

function processNoMatch(state, input, parts) {
  if (parts.length < 5) throw new Error("NO_MATCH requires 5 fields.");
  const [, windowId, anchorType, anchorId] = parts;
  if (windowId !== input.windowId) throw new Error("windowId mismatch.");
  if (!new Set(["terminology", "style"]).has(anchorType)) {
    throw new Error(`Unknown anchorType ${anchorType}.`);
  }
  disposeAnchor(state, anchorId, anchorType);
  state.unmatchedAnchors.push({
    windowId: input.windowId,
    anchorType,
    anchorId,
    reason: parts.slice(4).join("|").trim(),
  });
  markDisposed(state, anchorId);
  acceptRecord(state.collector);
}

function processWindowDone(state, input, parts) {
  if (parts[1] !== input.windowId) throw new Error("WINDOW_DONE id mismatch.");
  state.completed = true;
}

function processRecord(state, input, parts) {
  if (parts[0] === "TERM_LINK") return processTermLink(state, input, parts);
  if (parts[0] === "STYLE_PAIR") return processStylePair(state, input, parts);
  if (parts[0] === "NO_MATCH") return processNoMatch(state, input, parts);
  if (parts[0] === "WINDOW_DONE") return processWindowDone(state, input, parts);
  throw new Error(`Unsupported record ${parts[0]}.`);
}

function processLine(state, input, rawLine, index) {
  const parts = rawLine
    .trim()
    .split("|")
    .map((part) => part.trim());
  if (!parts[0]) return;
  try {
    processRecord(state, input, parts);
  } catch (error) {
    quarantineRecord(state.collector, {
      lineNumber: index + 1,
      raw: rawLine,
      kind: parts[0] || null,
      reason: error.message,
    });
  }
}

function finalizeParse(state, input) {
  if (!state.completed) {
    const error = new Error(`Window ${input.windowId} did not emit WINDOW_DONE.`);
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const missing = [...state.anchors.keys()].filter((anchorId) => !state.disposed.has(anchorId));
  if (missing.length > 0) addSemanticWarning(state.collector, `Bilingual window omitted ${missing.length} anchor(s).`);
  for (const anchorId of missing) {
    const anchor = state.anchors.get(anchorId);
    state.unmatchedAnchors.push({
      windowId: input.windowId,
      anchorType: anchor.purpose,
      anchorId,
      reason: "AO did not return a valid disposition for this anchor.",
      unresolved: true,
    });
  }
  return {
    windowId: input.windowId,
    termLinks: state.termLinks,
    stylePairs: state.stylePairs,
    unmatchedAnchors: state.unmatchedAnchors,
    semanticResult: finalizeSemanticResult(state.collector, {
      expectedRecords: state.anchors.size,
      observedRecords: state.anchors.size - missing.length,
    }),
  };
}

function parseBilingualEvidenceWindow(content, input) {
  const state = createState(input);
  const lines = String(content || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    processLine(state, input, lines[index], index);
  }
  return finalizeParse(state, input);
}

function validateBilingualEvidenceWindow(result) {
  if (!result || !Array.isArray(result.termLinks) || !Array.isArray(result.stylePairs)) {
    throw new Error("Invalid bilingual evidence window result.");
  }
  return result;
}

module.exports = {
  STYLE_CHANNELS,
  TERM_CATEGORIES,
  TEXT_ROLES,
  parseBilingualEvidenceWindow,
  validateBilingualEvidenceWindow,
};
