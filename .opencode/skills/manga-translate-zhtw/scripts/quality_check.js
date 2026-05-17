#!/usr/bin/env node

/**
 * quality_check.js
 * 取得場景翻譯資料，供 Agent 進行品質評估與修正。
 *
 * 用法:
 *   node quality_check.js [--base-url http://127.0.0.1:9999]
 *
 * 輸出:
 *   { translations: [...], pages: [...] }  — 供 Agent 呼叫 LLM 評估
 */

const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { baseUrl: config.DEFAULT_BASE_URL };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) opts.baseUrl = args[++i].replace(/\/+$/, "");
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: opts.baseUrl });
  if (!res.ok) { console.error(JSON.stringify({ success: false, error: `取得場景失敗 (${res.status})` })); process.exit(1); }
  const scene = await res.json();
  const pages = scene.scene?.pages || {};
  const allTexts = [];
  const pageList = [];

  for (const [pageId, page] of Object.entries(pages)) {
    pageList.push({ id: pageId, name: page.name });
    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const t = node.kind?.text;
      if (t && t.text && t.translation) {
        allTexts.push({ id: nodeId, pageId, pageName: page.name, original: t.text, translation: t.translation });
      }
    }
  }

  console.log(JSON.stringify({
    success: true,
    data: {
      translations: allTexts,
      pages: pageList,
      totalTranslations: allTexts.length,
      totalPages: pageList.length
    }
  }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ success: false, error: err.message })); process.exit(1); });
