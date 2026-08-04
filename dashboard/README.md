# SwiftLM Dashboard

Dashboard 是平台的公開 API gateway 與管理介面，部署在 Zeabur Tencent Tokyo。模型權重不在這個服務中；所有推理會經由 SwiftLM origin、Wonder Mesh 與 relay 回到本機 Mac。

## 功能

- 管理員登入。
- 建立、列出與撤銷客戶 API key。
- OpenAI-compatible `/v1/models` 與 `/v1/chat/completions`。
- 多輪網頁聊天。
- API request、token、延遲與內容 preview 紀錄。
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
DATA_DIR=/data
```

目前 upstream 必須是：

```text
https://richard-swiftlm-origin-7165.zeabur.app/v1
```

不得設為 client-facing `richard-swiftlm.zeabur.app`，否則會形成代理迴圈。

完整網路架構與 Wonder Mesh 重建流程請見 [../docs/wonder-mesh-local-api.md](../docs/wonder-mesh-local-api.md)。
