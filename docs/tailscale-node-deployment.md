# 用 Tailscale 部署新節點（不需要 node-agent）

這份文件說明 [inference-nodes.md](inference-nodes.md) 裡「優先用 Tailscale」那個方向的具體部署步驟：讓一個 backend（vLLM、llama.cpp、SwiftLM…）不需要安裝任何 SwiftLM 專屬軟體，就能安全地被 Dashboard 存取。

適用情境：backend 主機不方便、或不想在 backend process 本身額外裝東西；用 Tailscale 的裝置級 ACL 當安全邊界，取代 request 層的 HMAC enrollment。

## 架構

```text
Dashboard（Zeabur）
    │ Tailscale tailnet（ACL 只允許 Dashboard 連進來）
    ▼
VM / 轉發層（機器上跑 tailscale client）
    │ 機器內部私有網路（例如 Lima vmnet，外部連不到）
    ▼
Backend（vLLM / SwiftLM / ...），只聽 127.0.0.1
```

跟現有 `docs/wonder-mesh-local-api.md` 的差別：那份文件的 relay（`socat`）跑在 **Zeabur 雲端**，靠 Wonder Mesh Gateway 把公開網域路由過去；這裡的轉發層跑在 **機器本地的 VM**，靠 Tailscale 的裝置身分 + ACL 決定誰連得進來，不需要公開網域，也不需要 Wonder Mesh Gateway 那一層。

## 節點端（VM）步驟

1. **Backend 只聽 loopback**，不要 `--host 0.0.0.0`：

   ```bash
   vllm serve Qwen/Qwen3-32B --host 127.0.0.1 --port 8000
   ```

2. **VM 裡安裝 Tailscale 並加入你的 tailnet**：

   ```bash
   tailscale up
   ```

   記下這台 VM 的 Tailscale IP（`100.x.x.x`）或設定 MagicDNS 名稱。

3. **VM 內把 Tailscale 收到的請求轉發到機器的私有 IP**（VM 到實體機器之間走的是機器內部虛擬網卡，例如 Lima 的 `192.168.5.x`，外部連不到這一段）：

   ```bash
   socat TCP-LISTEN:8000,fork,reuseaddr,bind=100.x.x.x TCP:192.168.5.2:8000
   ```

   這裡的 `socat` 換成任何你熟悉的轉發工具都可以（`nginx stream`、`nftables` port forward 等）；重點只是「監聽 Tailscale 這一側，轉發到本機私有網段的 backend port」，不用做任何驗證或解析——驗證交給下一步的 ACL。

4. **設定 Tailscale ACL，只允許 Dashboard 的裝置連到這個 port**：在 Tailscale 管理後台（或 `acl.hujson`）限制只有 Dashboard 的 tailnet 身分能存取這台 VM 的對應 port/tag。沒有寫進 ACL 的裝置，連 TCP 都連不上，不會走到任何 HTTP 層。

## Dashboard 端

在「機器」頁面手動加入節點：

- 節點 `/v1` 網址：`http://<VM 的 Tailscale IP 或 MagicDNS>:8000/v1`
- 驗證方式：`none`（安全邊界是 Tailscale ACL，不是這裡）；如果 backend 自己也有 API key，也可以疊上 `bearer` 當多一層防護，但不是必要
- 不需要跑 enrollment、不需要 node-agent、不需要 `swiftlm-node join`

## 尚待驗證的一塊：Dashboard 自己要怎麼加入 tailnet

上面的步驟都是「節點這一側」，都很確定可行。但 Dashboard 本身跑在 Zeabur——**要讓 Zeabur 上的 Dashboard 容器直接連到 Tailscale tailnet 裡的位址，需要 Dashboard 容器本身也是 tailnet 成員**，這件事目前還沒有在這個專案裡驗證過，老實列出幾個可能做法，都各有限制，實際選哪個要看 Zeabur 容器的權限：

- **Tailscale sidecar / userspace networking**：在 Dashboard 的容器裡跑 `tailscaled --tun=userspace-networking`，不需要 `NET_ADMIN`/TUN device 權限，很多受限的容器環境（可能包含 Zeabur）都能用這個模式，但要另外設定 SOCKS5/HTTP proxy 模式讓 Node.js 的 `fetch` 走這個 proxy 出去，這部分還沒測試過。
- **Tailscale subnet router**：找一台你自己控制、能跑完整 tailscale client 的機器（例如某台一直開著的伺服器）當 subnet router，把 tailnet 的位址段廣播出去，讓 Zeabur 用一般網路路由連到——但 Zeabur 本身是不是能連到那台 subnet router 的公開位址，一樣要驗證。
- **Tailscale Funnel/Serve**：把節點端曝露成一個 Tailscale 自己提供的公開 HTTPS 端點，Dashboard 用一般 HTTPS 連過去，不需要 Dashboard 本身在 tailnet 裡——但這樣節點又變成有公開網址，要另外確認 Funnel 的存取控制是否符合你要的安全模型。

在其中一個做法實際驗證可行之前，這份文件的 Dashboard 端步驟只能算是「預期會這樣接」，還不是「已驗證能動」。建議先在一台測試節點上走完整流程（VM 部署 → Tailscale ACL → Dashboard 實際連得到 `/v1/models`）確認可行，再套用到正式的 vLLM 節點。
