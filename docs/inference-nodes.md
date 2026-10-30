# 異質推理節點與 provider adapter

Dashboard 對 client 永遠只提供一組 OpenAI-compatible `/v1` API。底層節點可以是不同硬體與不同 inference backend，client 不需要知道差別。

這份文件說明 Phase 1（vLLM compatibility）、Phase 2（Node Agent）、Phase 3（Secure enrollment）與 Phase 4 的一部分（多模型節點）已經完成的部分，以及仍未實作的部分。

## 分層

```text
Client
  │ sk-mlx-*
  ▼
Dashboard / API Gateway        client auth、node selection、audit
  │
  ▼
OpenAI protocol adapter        /models、/chat/completions、streaming、usage
  │
  ├─ SwiftLM provider extension
  ├─ vLLM provider extension
  ├─ llama.cpp provider extension
  └─ generic OpenAI-compatible
  │
  ▼
Private transport（Wonder Mesh / Tailscale / WireGuard / LAN）
  │
  ▼
Inference runtime
```

共用的 adapter 在 `dashboard/src/proxy.js`，只處理所有 backend 都一樣的事情。backend 之間真正不同的部分集中在 `dashboard/src/providers.js`。

## Node 資料模型

`nodes` 表以 backend descriptor 描述一台機器：

| 欄位 | 說明 |
| --- | --- |
| `id` / `name` | 節點識別與顯示名稱 |
| `origin_base_url` | 節點的 OpenAI `/v1` root（可帶前綴路徑，只要求以 `/v1` 結尾） |
| `provider` | `swiftlm` / `vllm` / `llamacpp` / `generic` |
| `protocol` | 目前只支援 `openai` |
| `auth_type` | `none` / `bearer` / `api_key_header`（`mtls` 已保留但尚未實作，會在 API 層被拒絕） |
| `auth_header` | `api_key_header` 時使用的 header 名稱，預設 `X-API-Key` |
| `upstream_api_key` | 憑證，AES-256-GCM 加密保存；`auth_type = none` 時為 `NULL` |
| `capabilities` | JSON；未設定時採用該 provider 的預設能力 |
| `model_id` / `model_name` | 節點的預設模型（新對話沒有指定模型時的目標），實際可用模型集合見下方 `node_models` |

既有資料庫升級後，所有舊節點都會拿到 `provider = swiftlm`、`protocol = openai`、`auth_type = bearer`，行為與升級前完全相同。

`upstream_api_key` 不再是必填欄位，只是其中一種 credential strategy。私有網路上的 vLLM 可以用 `auth_type = none` 加入。

預設節點的憑證來自 server 環境變數，且只借給預設節點本身；其他節點若沒有自己的憑證，不會拿到 SwiftLM master key。

## Provider 差異

| | SwiftLM | vLLM | llama.cpp | generic |
| --- | --- | --- | --- | --- |
| 額外 request header | `X-MLX-Include-Metrics` | 無 | 無 | 無 |
| `enable_thinking` | 原樣送出 | 轉成 `chat_template_kwargs` | 移除 | 移除 |
| inline metrics | `event: mlx-metrics` | 無 | 非串流 `timings` | 無 |
| `queue_ms` | 節點回報 | `null` | `null` | `null` |

SwiftLM-specific 欄位不會流到不認得它的 backend：vLLM 對未知的 top-level 欄位會回 400，所以 `enable_thinking` 必須轉成 chat template 參數而不是直接送出。

### Metrics 正規化

不同 backend 的 metrics 會被正規化成同一組欄位（`prompt_tokens`、`completion_tokens`、`queue_ms`、`ttft_ms`、`throughput_tps`），使用紀錄才能跨 backend 比較。

- backend 自己回報的數值優先。
- backend 沒有回報時，Gateway 會用自己觀察到的串流時間補上 `ttft_ms` 與 `throughput_tps`。Gateway 量到的 TTFT 包含到節點的網路往返，因此節點自己回報的值一定優先。
- `queue_ms` 只有 backend 回報時才有值；Gateway 看不到上游排隊，所以不會猜。
- 不支援的 metrics 是 `null`，不是錯誤。

## 加入一台 vLLM 節點

節點端只需要讓 vLLM 監聽在私有網路可達的位置：

```bash
vllm serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8000
```

再把該位址透過私有 transport 發布，於 Dashboard 的「機器」頁面：

1. 填入節點 `/v1` 網址。
2. 按「偵測 backend 與模型」，Dashboard 會辨識出 vLLM 並帶出模型 ID。
3. 驗證方式選「無驗證」（私有網路節點）或設定憑證。
4. 加入後即可為該節點建立 `sk-mlx-*` client key。

backend 偵測依據：`x-mlx-request-id` header 代表 SwiftLM；`/v1/models` 出現 `owned_by: vllm` 或 `max_model_len` 代表 vLLM；`owned_by` 含 `llamacpp` 代表 llama.cpp；其餘視為 generic OpenAI-compatible。

這是手動加入節點的路徑：管理員自己輸入網址與憑證，Dashboard 相信這個網址。下一節的 enrollment 流程解決的是另一個問題——讓節點自己證明身分，而不是單靠網路拓樸。

## 一個節點提供多個模型

`node_models` 表記錄一個節點可以服務哪些模型：

| 欄位 | 說明 |
| --- | --- |
| `node_id` / `model_id` | 複合 UNIQUE，同一個模型不能在同一節點重複註冊 |
| `model_name` | 顯示名稱 |
| `enabled` | 停用後這個模型立即對 client 不可見，但仍保留在清單裡（跟停用整台機器是同一種可逆動作） |

**範圍界定**：這裡處理的是「一個 endpoint 原生支援多個模型」的情況——vLLM 新版、Ollama、LM Studio 這類 backend 本身就能用 request body 的 `model` 欄位在多個模型間切換，一個 `origin_base_url` 就能服務全部。**不是**「同一個 node 橫跨兩個不同 port/兩個獨立 process」。後者每個 port 都是獨立的推理進程，如果透過 enrollment 使用 node-agent，也會是獨立的 node-agent 身分（`node_secret` 是綁在一個監聽 port 上的），因此仍然要註冊成兩個獨立的 node、發兩把不同的 client key——這點沒有改變，`node_models` 不會、也不應該讓兩個 port 共用一個 node 身分。

行為：

- 建立節點時自動把它自己的 `model_id`/`model_name` 註冊進 `node_models`；這是唯一保證每個節點至少有一個可用模型的地方。
- 在「機器」頁面每張節點卡片下方可以看到目前註冊的模型（chip 形式），「+ 新增模型」可以加入同一個 endpoint 支援的其他模型 ID；每個 chip 可以個別停用或移除。
- 節點至少要保留一個模型；移除最後一個會被拒絕（後端 409、前端也不會顯示移除按鈕），要整個下線就直接刪除節點。
- Client 端 `/v1/models` 回傳的是這個節點目前啟用的模型清單，`/v1/chat/completions` 的 `model` 欄位只要在這個清單裡就會被原樣轉送給 backend——不會像 Phase 1 時那樣被硬改寫成節點的預設模型。一把 client key 綁定的是節點，不是單一模型，因此同一把 key 現在可以呼叫節點上任何一個已啟用的模型。
- Dashboard 網頁聊天的「新對話」預設用節點的主要模型，但可以在送出第一則訊息前用模型下拉選單換成節點上的其他模型；對話一旦有訊息就會固定使用當時選的模型（跟固定 node 是同一個機制）。

## 目前的安全邊界方向：優先用 Tailscale，Enrollment 暫緩

下面兩節（三種憑證通道、Enrollment 流程）描述的 HMAC enrollment 機制**已經實作、程式碼保留**，但目前決定**不是新節點的建議路徑**，後續也暫緩繼續投資（例如原本規劃的「vLLM 專用 node-agent」）。

原因：很多節點（尤其 vLLM）不一定能、或不一定想在 backend 本機額外安裝東西。與其為每種 backend 各寫一個 node-agent 來做 request 層簽章驗證，改用 Tailscale（或其他 mesh VPN）本身的裝置級 ACL 更省事、也更扎實——它是成熟系統做的網路層身分驗證（WireGuard 金鑰 + ACL），擋在 TCP 連線建立之前，而不是進來之後才驗證 request。只要節點所在機器（或機器上專門負責轉發的 VM）本身加入 tailnet，把 `origin_base_url` 指到 Tailscale 配發的位址，ACL 限制只有 Dashboard 能連進來，`auth_type` 就可以安心設 `none`，不需要 enrollment、不需要 node_secret、不需要 node-agent。

兩條路徑不衝突、可以並存，依節點情況選一種：

| | Tailscale ACL（建議） | Enrollment（HMAC，見下） |
| --- | --- | --- |
| 驗證發生在哪一層 | 網路層（TCP 連線建立前） | Request 層（HTTP header 簽章） |
| Backend 主機需要裝什麼 | 只要 tailnet 裡有一個節點（機器本身或機器上的 VM）| 需要一個懂 HTTP 的 node-agent（目前只有 `mlx-gateway`/SwiftLM 有） |
| 目前狀態 | 建議方向，程式碼不需要改動（`origin_base_url` 本來就是透明的） | 已完成、保留給已經在用 `mlx-gateway` 的 SwiftLM 節點 |

具體部署步驟見 [用 Tailscale 部署新節點](tailscale-node-deployment.md)。

## 三種憑證通道

平台上同時存在三種彼此獨立的憑證，任何一種外洩都不能讓攻擊者取得其他兩種的權限：

| 通道 | 方向 | 用途 | 實作 |
| --- | --- | --- | --- |
| Client API Key | Client → Dashboard | 控制誰能呼叫哪個 model/node、quota | `sk-mlx-*`，HMAC digest 存於 `api_keys` |
| Node Identity | Node Agent → Dashboard | 證明 heartbeat／註冊確實來自這台已註冊的節點 | enrollment 時發出的 `node_secret`，HMAC 簽章 |
| Gateway Identity | Dashboard → Node Agent | 防止知道節點網路位址的第三方直接呼叫 GPU | 與 Node Identity 共用同一把 `node_secret`（MVP 選擇，見下） |
| （另外）Backend 憑證 | Node Agent → 本機 backend | 節點自己的 inference runtime 需要的憑證，例如 SwiftLM 的 upstream API key | 就是 Phase 1 的 `auth_type` / `upstream_api_key`，與上面三者無關 |

Node Identity 與 Gateway Identity 的簽章邏輯完全相同（HMAC-SHA256，涵蓋 `METHOD/PATH/NODE_ID/TIMESTAMP/NONCE/SHA256(BODY)`），只是方向相反，因此 MVP 選擇讓它們共用同一把由 enrollment 產生的 `node_secret`，而不是像架構提案裡 Ed25519 那樣為兩個方向各自準備一對金鑰。程式碼分別在 `dashboard/src/nodeAuth.js`（Dashboard 端）與 `mlx-gateway/nodeAgent.mjs`（節點端）——兩份刻意重複而非共用套件，因為兩者部署到完全不同的地方，不應該互相依賴對方的執行環境；`mlx-gateway/nodeAgent.test.mjs` 有一個測試專門驗證兩份實作對同一組輸入產生完全一致的簽章。

## Enrollment 流程

```text
1. 管理員在 Dashboard「機器」頁面按「產生 Token」
   → enroll_xxxxx，10 分鐘內有效、single-use、DB 只存 digest

2. 節點端執行
   swiftlm-node join enroll_xxxxx \
     --server https://dashboard.example.com \
     --name "GPU 01" \
     --base-url https://gpu-01-origin.example/v1 \
     --model-id Qwen/Qwen3-32B
   → 呼叫 POST /api/node-agent/enroll
   → Dashboard 驗證 token（存在、未使用、未過期）後建立 node，產生 node_secret
   → token 立即被標記為已使用（DB 層的 atomic UPDATE ... WHERE used_at IS NULL 保證不會被用兩次）
   → node_id + node_secret 存到本機 .state/node-agent.json（只回傳一次，權限 0600）

3. 重啟 mlx-gateway，它會讀到 .state/node-agent.json 並：
   - 每 30 秒送一次簽章 heartbeat 到 /api/node-agent/:id/heartbeat
   - 要求所有會轉發到本機 backend 的請求都必須帶有效的 Gateway-Identity 簽章
```

`--base-url` 是 Dashboard 用來連回這個節點的位址（透過 Wonder Mesh / Tailscale 等私有 transport 曝露），不是本機 backend 的 port。此位址必須在 enroll 當下就能被 Dashboard 使用——目前還不支援節點主動建立 outbound tunnel（見「尚未實作」）。

Node 一旦 enrollment 完成，`auth_type` 預設為 `none`：Gateway-Identity 簽章才是設計上的保護機制，不是靠再疊一把 backend bearer key。兩者可以並存，但不是必要。

### Replay protection

簽章涵蓋 timestamp（預設 ±5 分鐘窗口）與 nonce（依 node_id 分開快取，避免不同節點剛好選到同個 nonce 而誤判）。同一個簽章重送第二次會被拒絕；`dashboard/src/nodeAuth.js` 與 `mlx-gateway/nodeAgent.mjs` 的 `createNonceCache()` 各自維護自己方向的 nonce 快取（Dashboard 對 heartbeat、節點對轉發請求）。nonce 快取存在記憶體中，Dashboard 或節點重啟會讓快取歸零——在 timestamp 窗口內這是可接受的 MVP 折衷。

## Node Agent（`mlx-gateway` 的 opt-in 模式）

沒有直接建立新的 `swiftlm-node-agent` package，而是照 issue 裡的建議把 enrollment/heartbeat/簽章驗證能力加進現有的 `mlx-gateway`，且完全是 opt-in：

- 沒有 `.state/node-agent.json`（沒有跑過 `join.mjs`）時，`mlx-gateway` 的行為與這次改動前完全一樣——不驗證簽章、不送 heartbeat。這是為了不影響現有正在跑的 Mac mini 部署。
- 有 enrollment state 時，除了 `/__mlx/*` 監控端點（本來就只允許 loopback）以外，所有會轉發到本機 backend 的請求都需要通過 Gateway-Identity 簽章驗證，否則回 401。

**範圍限制**：`mlx-gateway` 本身的 proxy/queue 核心仍是 SwiftLM-specific（解析 `mlx-metrics` SSE、注入 `x-mlx-request-id` 等），這次沒有重寫。但 `mlx-gateway/nodeAgent.mjs`（enrollment、簽章、heartbeat）完全不依賴 SwiftLM，未來要讓一個前面接 vLLM 或 llama.cpp 的 agent 具備同樣的 enrollment/簽章能力，可以直接重用這個檔案，不需要重新設計協定。

## 尚未實作

- **Ed25519 / mTLS 升級**：目前 Node Identity 與 Gateway Identity 都是 issue 裡列的 HMAC MVP 路徑，不是 Ed25519。升級只需要替換 `sign`/`verify` 兩個函式，呼叫端（enrollment、heartbeat、proxy 簽章）不需要改。
- **Node-initiated outbound tunnel**：目前仍是「Dashboard 主動連到 node.origin_base_url」，enrollment 也要求節點在加入當下就可被 Dashboard 連到。issue 提出的「節點主動建立 outbound tunnel」尚未實作。
- **node_secret 輪替**：沒有 rotation endpoint；要更換就是撤銷舊節點、重新 enrollment。
- **非 SwiftLM 的 node agent backend proxy**：`nodeAgent.mjs` 本身與 backend 無關，理論上可以重用給 vLLM/llama.cpp，但目前**暫緩投資這個方向**——新節點優先用 Tailscale ACL（見上方「目前的安全邊界方向」），不再規劃另外做一個 vLLM 專用 node-agent。
- **同一個 node 橫跨多個 port**：`node_models` 只解決「一個 endpoint 原生支援多模型」；同一台主機上兩個獨立的推理 process（兩個 port）仍然要註冊成兩個 node、發兩把不同的 client key，見上一節的範圍界定。
- **API key 的 node/model 權限矩陣**：目前一把 key 綁一個 node，可以用該 node 所有已啟用的模型；issue 提出的 `allowed_nodes` / `allowed_models` 更細緻的權限矩陣（例如同一把 key 跨多個 node，或限制只能用某個 node 的部分模型）還沒做。
- **Capability-aware routing / scheduler**：目前 client 送出的 `model` 只是「在這個 node 上找不找得到這個 model_id」的靜態檢查，沒有依 capability（例如自動挑一個目前有空的節點）做動態路由。
