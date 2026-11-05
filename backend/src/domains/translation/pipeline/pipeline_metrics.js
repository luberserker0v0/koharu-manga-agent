const METRICS_BASIS = "backend_observed_event_gaps";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return Math.round(sortedValues[index]);
}

function summarizeStage(engine, spans, measuredMs) {
  const values = spans.map((span) => span.durationMs).sort((a, b) => a - b);
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  const slowest = [...spans].sort((a, b) => b.durationMs - a.durationMs)[0] || null;
  return {
    engine,
    sampleCount: spans.length,
    totalMs,
    percent: measuredMs > 0 ? Number(((totalMs / measuredMs) * 100).toFixed(2)) : 0,
    averageMs: values.length > 0 ? Math.round(totalMs / values.length) : 0,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.round(values[values.length - 1]) : 0,
    slowestPageIndex: slowest?.pageIndex || null,
  };
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function summarizeStages(spans, measuredMs) {
  return [...groupBy(spans, (span) => span.engine).entries()]
    .map(([engine, entries]) => summarizeStage(engine, entries, measuredMs))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function summarizePage(pageIndex, spans, eventCount) {
  const totalMs = spans.reduce((sum, span) => sum + span.durationMs, 0);
  const slowest = [...spans].sort((a, b) => b.durationMs - a.durationMs)[0] || null;
  return {
    pageIndex,
    eventCount,
    observedMs: Math.round(totalMs),
    slowestEngine: slowest?.engine || null,
    slowestEngineMs: slowest ? Math.round(slowest.durationMs) : 0,
  };
}

function summarizePages(spans, pageEventCounts) {
  const pageGroups = groupBy(spans.filter((span) => span.pageIndex !== null), (span) => span.pageIndex);
  const pages = new Set([...pageGroups.keys(), ...pageEventCounts.keys()]);
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => summarizePage(page, pageGroups.get(page) || [], pageEventCounts.get(page) || 0));
}

function publicSpan(span) {
  return {
    pageIndex: span.pageIndex,
    engine: span.engine,
    source: span.source,
    durationMs: Math.round(span.durationMs),
    startedAt: new Date(span.startedAt).toISOString(),
    endedAt: new Date(span.endedAt).toISOString(),
  };
}

function buildSnapshot(progress, observedAt) {
  const telemetry = progress?.telemetry || {};
  const source = typeof telemetry.source === "string" ? telemetry.source : "unknown";
  return {
    observedAt,
    pageIndex: finiteNumber(progress?.currentPageIndex),
    engine: typeof progress?.engine === "string" && progress.engine ? progress.engine : "unknown",
    source,
    signature: JSON.stringify([source, progress?.currentPageIndex, progress?.engine, progress?.status, progress?.progress]),
  };
}

class PipelineMetricsCollector {
  constructor(options = {}) {
    this.clock = options.clock || (() => Date.now());
    this.operationId = options.operationId || null;
    this.translationTarget = options.translationTarget || null;
    this.generationSettings = options.generationSettings || null;
    this.lmStudio = options.lmStudio || null;
    this.systemPrompt = options.systemPrompt || null;
    this.pipelineProfile = options.pipelineProfile || null;
    this.startedAt = finiteNumber(options.startedAt) ?? this.clock();
    this.previous = null;
    this.firstEventAt = null;
    this.eventCount = 0;
    this.duplicateEventCount = 0;
    this.spans = [];
    this.pageEventCounts = new Map();
    this.sourceCounts = new Map();
    this.result = null;
  }

  observe(progress) {
    const observedAt = this.clock();
    const snapshot = buildSnapshot(progress, observedAt);
    this.eventCount += 1;
    this.firstEventAt ??= observedAt;
    this.increment(this.sourceCounts, snapshot.source);
    if (snapshot.pageIndex !== null) this.increment(this.pageEventCounts, snapshot.pageIndex);
    if (snapshot.signature === this.previous?.signature) {
      this.duplicateEventCount += 1;
      return;
    }
    if (this.previous) this.addSpan(this.previous, observedAt);
    this.previous = snapshot;
  }

  increment(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  addSpan(snapshot, endedAt) {
    const durationMs = Math.max(0, endedAt - snapshot.observedAt);
    this.spans.push({
      pageIndex: snapshot.pageIndex,
      engine: snapshot.engine,
      source: snapshot.source,
      durationMs,
      startedAt: snapshot.observedAt,
      endedAt,
    });
  }

  setExecutionMetadata({ generationSettings = null, lmStudio = null }) {
    this.generationSettings = generationSettings;
    this.lmStudio = lmStudio;
    if (this.result) {
      this.result.generationSettings = generationSettings;
      this.result.lmStudio = lmStudio;
    }
  }

  complete(options = {}) {
    if (this.result) return this.result;
    const completedAt = this.clock();
    if (this.previous) this.addSpan(this.previous, completedAt);
    const measuredMs = this.spans.reduce((sum, span) => sum + span.durationMs, 0);
    this.result = this.buildResult(options, completedAt, measuredMs);
    return this.result;
  }

  buildResult(options, completedAt, measuredMs) {
    return {
      schemaVersion: 1,
      measurementBasis: METRICS_BASIS,
      operationId: this.operationId,
      status: options.status || "completed",
      errorCode: options.errorCode || null,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - this.startedAt),
      firstEventDelayMs: this.firstEventAt === null ? null : Math.max(0, this.firstEventAt - this.startedAt),
      measuredMs: Math.round(measuredMs),
      eventCount: this.eventCount,
      transitionCount: this.spans.length,
      duplicateEventCount: this.duplicateEventCount,
      sourceCounts: Object.fromEntries(this.sourceCounts),
      translationTarget: this.translationTarget,
      generationSettings: this.generationSettings,
      lmStudio: this.lmStudio,
      systemPrompt: this.systemPrompt,
      pipelineProfile: this.pipelineProfile,
      stages: summarizeStages(this.spans, measuredMs),
      pages: summarizePages(this.spans, this.pageEventCounts),
      slowestSpans: [...this.spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10).map(publicSpan),
      pipeline: options.pipeline || null,
    };
  }
}

module.exports = {
  METRICS_BASIS,
  PipelineMetricsCollector,
  percentile,
};
