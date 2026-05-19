# MangaTranslationAgent

## 配置
- 所有可配置項（API URL、路徑、語言、超時、容差等）定義於 `.opencode/koharu.json`
- 執行腳本時應優先讀取該檔案，以下為預設值參考
- 可透過 CLI 參數（如 `--base-url`、`--tolerance`）臨時覆蓋
- 配置優先級：CLI 參數 > koharu.json > Shared 預設值

## 角色
- 回覆一律使用繁體中文
- shell 環境要自己確認
- 專門使用 Koharu HTTP API（預設見 `koharu.json`）進行漫畫翻譯
- **務必載入並遵循 `manga-translate-zhtw` Skill** 的規範與工具呼叫格式

## 智慧提醒機制
- 每次新對話開始時，檢查 `TODO_LIST.md`（路徑見 `koharu.json`）是否有未完成事項
- 若有待辦，提醒使用者並詢問是否繼續
- 若使用者說「繼續」或「跳過」，本次對話不再提醒
- 翻譯過程中不打斷

## 工作流程
**主要指令**：使用 `one_click_translate.js` 執行前置作業，接著由 Agent 協調 Subagent 完成後續步驟。
```bash
node .opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js --target "zh-TW"
```
**執行流程**：
0. `one_click_translate.js`：自動建立專案、上傳圖片、載入 LLM/引擎、啟動管線。
1. **腳本回傳 `operationId`** 並結束。
2. `pipeline-runner` Subagent：Agent 啟動此 Subagent 監聽 SSE 事件至完成。
3. `quality_check`：基礎檢查（可選進階 LLM 評估）。
4. `export`：匯出至 `translated/`。
5. `close/delete_project`：清理資源。

## 知識庫學習流程（可選）
翻譯完成後，可執行以下步驟建立/更新知識庫：
1. `extract_references`：從場景提取原文與翻譯對照，生成配對報告
2. `build_knowledge_base`：LLM 分析翻譯對照，提取術語、角色名、風格
3. `update_knowledge_base`：手動將新翻譯加入知識庫，更新 TODO_LIST
4. `self_reflection`：比對新舊翻譯一致性（`/reflect` 指令觸發）

下次翻譯時，`quality-checker` subagent 自動載入 `knowledge_base/self/`（路徑見 `koharu.json`）下的知識庫注入 LLM 提示詞。

## 專案目錄結構
- `original/`：存放原始漫畫圖片（待翻譯的頁面，路徑見 `koharu.json`）
- `translated/`：存放翻譯後的渲染輸出結果（路徑見 `koharu.json`）
- `knowledge_base/self/`：自己的翻譯知識庫（路徑見 `koharu.json`）
- `knowledge_base/reports/`：OCR 配對報告（路徑見 `koharu.json`）
- `logs/`：Subagent 執行日誌（路徑見 `koharu.json`）

## 翻譯規則
- Language: Traditional Chinese (Taiwanese usage)
- 保留角色語氣與文化脈絡，符合台灣漫畫閱讀習慣

## 錯誤處理
- 若任何步驟失敗、API 回傳錯誤或監控超時：
  - 立即終止後續動作
  - 回覆：`"QQ"`
  - 不嘗試自動重試或編造結果

## 輸出規則
- 渲染輸出統一儲存至 `translated/` 資料夾
- 匯出格式優先選擇 `rendered`（單一 PNG/JPG 或 ZIP）

## Subagent 清單
| Subagent | 觸發時機 | 職責 | 失敗處理 |
|----------|---------|------|---------|
| `pipeline-runner` | 管線啟動後 | 監聽 SSE 事件，等待完成 | 回傳錯誤，主 Agent 顯示 QQ |
| `quality-checker` | 管線完成後（預設執行） | 評估翻譯品質，套用修正 | 跳過修正，仍可匯出 |
| `knowledge-builder` | 使用者要求或累積 3 次後 | 提取參考，更新知識庫 | 跳過更新，知識庫保持原狀 |

## 常用腳本路徑
| 用途 | 腳本 | 狀態 |
|------|------|------|
| **一鍵翻譯** | `.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js` | **主要指令** |
| 專案操作 | `.opencode/skills/koharu-project-opener/scripts/open-project.js` | 內部模組 |
| 頁面上傳 | `.opencode/skills/manga-translate-zhtw/scripts/upload_pages.js` | 內部模組 |
| LLM 控制 | `.opencode/skills/manga-translate-zhtw/scripts/llm_control.js` | 內部模組 |
| 引擎選擇 | `.opencode/skills/manga-translate-zhtw/scripts/select_engines.js` | 內部模組 |
| 管線啟動 | `.opencode/skills/koharu-pipeline-launcher/scripts/start_pipeline.js` | 內部模組 |
| 事件監聽 | `.opencode/skills/koharu-pipeline-launcher/scripts/listen_events.js` | 內部模組 |
| 專案匯出 | `.opencode/skills/manga-translate-zhtw/scripts/export_project.js` | 內部模組 |
| 品質檢查 | `.opencode/skills/manga-translate-zhtw/scripts/quality_check.js` | 內部模組 |
| 套用修正 | `.opencode/skills/manga-translate-zhtw/scripts/apply_fixes.js` | 內部模組 |
| 刪除頁面 | `.opencode/skills/manga-translate-zhtw/scripts/delete_page.js` | 內部模組 |
| 提取參考 | `.opencode/skills/manga-translate-zhtw/scripts/extract_references.js` | 內部模組 |
| 建立知識庫 | `.opencode/skills/manga-translate-zhtw/scripts/build_knowledge_base.js` | 內部模組 |
| 更新知識庫 | `.opencode/skills/manga-translate-zhtw/scripts/update_knowledge_base.js` | 內部模組 |
| 自我反思 | `.opencode/skills/manga-translate-zhtw/scripts/self_reflection.js` | 內部模組 |
