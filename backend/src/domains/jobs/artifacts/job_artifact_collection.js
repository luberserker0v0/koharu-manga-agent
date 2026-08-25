const fs = require("fs");
const path = require("path");

const { paths } = require("../../../config");

function collectWorkspaceManifestArtifacts(jobId) {
  const jobWorkspaceRoot = path.join(paths.workspaceRoot, jobId);
  if (!fs.existsSync(jobWorkspaceRoot)) return [];

  const collected = [];
  const stack = [jobWorkspaceRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.name !== "import_manifest.json" && entry.name !== "export_manifest.json") continue;

      const [stage] = path.relative(jobWorkspaceRoot, entryPath).split(path.sep);
      collected.push({
        kind: entry.name === "import_manifest.json" ? "workspace_import_manifest" : "workspace_export_manifest",
        path: entryPath,
        metadata: { stage: stage || null, fileName: entry.name },
      });
    }
  }

  return collected.sort((left, right) => left.path.localeCompare(right.path));
}

function collectQualityCheckpoints(store, jobs) {
  const qualityCheckpointPaths = [];
  const qualityObservationCheckpointPaths = [];

  for (const job of jobs || []) {
    for (const event of store.getEvents(job.id) || []) {
      const checkpointPath = event.payload?.checkpointPath;
      if (typeof checkpointPath !== "string" || !fs.existsSync(checkpointPath)) continue;
      if (["quality.window.completed", "quality.window.reused"].includes(event.type)) {
        qualityCheckpointPaths.push(checkpointPath);
      }
      if (["quality_observation.window_completed", "quality_observation.window_reused"].includes(event.type)) {
        qualityObservationCheckpointPaths.push(checkpointPath);
      }
    }
  }

  return {
    qualityCheckpointPaths: [...new Set(qualityCheckpointPaths)],
    qualityObservationCheckpointPaths: [...new Set(qualityObservationCheckpointPaths)],
  };
}

module.exports = { collectQualityCheckpoints, collectWorkspaceManifestArtifacts };
