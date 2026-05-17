#!/usr/bin/env node

/**
 * listen_events.js
 * 監聽 Koharu SSE 事件串流，追蹤各階段進度，直到收到 JobFinished 或 JobWarning 事件。
 *
 * 用法:
 *   node listen_events.js --job-id <uuid> [--base-url http://127.0.0.1:9999] [--timeout 600]
 */

const http = require("http");
const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

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
    console.error("錯誤: 缺少 --job-id 參數");
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
  console.log("\n" + "═".repeat(60));
  console.log("📋 管線執行摘要");
  console.log("═".repeat(60));

  const steps = Object.keys(stepTracker);
  for (const step of steps) {
    const info = stepTracker[step];
    const label = getStepLabel(step);
    let icon;
    if (info.status === "completed") icon = "✅";
    else if (info.status === "failed") icon = "❌";
    else if (info.status === "running") icon = "⏳";
    else if (info.status === "skipped") icon = "⏭️";
    else icon = "❓";

    let detail = "";
    if (info.totalPages > 0) {
      detail = " (" + info.processedPages + "/" + info.totalPages + " 頁)";
    }
    if (info.error) {
      detail += " | 錯誤: " + info.error;
    }

    console.log(icon + " " + label + ": " + info.status.toUpperCase() + detail);
  }

  if (finalStatus) {
    console.log("─".repeat(60));
    console.log("最終狀態: " + finalStatus);
  }
  console.log("═".repeat(60));
}

async function checkJobStatus(baseUrl, jobId) {
  try {
    const res = await apiFetch(ENDPOINTS.OPERATIONS, { baseUrl });
    if (res.ok) {
      const data = await res.json();
      const ops = data.operations || [];
      const op = ops.find(o => o.id === jobId);
      if (op) return { found: true, status: op.status };
      return { found: false, status: "not_found" };
    }
  } catch (e) {
    return { found: false, status: "error" };
  }
}

async function listenEvents(opts) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const urlObj = new URL(baseUrl);
  const eventPath = ENDPOINTS.EVENTS;

  const statusCheck = await checkJobStatus(baseUrl, opts.jobId);
  if (!statusCheck.found || config.TERMINAL_STATES.includes(statusCheck.status)) {
    console.log("\n[" + formatTimestamp() + "] ⚠️  管線似乎已經完成 (狀態: " + statusCheck.status + ")");
    console.log("[" + formatTimestamp() + "] 無法顯示進度摘要，因為事件串流已結束。");
    console.log("═".repeat(60));
    process.exit(0);
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

  console.log("[" + formatTimestamp() + "] 連線至 SSE 串流: " + baseUrl + eventPath);
  console.log("[" + formatTimestamp() + "] 過濾 Job ID: " + opts.jobId);
  console.log("[" + formatTimestamp() + "] 超時設定: " + opts.timeout + " 秒");
  console.log("─".repeat(60));

  const stepTracker = {};
  let currentStep = null;
  let totalPages = 0;
  let finalStatus = null;
  let finished = false;

  const req = http.request(reqOpts, (res) => {
    if (res.statusCode !== 200) {
      console.error("[" + formatTimestamp() + "] 連線失敗: HTTP " + res.statusCode);
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
          if (!dataStr) continue;

          const data = parseSSEEvent(dataStr);

          const eventJobId = data.id || data.jobId;
          if (eventJobId && eventJobId !== opts.jobId) {
            eventType = "";
            continue;
          }

          const ts = formatTimestamp();

          if (eventType === "jobFinished" || data.event === "jobFinished") {
            console.log("\n[" + ts + "] ✅ JobFinished");
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
          } else if (eventType === "jobWarning" || data.event === "jobWarning") {
            const step = data.step || currentStep || "unknown";
            console.log("\n[" + ts + "] ⚠️  JobWarning");
            console.log("[" + ts + "] 步驟: " + getStepLabel(step));
            console.log("[" + ts + "] 警告: " + (data.message || JSON.stringify(data)));
            console.log("─".repeat(60));

            if (!stepTracker[step]) {
              stepTracker[step] = { status: "failed", processedPages: 0, totalPages: 0, error: null };
            }
            stepTracker[step].status = "failed";
            stepTracker[step].error = data.message || "未知錯誤";
          } else if (eventType === "jobProgress" || data.event === "jobProgress") {
            const step = data.step || "?";
            const pct = data.overallPercent != null ? data.overallPercent + "%" : "N/A";
            const currentPage = data.currentPage != null ? data.currentPage + 1 : "?";
            const tp = data.totalPages;
            if (tp && !totalPages) totalPages = tp;

            if (step !== currentStep) {
              if (currentStep && stepTracker[currentStep] && stepTracker[currentStep].status === "running") {
                stepTracker[currentStep].status = "completed";
              }

              currentStep = step;
              if (!stepTracker[step]) {
                stepTracker[step] = { status: "running", processedPages: 0, totalPages: tp || 0, error: null };
              } else {
                stepTracker[step].status = "running";
              }
              if (tp) stepTracker[step].totalPages = tp;

              let found = false;
              for (const ks of config.KNOWN_STEPS) {
                if (ks === step) found = true;
                else if (found && stepTracker[ks] && stepTracker[ks].status !== "completed" && stepTracker[ks].status !== "failed") {
                  stepTracker[ks].status = "skipped";
                }
              }
            }

            if (stepTracker[step] && data.currentPage != null) {
              stepTracker[step].processedPages = data.currentPage + 1;
            }

            const pageInfo = tp ? " (" + currentPage + "/" + tp + ")" : "";
            process.stdout.write("\r[" + ts + "] ⏳ 進度: " + pct + " | 步驟: " + getStepLabel(step) + pageInfo + "   ");
          } else if (eventType === "jobStarted" || data.event === "jobStarted") {
            console.log("\n[" + ts + "] 🚀 JobStarted: " + (data.id || opts.jobId));
          } else if (eventType === "snapshot" || data.event === "snapshot") {
            // skip
          } else {
            console.log("\n[" + ts + "] 📡 " + (eventType || data.event || "unknown") + ": " + JSON.stringify(data).slice(0, 200));
          }
          eventType = "";
        } else if (line === "") {
          eventType = "";
        }
      }
    });

    res.on("end", () => {
      if (!finished) {
        console.log("\n[" + formatTimestamp() + "] 串流已關閉");
        printSummary(stepTracker, finalStatus || "disconnected");
        process.exit(1);
      }
    });
  });

  req.on("error", (err) => {
    console.error("\n[" + formatTimestamp() + "] 連線錯誤: " + err.message);
    printSummary(stepTracker, finalStatus || "error");
    process.exit(1);
  });

  req.on("timeout", () => {
    console.error("\n[" + formatTimestamp() + "] ⏱️  超時 (" + opts.timeout + "s)");
    req.destroy();
    printSummary(stepTracker, finalStatus || "timeout");
    process.exit(1);
  });

  req.end();
}

const opts = parseArgs();
listenEvents(opts);
