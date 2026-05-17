#!/usr/bin/env node

/**
 * delete_page.js
 * 刪除指定頁面。
 *
 * 用法:
 *   node delete_page.js --page-id <uuid> [--base-url http://127.0.0.1:9999]
 */

const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

const args = process.argv.slice(2);
let pageId = null;
let baseUrl = config.DEFAULT_BASE_URL;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--page-id" && args[i + 1]) pageId = args[++i];
  else if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i].replace(/\/+$/, "");
}

if (!pageId) {
  console.error(JSON.stringify({ success: false, error: "缺少 --page-id 參數" }));
  process.exit(1);
}

// Get page info first for prev_page/prev_index
apiFetch(ENDPOINTS.SCENE, { baseUrl })
  .then(r => r.json())
  .then(scene => {
    const pages = scene.scene?.pages || {};
    const pageEntries = Object.entries(pages);
    const idx = pageEntries.findIndex(([id]) => id === pageId);
    if (idx === -1) {
      console.error(JSON.stringify({ success: false, error: "找不到頁面" }));
      process.exit(1);
    }
    const [, pageData] = pageEntries[idx];

    const payload = {
      removePage: {
        id: pageId,
        prev_page: pageData,
        prev_index: idx
      }
    };

    return apiFetch(ENDPOINTS.HISTORY_APPLY, {
      method: "POST",
      baseUrl,
      body: payload,
    });
  })
  .then(async res => {
    if (res.ok) {
      console.log(JSON.stringify({ success: true, message: "頁面已刪除" }));
      process.exit(0);
    } else {
      console.error(JSON.stringify({ success: false, error: await res.text() }));
      process.exit(1);
    }
  }).catch(err => {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  });
