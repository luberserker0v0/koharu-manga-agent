---
name: manga-translate-zhtw
description: 使用 Koharu HTTP API 將漫畫圖片翻譯為繁體中文，支援批量處理與管線監控。只要提到翻譯漫畫、處理漫畫專案、或需要將日文/英文/韓文漫畫渲染為繁體中文時就使用此 skill。
license: MIT
compatibility: opencode
metadata:
  audience: manga-translators
  language: zh-TW
  tools: nodejs, http-api
---

## ⚠️ 核心指令：全自動執行 (AUTONOMOUS EXECUTION)
- **禁止詢問**：收到翻譯指令後，**立即執行**腳本。絕對不要問「是否繼續？」、「確認執行？」。
- **主要指令**：使用 `one_click_translate.js` 執行全流程。
  ```bash
  node .opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js --target "zh-TW"
  ```
- **連續作業**：流程中的每個步驟必須**無縫接軌**。腳本結束後，**立刻**執行下一步，不要等待使用者回覆。

## 功能概述

本 skill 提供自動化漫畫翻譯流程，透過 Koharu HTTP API 將日文/英文/韓文漫畫頁面翻譯並渲染為繁體中文。支援完整管線：文字偵測 → OCR → 翻譯 → 去字修復 → 文字渲染。

## 前置需求

- Koharu 服務已啟動並暴露 HTTP API（預設 `http://127.0.0.1:9999`）
- Node.js 已安裝且可在 PATH 中使用
- 翻譯所需的 LLM 模型已可用
- **若使用 provider 模式**：請先開啟 Koharu UI 設定 OpenAI-compatible provider URL

## 使用時機

✅ 當你需要將非中文漫畫頁面翻譯為繁體中文時  
✅ 當你需要批量處理整個章節或專案時  
✅ 當你需要匯出 PSD、渲染圖或 Koharu 原生格式供後續編輯時  

❌ 不適用於單張圖片快速翻譯（建議使用輕量工具）  
❌ 不適用於非漫畫類型的文件翻譯（排版邏輯不同）

## 執行流程

### 0. 一鍵翻譯 (推薦)

**直接執行以下指令，不要分步詢問：**

```bash
node .opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js --target "zh-TW"
```

### 1. 手動流程 (僅供除錯參考)

> **注意**：除非使用者明確要求「手動執行」或「除錯」，否則請勿使用以下步驟。

### 1.1 列出專案

```bash
node .opencode/skills/koharu-project-opener/scripts/open-project.js --list
```

### 1. 開啟專案

```bash
node .opencode/skills/koharu-project-opener/scripts/open-project.js --open "{project-id}"
```

或創建新專案：

```bash
node .opencode/skills/koharu-project-opener/scripts/open-project.js --create "{project-name}"
```

### 2. 上傳頁面（如需）

若專案尚未包含圖片，使用 `scripts/upload_pages.js`：

```bash
node .opencode/skills/manga-translate-zhtw/scripts/upload_pages.js --paths "C:\path\to\page1.jpg,C:\path\to\page2.png"
```

對應 API：`POST /pages`（multipart 上傳）或 `POST /pages/from-paths`（Tauri 快速通道）。

### 3. 載入 LLM 模型

翻譯需要 LLM 模型。預設模型配置為 `kind: provider, providerId: openai-compatible`。

#### 3.1 檢查是否已有預設模型

```bash
node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --status
```

若已有載入的模型且狀態為 `ready`，跳至步驟 4。

#### 3.2 載入預設模型

使用 `--load-default` 載入預設模型（優先以 provider 模式，失敗後嘗試 local 模式）：

```bash
node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --load-default
```

載入邏輯：
1. 讀取 `.default-model` 取得模型 ID
2. 優先以 `kind: provider, providerId: openai-compatible` 載入
3. 若 provider 載入失敗，嘗試以 `kind: local` 載入
4. 兩者都失敗，列出本地模型讓使用者重新選擇

#### 3.3 列出本地模型並讓使用者選擇

若無預設模型或載入失敗，使用 `--local-catalog` 取得所有本地模型，透過 `Question tool` 讓使用者選擇：

```bash
node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --local-catalog
```

將回傳的本地模型列表透過 `Question tool` 呈現給使用者選擇。

#### 3.4 設定預設模型並載入

使用者選擇模型後：

1. 設定為預設模型（以後不會再問，除非本地找不到該模型）：
   ```bash
   node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --set-default "{model-id}"
   ```

2. 載入該模型（優先 provider 模式）：
   ```bash
   node .opencode/skills/manga-translate-zhtw/scripts/llm_control.js --load --model-id "{model-id}" --provider-id "openai-compatible"
   ```

對應 API：
- `GET /llm/current` — 查看狀態
- `PUT /llm/current` — 載入模型（body: `{ target: { kind: "provider", modelId: "...", providerId: "openai-compatible" } }`）
- `DELETE /llm/current` — 卸載模型
- `GET /llm/catalog` — 列出所有模型（需過濾 `kind === "local"`）

### 4. 選擇管線引擎並啟動翻譯管線

**重要：`steps` 欄位必須填入實際的 engine id，而非步驟名稱。**

#### 4.1 取得可用引擎並檢查快取

```bash
node .opencode/skills/manga-translate-zhtw/scripts/select_engines.js
```

此腳本會：
1. 呼叫 `GET /api/v1/engines` 取得所有可用引擎
2. 讀取 `.default-engines` 檢查是否有已儲存的選擇
3. 回傳 `{ success, needsQuestion, engines, questions? }`

#### 4.2 若需要使用者選擇（`needsQuestion: true`）

將 `questions` 陣列轉換為 `question tool` 呼叫，讓使用者為每個缺少預設的步驟挑選引擎：

管線步驟與引擎類別對應：
| 步驟 | 引擎類別 | 說明 |
|------|---------|------|
| detect | detectors | 文字框偵測 |
| ocr | ocr | 文字辨識 |
| translate | translators | 翻譯引擎 |
| clean | inpainters | 去字修復 |
| render | renderers | 最終渲染 |

使用者選擇後，將結果寫入 `.default-engines`（使用 `select_engines.js` 的儲存邏輯或直接寫入 JSON）。

#### 4.3 啟動管線

使用選擇好的 engine id 陣列啟動管線：

```bash
node .opencode/skills/koharu-pipeline-launcher/scripts/start_pipeline.js \
  --steps "comic-text-detector,manga-ocr,llm,aot-inpainting,koharu-renderer" \
  --target-language "zh-TW"
```

**若 API 回傳 400 錯誤（unknown engine）**：表示該引擎未安裝，自動挑選該類別第一個可用引擎，更新 `.default-engines` 後重試。

回傳 `{ operationId: "uuid" }`。

### 5. 監聽管線進度

取得 operationId 後，**立即使用 `@pipeline-runner` 呼叫子代理**（不要詢問，不要直接在 Shell 執行）：

**正確呼叫方式 (Task Tool)**：
```json
{
  "subagent_type": "pipeline-runner",
  "description": "監聽 Koharu 管線 SSE 事件",
  "prompt": "請執行 listen_events.js 監聽 operationId: {operationId} 直到完成。",
  "command": "node .opencode/skills/koharu-pipeline-launcher/scripts/listen_events.js --job-id \"{operationId}\""
}
```

### 6. 匯出結果

管線完成後，使用 `scripts/export_project.js`：

```bash
# 匯出渲染圖（PNG/JPG 或 ZIP）
node .opencode/skills/manga-translate-zhtw/scripts/export_project.js --format "rendered" --output "./translated/"

# 匯出 PSD
node .opencode/skills/manga-translate-zhtw/scripts/export_project.js --format "psd" --output "./translated/"

# 匯出 Koharu 原生格式
node .opencode/skills/manga-translate-zhtw/scripts/export_project.js --format "khr" --output "./translated/"
```

對應 API：`POST /projects/current/export`，請求體 `{ format, pages? }`。

### 7. 關閉專案

```bash
node .opencode/skills/koharu-project-opener/scripts/open-project.js --close
```

## 錯誤處理

- 任何 API 呼叫失敗：立即終止後續動作，回覆 `"QQ"`
- 管線超時或錯誤：回覆 `"QQ"`
- **不**嘗試自動重試或編造結果

## 輸出規則

- 渲染輸出統一儲存至 `translated/` 資料夾
- 匯出格式優先選擇 `rendered`（單一 PNG/JPG 或 ZIP）

## 翻譯規則

- Language: Traditional Chinese (Taiwanese usage)
- 保留角色語氣與文化脈絡，符合台灣漫畫閱讀習慣

## API 端點總覽

| 動作 | 方法 | 端點 | 用途 |
|------|------|------|------|
| 列出專案 | `GET` | `/projects` | 取得所有專案 |
| 創建專案 | `POST` | `/projects` | 新專案 |
| 開啟專案 | `PUT` | `/projects/current` | 開啟指定 id 的專案 |
| 關閉專案 | `DELETE` | `/projects/current` | 關閉目前專案 |
| 上傳頁面 | `POST` | `/pages` | multipart 圖片上傳 |
| 場景快照 | `GET` | `/scene.json` | 目前場景狀態 |
| 套用操作 | `POST` | `/history/apply` | 套用 Op 修改場景 |
| 撤銷 | `POST` | `/history/undo` | 撤銷上一步 |
| 重做 | `POST` | `/history/redo` | 重做已撤銷的操作 |
| 啟動管線 | `POST` | `/pipelines` | 啟動翻譯管線 |
| 可用引擎 | `GET` | `/engines` | 取得所有可用引擎列表 |
| 查看操作 | `GET` | `/operations` | 所有運行中的 operation |
| 取消操作 | `DELETE` | `/operations/{id}` | 取消管線 |
| LLM 狀態 | `GET` | `/llm/current` | 目前 LLM 狀態 |
| LLM 載入 | `PUT` | `/llm/current` | 載入本地模型 |
| LLM 卸載 | `DELETE` | `/llm/current` | 卸載模型 |
| LLM 目錄 | `GET` | `/llm/catalog` | 可用模型列表 |
| 匯出專案 | `POST` | `/projects/current/export` | 匯出為 khr/psd/rendered/inpainted |
| 事件串流 | `GET` | `/events` | SSE 事件訂閱 |

## 參考資源

- `scripts/upload_pages.js`：頁面上傳腳本
- `scripts/llm_control.js`：LLM 模型控制腳本
- `scripts/select_engines.js`：管線引擎選擇腳本（含 `.default-engines` 快取）
- `scripts/export_project.js`：專案匯出腳本
- `koharu-pipeline-launcher/scripts/start_pipeline.js`：管線啟動腳本
- `koharu-pipeline-launcher/scripts/listen_events.js`：SSE 事件監聽腳本
