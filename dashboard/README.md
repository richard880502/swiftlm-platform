# SwiftLM Dashboard

Dashboard 是平台的公開 API gateway 與管理介面，部署在 Zeabur Tencent Tokyo。模型權重不在這個服務中；推理一律經由 private transport 回到對應的節點機器——預設節點是透過 SwiftLM origin、Wonder Mesh 與 relay 連回本機 Mac。

## 功能

- 管理員登入。
- 建立、列出與撤銷綁定指定機器的客戶 API key。
- OpenAI-compatible `/v1/models` 與 `/v1/chat/completions`。
- 多輪網頁聊天；在第一則訊息前選擇機器與模型。
- 模型機器頁面：每 5 秒確認每個節點的模型在線狀態，並可偵測節點的 inference backend。
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

之後在 Dashboard 的「機器」加入其他 SwiftLM、vLLM 或任何 OpenAI 相容 Origin。每台機器目前代表一個活躍的模型服務，因此會有一個模型 ID；若同一部實體 Mac 要同時提供不同模型，請將每個獨立 service 以不同 Origin 登記為不同節點。

新增節點時需要填入該服務的 `/v1` URL、inference backend（`swiftlm` / `vllm` / `llamacpp` / `generic`）與驗證方式。「偵測 backend 與模型」會以一次 `/models` 請求判斷 backend 並帶出該節點已提供的模型。

驗證方式有三種：`bearer`（該節點自己的上游 API Key）、`api_key_header`（自訂 header 名稱）與 `none`。上游 API Key 因此不再是必填欄位——只監聽私有網路、由 private transport 保護的節點（例如 `vllm serve --host 127.0.0.1`）可以選 `none`。有設定憑證時，Dashboard 只在伺服器端使用，並以伺服器祕密加密後保存；節點列表、瀏覽器與 Dashboard 發給客戶的 API key 都不會取得它。這讓每台機器可以獨立輪替或撤銷上游憑證。預設節點的 master key 只借給預設節點自己，不會被送到其他節點的 endpoint。

若額外節點要更換憑證或改變驗證方式，在「機器」列點選「更新驗證」即可直接替換，不需要刪除、重建節點或重發 Dashboard API Key。預設 Mac mini 的 key 仍由 Zeabur 環境設定管理。

不同 backend 的差異只影響上游請求，不影響 client：SwiftLM-specific 的 metrics header 與 `enable_thinking` 不會原樣送到 vLLM，而不支援的 metrics 在使用紀錄中是 `null`。細節見 [../docs/inference-nodes.md](../docs/inference-nodes.md)。

預設機器不能刪除。其他機器可隨時刪除；Dashboard 會先列出影響範圍並要求確認。確認後，該節點的 Dashboard API Key、對話與使用紀錄會一併永久刪除。

## 停止生成

對話生成期間，輸入框右下角會顯示紅色停止按鈕。點擊後 Dashboard 會明確取消該次上游串流並通知 MLX Gateway 取消本機工作；已生成的文字會保留，對話可立即繼續。重新整理頁面不會觸發取消，只有按下停止按鈕才會中止生成。

Dashboard API Key 是節點綁定的 client credential，不是 SwiftLM Master Key。客戶仍呼叫同一個公開 endpoint：

```text
https://richard-swiftlm.zeabur.app/v1
```

Dashboard 會根據 Key 的 `node_id` 轉送到正確 Origin，並拒絕不屬於該節點的 `model`。

完整網路架構與 Wonder Mesh 重建流程請見 [../docs/wonder-mesh-local-api.md](../docs/wonder-mesh-local-api.md)。
