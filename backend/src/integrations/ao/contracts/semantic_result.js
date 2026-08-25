const SEMANTIC_OUTCOMES = new Set(["clean", "warnings", "partial"]);

function createSemanticCollector() {
  return {
    acceptedRecords: 0,
    quarantinedRecords: [],
    warnings: [],
  };
}

function quarantineRecord(collector, { lineNumber = null, raw = null, kind = null, reason }) {
  collector.quarantinedRecords.push({ lineNumber, raw, kind, reason: String(reason || "Invalid semantic record.") });
}

function acceptRecord(collector, count = 1) {
  collector.acceptedRecords += count;
}

function addSemanticWarning(collector, warning) {
  if (warning) collector.warnings.push(String(warning));
}

function finalizeSemanticResult(collector, { expectedRecords = null, observedRecords = null } = {}) {
  const quarantinedRecordCount = collector.quarantinedRecords.length;
  const hasCoverageGap = Number.isFinite(expectedRecords) && Number.isFinite(observedRecords)
    ? observedRecords < expectedRecords
    : false;
  const outcome = collector.acceptedRecords === 0 && (quarantinedRecordCount > 0 || collector.warnings.length > 0 || hasCoverageGap)
    ? "partial"
    : quarantinedRecordCount > 0 || collector.warnings.length > 0 || hasCoverageGap
      ? "warnings"
      : "clean";
  return {
    outcome,
    acceptedRecordCount: collector.acceptedRecords,
    quarantinedRecordCount,
    quarantinedRecords: collector.quarantinedRecords,
    warnings: collector.warnings,
    coverage: Number.isFinite(expectedRecords)
      ? {
          expected: expectedRecords,
          observed: Number.isFinite(observedRecords) ? observedRecords : collector.acceptedRecords,
        }
      : null,
  };
}

function mergeSemanticResults(results = []) {
  const valid = results.filter(Boolean);
  const acceptedRecordCount = valid.reduce((sum, result) => sum + (result.acceptedRecordCount || 0), 0);
  const quarantinedRecordCount = valid.reduce((sum, result) => sum + (result.quarantinedRecordCount || 0), 0);
  const warnings = valid.flatMap((result) => result.warnings || []);
  const degradedStages = valid
    .filter((result) => result.outcome && result.outcome !== "clean")
    .map((result) => result.stage)
    .filter(Boolean);
  const outcome = valid.some((result) => result.outcome === "partial")
    ? "partial"
    : valid.some((result) => result.outcome === "warnings") || warnings.length > 0
      ? "warnings"
      : "clean";
  return { outcome, acceptedRecordCount, quarantinedRecordCount, warnings, degradedStages };
}

function assertSemanticOutcome(value) {
  if (!SEMANTIC_OUTCOMES.has(value)) throw new Error(`Unknown semantic outcome ${value}.`);
  return value;
}

function collectSemanticResults(value, results = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return results;
  seen.add(value);
  if (value.semanticResult && typeof value.semanticResult === "object") {
    results.push(value.semanticResult);
    return results;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSemanticResults(entry, results, seen);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "semanticResult") collectSemanticResults(entry, results, seen);
    }
  }
  return results;
}

function summarizeJobOutcome(result) {
  const semanticResults = collectSemanticResults(result);
  return semanticResults.length > 0
    ? mergeSemanticResults(semanticResults)
    : { outcome: "clean", acceptedRecordCount: 0, quarantinedRecordCount: 0, warnings: [], degradedStages: [] };
}

module.exports = {
  SEMANTIC_OUTCOMES,
  acceptRecord,
  addSemanticWarning,
  assertSemanticOutcome,
  createSemanticCollector,
  finalizeSemanticResult,
  mergeSemanticResults,
  quarantineRecord,
  summarizeJobOutcome,
};
