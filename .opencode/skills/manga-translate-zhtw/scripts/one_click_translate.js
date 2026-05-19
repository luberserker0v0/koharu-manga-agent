#!/usr/bin/env node
/**
 * one_click_translate.js
 * 一鍵漫畫翻譯腳本：處理固定前置作業，並呼叫 pipeline-runner 執行管線與監聽。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 預設配置
const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:9999',
  targetLang: 'zh-TW',
  originalDir: path.join(__dirname, '..', '..', '..', '..', 'original'),
  translatedDir: path.join(__dirname, '..', '..', '..', '..', 'translated'),
  autoDeleteProject: true
};

function runStep(description, command) {
  console.log(`[Step] ${description}`);
  try {
    const output = execSync(command, { stdio: 'pipe' });
    console.log(`[OK] ${description}`);
    return JSON.parse(output.toString());
  } catch (error) {
    console.error(`[FAIL] ${description}`);
    console.error(error.stderr.toString());
    process.exit(1);
  }
}

async function main() {
  // 1. 解析 CLI 參數
  const args = process.argv.slice(2);
  const targetLang = args.find(a => a.startsWith('--target'))?.split('=')[1] || DEFAULT_CONFIG.targetLang;
  const baseUrl = args.find(a => a.startsWith('--base-url'))?.split('=')[1] || DEFAULT_CONFIG.baseUrl;
  
  // 2. 檢查原始圖片目錄
  if (!fs.existsSync(DEFAULT_CONFIG.originalDir)) {
    console.error(`[Error] 找不到原始圖片目錄: ${DEFAULT_CONFIG.originalDir}`);
    process.exit(1);
  }
  const images = fs.readdirSync(DEFAULT_CONFIG.originalDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  if (images.length === 0) {
    console.error('[Error] original/ 資料夾內沒有找到有效的圖片檔案。');
    process.exit(1);
  }
  console.log(`[Info] 找到 ${images.length} 張圖片，準備開始翻譯流程...`);

  // 3. 建立並開啟專案
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const projectName = `translate_${timestamp}`;
  runStep('建立專案', `node .opencode/skills/koharu-project-opener/scripts/open-project.js --create "${projectName}" --base-url "${baseUrl}"`);
  runStep('開啟專案', `node .opencode/skills/koharu-project-opener/scripts/open-project.js --open "${projectName}" --base-url "${baseUrl}"`);

  // 4. 上傳圖片
  const imagePaths = images.map(img => path.join(DEFAULT_CONFIG.originalDir, img)).join(',');
  runStep('上傳圖片', `node .opencode/skills/manga-translate-zhtw/scripts/upload_pages.js --paths "${imagePaths}" --base-url "${baseUrl}"`);

  // 5. 載入 LLM 與引擎
  runStep('載入 LLM', `node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --load-default --base-url "${baseUrl}"`);
  runStep('選擇引擎', `node .opencode/skills/manga-translate-zhtw/scripts/select_engines.js --base-url "${baseUrl}"`);

  // 6. 啟動管線 (加入 comic-text-detector-seg 以產生 Inpaint 所需的 Segment Mask)
  const pipelineResult = runStep('啟動管線', `node .opencode/skills/koharu-pipeline-launcher/scripts/start_pipeline.js --steps "pp-doclayout-v3,speech-bubble-segmentation,paddle-ocr-vl-1.5,llm,comic-text-detector-seg,aot-inpainting,koharu-renderer" --target-language "${targetLang}" --base-url "${baseUrl}"`);
  const operationId = pipelineResult.operationId;

  if (!operationId) {
    console.error('[Error] 無法獲取管線 Operation ID');
    process.exit(1);
  }

  // 7. 輸出 Operation ID 供 Agent 啟動 pipeline-runner Subagent
  console.log(JSON.stringify({ success: true, operationId, nextStep: '請啟動 pipeline-runner Subagent 監聽 SSE 事件' }));
  console.log('[Info] 前置作業完成，管線已啟動。請由 pipeline-runner Subagent 接手監聽進度。');
  
  // 腳本在此結束，不自行監聽 SSE，確保由 Subagent 執行
  process.exit(0);
}

main().catch(e => {
  console.error('[Fatal]', e);
  process.exit(1);
});