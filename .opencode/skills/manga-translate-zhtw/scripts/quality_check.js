#!/usr/bin/env node

/**
 * quality_check.js
 * Read translated text from the current scene so the main agent or subagent
 * can perform quality analysis with an LLM.
 *
 * Usage:
 *   node quality_check.js [--base-url http://127.0.0.1:9999]
 *
 * Output:
 *   { success: true, data: { translations: [...], pages: [...] } }
 */

const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { baseUrl: config.DEFAULT_BASE_URL };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) {
      opts.baseUrl = args[++i].replace(/\/+$/, "");
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();
  const res = await apiFetch(ENDPOINTS.SCENE, { baseUrl: opts.baseUrl });

  if (!res.ok) {
    console.error(
      JSON.stringify({
        success: false,
        error: `Failed to read scene (${res.status})`,
      })
    );
    process.exit(1);
  }

  const scene = await res.json();
  const pages = scene.scene?.pages || {};
  const allTexts = [];
  const pageList = [];

  for (const [pageId, page] of Object.entries(pages)) {
    pageList.push({ id: pageId, name: page.name });

    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const textNode = node.kind?.text;
      if (textNode && textNode.text && textNode.translation) {
        allTexts.push({
          id: nodeId,
          pageId,
          pageName: page.name,
          original: textNode.text,
          translation: textNode.translation,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        data: {
          translations: allTexts,
          pages: pageList,
          totalTranslations: allTexts.length,
          totalPages: pageList.length,
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
