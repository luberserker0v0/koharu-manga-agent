#!/usr/bin/env node

/**
 * clean_logs.js
 * 清理 Subagent 執行日誌。
 *
 * 用法:
 *   node clean_logs.js --list
 *   node clean_logs.js --older-than 7d
 *   node clean_logs.js --subagent pipeline-runner
 *   node clean_logs.js --all
 */

const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");

const LOGS_DIR = config.PATHS.LOGS;
const SUBAGENTS = config.SUBAGENTS;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { list: false, olderThan: null, subagent: null, all: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--list") opts.list = true;
    else if (args[i] === "--older-than" && args[i + 1]) opts.olderThan = args[++i];
    else if (args[i] === "--subagent" && args[i + 1]) opts.subagent = args[++i];
    else if (args[i] === "--all") opts.all = true;
  }
  return opts;
}

function parseDays(str) {
  const match = str.match(/^(\d+)(d|h|m)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "d") return value;
  if (unit === "h") return value / 24;
  if (unit === "m") return value / 30;
  return null;
}

function getLogFiles(subagentFilter = null) {
  const files = [];
  const targets = subagentFilter ? [subagentFilter] : SUBAGENTS;

  for (const sub of targets) {
    const dir = path.join(LOGS_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        const filePath = path.join(dir, entry);
        const stat = fs.statSync(filePath);
        files.push({ path: filePath, subagent: sub, name: entry, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  return files;
}

function listLogs() {
  const files = getLogFiles();
  const stats = {};

  for (const sub of SUBAGENTS) {
    const subFiles = files.filter(f => f.subagent === sub);
    stats[sub] = { count: subFiles.length, totalBytes: subFiles.reduce((sum, f) => sum + f.size, 0) };
  }

  const totalFiles = files.length;
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  console.log(JSON.stringify({
    success: true,
    stats,
    totalFiles,
    totalBytes,
    totalMB: (totalBytes / 1048576).toFixed(2)
  }, null, 2));
}

function cleanLogs(opts) {
  const files = getLogFiles(opts.subagent);
  let toDelete = files;

  if (opts.olderThan) {
    const days = parseDays(opts.olderThan);
    if (days === null) {
      console.error(JSON.stringify({ success: false, error: "無效的時間格式，使用格式如 7d、24h、30d" }));
      process.exit(1);
    }
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    toDelete = files.filter(f => f.mtime < cutoff);
  }

  if (opts.all) {
    toDelete = files;
  }

  if (toDelete.length === 0) {
    console.log(JSON.stringify({ success: true, message: "無符合條件的日誌可清理", deleted: 0, remaining: files.length }));
    process.exit(0);
  }

  let deletedCount = 0;
  let freedBytes = 0;

  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.path);
      deletedCount++;
      freedBytes += file.size;
    } catch (err) {
      console.error("警告: 無法刪除 " + file.path + ": " + err.message);
    }
  }

  const remaining = getLogFiles(opts.subagent).length;

  console.log(JSON.stringify({
    success: true,
    deleted: deletedCount,
    remaining,
    freedBytes,
    freedMB: (freedBytes / 1048576).toFixed(2)
  }, null, 2));
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(LOGS_DIR)) {
    console.log(JSON.stringify({ success: true, message: "日誌目錄不存在，無需清理" }));
    process.exit(0);
  }

  if (opts.list) {
    listLogs();
  } else {
    cleanLogs(opts);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
