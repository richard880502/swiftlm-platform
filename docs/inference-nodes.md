# 異質推理節點與 provider adapter

Dashboard 對 client 永遠只提供一組 OpenAI-compatible `/v1` API。底層節點可以是不同硬體與不同 inference backend，client 不需要知道差別。

這份文件說明 Phase 1（vLLM compatibility）已經完成的部分，以及後續 phase 的預留位置。

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
| `model_id` / `model_name` | 目前仍是 1 Node = 1 model，多模型留待 Phase 4 的 `node_models` |

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

## 後續 phase

Phase 1 只讓不同 backend 可以共存，尚未包含：

- **Phase 2 — Node Agent**：把 `mlx-gateway` 泛化成 `swiftlm-node-agent`，負責 backend discovery、heartbeat、capability reporting 與 model 同步。目前 `capabilities` 欄位已預留給 agent 回報。
- **Phase 3 — Secure enrollment**：一次性 enrollment token、node identity、Gateway → Node 與 Node → Dashboard 的請求簽章與 replay protection。目前節點仍由管理員手動加入，Gateway 對節點的保護依賴 private transport 與 `auth_type`。
- **Phase 4 — multi-model / routing**：`node_models`、API key 的 node/model 權限與 capability-aware routing。目前仍是 1 Node = 1 model。
