# 工作流程文件 - MangaTranslationAgent

## 1. 主要工作流程

### 1.1 一鍵翻譯流程 (推薦)
```
開始
  │
  ├─ Agent 執行: node one_click_translate.js --target "zh-TW"
  │
  ├─ 1. 初始化檢查
  │     ├─ 檢查 original/ 資料夾是否存在
  │     └─ 過濾有效圖片檔 (.jpg, .png, .webp)
  │
  ├─ 2. 自動建立與開啟專案
  │     ├─ 生成帶時間戳的唯一名稱 (translate_YYYYMMDD_HHMMSS)
  │     └─ 開啟新專案
  │
  ├─ 3. 智慧上傳圖片
  │     ├─ 掃描目錄並自動過濾圖片
  │     └─ 批次上傳至 Koharu API
  │
  ├─ 4. 環境配置
  │     ├─ 載入預設 LLM 模型 (--load-default)
  │     └─ 套用快取引擎配置 (.default-engines)
  │
  ├─ 5. 啟動翻譯管線
  │     ├─ POST /pipelines
  │     └─ 取得 operationId
  │
  ├─ 6. 腳本結束並回傳 operationId
  │     └─ 輸出 JSON: { success: true, operationId, nextStep: "..." }
  │
  ├─ 7. Agent 啟動 pipeline-runner Subagent
  │     ├─ 傳入 operationId
  │     ├─ Subagent 執行 listen_events.js
  │     └─ 阻塞等待 SSE 事件 (JobFinished/JobWarning)
  │
  ├─ 8. 匯出結果
  │     ├─ POST /projects/current/export (format: rendered)
  │     └─ 儲存至 translated/
  │
  └─ 9. 清理資源
        └─ 關閉/刪除臨時專案
```

### 1.2 完整手動流程 (舊版/除錯用)
```
開始
  │
  ├─ 0. 檢查 TODO_LIST.md
  │     └─ 若有未完成事項，提醒使用者
  │
  ├─ 1. 列出 Koharu 專案
  │     └─ 使用者選擇目標專案
  │
  ├─ 2. 開啟專案
  │     └─ PUT /projects/current
  │
  ├─ 3. 上傳圖片（如需）
  │     ├─ 檢查 original/ 資料夾
  │     ├─ 比對現有頁面名稱（避免重複）
  │     └─ 上傳新圖片
  │
  ├─ 4. 載入 LLM 模型
  │     ├─ 檢查 .default-model
  │     ├─ 嘗試載入預設模型
  │     └─ 若失敗，列出本地模型讓使用者選擇
  │
  ├─ 5. 選擇管線引擎
  │     ├─ 檢查 .default-engines 快取
  │     ├─ 若缺少，讓使用者為每個步驟挑選
  │     └─ 儲存選擇至快取
  │
  ├─ 6. 啟動翻譯管線
  │     ├─ POST /pipelines
  │     ├─ 取得 operationId
  │     └─ 呼叫 pipeline-runner subagent
  │          └─ 監聽 SSE 事件 → 等待完成 → 回傳摘要
  │
  ├─ 7. 品質檢查（預設執行）
  │     ├─ 詢問使用者是否跳過
  │     ├─ 若執行，呼叫 quality-checker subagent
  │     │    ├─ 載入 knowledge_base/self/*.json
  │     │    ├─ 取得場景翻譯
  │     │    ├─ LLM 評估品質
  │     │    ├─ 套用修正（apply_fixes.js）
  │     │    └─ 重新渲染
  │     └─ 回傳品質報告
  │
  ├─ 8. 匯出結果
  │     ├─ POST /projects/current/export
  │     └─ 儲存至 translated/
  │
  ├─ 9. 更新知識庫（詢問或累積 3 次後提醒）
  │     └─ 呼叫 knowledge-builder subagent
  │          ├─ 提取參考資料
  │          ├─ 建立知識庫
  │          ├─ 更新知識庫
  │          └─ 更新 TODO_LIST.md
  │
  └─ 10. 關閉專案
        └─ DELETE /projects/current
```

## 2. Subagent 工作流程

### 2.1 pipeline-runner
```
輸入: operationId, baseUrl
  │
  ├─ 執行 listen_events.js
  │     └─ 連線至 SSE 串流
  │
  ├─ 監聽事件
  │     ├─ jobStarted → 記錄開始
  │     ├─ jobProgress → 顯示進度
  │     ├─ jobWarning → 記錄警告
  │     └─ jobFinished → 記錄完成
  │
  ├─ 等待完成或超時
  │     └─ 超時: 600 秒
  │
  └─ 回傳摘要
        └─ JSON 格式: { status, summary, error }
```

### 2.2 quality-checker
```
輸入: baseUrl, skipFlag
  │
  ├─ 載入知識庫
  │     └─ 讀取 knowledge_base/self/*.json
  │
  ├─ 取得場景翻譯
  │     └─ GET /scene.json
  │
  ├─ 注入知識庫至提示詞
  │     ├─ 角色名稱對照表
  │     ├─ 專有名詞對照表
  │     └─ 風格指南
  │
  ├─ LLM 評估品質
  │     ├─ 語言正確性檢查
  │     └─ 風格一致性檢查
  │
  ├─ 套用修正
  │     ├─ 產生 fixes.json
  │     ├─ 執行 apply_fixes.js
  │     └─ 觸發重新渲染
  │
  └─ 回傳報告
        └─ JSON 格式: { status, consistencyRate, fixed, error }
```

### 2.3 knowledge-builder
```
輸入: baseUrl, projectName
  │
  ├─ 提取參考資料
  │     └─ 執行 extract_references.js
  │
  ├─ 建立知識庫
  │     └─ 執行 build_knowledge_base.js
  │
  ├─ 更新知識庫
  │     └─ 執行 update_knowledge_base.js
  │
  ├─ 更新 TODO_LIST.md
  │     └─ 記錄更新時間
  │
  └─ 回傳報告
        └─ JSON 格式: { status, characters, terminology, error }
```

## 3. 錯誤處理流程

### 3.1 管線失敗
```
管線啟動
  │
  ├─ 成功取得 operationId
  │     └─ 繼續監聽
  │
  └─ 失敗
        ├─ API 回傳錯誤 → 顯示 QQ
        ├─ 超時 → 顯示 QQ
        └─ SSE 連線失敗 → 顯示 QQ
```

### 3.2 品質檢查失敗
```
品質檢查
  │
  ├─ 成功
  │     └─ 繼續匯出
  │
  └─ 失敗
        ├─ LLM 評估失敗 → 跳過修正，繼續匯出
        ├─ apply_fixes 失敗 → 記錄錯誤，繼續匯出
        └─ 重新渲染失敗 → 記錄錯誤，繼續匯出
```

### 3.3 知識庫更新失敗
```
知識庫更新
  │
  ├─ 成功
  │     └─ 更新 TODO_LIST.md
  │
  └─ 失敗
        ├─ 提取失敗 → 跳過更新
        ├─ 分析失敗 → 跳過更新
        └─ 寫入失敗 → 跳過更新
```

## 4. 智慧提醒機制

### 4.1 觸發時機
- 每次新對話開始時
- 檢查 `TODO_LIST.md` 是否有未完成事項

### 4.2 提醒內容
```
📋 待辦事項提醒：
- [ ] 提取 `專案名稱` 參考資料
- [ ] 建立知識庫
- [ ] 檢查翻譯風格一致性

是否繼續處理待辦事項？(y/N)
```

### 4.3 使用者回應處理
- `y` 或 `是` → 引導至對應流程
- `N` 或 `否` 或 `繼續` 或 `跳過` → 本次對話不再提醒
- 翻譯過程中不打斷

## 5. 知識庫更新追蹤

### 5.1 計數機制
- 每次翻譯完成後，計數器 +1
- 達到 3 次時，提醒使用者更新知識庫
- 更新後重置計數器

### 5.2 TODO_LIST.md 格式
```markdown
## 知識庫更新追蹤
- 最近翻譯次數：1/3
```

## 6. 日誌管理

### 6.1 日誌結構
```
logs/
├── pipeline-runner/
│   └── {operationId}_{timestamp}.json
├── quality-checker/
│   └── {jobId}_{timestamp}.json
└── knowledge-builder/
    └── {jobId}_{timestamp}.json
```

### 6.2 日誌格式
```json
{
  "jobId": "uuid",
  "timestamp": "ISO 時間",
  "subagent": "subagent 名稱",
  "status": "success|error",
  "duration_ms": 執行時間,
  "input": { ... },
  "result": { ... },
  "error": null 或錯誤訊息
}
```

### 6.3 清理指令
```bash
# 列出日誌統計
node .opencode/skills/clean-logs/scripts/clean_logs.js --list

# 清理 7 天前的日誌
node .opencode/skills/clean-logs/scripts/clean_logs.js --older-than 7d

# 清理所有日誌
node .opencode/skills/clean-logs/scripts/clean_logs.js --all
```


## 7. 測試工作流程

### 7.1 測試執行時機
| 時機 | 測試類型 | 指令 |
|------|---------|------|
| 開發中 | 單元測試 | `npm run test:unit` |
| 提交前 | 單元 + 整合 | `npm run test:unit && npm run test:integration` |
| 發布前 | 全部測試 | `npm test` |
| 定期 | 覆蓋率報告 | `npm run test:coverage` |

### 7.2 CI/CD 整合
```yaml
# 建議的 CI 流程
steps:
  - npm install
  - npm run test:unit
  - npm run test:integration
  - npm run test:coverage
  - npm run test:e2e  # 需 Koharu 服務
```

### 7.3 測試失敗處理
| 失敗類型 | 處理方式 |
|---------|---------|
| 單元測試失敗 | 修正 config.js 或 api.js |
| 整合測試失敗 | 檢查腳本 require 路徑 |
| E2E 測試失敗 | 確認 Koharu 服務運行 |
| 覆蓋率下降 | 新增測試案例 |

### 7.4 測試資料管理
- 測試使用實際 koharu.json 配置
- E2E 測試不修改專案狀態
- 知識庫測試驗證現有檔案格式
