import type { GuiJob } from "../../../api/jobs";

const INGESTION_STAGE_LABELS: Record<string, string> = {
  "reference_ingestion": "Ingestion",
  "reference_ingestion.memory": "Load memory",
  "reference_ingestion.ao_start": "Start AO",
  "reference_ingestion.observation": "Observe chapter",
  "reference_ingestion.observation.reused": "Reuse chapter observation",
  "reference_ingestion.observation.completed": "Chapter observation complete",
  "reference_ingestion.terminology_from_observation": "Build terminology evidence",
  "reference_ingestion.story": "Story memory update",
  "reference_ingestion.merge": "Merge knowledge",
  "reference_ingestion.write": "Write artifacts",
  "reference_ingestion.completed": "Completed",
};

function latestIngestionProgress(job: GuiJob) {
  const event = [...(job.events || [])]
    .reverse()
    .find((item) => item.type === "reference_ingestion.progress");
  return event?.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : null;
}

export function displayJobType(type: string) {
  switch (type) {
    case "reference_extraction":
      return "Reference Extraction";
    case "reference_ingestion":
      return "Reference Ingestion";
    case "reference_observation":
      return "Chapter Observation";
    case "reference_bilingual_enrichment":
      return "Bilingual Evidence Enrichment";
    case "translation":
      return "翻譯";
    case "post_edit_export":
      return "後編修匯出";
    default:
      return type;
  }
}

export function selectedJobSummary(job: GuiJob | null) {
  if (!job) {
    return [];
  }

  const items: Array<{ label: string; value: string }> = [];
  if (job.stage) {
    const progress = latestIngestionProgress(job);
    const batchDetail = Number(progress?.batches || 0) > 0
      ? ` ${String(progress?.batch || 0)}/${String(progress?.batches)}`
      : "";
    const percentDetail = Number.isFinite(Number(progress?.percent))
      ? ` (${String(progress?.percent)}%)`
      : "";
    items.push({
      label: "Current stage",
      value: `${INGESTION_STAGE_LABELS[job.stage] || job.stage}${batchDetail}${percentDetail}`,
    });
  }
  if (typeof job.payload.translatorLabel === "string" && job.payload.translatorLabel) {
    items.push({ label: "譯者", value: job.payload.translatorLabel });
  } else if (typeof job.payload.translatorId === "string" && job.payload.translatorId) {
    items.push({ label: "譯者 ID", value: job.payload.translatorId });
  }
  if (typeof job.payload.translator === "string" && job.payload.translator) {
    items.push({ label: "譯者", value: job.payload.translator });
  }
  if (!job.result || typeof job.result !== "object") {
    return items;
  }

  const result = job.result as Record<string, unknown>;

  if (typeof result.manifestLabel === "string" && result.manifestLabel) {
    items.push({ label: "Reference", value: result.manifestLabel });
  }
  if (typeof result.mangaId === "string" && result.mangaId) {
    items.push({ label: "漫畫 ID", value: result.mangaId });
  }
  if (typeof result.chapterId === "string" && result.chapterId) {
    items.push({ label: "章節 ID", value: result.chapterId });
  }
  if (typeof job.payload.chapterTitle === "string" && job.payload.chapterTitle) {
    items.push({ label: "章節標題", value: job.payload.chapterTitle });
  }
  if (typeof result.translatorId === "string" && result.translatorId) {
    items.push({ label: "譯者 ID", value: result.translatorId });
  }
  if (
    result.candidateSummary &&
    typeof result.candidateSummary === "object" &&
    result.candidateSummary !== null
  ) {
    const candidateSummary = result.candidateSummary as Record<string, unknown>;
    items.push({
      label: "摘要",
      value: "專有名詞 " + String(candidateSummary.terminology || 0) + " / 角色 " + String(candidateSummary.characters || 0),
    });
  }
  if (job.type === "reference_ingestion") {
    items.push({
      label: "Reference 用途",
      value:
        [
          job.payload.useForTerminology === false ? null : "專有名詞",
          job.payload.useForStyle === false ? null : "翻譯風格",
        ]
          .filter(Boolean)
          .join(" + ") || "未設定",
    });
  }
  if (typeof result.systemPrompt === "string" && result.systemPrompt.trim()) {
    items.push({
      label: "系統 Prompt",
      value: result.systemPrompt.trim().slice(0, 120),
    });
  }
  return items;
}

export function ingestionResultSummary(job: GuiJob | null) {
  if (!job || job.type !== "reference_ingestion" || !job.result || typeof job.result !== "object") {
    return null;
  }

  const result = job.result as Record<string, unknown>;
  const candidateSummary =
    result.candidateSummary && typeof result.candidateSummary === "object"
      ? (result.candidateSummary as Record<string, unknown>)
      : null;

  return {
    terminology: Number(candidateSummary?.terminology || 0),
    characters: Number(candidateSummary?.characters || 0),
    candidateTerms: Number(candidateSummary?.candidateTerms || 0),
    candidateCharacters: Number(candidateSummary?.candidateCharacters || 0),
    manifestLabel: typeof result.manifestLabel === "string" ? result.manifestLabel : null,
  };
}
