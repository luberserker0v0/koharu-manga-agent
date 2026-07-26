const { splitEscapedLine } = require("./quality_line_contract");

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
  let completed = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = splitEscapedLine(line);
    if (completed) throw new Error("PROJECTION_DONE must be final.");
    if (fields[0] === "TERM") {
      if (fields.length !== 5) throw new Error("TERM must contain exactly 5 fields.");
      const [, entryId, targetRendering, confidence, reason] = fields;
      if (!terms.has(entryId) || dispositions.has(`term:${entryId}`)) throw new Error(`Invalid locale TERM ${entryId}.`);
      if (!targetRendering) throw new Error(`Locale TERM ${entryId} is empty.`);
      dispositions.add(`term:${entryId}`);
      projectedTerms.push({ entryId, targetRendering, confidence: parseConfidence(confidence), reason });
      continue;
    }
    if (fields[0] === "STYLE") {
      if (fields.length !== 5) throw new Error("STYLE must contain exactly 5 fields.");
      const [, exampleId, targetText, confidence, reason] = fields;
      if (!examples.has(exampleId) || dispositions.has(`style:${exampleId}`)) throw new Error(`Invalid locale STYLE ${exampleId}.`);
      if (!targetText) throw new Error(`Locale STYLE ${exampleId} is empty.`);
      dispositions.add(`style:${exampleId}`);
      projectedStyleExamples.push({ exampleId, targetText, confidence: parseConfidence(confidence), reason });
      continue;
    }
    if (fields[0] === "PROJECTION_DONE") {
      if (fields.length !== 2 || fields[1] !== input.projectionId) throw new Error("PROJECTION_DONE ID mismatch.");
      completed = true;
      continue;
    }
    throw new Error(`Unknown locale projection record ${fields[0]}.`);
  }
  if (!completed) throw new Error("Locale projection is missing PROJECTION_DONE.");
  if (projectedTerms.length !== terms.size || projectedStyleExamples.length !== examples.size) {
    throw new Error("Locale projection did not cover every supplied entry exactly once.");
  }
  return { projectedTerms, projectedStyleExamples };
}

module.exports = { parseReferenceLocaleProjectionOutput };
