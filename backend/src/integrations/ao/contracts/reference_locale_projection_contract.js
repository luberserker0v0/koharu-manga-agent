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
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("Locale projection confidence must be between 0 and 1.");
  return parsed;
}

function parseReferenceLocaleProjectionOutput(text, input) {
  const terms = new Map((input.terms || []).map((entry) => [entry.entryId, entry]));
  const examples = new Map((input.styleExamples || []).map((entry) => [entry.exampleId, entry]));
  const projectedTerms = [];
  const projectedStyleExamples = [];
  const dispositions = new Set();
  const collector = createSemanticCollector();
  let completed = false;
  const rawLines = String(text || "").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex];
    const line = rawLine.trim();
    if (!line) continue;
    let kind = null;
    try {
      const fields = splitEscapedLine(line);
      kind = fields[0];
      if (completed) throw new Error("PROJECTION_DONE must be final.");
      if (fields[0] === "TERM") {
      if (fields.length !== 5) throw new Error("TERM must contain exactly 5 fields.");
      const [, entryId, targetRendering, confidence, reason] = fields;
      if (!terms.has(entryId) || dispositions.has(`term:${entryId}`)) throw new Error(`Invalid locale TERM ${entryId}.`);
      if (!targetRendering) throw new Error(`Locale TERM ${entryId} is empty.`);
      dispositions.add(`term:${entryId}`);
      projectedTerms.push({ entryId, targetRendering, confidence: parseConfidence(confidence), reason });
      acceptRecord(collector);
      continue;
      }
      if (fields[0] === "STYLE") {
      if (fields.length !== 5) throw new Error("STYLE must contain exactly 5 fields.");
      const [, exampleId, targetText, confidence, reason] = fields;
      if (!examples.has(exampleId) || dispositions.has(`style:${exampleId}`)) throw new Error(`Invalid locale STYLE ${exampleId}.`);
      if (!targetText) throw new Error(`Locale STYLE ${exampleId} is empty.`);
      dispositions.add(`style:${exampleId}`);
      projectedStyleExamples.push({ exampleId, targetText, confidence: parseConfidence(confidence), reason });
      acceptRecord(collector);
      continue;
      }
      if (fields[0] === "PROJECTION_DONE") {
      if (fields.length !== 2 || fields[1] !== input.projectionId) throw new Error("PROJECTION_DONE ID mismatch.");
      completed = true;
      continue;
      }
      throw new Error(`Unknown locale projection record ${fields[0]}.`);
    } catch (error) {
      quarantineRecord(collector, { lineNumber: lineIndex + 1, raw: rawLine, kind, reason: error.message });
    }
  }
  if (!completed) {
    const error = new Error("Locale projection is missing PROJECTION_DONE.");
    error.code = "AO_OUTPUT_INCOMPLETE";
    throw error;
  }
  const expected = terms.size + examples.size;
  const observed = projectedTerms.length + projectedStyleExamples.length;
  if (observed < expected) addSemanticWarning(collector, `Locale projection omitted ${expected - observed} entry or entries; original rendering will be used.`);
  return {
    projectedTerms,
    projectedStyleExamples,
    semanticResult: finalizeSemanticResult(collector, { expectedRecords: expected, observedRecords: observed }),
  };
}

module.exports = { parseReferenceLocaleProjectionOutput };
