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
  if (!Number.isFinite(result) || result < 0 || result > 1)
    throw new Error("Deep Audit confidence must be between 0 and 1.");
  return result;
}

function createDeepAuditParseState() {
  return {
    findings: [],
    proposals: [],
    disposed: new Set(),
    completed: false,
    collector: createSemanticCollector(),
  };
}

function handleAuditFinding(state, candidates, parts) {
  if (parts.length !== 7) throw new Error("AUDIT_FINDING must contain exactly 7 fields.");
  const [, nodeId, type, severity, confidence, message, disposition] = parts;
  if (!candidates.has(nodeId)) throw new Error(`AUDIT_FINDING references unknown node ${nodeId}.`);
  if (!ISSUE_TYPES.has(type) || !SEVERITIES.has(severity) || !["keep", "revise"].includes(disposition))
    throw new Error("Invalid Deep Audit finding enum.");
  state.findings.push({
    nodeId,
    type,
    severity,
    confidence: parseConfidence(confidence),
    message,
    disposition,
  });
  state.disposed.add(nodeId);
  acceptRecord(state.collector);
}

function handleAuditRevision(state, candidates, parts) {
  if (parts.length !== 6) throw new Error("AUDIT_REVISION must contain exactly 6 fields.");
  const [, nodeId, type, confidence, revisedTranslation, reason] = parts;
  const candidate = candidates.get(nodeId);
  if (!candidate || !ISSUE_TYPES.has(type) || !revisedTranslation) throw new Error("Invalid Deep Audit revision.");
  if (state.proposals.some((entry) => entry.nodeId === nodeId))
    throw new Error(`Duplicate Deep Audit revision for ${nodeId}.`);
  for (const reasonEntry of candidate.reasons || []) {
    const canonical = reasonEntry.type === "locked_term" ? reasonEntry.evidence?.canonicalTranslation : null;
    if (canonical && !revisedTranslation.includes(canonical))
      throw new Error(`Deep Audit revision for ${nodeId} breaks locked term ${canonical}.`);
  }
  state.proposals.push({
    nodeId,
    pageName: candidate.pageName,
    original: candidate.original,
    currentTranslation: candidate.currentTranslation,
    revisedTranslation,
    reasonType: type,
    confidence: parseConfidence(confidence),
    reason,
  });
  state.disposed.add(nodeId);
  acceptRecord(state.collector);
}

function handleAuditKeep(state, candidates, parts) {
  if (parts.length !== 3 || !candidates.has(parts[1])) throw new Error("Invalid AUDIT_KEEP record.");
  state.disposed.add(parts[1]);
  acceptRecord(state.collector);
}

function handleWindowDone(state, input, parts) {
  if (parts[1] !== input.windowId) throw new Error("Deep Audit WINDOW_DONE mismatch.");
  state.completed = true;
}

function dispatchDeepAuditRecord(state, input, candidates, parts, kind) {
  if (kind === "AUDIT_FINDING") return handleAuditFinding(state, candidates, parts);
  if (kind === "AUDIT_REVISION") return handleAuditRevision(state, candidates, parts);
  if (kind === "AUDIT_KEEP") return handleAuditKeep(state, candidates, parts);
  if (kind === "WINDOW_DONE") return handleWindowDone(state, input, parts);
  throw new Error(`Unknown Deep Audit record ${kind}.`);
}

function finalizeDeepAuditParse(state, input, candidates) {
  if (!state.completed) {
    const error = new Error("Deep Audit output is missing WINDOW_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const missing = [...candidates.keys()].filter((nodeId) => !state.disposed.has(nodeId));
  if (missing.length > 0) addSemanticWarning(state.collector, `Deep Audit omitted ${missing.length} node(s).`);
  return {
    windowId: input.windowId,
    findings: state.findings,
    proposals: state.proposals,
    unobservedNodeIds: missing,
    semanticResult: finalizeSemanticResult(state.collector, {
      expectedRecords: candidates.size,
      observedRecords: candidates.size - missing.length,
    }),
  };
}

function parseDeepAuditWindowOutput(text, input) {
  const candidates = new Map((input.candidates || []).map((entry) => [entry.nodeId, entry]));
  const state = createDeepAuditParseState();
  const rawLines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const raw = rawLines[lineIndex];
    if (!raw.trim()) continue;
    let kind = null;
    try {
      const parts = splitEscapedLine(raw.trim());
      kind = parts[0];
      dispatchDeepAuditRecord(state, input, candidates, parts, kind);
    } catch (error) {
      quarantineRecord(state.collector, {
        lineNumber: lineIndex + 1,
        raw,
        kind,
        reason: error.message,
      });
    }
  }
  return finalizeDeepAuditParse(state, input, candidates);
}

module.exports = { parseDeepAuditWindowOutput };
