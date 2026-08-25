const { ISSUE_TYPES, SEVERITIES, splitEscapedLine } = require("./quality_line_contract");
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

function parseConfidence(value) {
  const result = Number.parseFloat(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) throw new Error("Deep Audit confidence must be between 0 and 1.");
  return result;
}

function parseDeepAuditWindowOutput(text, input) {
  const candidates = new Map((input.candidates || []).map((entry) => [entry.nodeId, entry]));
  const findings = [];
  const proposals = [];
  const disposed = new Set();
  const collector = createSemanticCollector();
  let completed = false;
  const rawLines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const raw = rawLines[lineIndex];
    if (!raw.trim()) continue;
    let kind = null;
    try {
      const parts = splitEscapedLine(raw.trim());
      kind = parts[0];
      if (parts[0] === "AUDIT_FINDING") {
      if (parts.length !== 7) throw new Error("AUDIT_FINDING must contain exactly 7 fields.");
      const [, nodeId, type, severity, confidence, message, disposition] = parts;
      if (!candidates.has(nodeId)) throw new Error(`AUDIT_FINDING references unknown node ${nodeId}.`);
      if (!ISSUE_TYPES.has(type) || !SEVERITIES.has(severity) || !["keep", "revise"].includes(disposition)) throw new Error("Invalid Deep Audit finding enum.");
      findings.push({ nodeId, type, severity, confidence: parseConfidence(confidence), message, disposition });
      disposed.add(nodeId);
      acceptRecord(collector);
      } else if (parts[0] === "AUDIT_REVISION") {
      if (parts.length !== 6) throw new Error("AUDIT_REVISION must contain exactly 6 fields.");
      const [, nodeId, type, confidence, revisedTranslation, reason] = parts;
      const candidate = candidates.get(nodeId);
      if (!candidate || !ISSUE_TYPES.has(type) || !revisedTranslation) throw new Error("Invalid Deep Audit revision.");
      if (proposals.some((entry) => entry.nodeId === nodeId)) throw new Error(`Duplicate Deep Audit revision for ${nodeId}.`);
      for (const reasonEntry of candidate.reasons || []) {
        const canonical = reasonEntry.type === "locked_term" ? reasonEntry.evidence?.canonicalTranslation : null;
        if (canonical && !revisedTranslation.includes(canonical)) throw new Error(`Deep Audit revision for ${nodeId} breaks locked term ${canonical}.`);
      }
      proposals.push({ nodeId, pageName: candidate.pageName, original: candidate.original, currentTranslation: candidate.currentTranslation, revisedTranslation, reasonType: type, confidence: parseConfidence(confidence), reason });
      disposed.add(nodeId);
      acceptRecord(collector);
      } else if (parts[0] === "AUDIT_KEEP") {
      if (parts.length !== 3 || !candidates.has(parts[1])) throw new Error("Invalid AUDIT_KEEP record.");
      disposed.add(parts[1]);
      acceptRecord(collector);
      } else if (parts[0] === "WINDOW_DONE") {
      if (parts[1] !== input.windowId) throw new Error("Deep Audit WINDOW_DONE mismatch.");
      completed = true;
      } else {
        throw new Error(`Unknown Deep Audit record ${parts[0]}.`);
      }
    } catch (error) {
      quarantineRecord(collector, { lineNumber: lineIndex + 1, raw, kind, reason: error.message });
    }
  }
  if (!completed) {
    const error = new Error("Deep Audit output is missing WINDOW_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const missing = [...candidates.keys()].filter((nodeId) => !disposed.has(nodeId));
  if (missing.length > 0) addSemanticWarning(collector, `Deep Audit omitted ${missing.length} node(s).`);
  return {
    windowId: input.windowId,
    findings,
    proposals,
    unobservedNodeIds: missing,
    semanticResult: finalizeSemanticResult(collector, {
      expectedRecords: candidates.size,
      observedRecords: candidates.size - missing.length,
    }),
  };
}

module.exports = { parseDeepAuditWindowOutput };
