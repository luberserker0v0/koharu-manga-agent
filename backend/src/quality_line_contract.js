const ISSUE_TYPES = new Set([
  "glossary_consistency", "locked_term_preservation", "context_accuracy",
  "speaker_voice_consistency", "register_consistency", "punctuation_consistency",
  "readability_fluency", "ambiguity_control", "translation_accuracy",
  "sequence_alignment", "translation_completeness",
]);
const SEVERITIES = new Set(["low", "medium", "high"]);
const COMPLETENESS_REASONS = new Set([
  "translation_missing",
  "source_target_identity",
]);

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
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} confidence must be between 0 and 1.`);
  return parsed;
}

function parseQualityWindowOutput(text, input) {
  const candidateById = new Map((input.candidates || []).map((entry) => [entry.nodeId, entry]));
  const issues = [];
  const warnings = [];
  const revisions = [];
  const passedChecks = [];
  const failedChecks = [];
  const notes = [];
  let completed = false;
  const dispositions = new Map();
  const acceptedNodeIds = new Set();
  const acceptances = [];
  let windowHeader = null;

  function setDisposition(nodeId, disposition, recordKind) {
    const existing = dispositions.get(nodeId);
    if (existing && existing !== disposition) {
      throw new Error(
        `${recordKind} for ${nodeId} conflicts with existing ${existing} disposition.`
      );
    }
    dispositions.set(nodeId, disposition);
  }

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = splitEscapedLine(line);
    const kind = parts[0];
    if (completed) throw new Error("WINDOW_DONE must be the final non-empty record.");
    if (kind === "WINDOW") {
      if (parts.length !== 6) throw new Error("WINDOW must contain exactly 6 fields.");
      if (windowHeader) throw new Error("Quality output contains more than one WINDOW header.");
      if (issues.length || warnings.length || revisions.length || acceptances.length || passedChecks.length || failedChecks.length || notes.length || completed) {
        throw new Error("WINDOW must be the first non-empty record.");
      }
      const [, windowId, projectionFingerprint, translationMemoryFingerprint, sourceLanguage, targetLanguage] = parts;
      const expected = {
        windowId: input.windowId,
        projectionFingerprint: input.projectionFingerprint,
        translationMemoryFingerprint: input.translationMemoryFingerprint,
        sourceLanguage: input.languages?.sourceLanguage,
        targetLanguage: input.languages?.targetLanguage,
      };
      const actual = { windowId, projectionFingerprint, translationMemoryFingerprint, sourceLanguage, targetLanguage };
      for (const [field, expectedValue] of Object.entries(expected)) {
        if (expectedValue != null && String(expectedValue) !== actual[field]) {
          throw new Error(`WINDOW ${field} does not match the quality input.`);
        }
      }
      windowHeader = actual;
      continue;
    }
    if (kind === "ISSUE" || kind === "WARNING") {
      if (parts.length !== 7) throw new Error(`${kind} must contain exactly 7 fields.`);
      const [, nodeId, type, severity, confidenceText, message, disposition] = parts;
      if (!candidateById.has(nodeId)) throw new Error(`${kind} references unknown node ${nodeId}.`);
      if (!ISSUE_TYPES.has(type)) throw new Error(`${kind} contains unknown type ${type}.`);
      if (!SEVERITIES.has(severity)) throw new Error(`${kind} contains unknown severity ${severity}.`);
      if (!['keep', 'revise'].includes(disposition)) throw new Error(`${kind} disposition must be keep or revise.`);
      setDisposition(nodeId, disposition, kind);
      (kind === "ISSUE" ? issues : warnings).push({
        type, severity, confidence: confidence(confidenceText, kind), nodeId,
        pageName: candidateById.get(nodeId).pageName, message,
      });
      continue;
    }
    if (kind === "REVISION") {
      if (parts.length !== 6) throw new Error("REVISION must contain exactly 6 fields.");
      const [, nodeId, type, confidenceText, revisedTranslation, reason] = parts;
      const candidate = candidateById.get(nodeId);
      if (!candidate) throw new Error(`REVISION references unknown node ${nodeId}.`);
      if (!ISSUE_TYPES.has(type)) throw new Error(`REVISION contains unknown type ${type}.`);
      if (!revisedTranslation) throw new Error(`REVISION for ${nodeId} has an empty translation.`);
      if (revisions.some((entry) => entry.nodeId === nodeId)) throw new Error(`Duplicate REVISION for ${nodeId}.`);
      for (const reasonEntry of candidate.reasons || []) {
        if (reasonEntry.type !== "locked_term") continue;
        const canonical = reasonEntry.evidence?.canonicalTranslation;
        if (canonical && !revisedTranslation.includes(canonical)) throw new Error(`REVISION for ${nodeId} breaks locked term ${canonical}.`);
      }
      revisions.push({
        nodeId, pageName: candidate.pageName, original: candidate.original,
        currentTranslation: candidate.currentTranslation, revisedTranslation,
        reasonType: type, confidence: confidence(confidenceText, "REVISION"), reason,
      });
      setDisposition(nodeId, "revise", "REVISION");
      continue;
    }
    if (kind === "ACCEPT") {
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
      if (acceptedNodeIds.has(nodeId)) throw new Error(`Duplicate ACCEPT for ${nodeId}.`);
      acceptedNodeIds.add(nodeId);
      acceptances.push({ nodeId, checkName, reason });
      setDisposition(nodeId, "accept", "ACCEPT");
      continue;
    }
    if (kind === "PASS" || kind === "FAIL") {
      if (parts.length !== 2 || !parts[1]) throw new Error(`${kind} must contain one check name.`);
      (kind === "PASS" ? passedChecks : failedChecks).push(parts[1]);
      continue;
    }
    if (kind === "NOTES") {
      notes.push(parts.slice(1).join(" | "));
      continue;
    }
    if (kind === "WINDOW_DONE") {
      if (parts.length !== 2) throw new Error("WINDOW_DONE must contain exactly 2 fields.");
      if (parts[1] !== input.windowId) throw new Error(`WINDOW_DONE does not match ${input.windowId}.`);
      completed = true;
      continue;
    }
    throw new Error(`Unknown quality output record ${kind}.`);
  }
  if (!completed) throw new Error(`Quality output is missing WINDOW_DONE|${input.windowId}.`);
  const revisedNodeIds = new Set(revisions.map((entry) => entry.nodeId));
  for (const nodeId of acceptedNodeIds) {
    if (revisedNodeIds.has(nodeId)) {
      throw new Error(`Completeness candidate ${nodeId} cannot contain both REVISION and ACCEPT.`);
    }
  }
  for (const candidate of input.candidates || []) {
    if (!(candidate.reasons || []).some((entry) => COMPLETENESS_REASONS.has(entry.type))) continue;
    if (!revisedNodeIds.has(candidate.nodeId) && !acceptedNodeIds.has(candidate.nodeId)) {
      throw new Error(
        `Completeness candidate ${candidate.nodeId} requires REVISION or ACCEPT.`
      );
    }
  }
  return {
    windowId: input.windowId,
    windowHeader,
    issues,
    warnings,
    revisions,
    acceptedNodeIds: [...acceptedNodeIds],
    acceptances,
    passedChecks,
    failedChecks,
    notes,
    dispositions: Object.fromEntries(dispositions),
  };
}

module.exports = { COMPLETENESS_REASONS, ISSUE_TYPES, SEVERITIES, parseQualityWindowOutput, splitEscapedLine };
