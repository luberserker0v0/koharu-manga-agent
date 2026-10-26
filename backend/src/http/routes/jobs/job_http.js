const path = require("path");

const INTERNAL_LOCATION_KEY = /(?:path|paths|dir|directory|folder|root)$/i;

function isInternalLocationKey(key, value) {
  const normalized = key.toLowerCase();
  const locationValue = typeof value === "string" || Array.isArray(value);
  return normalized !== "root" && locationValue && INTERNAL_LOCATION_KEY.test(key) && !normalized.endsWith("url");
}

function withoutInternalLocations(value) {
  if (Array.isArray(value)) return value.map(withoutInternalLocations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => !isInternalLocationKey(key, entry))
      .map(([key, entry]) => [key, withoutInternalLocations(entry)]),
  );
}

function publicArtifact(jobId, artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    fileName: path.basename(artifact.path || `artifact-${artifact.id}`),
    contentUrl: `/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${artifact.id}/content`,
    metadata: withoutInternalLocations(artifact.metadata),
    createdAt: artifact.createdAt,
  };
}

function publicArtifacts(jobId, artifacts) {
  return (artifacts || []).map((artifact) => publicArtifact(jobId, artifact));
}

function publicEvent(event) {
  return { ...event, payload: withoutInternalLocations(event.payload) };
}

function publicJob(job) {
  if (!job) return job;
  return {
    ...job,
    payload: withoutInternalLocations(job.payload),
    result: withoutInternalLocations(job.result),
    diagnostics: withoutInternalLocations(job.diagnostics),
    resumeMetadata: withoutInternalLocations(job.resumeMetadata),
    events: (job.events || []).map(publicEvent),
    artifacts: publicArtifacts(job.id, job.artifacts),
    children: job.children?.map(publicJob),
  };
}

function publicJobMessage(message) {
  return {
    ...message,
    payload: withoutInternalLocations(message.payload),
    ...(message.job ? { job: publicJob(message.job) } : {}),
  };
}

module.exports = {
  publicArtifacts,
  publicEvent,
  publicJob,
  publicJobMessage,
  withoutInternalLocations,
};
