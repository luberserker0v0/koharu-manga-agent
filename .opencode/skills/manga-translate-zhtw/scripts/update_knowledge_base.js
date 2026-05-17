#!/usr/bin/env node

/**
 * update_knowledge_base.js
 * 手動將新翻譯加入知識庫，並更新 TODO_LIST.md。
 *
 * 用法:
 *   node update_knowledge_base.js [--base-url http://127.0.0.1:9999] [--kb ./knowledge_base/self/my-manga.json]
 */

const fs = require("fs");
const path = require("path");
const config = require("../../shared/config");
const { apiFetch, ENDPOINTS } = require("../../shared/api");

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

function updateTodoList(action, description) {
  if (!fs.existsSync(config.PATHS.TODO_LIST)) {
    fs.writeFileSync(config.PATHS.TODO_LIST, "# 翻譯待辦事項\n\n## 待處理\n\n## 已完成\n\n## 待反思\n");
  }
  let content = fs.readFileSync(config.PATHS.TODO_LIST, "utf-8");
  const date = new Date().toISOString().split("T")[0];

  if (action === "add_pending") {
    content = content.replace("## 待處理\n", `## 待處理\n- [ ] ${description}\n`);
  } else if (action === "complete") {
    content = content.replace(`- [ ] ${description}`, `- [x] ${description} (${date})`);
  } else if (action === "add_reflect") {
    content = content.replace("## 待反思\n", `## 待反思\n- [ ] ${description}\n`);
  }
  fs.writeFileSync(config.PATHS.TODO_LIST, content);
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.kb)) {
    console.error(JSON.stringify({ success: false, error: "知識庫不存在，請先執行 extract_references.js 和 build_knowledge_base.js" }));
    process.exit(1);
  }

  console.error("🔄 正在更新知識庫...");

  try {
    const scene = await getScene(opts.baseUrl);
    const pages = scene.scene?.pages || {};
    const newPairs = [];

    for (const [pageId, page] of Object.entries(pages)) {
      for (const [nodeId, node] of Object.entries(page.nodes || {})) {
        const t = node.kind?.text;
        if (t && t.text && t.translation) {
          newPairs.push({
            original: t.text,
            translation: t.translation,
            pageName: page.name,
          });
        }
      }
    }

    const kb = JSON.parse(fs.readFileSync(opts.kb, "utf-8"));
    const existingPairs = kb.translation_pairs || [];
    const existingTexts = new Set(existingPairs.map(p => p.original));

    let addedCount = 0;
    for (const pair of newPairs) {
      if (!existingTexts.has(pair.original)) {
        existingPairs.push(pair);
        addedCount++;
      }
    }

    kb.translation_pairs = existingPairs;
    kb.updated_at = new Date().toISOString();
    fs.writeFileSync(opts.kb, JSON.stringify(kb, null, 2));

    updateTodoList("complete", "更新知識庫");
    updateTodoList("add_reflect", "檢查翻譯風格一致性");

    console.log(JSON.stringify({
      success: true,
      totalPairs: existingPairs.length,
      added: addedCount,
      output: opts.kb,
    }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
