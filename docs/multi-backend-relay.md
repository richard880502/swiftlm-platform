# 一個 relay 轉發多台內部機器

如果內部網域本來就互通（同一個 LAN / VPC，機器彼此連得到），不需要每台 backend 機器各自架一個對外的轉發層。一個有加入私有 mesh 網路（Tailscale 等）的 relay，可以同時幫多台內部機器轉發——這個 relay 甚至不用跟任何一台 backend 機器同一台實體主機，只要它連得到那些內部 IP 就行。

平台這邊的資料模型不受影響：不管幾台機器共用同一個 relay，每一個獨立的 backend process 在 Dashboard 裡仍然是一個獨立的 node、一把獨立的 client key。relay 只負責網路層轉發，不會把多個 backend 合併成一個節點身分。

## 做法一：多個 socat 實例，各轉發一台機器

```bash
# 轉發到內部機器 A 的 vLLM（10.0.0.5:8000）
socat TCP-LISTEN:9001,fork,reuseaddr,bind=<relay 的 tailscale IP> TCP:10.0.0.5:8000

# 轉發到內部機器 B 的 vLLM（10.0.0.6:8000）
socat TCP-LISTEN:9002,fork,reuseaddr,bind=<relay 的 tailscale IP> TCP:10.0.0.6:8000
```

`TCP:` 後面的目標可以是任何 relay 連得到的內部 IP，不必是 relay 自己所在的機器。每台機器各佔一個獨立的 listen port，Dashboard 端各自用 `http://<relay-tailscale-ip>:9001/v1`、`:9002/v1` 註冊成不同節點。

**務必帶 `bind=<relay 的 tailscale IP>`**：不帶的話 socat 預設監聽 `0.0.0.0`（relay 的所有網路介面），等於這個 port 在 relay 的其他網卡（例如它自己的 LAN IP）上也連得到，繞過「只有 tailnet ACL 允許的裝置才能連」這道防線，ACL 形同虛設。

新增機器就是多開一個 socat process，沒有數量上限，但機器一多，管理一堆 port 會變得繁瑣——這時候可以考慮做法二。

## 做法二：nginx / Caddy 用路徑分流，只佔一個對外 port

```nginx
location /node-a/ {
    proxy_pass http://10.0.0.5:8000/;
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
location /node-b/ {
    proxy_pass http://10.0.0.6:8000/;
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

nginx 會自動處理路徑改寫：打 `/node-a/v1/chat/completions` 會被轉成 `http://10.0.0.5:8000/v1/chat/completions`。Dashboard 端節點網址設成 `http://<relay-tailscale-ip>/node-a/v1`、`.../node-b/v1`。新增機器只要多加一個 `location` 區塊，不用佔用新 port。

**`proxy_buffering off` 這幾行不能省**：這個平台的 `/v1/chat/completions` 靠 SSE 逐段回傳做串流。nginx 預設會把上游回應整包緩衝完才吐給客戶端，沒關掉的話串流效果會消失——不會報錯，只是變成要等生成完才整包收到，體驗上像是壞掉但其實只是設定漏掉。

## 兩種做法怎麼選

- 機器數量少（個位數）、想要最少的移動零件：做法一，每台機器一個 socat process。
- 機器數量會持續增加、想要新增機器不用開新 port：做法二，一個 nginx 對外，內部用路徑分流。

兩種都只是網路層的轉發規則，跟 [用 Tailscale 部署新節點](tailscale-node-deployment.md) 裡「backend 只聽 loopback／私有網段、ACL 限制誰能連進 relay」的安全模型完全相容，只是把「relay 轉發到自己這台機器」擴充成「relay 轉發到內部網路裡的任何一台機器」。
