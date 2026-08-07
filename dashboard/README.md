# SwiftLM Dashboard

Dashboard 是平台的公開 API gateway 與管理介面，部署在 Zeabur Tencent Tokyo。模型權重不在這個服務中；所有推理會經由 SwiftLM origin、Wonder Mesh 與 relay 回到本機 Mac。

## 功能

- 管理員登入。
- 建立、列出與撤銷綁定指定機器的客戶 API key。
- OpenAI-compatible `/v1/models` 與 `/v1/chat/completions`。
- 多輪網頁聊天；在第一則訊息前選擇機器與模型。
- 模型機器頁面：每 5 秒確認每個 SwiftLM Origin 的模型在線狀態。
- API request、token、token/s、TTFT、排隊時間、延遲、機器、模型與內容 preview 紀錄。
- SQLite 持久化，Zeabur volume 掛載於 `/data`。

## 本機開發

```zsh
cd ~/Desktop/mlx-server/dashboard
npm install
cp .env.example .env
npm test
npm start
```

`.env` 只能保存本機開發 secrets，已被 Git 忽略。不要把 `ADMIN_PASSWORD`、`SESSION_SECRET`、`KEY_HASH_SECRET` 或 `UPSTREAM_API_KEY` 提交到 repository。

## 部署

Zeabur target 保存於 `.zeabur/deploy.json`，不含 secrets。正式 secrets 必須透過 Zeabur secret environment variables 設定。

必要變數：

```text
ADMIN_PASSWORD
SESSION_SECRET
KEY_HASH_SECRET
UPSTREAM_BASE_URL
UPSTREAM_API_KEY
MODEL_ID
MODEL_DISPLAY_NAME
DEFAULT_NODE_ID
DEFAULT_NODE_NAME
DATA_DIR=/data
```

目前 upstream 必須是：

```text
https://richard-swiftlm-origin-7165.zeabur.app/v1
```

不得設為 client-facing `richard-swiftlm.zeabur.app`，否則會形成代理迴圈。

## 機器與 API Key

第一台機器由 `UPSTREAM_BASE_URL`、`MODEL_ID` 與 `DEFAULT_NODE_*` 自動建立；舊有對話、Key 與 request history 會安全地遷移到這個預設節點。

之後在 Dashboard 的「機器」加入其他 SwiftLM Origin。每台機器目前代表一個活躍的 SwiftLM 模型服務，因此會有一個模型 ID；若同一部實體 Mac 要同時提供不同模型，請將每個獨立 SwiftLM service 以不同 Origin 登記為不同節點。

Dashboard API Key 是節點綁定的 client credential，不是 SwiftLM Master Key。客戶仍呼叫同一個公開 endpoint：

```text
https://richard-swiftlm.zeabur.app/v1
```

Dashboard 會根據 Key 的 `node_id` 轉送到正確 Origin，並拒絕不屬於該節點的 `model`。

完整網路架構與 Wonder Mesh 重建流程請見 [../docs/wonder-mesh-local-api.md](../docs/wonder-mesh-local-api.md)。
