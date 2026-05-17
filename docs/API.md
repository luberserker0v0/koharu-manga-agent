# API 參考文件 - Koharu HTTP API

> **注意**：所有 API 端點已集中管理於 `.opencode/skills/shared/api.js` 的 `ENDPOINTS` 物件。
> 腳本應使用 `apiFetch(ENDPOINTS.XXX)` 而非硬編碼路徑。

## 1. 基礎資訊
- **Base URL**: `http://127.0.0.1:9999/api/v1`
- **Content-Type**: `application/json`
- **認證**: 無（本地服務）

## 2. 專案管理

### 2.1 列出所有專案
```http
GET /projects
```
**回應**:
```json
{
  "projects": [
    {
      "id": "untitled",
      "name": "我是星際國家的惡德領主",
      "path": "C:\\Users\\...\\untitled.khrproj",
      "updatedAtMs": 1778956213239
    }
  ]
}
```

### 2.2 開啟專案
```http
PUT /projects/current
Content-Type: application/json

{
  "id": "untitled"
}
```

### 2.3 關閉專案
```http
DELETE /projects/current
```

### 2.4 創建專案
```http
POST /projects
Content-Type: application/json

{
  "name": "新專案名稱"
}
```

## 3. 頁面上傳

### 3.1 從路徑上傳（快速通道）
```http
POST /pages/from-paths
Content-Type: application/json

{
  "paths": ["C:\\path\\to\\page1.jpg", "C:\\path\\to\\page2.png"],
  "replace": false
}
```

### 3.2 Multipart 上傳
```http
POST /pages
Content-Type: multipart/form-data; boundary=----FormBoundary...

------FormBoundary...
Content-Disposition: form-data; name="files"; filename="page1.jpg"
Content-Type: application/octet-stream

<binary data>
------FormBoundary...--
```

## 4. LLM 模型控制

### 4.1 查看當前狀態
```http
GET /llm/current
```
**回應**:
```json
{
  "status": "ready",
  "target": {
    "kind": "provider",
    "modelId": "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    "providerId": "openai-compatible"
  },
  "error": null
}
```

### 4.2 載入模型
```http
PUT /llm/current
Content-Type: application/json

{
  "target": {
    "kind": "provider",
    "modelId": "gemma-4-e4b-uncensored-hauhaucs-aggressive",
    "providerId": "openai-compatible"
  }
}
```

或使用 local 模式：
```http
PUT /llm/current
Content-Type: application/json

{
  "target": {
    "kind": "local",
    "modelId": "qwen3.6-27b",
    "providerId": null
  }
}
```

### 4.3 卸載模型
```http
DELETE /llm/current
```

### 4.4 列出可用模型
```http
GET /llm/catalog
```
**回應**:
```json
{
  "localModels": [
    {
      "target": { "kind": "local", "modelId": "qwen3.6-27b", "providerId": null },
      "name": "qwen3.6-27b",
      "languages": ["zh-CN", "en-US", "zh-TW", ...]
    }
  ],
  "providers": [...]
}
```

## 5. 管線控制

### 5.1 啟動管線
```http
POST /pipelines
Content-Type: application/json

{
  "steps": ["comic-text-detector", "speech-bubble-segmentation", "paddle-ocr-vl-1.5", "llm", "aot-inpainting", "koharu-renderer"],
  "targetLanguage": "zh-TW"
}
```
**回應**:
```json
{
  "operationId": "a8db1072-b0c8-4d21-ae2c-228542251227"
}
```

### 5.2 查看運行中操作
```http
GET /operations
```

### 5.3 取消操作
```http
DELETE /operations/{id}
```

## 6. 場景與歷史

### 6.1 場景快照
```http
GET /scene.json
```

### 6.2 套用操作
```http
POST /history/apply
Content-Type: application/json

{
  "batch": {
    "ops": [
      {
        "updateNode": {
          "page": "page-uuid",
          "id": "node-uuid",
          "patch": {
            "data": {
              "text": {
                "translation": "新翻譯內容"
              }
            }
          }
        }
      }
    ],
    "label": "quality_check_fixes"
  }
}
```
**回應**:
```json
{
  "epoch": 167
}
```

### 6.3 撤銷/重做
```http
POST /history/undo
POST /history/redo
```

## 7. 引擎管理

### 7.1 列出可用引擎
```http
GET /engines
```
**回應**:
```json
{
  "detectors": [{ "id": "comic-text-detector", "name": "Comic Text Detector", ... }],
  "ocr": [{ "id": "paddle-ocr-vl-1.5", "name": "PaddleOCR-VL", ... }],
  "translators": [{ "id": "llm", "name": "LLM", ... }],
  "inpainters": [{ "id": "aot-inpainting", "name": "AOT Inpainting", ... }],
  "renderers": [{ "id": "koharu-renderer", "name": "Koharu Renderer", ... }]
}
```

## 8. 匯出

### 8.1 匯出專案
```http
POST /projects/current/export
Content-Type: application/json

{
  "format": "rendered"
}
```
**支援格式**: `rendered`, `psd`, `khr`, `inpainted`

## 9. 事件串流 (SSE)

### 9.1 訂閱事件
```http
GET /events
Accept: text/event-stream
```
**事件類型**:
- `jobStarted`: 工作開始
- `jobProgress`: 進度更新
- `jobFinished`: 工作完成
- `jobWarning`: 警告訊息
- `snapshot`: 初始快照

**進度事件格式**:
```json
{
  "event": "jobProgress",
  "step": "ocr",
  "overallPercent": 50,
  "currentPage": 1,
  "totalPages": 3
}
```

## 10. 錯誤處理

### 10.1 常見錯誤碼
| 狀態碼 | 描述 | 處理方式 |
|--------|------|---------|
| 400 | 請求格式錯誤 | 檢查 payload 格式 |
| 404 | 資源不存在 | 確認 ID 正確 |
| 405 | 方法不允許 | 檢查 HTTP 方法 |
| 422 | 驗證失敗 | 檢查欄位格式 |
| 500 | 伺服器錯誤 | 重試或檢查日誌 |

### 10.2 錯誤回應格式
```json
{
  "status": 422,
  "message": "Failed to deserialize the JSON body into the target type: ..."
}
```

## 11. 腳本對應表

| 腳本 | API 端點 | 功能 |
|------|---------|------|
| `open-project.js` | `GET/PUT/DELETE /projects` | 專案管理 |
| `upload_pages.js` | `POST /pages` | 頁面上傳 |
| `llm_control.js` | `GET/PUT/DELETE /llm` | 模型控制 |
| `select_engines.js` | `GET /engines` | 引擎選擇 |
| `start_pipeline.js` | `POST /pipelines` | 管線啟動 |
| `listen_events.js` | `GET /events` | 事件監聽 |
| `quality_check.js` | `GET /scene.json` | 品質檢查 |
| `apply_fixes.js` | `POST /history/apply` | 套用修正 |
| `export_project.js` | `POST /projects/current/export` | 專案匯出 |
