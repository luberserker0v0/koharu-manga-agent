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

function parseConfidence(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(normalized)) {
    throw new Error(`${field} must be a decimal number between 0 and 1.`);
  }
  return Number(normalized);
}

function splitKeys(value, allowed, field) {
  const keys = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (keys.length === 0 || keys.length > 4) throw new Error(`${field} requires 1 to 4 nodes.`);
  if (new Set(keys).size !== keys.length) throw new Error(`${field} contains duplicate nodes.`);
  for (const key of keys) if (!allowed.has(key)) throw new Error(`${field} contains unknown node ${key}.`);
  return keys;
}

function parseBilingualEvidenceWindow(content, input) {
  const anchors = new Map((input.anchors || []).map((anchor) => [anchor.anchorId, anchor]));
  const sourceKeys = new Set((input.sourceNodes || []).map((node) => node.nodeKey));
  const targetByKey = new Map((input.targetNodes || []).map((node) => [node.nodeKey, node]));
  const targetKeys = new Set(targetByKey.keys());
  const disposed = new Set();
  const termLinks = [];
  const stylePairs = [];
  const unmatchedAnchors = [];
  let completed = false;

  const dispose = (anchorId, expectedPurpose) => {
    const anchor = anchors.get(anchorId);
    if (!anchor) throw new Error(`Unknown anchor ${anchorId}.`);
    if (anchor.purpose !== expectedPurpose) {
      throw new Error(`Anchor ${anchorId} is not a ${expectedPurpose} anchor.`);
    }
    if (disposed.has(anchorId)) throw new Error(`Anchor ${anchorId} was disposed more than once.`);
    disposed.add(anchorId);
    return anchor;
  };

  for (const [index, rawLine] of String(content || "").split(/\r?\n/).entries()) {
    const parts = rawLine.trim().split("|").map((part) => part.trim());
    if (!parts[0]) continue;
    try {
      if (parts[0] === "TERM_LINK") {
        if (parts.length < 8) throw new Error("TERM_LINK requires 8 fields.");
        const [, windowId, sourceMentionId, targetSurface, targetValue, category, score] = parts;
        if (windowId !== input.windowId) throw new Error("windowId mismatch.");
        const anchor = dispose(sourceMentionId, "terminology");
        if (anchor.sourceMentionId !== sourceMentionId) throw new Error("sourceMentionId mismatch.");
        if (!TERM_CATEGORIES.has(category)) throw new Error(`Unknown terminology category ${category}.`);
        const targetNodeKeys = splitKeys(targetValue, targetKeys, "targetNodeKeys");
        const targetText = targetNodeKeys.map((key) => targetByKey.get(key)?.text || "").join("\n");
        if (!targetSurface || !targetText.includes(targetSurface)) {
          throw new Error(`Target surface ${targetSurface} is not present in target evidence.`);
        }
        termLinks.push({
          termLinkId: `${input.windowId}_term_${termLinks.length + 1}`,
          windowId: input.windowId,
          sourceMentionId,
          sourceNodeKeys: anchor.sourceNodeKeys,
          targetNodeKeys,
          targetSurface,
          category,
          confidence: parseConfidence(score, "term link confidence"),
          reason: parts.slice(7).join("|").trim(),
        });
      } else if (parts[0] === "STYLE_PAIR") {
        if (parts.length < 8) throw new Error("STYLE_PAIR requires 8 fields.");
        const [, windowId, sourceValue, targetValue, textRole, styleChannel, score] = parts;
        if (windowId !== input.windowId) throw new Error("windowId mismatch.");
        if (!TEXT_ROLES.has(textRole)) throw new Error(`Unknown textRole ${textRole}.`);
        if (!STYLE_CHANNELS.has(styleChannel)) throw new Error(`Unknown styleChannel ${styleChannel}.`);
        const sourceNodeKeys = splitKeys(sourceValue, sourceKeys, "sourceNodeKeys");
        const targetNodeKeys = splitKeys(targetValue, targetKeys, "targetNodeKeys");
        const anchor = [...anchors.values()].find((candidate) =>
          candidate.purpose === "style" &&
          candidate.sourceNodeKeys.length === sourceNodeKeys.length &&
          candidate.sourceNodeKeys.every((key, keyIndex) => key === sourceNodeKeys[keyIndex])
        );
        if (!anchor) throw new Error("STYLE_PAIR does not identify a style anchor.");
        dispose(anchor.anchorId, "style");
        if (anchor.textRole !== textRole || anchor.styleChannel !== styleChannel) {
          throw new Error(`STYLE_PAIR role/channel does not match anchor ${anchor.anchorId}.`);
        }
        stylePairs.push({
          stylePairId: `${input.windowId}_style_${stylePairs.length + 1}`,
          windowId: input.windowId,
          anchorId: anchor.anchorId,
          sourceNodeKeys,
          targetNodeKeys,
          textRole,
          styleChannel,
          confidence: parseConfidence(score, "style pair confidence"),
          reason: parts.slice(7).join("|").trim(),
        });
      } else if (parts[0] === "NO_MATCH") {
        if (parts.length < 5) throw new Error("NO_MATCH requires 5 fields.");
        const [, windowId, anchorType, anchorId] = parts;
        if (windowId !== input.windowId) throw new Error("windowId mismatch.");
        if (!new Set(["terminology", "style"]).has(anchorType)) {
          throw new Error(`Unknown anchorType ${anchorType}.`);
        }
        dispose(anchorId, anchorType);
        unmatchedAnchors.push({
          windowId: input.windowId,
          anchorType,
          anchorId,
          reason: parts.slice(4).join("|").trim(),
        });
      } else if (parts[0] === "WINDOW_DONE") {
        if (parts[1] !== input.windowId) throw new Error("WINDOW_DONE id mismatch.");
        completed = true;
      } else {
        throw new Error(`Unsupported record ${parts[0]}.`);
      }
    } catch (error) {
      throw new Error(`Bilingual evidence line ${index + 1}: ${error.message}`);
    }
  }
  if (!completed) throw new Error(`Window ${input.windowId} did not emit WINDOW_DONE.`);
  const missing = [...anchors.keys()].filter((anchorId) => !disposed.has(anchorId));
  if (missing.length > 0) throw new Error(`Window anchor disposition is incomplete: ${missing.join(", ")}.`);
  return { windowId: input.windowId, termLinks, stylePairs, unmatchedAnchors };
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
