#!/usr/bin/env node

/**
 * upload_pages.js
 * 透過 Koharu HTTP API 上傳圖片頁面到當前專案。
 *
 * 用法:
 *   node upload_pages.js --paths "file1.jpg,file2.png" [--base-url http://127.0.0.1:9999] [--replace]
 */

const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");
const { apiFetch, ENDPOINTS, buildUrl } = require("../../shared/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    paths: null,
    replace: false,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--paths" && args[i + 1]) {
      opts.paths = args[++i].split(",").map((s) => s.trim());
    } else if (args[i] === "--replace") {
      opts.replace = true;
    } else if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    }
  }

  if (!opts.paths || opts.paths.length === 0) {
    console.error("錯誤: 缺少 --paths 參數（以逗號分隔的圖片路徑）");
    process.exit(1);
  }

  return opts;
}

async function getExistingPages(baseUrl) {
  try {
    const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
    if (!res.ok) return [];
    const scene = await res.json();
    const pages = scene.scene?.pages || {};
    const result = [];
    for (const [pageId, page] of Object.entries(pages)) {
      if (page.name) result.push({ id: pageId, name: page.name });
    }
    return result;
  } catch {
    return [];
  }
}

async function uploadPages(opts) {
  const validFiles = [];
  for (const p of opts.paths) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      console.error(`警告: 檔案不存在，跳過: ${resolved}`);
      continue;
    }
    validFiles.push(resolved);
  }

  if (validFiles.length === 0) {
    console.error(JSON.stringify({ success: false, error: "沒有有效的檔案路徑" }));
    process.exit(1);
  }

  // 取得現有頁面清單，避免重複上傳
  const existingPages = await getExistingPages(opts.baseUrl);
  const existingNames = new Set(existingPages.map(p => p.name));
  const toUpload = [];
  const skipped = [];

  for (const filePath of validFiles) {
    const fileName = path.basename(filePath);
    if (existingNames.has(fileName) && !opts.replace) {
      skipped.push({ path: filePath, reason: "已存在" });
    } else {
      toUpload.push(filePath);
    }
  }

  if (skipped.length > 0) {
    console.error(JSON.stringify({
      message: `跳過 ${skipped.length} 張已存在的圖片`,
      skipped: skipped.map(s => path.basename(s.path))
    }));
  }

  if (toUpload.length === 0) {
    console.log(JSON.stringify({ success: true, message: "所有圖片已存在，無須上傳", skipped: skipped.map(s => path.basename(s.path)) }));
    process.exit(0);
  }

  const baseUrl = opts.baseUrl;

  // Try /pages/from-paths first (Tauri fast path)
  try {
    const res = await apiFetch(ENDPOINTS.PAGES_FROM_PATHS, {
      method: "POST",
      baseUrl,
      body: { paths: toUpload, replace: opts.replace },
    });

    if (res.ok) {
      const data = await res.json();
      console.log(JSON.stringify({ success: true, data, method: "from-paths", uploaded: toUpload.length, skipped: skipped.map(s => path.basename(s.path)) }));
      process.exit(0);
    }
  } catch {
    // Fall through to multipart upload
  }

  // Fallback: multipart upload to /pages (uses raw fetch to set custom Content-Type)
  const boundary = `----FormBoundary${Date.now()}`;
  const parts = [];

  if (opts.replace) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="replace"\r\n\r\ntrue\r\n`));
  }

  for (const filePath of toUpload) {
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  try {
    const res = await fetch(buildUrl(ENDPOINTS.PAGES, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(JSON.stringify({ success: false, error: `上傳失敗 (${res.status}): ${text}` }));
      process.exit(1);
    }

    const data = await res.json();
    console.log(JSON.stringify({ success: true, data, method: "multipart", uploaded: toUpload.length, skipped: skipped.map(s => path.basename(s.path)) }));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: `連線失敗: ${err.message}` }));
    process.exit(1);
  }
}

const opts = parseArgs();
uploadPages(opts);
