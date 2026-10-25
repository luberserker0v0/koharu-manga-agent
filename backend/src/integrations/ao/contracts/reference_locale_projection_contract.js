const { splitEscapedLine } = require("./quality_line_contract");
const {
  acceptRecord,
  addSemanticWarning,
  createSemanticCollector,
  finalizeSemanticResult,
  quarantineRecord,
} = require("./semantic_result");

function parseConfidence(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
    throw new Error("Locale projection confidence must be between 0 and 1.");
  return parsed;
}

function handleTermRecord(fields, terms, dispositions, projectedTerms, collector) {
  if (fields.length !== 5) throw new Error("TERM must contain exactly 5 fields.");
  const [, entryId, targetRendering, confidence, reason] = fields;
  if (!terms.has(entryId) || dispositions.has(`term:${entryId}`)) throw new Error(`Invalid locale TERM ${entryId}.`);
  if (!targetRendering) throw new Error(`Locale TERM ${entryId} is empty.`);
  dispositions.add(`term:${entryId}`);
  projectedTerms.push({
    entryId,
    targetRendering,
    confidence: parseConfidence(confidence),
    reason,
  });
  acceptRecord(collector);
}

function handleStyleRecord(fields, examples, dispositions, projectedStyleExamples, collector) {
  if (fields.length !== 5) throw new Error("STYLE must contain exactly 5 fields.");
  const [, exampleId, targetText, confidence, reason] = fields;
  if (!examples.has(exampleId) || dispositions.has(`style:${exampleId}`))
    throw new Error(`Invalid locale STYLE ${exampleId}.`);
  if (!targetText) throw new Error(`Locale STYLE ${exampleId} is empty.`);
  dispositions.add(`style:${exampleId}`);
  projectedStyleExamples.push({
    exampleId,
    targetText,
    confidence: parseConfidence(confidence),
    reason,
  });
  acceptRecord(collector);
}

function handleProjectionDone(fields, input, state) {
  if (fields.length !== 2 || fields[1] !== input.projectionId) throw new Error("PROJECTION_DONE ID mismatch.");
  state.completed = true;
}

function createProjectionState(input) {
  return {
    terms: new Map((input.terms || []).map((entry) => [entry.entryId, entry])),
    examples: new Map((input.styleExamples || []).map((entry) => [entry.exampleId, entry])),
    projectedTerms: [],
    projectedStyleExamples: [],
    dispositions: new Set(),
    collector: createSemanticCollector(),
    completed: false,
    input,
  };
}

function processProjectionLine(state, rawLine, lineIndex) {
  const line = rawLine.trim();
  if (!line) return;
  let kind = null;
  try {
    const fields = splitEscapedLine(line);
    kind = fields[0];
    if (state.completed) throw new Error("PROJECTION_DONE must be final.");
    if (fields[0] === "TERM") {
      handleTermRecord(fields, state.terms, state.dispositions, state.projectedTerms, state.collector);
      return;
    }
    if (fields[0] === "STYLE") {
      handleStyleRecord(fields, state.examples, state.dispositions, state.projectedStyleExamples, state.collector);
      return;
    }
    if (fields[0] === "PROJECTION_DONE") {
      handleProjectionDone(fields, state.input, state);
      return;
    }
    throw new Error(`Unknown locale projection record ${fields[0]}.`);
  } catch (error) {
    quarantineRecord(state.collector, {
      lineNumber: lineIndex + 1,
      raw: rawLine,
      kind,
      reason: error.message,
    });
  }
}

function processProjectionLines(state, rawLines) {
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    processProjectionLine(state, rawLines[lineIndex], lineIndex);
  }
}

function buildProjectionResult(state) {
  const expected = state.terms.size + state.examples.size;
  const observed = state.projectedTerms.length + state.projectedStyleExamples.length;
  if (observed < expected)
    addSemanticWarning(
      state.collector,
      `Locale projection omitted ${expected - observed} entry or entries; original rendering will be used.`,
    );
  return {
    projectedTerms: state.projectedTerms,
    projectedStyleExamples: state.projectedStyleExamples,
    semanticResult: finalizeSemanticResult(state.collector, {
      expectedRecords: expected,
      observedRecords: observed,
    }),
  };
}

function parseReferenceLocaleProjectionOutput(text, input) {
  const state = createProjectionState(input);
  const rawLines = String(text || "").split(/\r?\n/);
  processProjectionLines(state, rawLines);
  if (!state.completed) {
    const error = new Error("Locale projection is missing PROJECTION_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  return buildProjectionResult(state);
}

module.exports = { parseReferenceLocaleProjectionOutput };
