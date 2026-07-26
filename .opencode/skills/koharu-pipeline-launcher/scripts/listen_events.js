#!/usr/bin/env node

/**
 * listen_events.js
 * Listen to Koharu SSE events for a pipeline operation until completion,
 * warning, timeout, or disconnect.
 *
 * Usage:
 *   node listen_events.js --job-id <uuid> [--base-url http://127.0.0.1:9999] [--timeout 600]
 */

const http = require("http");
const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    jobId: null,
    baseUrl: config.DEFAULT_BASE_URL,
    timeout: config.TIMEOUTS.sseListen,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--job-id" && args[i + 1]) {
      opts.jobId = args[++i];
    } else if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    } else if (args[i] === "--timeout" && args[i + 1]) {
      opts.timeout = parseInt(args[++i], 10);
    }
  }

  if (!opts.jobId) {
    console.error("Error: missing required --job-id");
    process.exit(1);
  }

  return opts;
}

function parseSSEEvent(data) {
  try {
    return JSON.parse(data);
  } catch {
    return { raw: data };
  }
}

function formatTimestamp() {
  return new Date().toLocaleString("zh-TW", { hour12: false });
}

function getStepLabel(step) {
  return config.STEP_LABELS[step] || step;
}

function printSummary(stepTracker, finalStatus) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Pipeline summary");
  console.log("=".repeat(60));

  for (const step of Object.keys(stepTracker)) {
    const info = stepTracker[step];
    const label = getStepLabel(step);
    let icon = "-";
    if (info.status === "completed") icon = "[OK]";
    else if (info.status === "failed") icon = "[ERR]";
    else if (info.status === "running") icon = "[RUN]";
    else if (info.status === "skipped") icon = "[SKIP]";

    let detail = "";
    if (info.totalPages > 0) {
      detail = ` (${info.processedPages}/${info.totalPages} pages)`;
    }
    if (info.error) {
      detail += ` | error: ${info.error}`;
    }

    console.log(
      `${icon} ${label}: ${String(info.status).toUpperCase()}${detail}`
    );
  }

  if (finalStatus) {
    console.log("-".repeat(60));
    console.log(`Final status: ${finalStatus}`);
  }

  console.log("=".repeat(60));
}

async function checkJobStatus(baseUrl, jobId) {
  try {
    const res = await apiFetch(ENDPOINTS.OPERATIONS, { baseUrl });
    if (res.ok) {
      const data = await res.json();
      const ops = data.operations || [];
      const op = ops.find((entry) => entry.id === jobId);
      if (op) {
        return { found: true, status: op.status };
      }
      return { found: false, status: "not_found" };
    }
  } catch {
    return { found: false, status: "error" };
  }

  return { found: false, status: "error" };
}

async function getScene(baseUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

function summarizeScene(scene) {
  const pages = scene?.scene?.pages || {};
  let totalPages = 0;
  let translatedNodes = 0;

  for (const page of Object.values(pages)) {
    totalPages += 1;
    for (const node of Object.values(page.nodes || {})) {
      const textNode = node.kind?.text;
      if (textNode?.translation) {
        translatedNodes += 1;
      }
    }
  }

  return {
    totalPages,
    translatedNodes,
  };
}

async function recoverFinishedOperation(baseUrl, jobId, reason) {
  const scene = await getScene(baseUrl);
  const summary = summarizeScene(scene);

  if (summary.translatedNodes > 0) {
    return {
      recovered: true,
      finalStatus: "completed_before_listener_attached",
      stepTracker: {
        translate: {
          status: "completed",
          processedPages: summary.totalPages,
          totalPages: summary.totalPages,
          error: null,
        },
      },
      message: `Recovered operation ${jobId} from scene state after ${reason}.`,
    };
  }

  return {
    recovered: false,
    finalStatus: reason,
    stepTracker: {},
    message: `Unable to recover operation ${jobId} after ${reason}. No translated scene state was found.`,
  };
}

async function finishWithRecovery(baseUrl, jobId, reason, successExitCode = 0) {
  const recovery = await recoverFinishedOperation(baseUrl, jobId, reason);

  console.log(`\n[${formatTimestamp()}] ${recovery.message}`);
  printSummary(recovery.stepTracker, recovery.finalStatus);
  process.exit(recovery.recovered ? successExitCode : 1);
}

async function listenEvents(opts) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const urlObj = new URL(baseUrl);
  const eventPath = ENDPOINTS.EVENTS;

  const statusCheck = await checkJobStatus(baseUrl, opts.jobId);
  if (!statusCheck.found || config.TERMINAL_STATES.includes(statusCheck.status)) {
    await finishWithRecovery(
      baseUrl,
      opts.jobId,
      statusCheck.found ? statusCheck.status : "listener_attached_too_late",
      0
    );
    return;
  }

  const reqOpts = {
    hostname: urlObj.hostname || "127.0.0.1",
    port: urlObj.port || 9999,
    path: eventPath,
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    timeout: opts.timeout * 1000,
  };

  console.log(`[${formatTimestamp()}] Listening to SSE: ${baseUrl}${eventPath}`);
  console.log(`[${formatTimestamp()}] Job ID: ${opts.jobId}`);
  console.log(`[${formatTimestamp()}] Timeout: ${opts.timeout} seconds`);
  console.log("-".repeat(60));

  const stepTracker = {};
  let currentStep = null;
  let finalStatus = null;
  let finished = false;

  const req = http.request(reqOpts, (res) => {
    if (res.statusCode !== 200) {
      console.error(
        `[${formatTimestamp()}] SSE request failed: HTTP ${res.statusCode}`
      );
      process.exit(1);
    }

    let buffer = "";
    let eventType = "";

    res.setEncoding("utf8");

    res.on("data", (chunk) => {
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) {
            continue;
          }

          const data = parseSSEEvent(dataStr);
          const eventJobId = data.id || data.jobId;
          if (eventJobId && eventJobId !== opts.jobId) {
            eventType = "";
            continue;
          }

          const ts = formatTimestamp();

          if (eventType === "jobFinished" || data.event === "jobFinished") {
            console.log(`\n[${ts}] jobFinished`);
            finalStatus = data.status || "finished";

            for (const step of Object.keys(stepTracker)) {
              if (stepTracker[step].status === "running") {
                stepTracker[step].status = "skipped";
              }
            }

            printSummary(stepTracker, finalStatus);
            finished = true;
            res.destroy();
            process.exit(0);
          } else if (
            eventType === "jobWarning" ||
            data.event === "jobWarning"
          ) {
            const step = data.step || currentStep || "unknown";
            console.log(`\n[${ts}] jobWarning`);
            console.log(`[${ts}] Step: ${getStepLabel(step)}`);
            console.log(
              `[${ts}] Message: ${data.message || JSON.stringify(data)}`
            );
            console.log("-".repeat(60));

            if (!stepTracker[step]) {
              stepTracker[step] = {
                status: "failed",
                processedPages: 0,
                totalPages: 0,
                error: null,
              };
            }

            stepTracker[step].status = "failed";
            stepTracker[step].error = data.message || "Unknown warning";
          } else if (
            eventType === "jobProgress" ||
            data.event === "jobProgress"
          ) {
            const step = data.step || "?";
            const pct =
              data.overallPercent != null ? `${data.overallPercent}%` : "N/A";
            const currentPage =
              data.currentPage != null ? data.currentPage + 1 : "?";
            const totalPages = data.totalPages;

            if (step !== currentStep) {
              if (
                currentStep &&
                stepTracker[currentStep] &&
                stepTracker[currentStep].status === "running"
              ) {
                stepTracker[currentStep].status = "completed";
              }

              currentStep = step;
              if (!stepTracker[step]) {
                stepTracker[step] = {
                  status: "running",
                  processedPages: 0,
                  totalPages: totalPages || 0,
                  error: null,
                };
              } else {
                stepTracker[step].status = "running";
              }

              if (totalPages) {
                stepTracker[step].totalPages = totalPages;
              }

              let found = false;
              for (const knownStep of config.KNOWN_STEPS) {
                if (knownStep === step) {
                  found = true;
                } else if (
                  found &&
                  stepTracker[knownStep] &&
                  stepTracker[knownStep].status !== "completed" &&
                  stepTracker[knownStep].status !== "failed"
                ) {
                  stepTracker[knownStep].status = "skipped";
                }
              }
            }

            if (stepTracker[step] && data.currentPage != null) {
              stepTracker[step].processedPages = data.currentPage + 1;
            }

            const pageInfo = totalPages
              ? ` (${currentPage}/${totalPages})`
              : "";
            process.stdout.write(
              `\r[${ts}] Progress: ${pct} | Step: ${getStepLabel(step)}${pageInfo}   `
            );
          } else if (
            eventType === "jobStarted" ||
            data.event === "jobStarted"
          ) {
            console.log(`\n[${ts}] jobStarted: ${data.id || opts.jobId}`);
          } else if (eventType === "snapshot" || data.event === "snapshot") {
            // Ignore snapshots.
          } else {
            console.log(
              `\n[${ts}] ${eventType || data.event || "unknown"}: ${JSON.stringify(
                data
              ).slice(0, 200)}`
            );
          }

          eventType = "";
        } else if (line === "") {
          eventType = "";
        }
      }
    });

    res.on("end", async () => {
      if (!finished) {
        await finishWithRecovery(
          baseUrl,
          opts.jobId,
          finalStatus || "sse_disconnected_before_terminal_event"
        );
      }
    });
  });

  req.on("error", async (err) => {
    console.error(`\n[${formatTimestamp()}] Request error: ${err.message}`);
    await finishWithRecovery(
      baseUrl,
      opts.jobId,
      finalStatus || "sse_request_error"
    );
  });

  req.on("timeout", async () => {
    console.error(`\n[${formatTimestamp()}] Timeout after ${opts.timeout}s`);
    req.destroy();
    await finishWithRecovery(
      baseUrl,
      opts.jobId,
      finalStatus || "timeout"
    );
  });

  req.end();
}

if (require.main === module) {
  const opts = parseArgs();
  listenEvents(opts);
}

module.exports = {
  checkJobStatus,
  getScene,
  listenEvents,
  parseArgs,
  recoverFinishedOperation,
  summarizeScene,
};
