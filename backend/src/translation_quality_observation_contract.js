const DISPOSITIONS = new Set(["clean", "suspect"]);
const RISK_TYPES = new Set([
  "none",
  "empty_translation",
  "sequence_shift",
  "meaning_change",
  "locked_term_violation",
  "terminology",
  "style",
  "story_context",
  "fluency",
]);

function splitEscapedLine(line) {
  const fields = [];
  let current = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      if (character === "n") current += "\n";
      else if (character === "|" || character === "\\") current += character;
      else throw new Error(`Unknown quality-observation escape \\${character}.`);
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      fields.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) throw new Error("Quality-observation output ends with an incomplete escape.");
  fields.push(current.trim());
  return fields;
}

function parseConfidence(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} confidence must be between 0 and 1.`);
  }
  return parsed;
}

function parseTranslationQualityObservationOutput(text, input) {
  const expectedNodes = new Map((input.nodes || []).map((node, index) => [node.nodeId, { ...node, index }]));
  const dispositions = new Map();
  const sequenceRisks = [];
  let completed = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = splitEscapedLine(line);
    const kind = fields[0];
    if (completed) throw new Error("WINDOW_DONE must be the final observation record.");
    if (kind === "NODE") {
      if (fields.length !== 7) throw new Error("NODE must contain exactly 7 fields.");
      const [, windowId, nodeId, disposition, riskText, confidenceText, reason] = fields;
      if (windowId !== input.windowId) throw new Error(`NODE references unknown window ${windowId}.`);
      const sourceNode = expectedNodes.get(nodeId);
      if (!sourceNode) throw new Error(`NODE references unknown node ${nodeId}.`);
      if (dispositions.has(nodeId)) throw new Error(`Duplicate NODE disposition for ${nodeId}.`);
      if (!DISPOSITIONS.has(disposition)) throw new Error(`Unknown NODE disposition ${disposition}.`);
      const riskTypes = riskText.split(",").map((value) => value.trim()).filter(Boolean);
      if (riskTypes.length === 0 || riskTypes.some((value) => !RISK_TYPES.has(value))) {
        throw new Error(`NODE ${nodeId} contains an unknown or empty risk type.`);
      }
      if (disposition === "clean" && (riskTypes.length !== 1 || riskTypes[0] !== "none")) {
        throw new Error(`Clean NODE ${nodeId} must use risk type none.`);
      }
      if (disposition === "suspect" && riskTypes.includes("none")) {
        throw new Error(`Suspect NODE ${nodeId} cannot use risk type none.`);
      }
      dispositions.set(nodeId, {
        nodeId,
        pageId: sourceNode.pageId || null,
        pageName: sourceNode.pageName || null,
        disposition,
        riskTypes,
        confidence: parseConfidence(confidenceText, "NODE"),
        reason,
      });
      continue;
    }
    if (kind === "SEQUENCE_RISK") {
      if (fields.length !== 8) throw new Error("SEQUENCE_RISK must contain exactly 8 fields.");
      const [, windowId, pageName, startNodeId, endNodeId, confidenceText, riskType, reason] = fields;
      if (windowId !== input.windowId) throw new Error(`SEQUENCE_RISK references unknown window ${windowId}.`);
      if (riskType !== "sequence_shift") throw new Error("SEQUENCE_RISK type must be sequence_shift.");
      const start = expectedNodes.get(startNodeId);
      const end = expectedNodes.get(endNodeId);
      if (!start || !end) throw new Error("SEQUENCE_RISK references an unknown node.");
      if (start.index > end.index) throw new Error("SEQUENCE_RISK node range is reversed.");
      const covered = [...expectedNodes.values()].slice(start.index, end.index + 1);
      if (covered.some((node) => node.pageName !== pageName)) {
        throw new Error("SEQUENCE_RISK must remain within one page.");
      }
      sequenceRisks.push({
        pageName,
        startNodeId,
        endNodeId,
        nodeIds: covered.map((node) => node.nodeId),
        riskType,
        confidence: parseConfidence(confidenceText, "SEQUENCE_RISK"),
        reason,
      });
      continue;
    }
    if (kind === "WINDOW_DONE") {
      if (fields.length !== 2 || fields[1] !== input.windowId) {
        throw new Error(`WINDOW_DONE does not match ${input.windowId}.`);
      }
      completed = true;
      continue;
    }
    throw new Error(`Unknown quality-observation record ${kind}.`);
  }

  if (!completed) throw new Error(`Quality observation is missing WINDOW_DONE|${input.windowId}.`);
  const missing = [...expectedNodes.keys()].filter((nodeId) => !dispositions.has(nodeId));
  if (missing.length > 0) throw new Error(`Quality observation omitted ${missing.length} node(s): ${missing.join(", ")}.`);
  for (const risk of sequenceRisks) {
    for (const nodeId of risk.nodeIds) {
      const node = dispositions.get(nodeId);
      if (node.disposition !== "suspect" || !node.riskTypes.includes("sequence_shift")) {
        throw new Error(`SEQUENCE_RISK node ${nodeId} must be classified as suspect sequence_shift.`);
      }
    }
  }
  return { windowId: input.windowId, nodes: [...dispositions.values()], sequenceRisks };
}

module.exports = {
  DISPOSITIONS,
  RISK_TYPES,
  parseTranslationQualityObservationOutput,
};
