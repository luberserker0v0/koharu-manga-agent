#!/usr/bin/env node

/**
 * export_project.js
 * 透過 Koharu HTTP API 匯出當前專案。
 *
 * 用法:
 *   node export_project.js --format "rendered" --output "./translated/"
 *   node export_project.js --format "psd" --output "./translated/"
 *   node export_project.js --format "khr" --output "./translated/"
 *   node export_project.js --format "inpainted" --output "./translated/"
 *   node export_project.js --format "rendered" --pages "page-id-1,page-id-2" --output "./translated/"
 */

const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    format: config.DEFAULTS.exportFormat,
    pages: null,
    output: config.PATHS.TRANSLATED,
    baseUrl: config.DEFAULT_BASE_URL,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) { opts.format = args[++i]; }
    else if (args[i] === "--pages" && args[i + 1]) { opts.pages = args[++i].split(",").map((s) => s.trim()); }
    else if (args[i] === "--output" && args[i + 1]) { opts.output = args[++i]; }
    else if (args[i] === "--base-url" && args[i + 1]) { opts.baseUrl = args[++i].replace(/\/+$/, ""); }
  }

  if (!opts.format) {
    console.error("錯誤: 缺少 --format 參數（khr, psd, rendered, inpainted）");
    process.exit(1);
  }

  if (!config.VALID_EXPORT_FORMATS.includes(opts.format)) {
    console.error(`錯誤: 無效格式 "${opts.format}"。有效選項: ${config.VALID_EXPORT_FORMATS.join(", ")}`);
    process.exit(1);
  }

  return opts;
}

async function exportProject(opts) {
  const body = { format: opts.format };
  if (opts.pages && opts.pages.length > 0) body.pages = opts.pages;

  try {
    const res = await apiFetch(ENDPOINTS.EXPORT, {
      method: "POST",
      baseUrl: opts.baseUrl,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(JSON.stringify({ success: false, error: `匯出失敗 (${res.status}): ${text}` }));
      process.exit(1);
    }

    const contentType = res.headers.get("content-type") || "";
    const outputDir = path.resolve(opts.output);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
      const ext = opts.format === "khr" ? "khr" : "zip";
      const filename = `export_${Date.now()}.${ext}`;
      const filePath = path.join(outputDir, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(JSON.stringify({
        success: true,
        message: `匯出完成`,
        path: filePath,
        size: buffer.length,
      }));
    } else if (contentType.includes("image/")) {
      const ext = contentType.includes("png") ? "png" : "jpg";
      const filename = `export_${Date.now()}.${ext}`;
      const filePath = path.join(outputDir, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(JSON.stringify({
        success: true,
        message: `匯出完成`,
        path: filePath,
        size: buffer.length,
      }));
    } else {
      const filename = `export_${Date.now()}_${opts.format}`;
      const filePath = path.join(outputDir, filename);
      fs.writeFileSync(filePath, buffer);
      console.log(JSON.stringify({
        success: true,
        message: `匯出完成`,
        path: filePath,
        size: buffer.length,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: `連線失敗: ${err.message}` }));
    process.exit(1);
  }
}

const opts = parseArgs();
exportProject(opts);
