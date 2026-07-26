#!/usr/bin/env node

/**
 * apply_fixes.js
 * 將修正後的翻譯透過 history/apply 寫入場景。
 *
 * 用法:
 *   node apply_fixes.js --fixes '[{"id":"nodeId","pageId":"pageId","translation":"新翻譯"},...]'
 *   node apply_fixes.js --fixes-file fixes.json
 */

const config = require("../lib/config");
const { apiFetch, ENDPOINTS } = require("../lib/api");
const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { baseUrl: config.DEFAULT_BASE_URL, fixes: null, fixesFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) opts.baseUrl = args[++i].replace(/\/+$/, "");
    else if (args[i] === "--fixes" && args[i + 1]) opts.fixes = args[++i];
    else if (args[i] === "--fixes-file" && args[i + 1]) opts.fixesFile = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  let fixes;

  if (opts.fixesFile) {
    const filePath = path.resolve(opts.fixesFile);
    fixes = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } else if (opts.fixes) {
    fixes = JSON.parse(opts.fixes);
  } else {
    console.error(JSON.stringify({ success: false, error: "請提供 --fixes 或 --fixes-file" }));
    process.exit(1);
  }

  if (!Array.isArray(fixes) || fixes.length === 0) {
    console.log(JSON.stringify({ success: true, message: "無修正項目" }));
    process.exit(0);
  }

  console.error(`🔧 正在套用 ${fixes.length} 筆翻譯修正...`);

  const ops = fixes.map(f => ({
    updateNode: {
      page: f.pageId,
      id: f.id,
      patch: {
        data: {
          text: {
            translation: f.translation
          }
        }
      }
    }
  }));

  const payload = {
    batch: {
      ops,
      label: "quality_check_fixes"
    }
  };

  console.error(`Payload: ${JSON.stringify(payload).slice(0, 200)}...`);

  const res = await apiFetch(ENDPOINTS.HISTORY_APPLY, {
    method: "POST",
    baseUrl: opts.baseUrl,
    body: payload,
  });

  if (res.ok) {
    const data = await res.json();
    console.log(JSON.stringify({ success: true, applied: fixes.length, epoch: data.epoch }));
    process.exit(0);
  } else {
    const errText = await res.text();
    console.error(`失敗 (${res.status}): ${errText}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(JSON.stringify({ success: false, error: err.message })); process.exit(1); });
