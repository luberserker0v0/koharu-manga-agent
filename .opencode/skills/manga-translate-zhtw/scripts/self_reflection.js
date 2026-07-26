#!/usr/bin/env node

/**
 * self_reflection.js
 * 比對新翻譯與歷史翻譯，識別風格漂移，生成一致性報告。
 *
 * 用法:
 *   node self_reflection.js [--kb ./knowledge_base/self/my-manga.json] [--base-url http://127.0.0.1:9999]
 */

const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { baseUrl: config.DEFAULT_BASE_URL, kb: config.PATHS.KNOWLEDGE_BASE };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) opts.baseUrl = args[++i].replace(/\/+$/, "");
    else if (args[i] === "--kb" && args[i + 1]) opts.kb = args[++i];
  }
  return opts;
}

async function getScene(baseUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  if (!res.ok) throw new Error(`取得場景失敗 (${res.status})`);
  return res.json();
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.kb)) {
    console.error(JSON.stringify({ success: false, error: "知識庫不存在" }));
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(opts.kb, "utf-8"));
  const historyPairs = kb.translation_pairs || [];
  const historyMap = new Map(historyPairs.map(p => [p.original, p.translation]));

  console.error("🔍 正在比對翻譯一致性...");

  try {
    const scene = await getScene(opts.baseUrl);
    const pages = scene.scene?.pages || {};
    const currentPairs = [];

    for (const [pageId, page] of Object.entries(pages)) {
      for (const [nodeId, node] of Object.entries(page.nodes || {})) {
        const t = node.kind?.text;
        if (t && t.text && t.translation) {
          currentPairs.push({ original: t.text, translation: t.translation, pageName: page.name });
        }
      }
    }

    const inconsistencies = [];
    let consistentCount = 0;

    for (const current of currentPairs) {
      const historical = historyMap.get(current.original);
      if (historical && historical !== current.translation) {
        inconsistencies.push({
          original: current.original,
          historical: historical,
          current: current.translation,
          pageName: current.pageName,
        });
      } else if (historical) {
        consistentCount++;
      }
    }

    const total = currentPairs.length;
    const consistencyRate = total > 0 ? ((consistentCount / total) * 100).toFixed(1) : 0;

    const report = {
      timestamp: new Date().toISOString(),
      totalTranslations: total,
      consistent: consistentCount,
      inconsistent: inconsistencies.length,
      consistencyRate: `${consistencyRate}%`,
      inconsistencies,
    };

    console.log(JSON.stringify(report, null, 2));

    console.error("\n🔍 自我反思報告");
    console.error("═".repeat(50));
    console.error(`📊 翻譯一致性: ${consistencyRate}%`);
    console.error(`✅ 一致: ${consistentCount} 筆`);
    console.error(`⚠️  不一致: ${inconsistencies.length} 筆`);

    if (inconsistencies.length > 0) {
      console.error("\n⚠️  發現譯法不一致：");
      for (const item of inconsistencies) {
        console.error(`  原文: ${item.original}`);
        console.error(`  歷史: ${item.historical}`);
        console.error(`  本次: ${item.current}`);
        console.error("─".repeat(40));
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
