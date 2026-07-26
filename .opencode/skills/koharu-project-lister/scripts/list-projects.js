#!/usr/bin/env node

/**
 * Koharu Project Lister Script
 * 負責：
 * 1. 呼叫 Koharu HTTP API 取得所有專案清單
 * 2. 格式化輸出為 JSON 或 Markdown 表格
 */

const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { apiUrl: config.DEFAULT_BASE_URL, format: "json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-url" && args[i + 1]) { parsed.apiUrl = args[i + 1]; i++; }
    else if (args[i] === "--format" && args[i + 1]) { parsed.format = args[i + 1]; i++; }
  }
  return parsed;
}

async function listProjects(apiUrl) {
  try {
    const res = await apiFetch(ENDPOINTS.PROJECTS, { baseUrl: apiUrl });
    if (!res.ok) {
      return { success: false, error: `API 回傳錯誤 (${res.status})` };
    }
    const data = await res.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: `連線失敗: ${err.message}` };
  }
}

function formatAsMarkdown(projects) {
  if (!projects || projects.length === 0) {
    return "目前沒有任何 Koharu 專案。";
  }

  const header = "| ID | 專案名稱 | 路徑 | 最後更新時間 |";
  const separator = "|----|---------|------|-------------|";
  const rows = projects.map(p => {
    const date = new Date(p.updatedAtMs).toLocaleString("zh-TW");
    return `| \`${p.id}\` | ${p.name} | \`${p.path}\` | ${date} |`;
  });

  return [header, separator, ...rows].join("\n");
}

async function main() {
  const args = parseArgs();
  const result = await listProjects(args.apiUrl);

  if (!result.success) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }

  const projects = result.data.projects || [];

  if (args.format === "markdown") {
    console.log(formatAsMarkdown(projects));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: `腳本執行錯誤: ${err.message}` }));
  process.exit(1);
});
