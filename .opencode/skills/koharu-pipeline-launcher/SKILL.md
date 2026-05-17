---
name: koharu-pipeline-launcher
description: >
  啟動 Koharu HTTP API 工作管線並監聽事件串流。使用 POST /pipelines 啟動管線，
  回傳 operationId 後，會詢問使用者是否要監聽該工作的 events。
  使用 Node.js 腳本透過 HTTP /events SSE 串流監聽，直到收到 JobWarning 或 JobFinished 事件。
  適用於任何需要啟動 Koharu 翻譯、渲染、OCR 等管線並即時追蹤進度的情境。
  只要提到啟動管線、開始 pipeline、翻譯流程、或需要監控 Koharu 工作進度時就使用此 skill。
license: MIT
compatibility: opencode
metadata:
  audience: manga-translators
  language: zh-TW
  tools: nodejs, http-api
---

## 功能概述

本 skill 提供標準化的 Koharu 管線啟動與事件監聽流程：
1. 透過 `POST /api/v1/pipelines` 啟動管線
2. 取得 operationId 後，使用 `question` tool 詢問使用者是否監聽事件
3. 若使用者同意，執行 Node.js 監聽腳本，透過 SSE 串流接收 `/events`
4. 腳本佔據對話流，直到收到 `JobWarning` 或 `JobFinished` 事件

## 前置需求

- Koharu 服務已啟動（預設 `http://127.0.0.1:9999`）
- Node.js 已安裝且可在 PATH 中使用
- 專案已透過 HTTP API 開啟（`PUT /projects/current`）

## 執行流程

### 1. 啟動管線

使用 `scripts/start_pipeline.js` 腳本發送 `POST /api/v1/pipelines`：

```bash
node "scripts/start_pipeline.js" --steps "comic-text-detector,manga-ocr,llm,aot-inpainting,koharu-renderer" --target-language "zh-TW"
```

**重要：`steps` 必須填入實際的 engine id，而非步驟名稱。**

可用引擎類別與常見 id：
| 步驟 | API 欄位 | 常見 engine id |
|------|---------|---------------|
| 文字偵測 | detectors | `comic-text-detector`, `anime-text` |
| 文字辨識 | ocr | `manga-ocr`, `paddle-ocr-vl-1.5` |
| 翻譯 | translators | `llm` |
| 去字修復 | inpainters | `aot-inpainting`, `lama-manga` |
| 渲染 | renderers | `koharu-renderer` |

完整列表請呼叫 `GET /api/v1/engines` 取得。

請求體欄位：
- `steps`（必填）：按順序執行的引擎 id 陣列
- `pages`（選填）：`PageId` 子集；省略時處理整個專案
- `targetLanguage`（選填）：目標語言，如 `"zh-TW"`
- `systemPrompt`（選填）：自訂系統提示
- `defaultFont`（選填）：預設字型

成功時回傳 `{ operationId: "uuid-string" }`。

若回傳 `400 unknown engine` 錯誤，表示該引擎未安裝，需改用其他可用 engine id。

### 2. 詢問是否監聽

取得 operationId 後，**必須**使用 `question` tool 詢問使用者：

```tool-call
question({
  questions: [{
    question: `管線已啟動，Job ID: ${operationId}。是否要即時監聽工作事件？`,
    header: "監聽確認",
    options: [
      { label: "是，開始監聽", description: "執行 SSE 事件串流監聽腳本" },
      { label: "否，稍後再說", description: "不監聽，可自行用 API 查詢狀態" }
    ]
  }]
})
```

### 3. 執行監聽腳本

若使用者選擇監聽，執行 `scripts/listen_events.js`：

```bash
node "scripts/listen_events.js" --job-id "{operationId}" --base-url "http://127.0.0.1:9999"
```

腳本行為：
- 連線至 `{base-url}/api/v1/events` SSE 串流
- 即時印出每個接收到的事件（含類型、進度、訊息）
- 收到 `JobFinished` 事件時，以 exit code 0 結束
- 收到 `JobWarning` 事件時，印出警告後**繼續監聽**直到完成
- 超時（預設 600 秒）或連線錯誤時，以 exit code 1 結束

### 4. 處理結果

根據監聽結果：
- `JobFinished`：繼續後續步驟（如匯出）
- `JobWarning`：通知使用者警告內容，詢問是否繼續
- 超時/錯誤：回覆 `"QQ"`，不嘗試自動重試

## 錯誤處理

- 管線啟動失敗：立即回覆 `"QQ"`
- 監聽腳本超時：回覆 `"QQ"`
- 監聽腳本收到非預期的錯誤事件：回覆 `"QQ"`
- **不**嘗試自動重試或編造結果

## API 端點參考

| 動作 | 方法 | 端點 | 用途 |
|------|------|------|------|
| 啟動管線 | `POST` | `/pipelines` | 以 operation 形式啟動管線 |
| 查看操作 | `GET` | `/operations` | 取得所有正在運行或最近完成的 operation |
| 取消操作 | `DELETE` | `/operations/{id}` | 取消一次管線運行 |
| 事件串流 | `GET` | `/events` | SSE 事件訂閱 |

## 參考資源

- `scripts/start_pipeline.js`：管線啟動腳本
- `scripts/listen_events.js`：SSE 事件監聽腳本
