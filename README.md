# SwiftLM Platform

這是一個完整的本機 LLM API 平台：本機 Apple Silicon 負責模型推理，Zeabur Wonder Mesh 提供外網連線，Dashboard 負責客戶 API key、聊天與使用紀錄。

本機模型使用 SwiftLM 的 SSD expert streaming 執行：

`majentik/Qwen3.6-35B-A3B-TurboQuant-MLX-4bit`

## 最簡單的用法

```zsh
cd ~/Desktop/mlx-server
./mlx start
./mlx status
./mlx test
./mlx logs engine
./mlx logs requests
./mlx stop
```

也可以從 Finder 雙擊：

- `start.command`：啟動
- `stop.command`：停止

查看所有指令：

```zsh
./mlx help
```

## 網址

- 本機 Gateway：`http://127.0.0.1:18124/v1`
- SwiftLM Direct（內部）：`http://127.0.0.1:18123/v1`
- Client API：`https://richard-swiftlm.zeabur.app/v1`
- SwiftLM origin：`https://richard-swiftlm-origin-7165.zeabur.app/v1`

Client API 使用 Dashboard 產生的 `sk-mlx-...` key。Origin 只供 Dashboard 與管理測試使用，使用 SwiftLM master key。

## 重要檔案

- `config.env`：模型、Port、Context、記憶體與公開網址。
- `mlx`：唯一管理指令。
- `common.sh`：共用設定與模型路徑解析。
- `swiftlm-runtime/`：SwiftLM binary 與 Metal runtime。
- `mlx-gateway/`：統一入口、推理佇列、request ID 與結構化效能紀錄。
- `dashboard/`：Zeabur Dashboard、API gateway、聊天及 request history。
- `deploy/wondermesh/`：Wonder Mesh relay 部署檔。
- `.state/`：PID 與後台日誌。

## 兩種日誌

```zsh
./mlx logs engine
```

顯示 SwiftLM／Metal 原始輸出，適合診斷模型與崩潰；併發輸出的文字可能交錯。

```zsh
./mlx logs requests
```

顯示經過 MLX Gateway 的 running、waiting、queue time、TTFT、tokens 與 throughput。每個請求都有獨立 request ID，不保存提示詞或完整回答。

模型保存在 `.cache/huggingface/`，目前使用的下載工具環境是 `.venv/`。

## Wonder Mesh 部署指南

完整的外網發布流程、視覺架構圖、安全邊界與故障排除請見：

[本機 API 透過 Zeabur Wonder Mesh 對外服務](docs/wonder-mesh-local-api.md)

Dashboard 的開發與部署方式請見 [dashboard/README.md](dashboard/README.md)。
