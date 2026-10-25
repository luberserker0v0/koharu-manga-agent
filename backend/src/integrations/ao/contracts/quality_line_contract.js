const ISSUE_TYPES = new Set([
  "glossary_consistency",
  "locked_term_preservation",
  "context_accuracy",
  "speaker_voice_consistency",
  "register_consistency",
  "punctuation_consistency",
  "readability_fluency",
  "ambiguity_control",
  "translation_accuracy",
  "sequence_alignment",
  "translation_completeness",
]);
const SEVERITIES = new Set(["low", "medium", "high"]);
const COMPLETENESS_REASONS = new Set(["translation_missing", "source_target_identity"]);
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

function splitEscapedLine(line) {
  const parts = [];
  let current = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      if (character === "n") current += "\n";
      else if (character === "|" || character === "\\") current += character;
      else throw new Error(`Unknown line-contract escape \\${character}.`);
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  parts.push(current.trim());
  return parts;
}

function confidence(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new Error(`${label} confidence must be between 0 and 1.`);
  return parsed;
}

function createQualityParseState() {
  return {
    issues: [],
    warnings: [],
    revisions: [],
    passedChecks: [],
    failedChecks: [],
    notes: [],
    completed: false,
    dispositions: new Map(),
    acceptedNodeIds: new Set(),
    acceptances: [],
    collector: createSemanticCollector(),
    windowHeader: null,
  };
}

function setDisposition(dispositions, nodeId, disposition, recordKind) {
  const existing = dispositions.get(nodeId);
  if (existing && existing !== disposition) {
    throw new Error(`${recordKind} for ${nodeId} conflicts with existing ${existing} disposition.`);
  }
  dispositions.set(nodeId, disposition);
}

function hasQualityRecords(state) {
  return state.issues.length || state.warnings.length || state.revisions.length || state.acceptances.length
    || state.passedChecks.length || state.failedChecks.length || state.notes.length || state.completed;
}

function expectedWindowHeader(input) {
  return {
    windowId: input.windowId,
    projectionFingerprint: input.projectionFingerprint,
    translationMemoryFingerprint: input.translationMemoryFingerprint,
    sourceLanguage: input.languages?.sourceLanguage,
    targetLanguage: input.languages?.targetLanguage,
  };
}

function handleWindowRecord(state, input, parts) {
  if (parts.length !== 6) throw new Error("WINDOW must contain exactly 6 fields.");
  if (state.windowHeader) throw new Error("Quality output contains more than one WINDOW header.");
  if (hasQualityRecords(state)) {
    throw new Error("WINDOW must be the first non-empty record.");
  }
  const [, windowId, projectionFingerprint, translationMemoryFingerprint, sourceLanguage, targetLanguage] = parts;
  const expected = expectedWindowHeader(input);
  const actual = {
    windowId,
    projectionFingerprint,
    translationMemoryFingerprint,
    sourceLanguage,
    targetLanguage,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue != null && String(expectedValue) !== actual[field]) {
      throw new Error(`WINDOW ${field} does not match the quality input.`);
    }
  }
  state.windowHeader = actual;
}

function handleIssueOrWarningRecord(state, candidateById, parts, kind) {
  if (parts.length !== 7) throw new Error(`${kind} must contain exactly 7 fields.`);
  const [, nodeId, type, severity, confidenceText, message, disposition] = parts;
  if (!candidateById.has(nodeId)) throw new Error(`${kind} references unknown node ${nodeId}.`);
  if (!ISSUE_TYPES.has(type)) throw new Error(`${kind} contains unknown type ${type}.`);
  if (!SEVERITIES.has(severity)) throw new Error(`${kind} contains unknown severity ${severity}.`);
  if (!["keep", "revise"].includes(disposition)) throw new Error(`${kind} disposition must be keep or revise.`);
  const parsedConfidence = confidence(confidenceText, kind);
  setDisposition(state.dispositions, nodeId, disposition, kind);
  (kind === "ISSUE" ? state.issues : state.warnings).push({
    type,
    severity,
    confidence: parsedConfidence,
    nodeId,
    pageName: candidateById.get(nodeId).pageName,
    message,
  });
  acceptRecord(state.collector);
}

function handleRevisionRecord(state, candidateById, parts) {
  if (parts.length !== 6) throw new Error("REVISION must contain exactly 6 fields.");
  const [, nodeId, type, confidenceText, revisedTranslation, reason] = parts;
  const candidate = candidateById.get(nodeId);
  if (!candidate) throw new Error(`REVISION references unknown node ${nodeId}.`);
  if (!ISSUE_TYPES.has(type)) throw new Error(`REVISION contains unknown type ${type}.`);
  if (!revisedTranslation) throw new Error(`REVISION for ${nodeId} has an empty translation.`);
  if (state.revisions.some((entry) => entry.nodeId === nodeId)) throw new Error(`Duplicate REVISION for ${nodeId}.`);
  for (const reasonEntry of candidate.reasons || []) {
    if (reasonEntry.type !== "locked_term") continue;
    const canonical = reasonEntry.evidence?.canonicalTranslation;
    if (canonical && !revisedTranslation.includes(canonical))
      throw new Error(`REVISION for ${nodeId} breaks locked term ${canonical}.`);
  }
  setDisposition(state.dispositions, nodeId, "revise", "REVISION");
  state.revisions.push({
    nodeId,
    pageName: candidate.pageName,
    original: candidate.original,
    currentTranslation: candidate.currentTranslation,
    revisedTranslation,
    reasonType: type,
    confidence: confidence(confidenceText, "REVISION"),
    reason,
  });
  acceptRecord(state.collector);
}

function handleAcceptRecord(state, candidateById, parts) {
  if (parts.length !== 4) throw new Error("ACCEPT must contain exactly 4 fields.");
  const [, nodeId, checkName, reason] = parts;
  const candidate = candidateById.get(nodeId);
  if (!candidate) throw new Error(`ACCEPT references unknown node ${nodeId}.`);
  if (checkName !== "translation_completeness") {
    throw new Error("ACCEPT check name must be translation_completeness.");
  }
  if (!(candidate.reasons || []).some((entry) => COMPLETENESS_REASONS.has(entry.type))) {
    throw new Error(`ACCEPT references non-completeness candidate ${nodeId}.`);
  }
  if (!reason) throw new Error(`ACCEPT for ${nodeId} requires a reason.`);
  if (state.acceptedNodeIds.has(nodeId)) throw new Error(`Duplicate ACCEPT for ${nodeId}.`);
  state.acceptedNodeIds.add(nodeId);
  state.acceptances.push({ nodeId, checkName, reason });
  setDisposition(state.dispositions, nodeId, "accept", "ACCEPT");
  acceptRecord(state.collector);
}

function handlePassFailRecord(state, parts, kind) {
  if (parts.length !== 2 || !parts[1]) throw new Error(`${kind} must contain one check name.`);
  (kind === "PASS" ? state.passedChecks : state.failedChecks).push(parts[1]);
  acceptRecord(state.collector);
}

function handleNotesRecord(state, parts) {
  state.notes.push(parts.slice(1).join(" | "));
  acceptRecord(state.collector);
}

function handleWindowDoneRecord(state, input, parts) {
  if (parts.length !== 2) throw new Error("WINDOW_DONE must contain exactly 2 fields.");
  if (parts[1] !== input.windowId) throw new Error(`WINDOW_DONE does not match ${input.windowId}.`);
  state.completed = true;
}

function dispatchQualityRecord(state, input, candidateById, parts, kind) {
  if (state.completed) throw new Error("WINDOW_DONE must be the final non-empty record.");
  if (kind === "WINDOW") return handleWindowRecord(state, input, parts);
  if (kind === "ISSUE" || kind === "WARNING") return handleIssueOrWarningRecord(state, candidateById, parts, kind);
  if (kind === "REVISION") return handleRevisionRecord(state, candidateById, parts);
  if (kind === "ACCEPT") return handleAcceptRecord(state, candidateById, parts);
  if (kind === "PASS" || kind === "FAIL") return handlePassFailRecord(state, parts, kind);
  if (kind === "NOTES") return handleNotesRecord(state, parts);
  if (kind === "WINDOW_DONE") return handleWindowDoneRecord(state, input, parts);
  throw new Error(`Unknown quality output record ${kind}.`);
}

function finalizeQualityParse(state, input) {
  if (!state.completed) {
    const error = new Error(`Quality output is missing WINDOW_DONE|${input.windowId}.`);
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const revisedNodeIds = new Set(state.revisions.map((entry) => entry.nodeId));
  for (const nodeId of state.acceptedNodeIds) {
    if (revisedNodeIds.has(nodeId)) {
      state.acceptedNodeIds.delete(nodeId);
      addSemanticWarning(state.collector, `Completeness ACCEPT for ${nodeId} was ignored because a revision exists.`);
    }
  }
  for (const candidate of input.candidates || []) {
    if (!(candidate.reasons || []).some((entry) => COMPLETENESS_REASONS.has(entry.type))) continue;
    if (!revisedNodeIds.has(candidate.nodeId) && !state.acceptedNodeIds.has(candidate.nodeId)) {
      addSemanticWarning(state.collector, `Completeness candidate ${candidate.nodeId} was not resolved by AO.`);
    }
  }
}

function buildQualityResult(state, input, candidateById) {
  return {
    windowId: input.windowId,
    windowHeader: state.windowHeader,
    issues: state.issues,
    warnings: state.warnings,
    revisions: state.revisions,
    acceptedNodeIds: [...state.acceptedNodeIds],
    acceptances: state.acceptances,
    passedChecks: state.passedChecks,
    failedChecks: state.failedChecks,
    notes: state.notes,
    dispositions: Object.fromEntries(state.dispositions),
    unresolvedNodeIds: (input.candidates || [])
      .filter((candidate) => !state.dispositions.has(candidate.nodeId))
      .map((candidate) => candidate.nodeId),
    semanticResult: finalizeSemanticResult(state.collector, {
      expectedRecords: candidateById.size,
      observedRecords: state.dispositions.size,
    }),
  };
}

function parseQualityWindowOutput(text, input) {
  const candidateById = new Map((input.candidates || []).map((entry) => [entry.nodeId, entry]));
  const state = createQualityParseState();
  const rawLines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex];
    const line = rawLine.trim();
    if (!line) continue;
    let kind = null;
    try {
      const parts = splitEscapedLine(line);
      kind = parts[0];
      dispatchQualityRecord(state, input, candidateById, parts, kind);
    } catch (error) {
      if (kind === "WINDOW") throw error;
      quarantineRecord(state.collector, {
        lineNumber: lineIndex + 1,
        raw: rawLine,
        kind,
        reason: error.message,
      });
    }
  }
  finalizeQualityParse(state, input);
  return buildQualityResult(state, input, candidateById);
}

module.exports = {
  COMPLETENESS_REASONS,
  ISSUE_TYPES,
  SEVERITIES,
  parseQualityWindowOutput,
  splitEscapedLine,
};
