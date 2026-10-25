const AO_ERROR_TYPES = new Set([
  "quota",
  "timeout",
  "transient_network",
  "invalid_output",
  "integrity",
  "persistence",
  "canceled",
  "unknown",
]);

function classifyAoError(error) {
  const message = String(error?.message || error || "");
  const code = String(error?.code || "");
  if (/cancel(?:ed|led)|aborted by user/i.test(message) || code === "AO_CANCELED") return "canceled";
  if (/quota|insufficient.*credit|rate limit|free.*limit|usage limit/i.test(message) || code === "AO_QUOTA")
    return "quota";
  if (
    /timed? out|timeout|did not produce|produced no tokens or message parts/i.test(message) ||
    ["AO_OUTPUT_TIMEOUT", "AO_MODEL_NO_OUTPUT", "ETIMEDOUT"].includes(code)
  )
    return "timeout";
  if (/fetch failed|ECONN|EPIPE|socket|needsRestart=true|\bstopped\b|\b5\d\d\b/i.test(message))
    return "transient_network";
  if (
    /missing .*DONE|missing WINDOW_DONE|missing OBSERVATION_DONE|missing KNOWLEDGE_DONE|AO_OUTPUT_MISSING/i.test(
      message,
    ) ||
    ["AO_OUTPUT_INCOMPLETE", "AO_OUTPUT_MISSING"].includes(code)
  )
    return "invalid_output";
  if (/fingerprint|snapshot.*match|unknown node|artifact not found|requires .* artifact/i.test(message))
    return "integrity";
  if (/SQLITE|database|atomic write|EACCES|ENOSPC|EROFS/i.test(message)) return "persistence";
  return "unknown";
}

function isRetryableAoError(error) {
  return ["timeout", "transient_network"].includes(classifyAoError(error));
}

function isResourceAoError(error) {
  return ["quota", "timeout", "transient_network"].includes(classifyAoError(error));
}

function inferFailureSource(error, stage = "") {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  const normalizedStage = String(stage || "").toLowerCase();
  if (
    code.startsWith("AO_") ||
    /reference_locale_projection|quality|knowledge|observation|bilingual|deep_audit/.test(normalizedStage)
  ) {
    return "ao";
  }
  if (
    code.startsWith("KOHARU_") ||
    /koharu|pipeline|setup_project|monitor_pipeline|export|close_project/.test(normalizedStage) ||
    /Koharu|Start pipeline|Read scene|Create project|Open project|Export failed/i.test(message)
  ) {
    return "koharu";
  }
  if (classifyAoError(error) === "persistence") return "storage";
  if (classifyAoError(error) === "integrity") return "data";
  return "backend";
}

function resolveRecommendedAction(resourceFailureType, failureSource, resumeAvailable) {
  if (resourceFailureType === "quota") return "restore_quota";
  if (failureSource === "ao" && resourceFailureType === "transient_network") return "start_ao_and_retry";
  if (failureSource === "koharu" && resourceFailureType === "transient_network") return "restart_koharu_and_retry";
  if (resumeAvailable) return "resume_checkpoint";
  if (resourceFailureType === "timeout") return "retry_after_timeout";
  if (resourceFailureType === "invalid_output") return "retry_semantic_stage";
  if (resourceFailureType === "persistence") return "check_storage";
  if (resourceFailureType === "integrity") return "inspect_input_artifacts";
  return "inspect_raw_error";
}

function buildRecommendation(resourceFailureType, resumeAvailable) {
  if (resourceFailureType === "quota") return "Restore AO quota, then resume this job.";
  if (resumeAvailable) return "Resume this job from its latest checkpoint.";
  return null;
}

function buildAoFailureDiagnostics(error, extras = {}) {
  const resourceFailureType = classifyAoError(error);
  const failureSource = inferFailureSource(error, extras.stage);
  const resumeAvailable = isResourceAoError(error) && Boolean(extras.checkpointPaths?.length || extras.resumeAvailable);
  const recommendedAction = resolveRecommendedAction(resourceFailureType, failureSource, resumeAvailable);
  return {
    resourceFailureType,
    failureSource,
    failureStage: extras.stage || null,
    failureCode: error?.code || null,
    resumeAvailable,
    failedWindowId: extras.failedWindowId || null,
    checkpointPaths: extras.checkpointPaths || [],
    recommendation: buildRecommendation(resourceFailureType, resumeAvailable),
    recommendedAction,
  };
}

module.exports = {
  AO_ERROR_TYPES,
  buildAoFailureDiagnostics,
  classifyAoError,
  isResourceAoError,
  isRetryableAoError,
  inferFailureSource,
};
