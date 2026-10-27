import { useEffect, useRef, useState } from "react";
import { getJobArtifacts, type GuiJob } from "../../../api/jobs";
import { downloadJobArtifact } from "../../../services/desktop_api";
import { subscribeToJobsStream } from "../../../stream/job_stream";

export type ExportDeliveryNotice = {
  tone: "success" | "error";
  fileName: string;
  detail: string;
};

const deliveredJobs = new Set<string>();
const pendingJobs = new Set<string>();

async function deliverExport(job: GuiJob): Promise<ExportDeliveryNotice | null> {
  if (deliveredJobs.has(job.id) || pendingJobs.has(job.id)) return null;
  pendingJobs.add(job.id);
  try {
    const { artifacts } = await getJobArtifacts(job.id);
    const reversed = [...artifacts].reverse();
    const artifact = reversed.find((entry) => entry.kind === "current_chapter_export")
      || reversed.find((entry) => entry.kind === "export");
    if (!artifact) return null;
    const result = await downloadJobArtifact({ jobId: job.id, artifactId: artifact.id });
    deliveredJobs.add(job.id);
    return { tone: "success", fileName: result.fileName, detail: result.path };
  } catch (error) {
    return { tone: "error", fileName: "", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    pendingJobs.delete(job.id);
  }
}

function succeededJobs(message: { type: string; job?: unknown; jobs?: unknown }): GuiJob[] {
  if (message.type === "jobs.snapshot" && Array.isArray(message.jobs)) {
    return (message.jobs as GuiJob[]).filter((job) => job.status === "succeeded");
  }
  const job = message.job as GuiJob | undefined;
  return job?.status === "succeeded" ? [job] : [];
}

export function useExportDelivery() {
  const [notice, setNotice] = useState<ExportDeliveryNotice | null>(null);
  const initialized = useRef(false);
  const completed = useRef(new Set<string>());
  useEffect(() => subscribeToJobsStream({ onEvent: (message) => {
    const jobs = succeededJobs(message);
    if (!initialized.current && message.type === "jobs.snapshot") {
      jobs.forEach((job) => completed.current.add(job.id));
      initialized.current = true;
      return;
    }
    for (const job of jobs) {
      if (completed.current.has(job.id)) continue;
      completed.current.add(job.id);
      void deliverExport(job).then((result) => { if (result) setNotice(result); });
    }
  } }), []);
  return { notice, dismiss: () => setNotice(null) };
}
