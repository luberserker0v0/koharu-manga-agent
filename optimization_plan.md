# 翻譯流程優化與修正計畫

## 1. 指令遵循失敗 (Instruction Following Failure)
**現象**：Agent 在收到「開始翻譯」指令後，未直接執行流程，而是停下來詢問確認問題。
**原因**：
- 模型特性：`gemma-4-e4b-uncensored-hauhaucs-aggressive` 過度強調互動性。
- 上下文理解偏差：缺乏對「直接開始」意圖的強烈觸發條件。
**解決方案**：
- **強化提示詞**：在 `AGENTS.md` 中明確指示：「當用戶表示『開始翻譯』時，**請勿詢問**，直接執行流程。若遇缺失步驟，請自動處理。」

## 2. 腳本路徑解析錯誤與自動化缺失
**現象**：
- 執行錯誤路徑 `manga-translate-zhtw/scripts/open-project.js` 導致 `MODULE_NOT_FOUND`。
- 專案列表為空時，Agent 停下來詢問而非自動建立。
**原因**：
- 路徑混淆：未嚴格遵守 `AGENTS.md` 中的腳本路徑對照表。
- 自動化邏輯不足：未觸發 `create_project` 流程。
**解決方案**：
- **統一腳本路徑**：嚴格引用 `koharu-project-opener/scripts/open-project.js`。
- **強制自動建立**：若無專案，必須自動執行 `create_project`（帶時間戳），禁止詢問。

## 3. 頁面上傳腳本缺陷與 Agent 幻覺
**現象**：
- `upload_pages.js` 接收目錄或萬用字元時拋出 `EISDIR` 錯誤。
- Agent 將崩潰錯誤誤判為「成功識別資料夾」，繼續執行後續步驟。
**原因**：
- 腳本限制：僅支援單一檔案路徑，未實作目錄遍歷。
- Agent 幻覺：模型未能正確解讀 Node.js 錯誤堆疊。
**解決方案**：
- **修復腳本邏輯**：更新 `upload_pages.js` 支援目錄輸入，自動掃描並過濾圖片。
- **規範 Agent 行為**：上傳前使用 `glob` 獲取清單，以逗號分隔傳入。
- **強化錯誤辨識**：遇 `Error` 或 `EISDIR` 立即終止並回報 "QQ"。

## 4. 模型選擇建議
**建議**：若當前模型持續無法遵循指令，建議換用指令遵循能力更強的模型（如 `qwen` 或 `claude` 系列）。

## 5. 腳本整合與一鍵翻譯策略 (核心優化)
**現象**：
- 多個分散的腳本（`open-project.js`, `upload_pages.js`, `start_pipeline.js` 等）增加了 Agent 的呼叫複雜度。
- 容易發生路徑拼湊錯誤、參數傳遞失敗或步驟遺漏。
**解決方案**：
- **建立 `one_click_translate.js`**：負責所有固定前置作業（專案建立、圖片掃描上傳、LLM/引擎配置）。
- **保留 `pipeline-runner`**：由 `one_click_translate.js` 呼叫 `listen_events.js` 來執行 SSE 監聽與阻塞等待，維持職責分離。
- **簡化 Agent 指令**：Agent 只需執行單一指令即可完成全流程，大幅降低出錯機率。
- **封裝內部邏輯**：將舊有腳本標記為內部模組，避免 Agent 直接呼叫。

---
*此檔案將持續更新，最終將統整所有修正與優化建議。*