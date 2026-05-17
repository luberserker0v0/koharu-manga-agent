# MangaTranslationAgent

基於 opencode 平台的自動化漫畫翻譯代理系統，透過 Koharu HTTP API 將日文/英文/韓文漫畫圖片翻譯並渲染為繁體中文。

## 功能特色

- **完整翻譯管線**：文字偵測 → OCR → 翻譯 → 去字修復 → 文字渲染
- **三層配置系統**：Shared 預設 → koharu.json → CLI 參數，靈活且易於管理
- **品質檢查**：LLM 自動評估翻譯品質，支援修正與重新渲染
- **知識庫管理**：自動提取術語、角色名、翻譯風格，提升翻譯一致性
- **Subagent 架構**：pipeline-runner、quality-checker、knowledge-builder 分工協作

## 快速開始

### 前置需求

- [Koharu](https://github.com/kanjieater/Koharu) 服務已啟動（預設 `http://127.0.0.1:9999`）
- **若使用 provider 模式**：請先開啟 Koharu UI 設定 OpenAI-compatible provider URL
- [opencode](https://opencode.ai) 平台
- Node.js v20+ 已安裝

### 安裝

```bash
# 克隆或複製本專案到任意目錄
cd comics/1

# 安裝測試依賴（可選）
cd tests && npm install && cd ..
```

### 基本使用

在 opencode 中開啟此專案，然後說「翻譯漫畫」即可啟動完整流程。

或手動執行：

```bash
# 1. 列出專案
node .opencode/skills/koharu-project-opener/scripts/open-project.js --list

# 2. 開啟專案
node .opencode/skills/koharu-project-opener/scripts/open-project.js --open "untitled"

# 3. 上傳圖片
node .opencode/skills/manga-translate-zhtw/scripts/upload_pages.js --paths "original/page1.jpg,original/page2.jpg"

# 4. 載入 LLM 模型
node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --load-default

# 5. 啟動翻譯管線
node .opencode/skills/koharu-pipeline-launcher/scripts/start_pipeline.js \
  --steps "comic-text-detector,paddle-ocr-vl-1.5,llm,aot-inpainting,koharu-renderer" \
  --target-language "zh-TW"

# 6. 匯出結果
node .opencode/skills/manga-translate-zhtw/scripts/export_project.js --format "rendered"
```

## 專案結構

```
comics/1/
├── AGENTS.md                  # 主 Agent 工作流程定義
├── TODO_LIST.md               # 待辦事項清單
├── .gitignore                 # 版本控制忽略規則
├── docs/                      # 軟體工程文件
│   ├── SRS.md                 # 軟體需求規格
│   ├── TDD.md                 # 測試驅動開發指南
│   ├── ARCHITECTURE.md        # 系統架構文件
│   ├── API.md                 # API 參考文件
│   └── WORKFLOW.md            # 工作流程文件
├── original/                  # 原始漫畫圖片（待翻譯）
├── translated/                # 翻譯後渲染輸出
├── knowledge_base/
│   ├── self/                  # 翻譯知識庫
│   └── reports/               # OCR 配對報告
├── logs/                      # Subagent 執行日誌
├── tests/                     # Jest 測試套件
│   ├── unit/                  # 單元測試
│   ├── integration/           # 整合測試
│   └── e2e/                   # 端到端測試
└── .opencode/
    ├── koharu.json            # 專案配置
    ├── opencode.json          # opencode 配置
    ├── agents/                # Subagent 定義
    └── skills/
        ├── shared/            # 共享配置模組
        │   ├── config.js      # 三層配置系統
        │   └── api.js         # API 端點常數
        ├── manga-translate-zhtw/
        ├── koharu-pipeline-launcher/
        ├── koharu-project-opener/
        ├── koharu-project-lister/
        └── clean-logs/
```

## 配置

所有可配置項定義於 `.opencode/koharu.json`：

```jsonc
{
  "api": { "baseUrl": "http://127.0.0.1:9999" },
  "llm": {
    "defaultModel": "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    "defaultProvider": "openai-compatible"
  },
  "timeouts": { "sseListen": 600, "llmRetry": 3 },
  "paths": {
    "knowledgeBase": "knowledge_base/self/my-manga.json",
    "translated": "translated/",
    "original": "original/"
  },
  "defaults": { "targetLanguage": "zh-TW", "exportFormat": "rendered", "tolerance": 10 },
  "engines": {
    "detect": "comic-text-detector",
    "ocr": "paddle-ocr-vl-1.5",
    "translate": "llm",
    "clean": "aot-inpainting",
    "render": "koharu-renderer"
  }
}
```

配置優先級：**CLI 參數 > koharu.json > Shared 預設值**

## 測試

```bash
# 全部測試
npm test --prefix tests

# 單元測試
npm run test:unit --prefix tests

# 整合測試
npm run test:integration --prefix tests

# 端到端測試（需 Koharu 服務）
npm run test:e2e --prefix tests

# 覆蓋率報告
npm run test:coverage --prefix tests
```

測試結果：**136 個測試全部通過**，覆蓋率 **96.87%**。

## 常用腳本

| 用途 | 腳本 |
|------|------|
| 專案操作 | `open-project.js` |
| 頁面上傳 | `upload_pages.js` |
| LLM 控制 | `llm_control.js` |
| 引擎選擇 | `select_engines.js` |
| 管線啟動 | `start_pipeline.js` |
| 事件監聽 | `listen_events.js` |
| 品質檢查 | `quality_check.js` |
| 套用修正 | `apply_fixes.js` |
| 專案匯出 | `export_project.js` |
| 知識庫管理 | `extract_references.js`, `build_knowledge_base.js`, `update_knowledge_base.js` |

## 文件

| 文件 | 說明 |
|------|------|
| [SRS.md](docs/SRS.md) | 軟體需求規格 |
| [TDD.md](docs/TDD.md) | 測試驅動開發指南 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系統架構文件 |
| [API.md](docs/API.md) | Koharu HTTP API 參考 |
| [WORKFLOW.md](docs/WORKFLOW.md) | 工作流程文件 |

## License

MIT
