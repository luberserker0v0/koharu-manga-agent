#!/usr/bin/env node

/**
 * update_knowledge_base.js
 * Merge the current project scene into the knowledge base and update TODO_LIST.md.
 *
 * Usage:
 *   node update_knowledge_base.js [--base-url http://127.0.0.1:9999] [--kb ./knowledge_base/self/my-manga.json]
 */

const fs = require("fs");
const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    baseUrl: config.DEFAULT_BASE_URL,
    kb: config.PATHS.KNOWLEDGE_BASE,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    } else if (args[i] === "--kb" && args[i + 1]) {
      opts.kb = args[++i];
    }
  }

  return opts;
}

async function getScene(baseUrl) {
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl });
  if (!res.ok) {
    throw new Error(`Failed to read scene (${res.status})`);
  }
  return res.json();
}

function updateTodoList(action, description) {
  if (!fs.existsSync(config.PATHS.TODO_LIST)) {
    fs.writeFileSync(
      config.PATHS.TODO_LIST,
      "# Knowledge Base Tasks\n\n## Pending\n\n## Completed\n\n## Reflection\n"
    );
  }

  let content = fs.readFileSync(config.PATHS.TODO_LIST, "utf-8");
  const date = new Date().toISOString().split("T")[0];

  if (action === "add_pending") {
    content = content.replace("## Pending\n", `## Pending\n- [ ] ${description}\n`);
  } else if (action === "complete") {
    content = content.replace(`- [ ] ${description}`, `- [x] ${description} (${date})`);
  } else if (action === "add_reflect") {
    content = content.replace(
      "## Reflection\n",
      `## Reflection\n- [ ] ${description}\n`
    );
  }

  fs.writeFileSync(config.PATHS.TODO_LIST, content);
}

async function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.kb)) {
    console.error(
      JSON.stringify({
        success: false,
        error:
          "Knowledge base file not found. Run extract_references.js and build_knowledge_base.js first.",
      })
    );
    process.exit(1);
  }

  console.error("Updating knowledge base from the current scene...");

  try {
    const scene = await getScene(opts.baseUrl);
    const pages = scene.scene?.pages || {};
    const newPairs = [];

    for (const page of Object.values(pages)) {
      for (const node of Object.values(page.nodes || {})) {
        const textNode = node.kind?.text;
        if (textNode && textNode.text && textNode.translation) {
          newPairs.push({
            original: textNode.text,
            translation: textNode.translation,
            pageName: page.name,
          });
        }
      }
    }

    const kb = JSON.parse(fs.readFileSync(opts.kb, "utf-8"));
    const existingPairs = kb.translation_pairs || [];
    const existingTexts = new Set(existingPairs.map((pair) => pair.original));

    let addedCount = 0;
    for (const pair of newPairs) {
      if (!existingTexts.has(pair.original)) {
        existingPairs.push(pair);
        addedCount += 1;
      }
    }

    kb.translation_pairs = existingPairs;
    kb.updated_at = new Date().toISOString();
    fs.writeFileSync(opts.kb, JSON.stringify(kb, null, 2));

    updateTodoList("complete", "Update knowledge base");
    updateTodoList("add_reflect", "Review translation consistency after the update");

    console.log(
      JSON.stringify(
        {
          success: true,
          totalPairs: existingPairs.length,
          added: addedCount,
          output: opts.kb,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
