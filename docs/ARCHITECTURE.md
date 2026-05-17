# 系統架構文件 - MangaTranslationAgent

## 1. 系統概觀
MangaTranslationAgent 是基於 opencode 平台構建的自動化代理系統，專門用於將日文/英文/韓文漫畫圖片翻譯並渲染為繁體中文。

## 2. 架構圖
```
┌──────────────────────────────────────────────────────────────────┐
│                        opencode 平台                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    主 Agent (協調者)                        │  │
│  │  - 使用者互動（選擇專案、模型、引擎）                         │  │
│  │  - 工作流程協調                                             │  │
│  │  - 智慧提醒（TODO_LIST 檢查）                               │  │
│  │  - 決策點（品質檢查選項、匯出格式）                           │  │
│  └────────┬──────────────────┬──────────────────┬─────────────┘  │
│           │                  │                  │                │
│           ▼                  ▼                  ▼                │
│  ┌────────────────┐ ┌──────────────────┐ ┌──────────────────┐   │
│  │ pipeline-runner│ │ quality-checker  │ │ knowledge-builder│   │
│  │                │ │                  │ │                  │   │
│  │ 監聽管線進度   │ │ 評估翻譯品質     │ │ 建立/更新知識庫  │   │
│  └────────┬───────┘ └────────┬─────────┘ └────────┬─────────┘   │
│           │                  │                  │                │
└───────────┼──────────────────┼──────────────────┼────────────────┘
            │                  │                  │
            ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Node.js 腳本層                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ llm_control│ │upload_pages│ │select_eng  │ │quality_check │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │apply_fixes │ │extract_ref │ │build_kb    │ │self_reflect  │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────────────┘
            │                  │                  │
            ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Koharu HTTP API                               │
│  - GET /projects          - POST /pipelines                      │
│  - PUT /projects/current  - GET /events (SSE)                   │
│  - POST /pages            - POST /history/apply                  │
│  - GET /llm/catalog       - POST /projects/current/export        │
│  - PUT /llm/current       - GET /scene.json                      │
└──────────────────────────────────────────────────────────────────┘
```

## 3. 目錄結構
```
comics/1/
├── .gitignore                 # 版本控制忽略規則
├── AGENTS.md                  # 主 Agent 工作流程定義
├── TODO_LIST.md               # 待辦事項清單
├── PROJECT_OPTIMIZATION.md    # 專案優化方案
├── docs/                      # 軟體工程文件
│   ├── SRS.md                 # 軟體需求規格
│   ├── TDD.md                 # 測試驅動開發指南
│   ├── ARCHITECTURE.md        # 系統架構文件
│   └── API.md                 # API 參考文件
├── original/                  # 原始漫畫圖片
├── translated/                # 翻譯後渲染輸出
├── knowledge_base/
│   ├── self/                  # 自己的翻譯知識庫
│   └── reports/               # OCR 配對報告
├── logs/                      # Subagent 執行日誌
│   ├── pipeline-runner/
│   ├── quality-checker/
│   └── knowledge-builder/
└── .opencode/
    ├── agents/                # Subagent 定義
    │   ├── manga-translators.md
    │   ├── pipeline-runner.md
    │   ├── quality-checker.md
    │   └── knowledge-builder.md
    ├── opencode.json          # opencode 配置
    └── skills/
        ├── manga-translate-zhtw/
        │   ├── SKILL.md
        │   ├── scripts/
        │   │   ├── upload_pages.js
        │   │   ├── llm_control.js
        │   │   ├── select_engines.js
        │   │   ├── quality_check.js
        │   │   ├── apply_fixes.js
        │   │   ├── extract_references.js
        │   │   ├── build_knowledge_base.js
        │   │   ├── update_knowledge_base.js
        │   │   ├── self_reflection.js
        │   │   └── delete_page.js
        │   ├── .default-model
        │   └── .default-engines
        ├── koharu-pipeline-launcher/
        ├── koharu-project-lister/
        ├── koharu-project-opener/
        └── clean-logs/
```

## 4. 資料流
### 4.1 翻譯流程
```
使用者請求
    │
    ▼
主 Agent 協調
    │
    ├── 1. 列出專案 → 使用者選擇
    ├── 2. 開啟專案
    ├── 3. 上傳圖片（重複偵測）
    ├── 4. 載入 LLM 模型
    ├── 5. 選擇管線引擎
    ├── 6. 啟動管線 → pipeline-runner subagent
    │        └─ 監聽 SSE → 等待完成 → 回傳摘要
    ├── 7. 品質檢查 → quality-checker subagent
    │        └─ 載入知識庫 → 評估 → 修正 → 重新渲染
    ├── 8. 匯出結果
    ├── 9. 更新知識庫 → knowledge-builder subagent
    │        └─ 提取參考 → 分析 → 更新 → 記錄
    └── 10. 關閉專案
```

### 4.2 知識庫流程
```
翻譯完成
    │
    ▼
extract_references.js
    │
    ├── OCR 原文與翻譯
    ├── 座標配對（±10px 容差）
    └─ 輸出 translation_pairs + report
    │
    ▼
build_knowledge_base.js
    │
    ├── LLM 分析翻譯對照
    ├── 提取術語、角色名、風格
    └─ 輸出 knowledge_base.json
    │
    ▼
update_knowledge_base.js
    │
    ├── 手動將新翻譯加入知識庫
    ├── 更新 TODO_LIST.md
    └─ 記錄更新追蹤
```

## 5. 技術棧
| 層級 | 技術 |
|------|------|
| 平台 | opencode |
| 腳本語言 | Node.js (JavaScript) |
| API 通訊 | HTTP/JSON, SSE |
| 外部服務 | Koharu HTTP API |
| AI 模型 | LLM (provider/openai-compatible 優先，local 備援) |
| 文件格式 | Markdown, JSON |

## 6. 部署架構
### 6.1 本地部署
- Koharu 服務：`http://127.0.0.1:9999`
- Node.js 腳本：本地執行
- 檔案儲存：本地檔案系統

### 6.2 資源需求
- CPU: 4 核心以上（LLM 推理）
- RAM: 16 GB 以上（模型載入）
- 儲存: 10 GB 以上（圖片與知識庫）
- 網路: 本地回環（Koharu API）

## 7. 安全性考量
- 不儲存敏感資訊於程式碼中
- API 金鑰應透過環境變數管理
- 日誌不包含個人識別資訊
- 檔案權限限制為使用者可讀寫

## 8. 效能考量
- 管線監聽超時：600 秒
- 品質檢查超時：300 秒
- 知識庫更新超時：300 秒
- 支援批次處理與增量更新
- 快取機制減少重複 API 呼叫


## 9. 測試架構

### 9.1 測試框架
- **Jest** v29.7.0
- **測試環境**: Node.js
- **測試超時**: 30 秒

### 9.2 測試目錄結構
```
tests/
├── jest.config.js              # Jest 配置
├── setup.js                    # 測試環境初始化
├── package.json                # Jest 依賴
├── helpers/
│   └── koharu.js               # Koharu API 測試輔助
├── unit/                       # 單元測試
│   ├── config.test.js          # 配置系統（18 個測試）
│   └── api.test.js             # API 模組（12 個測試）
├── integration/                # 整合測試
│   ├── script_load.test.js     # 腳本載入（80 個測試）
│   └── config_override.test.js # 配置覆蓋（10 個測試）
└── e2e/                        # 端到端測試
    ├── pipeline.test.js        # 管線流程（9 個測試）
    └── knowledge_base.test.js  # 知識庫流程（7 個測試）
```

### 9.3 測試執行指令
```bash
npm test                    # 全部測試（136 個）
npm run test:unit          # 單元測試（30 個）
npm run test:integration   # 整合測試（90 個）
npm run test:e2e           # 端到端測試（16 個）
npm run test:coverage      # 覆蓋率報告（96.87%）
```

### 9.4 覆蓋率目標
| 模組 | 目標 | 實際 |
|------|------|------|
| `shared/config.js` | 95% | 95% |
| `shared/api.js` | 100% | 100% |
