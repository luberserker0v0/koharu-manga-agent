#!/usr/bin/env node

/**
 * extract_references.js
 * 從場景提取原文與翻譯對照，生成參考資料與配對報告。
 *
 * 用法:
 *   node extract_references.js [--base-url http://127.0.0.1:9999] [--output ./knowledge_base/self/my-manga.json] [--tolerance 10]
 */

const fs = require("fs");
const path = require("path");
const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    baseUrl: config.DEFAULT_BASE_URL,
    output: config.PATHS.KNOWLEDGE_BASE,
    report: config.PATHS.REPORTS,
    tolerance: config.DEFAULTS.tolerance,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) opts.baseUrl = args[++i].replace(/\/+$/, "");
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--report" && args[i + 1]) opts.report = args[++i];
    else if (args[i] === "--tolerance" && args[i + 1]) opts.tolerance = parseInt(args[++i], 10);
  }
  return opts;
}

async function getScene(baseUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  if (!res.ok) throw new Error(`取得場景失敗 (${res.status})`);
  return res.json();
}

function distance(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

function extractTextNodes(scene) {
  const pages = scene.scene?.pages || {};
  const result = {};

  for (const [pageId, page] of Object.entries(pages)) {
    const texts = [];
    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const t = node.kind?.text;
      if (t && t.text) {
        texts.push({
          nodeId,
          text: t.text,
          translation: t.translation || null,
          x: node.transform?.x || 0,
          y: node.transform?.y || 0,
          width: node.transform?.width || 0,
          height: node.transform?.height || 0,
          centerX: (node.transform?.x || 0) + (node.transform?.width || 0) / 2,
          centerY: (node.transform?.y || 0) + (node.transform?.height || 0) / 2,
        });
      }
    }
    result[pageId] = { pageName: page.name, texts };
  }
  return result;
}

function matchTexts(originalTexts, translatedTexts, tolerance) {
  const matched = [];
  const usedTranslated = new Set();

  for (const orig of originalTexts) {
    let bestMatch = null;
    let bestDist = Infinity;
    let candidateCount = 0;

    for (const trans of translatedTexts) {
      if (usedTranslated.has(trans.nodeId)) continue;
      const d = distance(
        { x: orig.centerX, y: orig.centerY },
        { x: trans.centerX, y: trans.centerY }
      );
      if (d <= tolerance) {
        candidateCount++;
        if (d < bestDist) {
          bestDist = d;
          bestMatch = trans;
        }
      }
    }

    if (bestMatch) {
      usedTranslated.add(bestMatch.nodeId);
      matched.push({
        original: orig.text,
        translation: bestMatch.translation || bestMatch.text,
        pageName: orig.pageName || translatedTexts[0]?.pageName,
        distance: Math.round(bestDist * 100) / 100,
        candidates: candidateCount,
      });
    }
  }

  const unmatchedOriginal = originalTexts.filter(o =>
    !matched.some(m => m.original === o.text && m.pageName === (o.pageName))
  );
  const unmatchedTranslated = translatedTexts.filter(t =>
    !usedTranslated.has(t.nodeId)
  );

  return { matched, unmatchedOriginal, unmatchedTranslated };
}

async function main() {
  const opts = parseArgs();
  console.error("🔍 正在提取場景文字資料...");

  const scene = await getScene(opts.baseUrl);
  const pageData = extractTextNodes(scene);

  const allPairs = [];
  const reportPages = [];
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalCandidates = 0;

  for (const [pageId, data] of Object.entries(pageData)) {
    const texts = data.texts;
    const withTranslation = texts.filter(t => t.translation);
    const withoutTranslation = texts.filter(t => !t.translation);

    if (withTranslation.length > 0) {
      for (const t of withTranslation) {
        allPairs.push({
          original: t.text,
          translation: t.translation,
          pageName: data.pageName,
          distance: 0,
          candidates: 1,
        });
      }
      totalMatched += withTranslation.length;
      totalUnmatched += withoutTranslation.length;

      reportPages.push({
        page: data.pageName,
        pageId,
        originalTexts: texts.length,
        translatedTexts: withTranslation.length,
        matched: withTranslation.length,
        unmatched: withoutTranslation.length,
        avgCandidates: 1,
      });
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    tolerance: opts.tolerance,
    totalPairs: allPairs.length,
    totalMatched,
    totalUnmatched,
    avgCandidates: totalMatched > 0 ? (totalCandidates / totalMatched).toFixed(2) : 0,
    pages: reportPages,
    unmatchedItems: [],
  };

  const outputDir = path.dirname(opts.output);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(opts.output, JSON.stringify({
    project_name: scene.scene?.project?.name || "unknown",
    source: "self",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    translation_pairs: allPairs,
    characters: {},
    terminology: {},
    style_profile: {},
    style_examples: [],
  }, null, 2));

  const reportDir = path.dirname(opts.report);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(opts.report, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    success: true,
    pairs: allPairs.length,
    matched: totalMatched,
    unmatched: totalUnmatched,
    output: opts.output,
    report: opts.report,
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
