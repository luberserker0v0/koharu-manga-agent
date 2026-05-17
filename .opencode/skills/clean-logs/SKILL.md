---
name: clean-logs
description: 清理 Subagent 執行日誌。使用此 skill 當使用者要求清理 logs 資料夾、刪除舊日誌、或管理日誌檔案時。
---

## 功能概述

清理 `logs/` 目錄下的 Subagent 執行日誌，支援依時間、子代理類型或全部清理。

## 使用時機

✅ 當使用者要求「清理日誌」、「刪除舊日誌」時  
✅ 當日誌檔案過多，需要釋放空間時  
✅ 定期維護時  

## 執行流程

### 1. 列出目前日誌統計

```bash
node .opencode/skills/clean-logs/scripts/clean_logs.js --list
```

### 2. 清理指定條件的日誌

```bash
# 清理 7 天前的日誌
node .opencode/skills/clean-logs/scripts/clean_logs.js --older-than 7d

# 清理特定 subagent 的日誌
node .opencode/skills/clean-logs/scripts/clean_logs.js --subagent pipeline-runner

# 清理所有日誌
node .opencode/skills/clean-logs/scripts/clean_logs.js --all
```

## 輸出格式

```json
{
  "success": true,
  "deleted": 15,
  "remaining": 3,
  "freedBytes": 1048576
}
```

## 錯誤處理

- 若日誌目錄不存在，回傳提示建立
- 若無符合條件的日誌，回傳提示
