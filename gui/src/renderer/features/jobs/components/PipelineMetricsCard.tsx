import type { GuiJobEvent } from "../../../api/jobs";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
type MetricsRecord = Record<string, unknown>;
type StageMetric = {
  engine: string;
  totalMs: number;
  percent: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};
type SlowSpan = { pageIndex: number | null; engine: string; durationMs: number };
type PipelineMetrics = {
  durationMs: number;
  eventCount: number;
  transitionCount: number;
  sourceCounts: Record<string, number>;
  stages: StageMetric[];
  slowestSpans: SlowSpan[];
  translationTarget: MetricsRecord | null;
  generationSettings: MetricsRecord | null;
  lmStudio: MetricsRecord | null;
  systemPrompt: MetricsRecord | null;
  pipelineProfile: MetricsRecord | null;
};

function asRecord(value: unknown): MetricsRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MetricsRecord : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseStage(value: unknown): StageMetric | null {
  const stage = asRecord(value);
  if (!stage || typeof stage.engine !== "string") return null;
  return { engine: stage.engine, totalMs: numberValue(stage.totalMs), percent: numberValue(stage.percent),
    p50Ms: numberValue(stage.p50Ms), p95Ms: numberValue(stage.p95Ms), maxMs: numberValue(stage.maxMs) };
}

function parseSlowSpan(value: unknown): SlowSpan | null {
  const span = asRecord(value);
  if (!span || typeof span.engine !== "string") return null;
  return { pageIndex: typeof span.pageIndex === "number" ? span.pageIndex : null,
    engine: span.engine, durationMs: numberValue(span.durationMs) };
}

function parseMetrics(value: unknown): PipelineMetrics | null {
  const metrics = asRecord(value);
  if (!metrics || metrics.schemaVersion !== 1) return null;
  const stages = Array.isArray(metrics.stages) ? metrics.stages.map(parseStage).filter(Boolean) as StageMetric[] : [];
  const slowestSpans = Array.isArray(metrics.slowestSpans)
    ? metrics.slowestSpans.map(parseSlowSpan).filter(Boolean) as SlowSpan[] : [];
  const rawSources = asRecord(metrics.sourceCounts) || {};
  const sourceCounts = Object.fromEntries(Object.entries(rawSources).map(([key, count]) => [key, numberValue(count)]));
  return { durationMs: numberValue(metrics.durationMs), eventCount: numberValue(metrics.eventCount),
    transitionCount: numberValue(metrics.transitionCount), sourceCounts, stages, slowestSpans,
    translationTarget: asRecord(metrics.translationTarget), generationSettings: asRecord(metrics.generationSettings),
    lmStudio: asRecord(metrics.lmStudio), systemPrompt: asRecord(metrics.systemPrompt),
    pipelineProfile: asRecord(metrics.pipelineProfile) };
}

function latestMetrics(events: GuiJobEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "pipeline.metrics") return parseMetrics(events[index].payload);
  }
  return null;
}

function formatDuration(milliseconds: number, t: TranslateFn) {
  if (milliseconds < 1000) return t("jobDetail.metrics.durationMs", { value: Math.round(milliseconds) });
  if (milliseconds < 60000) return t("jobDetail.metrics.durationSeconds", { value: (milliseconds / 1000).toFixed(1) });
  return t("jobDetail.metrics.durationMinutes", { value: (milliseconds / 60000).toFixed(1) });
}

function targetLabel(target: MetricsRecord | null, t: TranslateFn) {
  const provider = typeof target?.providerId === "string" ? target.providerId : null;
  const model = typeof target?.modelId === "string" ? target.modelId : null;
  return provider && model ? `${provider} / ${model}` : t("jobDetail.status.notReported");
}

function promptLabel(prompt: MetricsRecord | null, t: TranslateFn) {
  if (prompt?.applied !== true) return t("jobDetail.metrics.promptOmitted");
  const source = typeof prompt.source === "string" ? prompt.source : "unknown";
  const bytes = numberValue(prompt.bytes);
  return t("jobDetail.metrics.promptApplied", { source, bytes });
}

function generationLabel(settings: MetricsRecord | null, t: TranslateFn) {
  if (!settings) return t("jobDetail.status.notReported");
  const temperature = typeof settings.temperature === "number"
    ? settings.temperature.toString() : t("jobDetail.status.notReported");
  const reasoning = asRecord(settings.reasoningCapability);
  const reasoningDefault = typeof reasoning?.default === "string" ? reasoning.default : null;
  const thinking = settings.thinkingEnabled === true
    ? t("jobDetail.metrics.thinkingOn")
    : settings.thinkingEnabled === false
      ? t("jobDetail.metrics.thinkingOff")
      : reasoningDefault ? t("jobDetail.metrics.thinkingCapability", { value: reasoningDefault })
        : t("jobDetail.metrics.thinkingExternal");
  return t("jobDetail.metrics.generationValue", { temperature, thinking });
}

function lmStudioLabel(snapshot: MetricsRecord | null, t: TranslateFn) {
  if (!snapshot || snapshot.available !== true) return t("jobDetail.metrics.lmStudioUnavailable");
  const model = typeof snapshot.modelKey === "string" ? snapshot.modelKey : t("jobDetail.status.notReported");
  const state = snapshot.loaded === true
    ? t("jobDetail.metrics.lmStudioLoaded") : t("jobDetail.metrics.lmStudioNotLoaded");
  return `${model} · ${state}`;
}

function sourceLabel(sourceCounts: Record<string, number>, t: TranslateFn) {
  const entries = Object.entries(sourceCounts);
  if (entries.length === 0) return t("jobDetail.status.notReported");
  return entries.map(([source, count]) => `${source}: ${count}`).join(" · ");
}

function profileLabel(profile: MetricsRecord | null, t: TranslateFn) {
  if (!profile) return t("jobDetail.status.notReported");
  const id = typeof profile.id === "string" ? profile.id : t("jobDetail.status.notReported");
  const engines = asRecord(profile.engines);
  const clean = typeof engines?.clean === "string" ? engines.clean : t("jobDetail.status.notReported");
  return `${id} · ${clean}`;
}

function OverviewMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="overview-card"><span className="overview-card-label">{label}</span>
    <strong className="overview-card-value">{value}</strong></div>;
}

function StageMetricItem({ stage, t }: { stage: StageMetric; t: TranslateFn }) {
  return <div className="overview-card"><span className="overview-card-label">{stage.engine}</span>
    <strong className="overview-card-value">{formatDuration(stage.totalMs, t)} · {stage.percent.toFixed(1)}%</strong>
    <span className="muted-text">{t("jobDetail.metrics.stageDistribution", {
      p50: formatDuration(stage.p50Ms, t), p95: formatDuration(stage.p95Ms, t), max: formatDuration(stage.maxMs, t),
    })}</span></div>;
}

function SlowSpanItem({ span, t }: { span: SlowSpan; t: TranslateFn }) {
  const page = span.pageIndex ?? t("jobDetail.status.notReported");
  return <li>{t("jobDetail.metrics.slowSpan", {
    page, engine: span.engine, duration: formatDuration(span.durationMs, t),
  })}</li>;
}

export function PipelineMetricsCard({ events, t }: { events: GuiJobEvent[]; t: TranslateFn }) {
  const metrics = latestMetrics(events);
  if (!metrics) return null;
  return <article className="card">
    <h2>{t("jobDetail.metrics.title")}</h2>
    <p className="muted-text">{t("jobDetail.metrics.basis")}</p>
    <div className="overview-card-grid">
      <OverviewMetric label={t("jobDetail.metrics.totalDuration")} value={formatDuration(metrics.durationMs, t)} />
      <OverviewMetric label={t("jobDetail.metrics.events")} value={`${metrics.eventCount} / ${metrics.transitionCount}`} />
      <OverviewMetric label={t("jobDetail.metrics.sources")} value={sourceLabel(metrics.sourceCounts, t)} />
      <OverviewMetric label={t("jobDetail.metrics.target")} value={targetLabel(metrics.translationTarget, t)} />
      <OverviewMetric label={t("jobDetail.metrics.generation")}
        value={generationLabel(metrics.generationSettings, t)} />
      <OverviewMetric label={t("jobDetail.metrics.lmStudio")}
        value={lmStudioLabel(metrics.lmStudio, t)} />
      <OverviewMetric label={t("jobDetail.metrics.prompt")} value={promptLabel(metrics.systemPrompt, t)} />
      <OverviewMetric label={t("jobDetail.metrics.pipelineProfile")}
        value={profileLabel(metrics.pipelineProfile, t)} />
    </div>
    <h3>{t("jobDetail.metrics.stageTitle")}</h3>
    <div className="overview-card-grid">{metrics.stages.slice(0, 8).map((stage) =>
      <StageMetricItem key={stage.engine} stage={stage} t={t} />)}</div>
    <h3>{t("jobDetail.metrics.slowestTitle")}</h3>
    <ul className="compact-list">{metrics.slowestSpans.slice(0, 5).map((span, index) =>
      <SlowSpanItem key={`${span.pageIndex}-${span.engine}-${index}`} span={span} t={t} />)}</ul>
  </article>;
}
