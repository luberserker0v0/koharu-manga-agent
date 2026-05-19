#!/usr/bin/env node

/**
 * Koharu Project Opener Script
 * 負責透過 HTTP API 管理 Koharu 專案：列出、開啟、創建、關閉、檢查。
 */

const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    list: false,
    open: null,
    create: null,
    close: false,
    current: false,
    delete: null,
    apiUrl: config.DEFAULT_BASE_URL,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list") parsed.list = true;
    else if (args[i] === "--open" && args[i + 1]) { parsed.open = args[i + 1]; i++; }
    else if (args[i] === "--create" && args[i + 1]) { parsed.create = args[i + 1]; i++; }
    else if (args[i] === "--close") parsed.close = true;
    else if (args[i] === "--current") parsed.current = true;
    else if (args[i] === "--delete" && args[i + 1]) { parsed.delete = args[i + 1]; i++; }
    else if (args[i] === "--api-url" && args[i + 1]) { parsed.apiUrl = args[i + 1]; i++; }
  }
  return parsed;
}

async function listProjects(apiUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS, { baseUrl: apiUrl });
  if (!res.ok) return { success: false, error: `API 回傳錯誤 (${res.status})` };
  const data = await res.json();
  const projects = data.projects || [];
  if (projects.length === 0) return { success: true, data: [], message: "沒有找到任何專案" };
  return { success: true, data: projects };
}

async function openProject(id, apiUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, {
    method: "PUT",
    baseUrl: apiUrl,
    body: { id },
  });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `開啟失敗 (${res.status}): ${text}` };
  }
  const data = await res.json();
  return { success: true, data };
}

async function createProject(name, apiUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS, {
    method: "POST",
    baseUrl: apiUrl,
    body: { name },
  });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `創建失敗 (${res.status}): ${text}` };
  }
  const data = await res.json();
  return { success: true, data };
}

async function closeProject(apiUrl) {
  const res = await apiFetch(ENDPOINTS.PROJECTS_CURRENT, { method: "DELETE", baseUrl: apiUrl });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `關閉失敗 (${res.status}): ${text}` };
  }
  return { success: true, message: "專案已關閉" };
}

async function getCurrentProject(apiUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: apiUrl });
  if (!res.ok) {
    if (res.status === 404 || res.status === 503) return { success: false, error: "目前沒有開啟任何專案" };
    return { success: false, error: `取得場景失敗 (${res.status})` };
  }
  const data = await res.json();
  return { success: true, data };
}

async function deleteProject(id, apiUrl) {
  const fs = require("fs").promises;
  const path = require("path");

  // 先取得專案列表找到路徑
  const listResult = await listProjects(apiUrl);
  if (!listResult.success) return { success: false, error: "無法取得專案列表" };

  const target = listResult.data.find(p => p.id === id);
  if (!target) return { success: false, error: `找不到專案 "${id}"` };

  // 關閉專案（若正在使用中）
  await closeProject(apiUrl);

  // 遞歸刪除專案資料夾
  const projectPath = target.path;
  try {
    await fs.rm(projectPath, { recursive: true, force: true });
    return { success: true, message: `專案 "${id}" 已從磁碟刪除` };
  } catch (err) {
    return { success: false, error: `刪除失敗: ${err.message}` };
  }
}

function formatProjectTable(projects) {
  const header = "| ID | 專案名稱 | 路徑 | 最後更新時間 |";
  const separator = "|----|---------|------|-------------|";
  const rows = projects.map(p => {
    const date = p.updatedAtMs ? new Date(p.updatedAtMs).toLocaleString("zh-TW") : "N/A";
    return `| \`${p.id}\` | ${p.name} | \`${p.path}\` | ${date} |`;
  });
  return [header, separator, ...rows].join("\n");
}

async function main() {
  const opts = parseArgs();

  if (opts.list) {
    const result = await listProjects(opts.apiUrl);
    if (!result.success) { console.error(JSON.stringify(result)); process.exit(1); }
    if (result.data.length === 0) { console.log(result.message); }
    else { console.log(formatProjectTable(result.data)); }
    process.exit(0);
  }

  if (opts.open) {
    const result = await openProject(opts.open, opts.apiUrl);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.create) {
    const result = await createProject(opts.create, opts.apiUrl);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.close) {
    const result = await closeProject(opts.apiUrl);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.current) {
    const result = await getCurrentProject(opts.apiUrl);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (opts.delete) {
    const result = await deleteProject(opts.delete, opts.apiUrl);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  console.error("請指定操作：--list、--open <id>、--create <name>、--close、--current、--delete <id>");
  process.exit(1);
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: `腳本執行錯誤: ${err.message}` }));
  process.exit(1);
});
