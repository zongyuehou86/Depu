# 本机开房与联机访问

这版牌桌由你的 Mac 运行服务端。房间、正在进行的牌局和重连凭证保存在本机 `data/` 目录；每手结算后的完整文字记录另存于 `hand-records/<房间号>/<手数>.txt`。我们已验证只重启服务端后，牌局状态、手牌、底池和行动轮次能恢复。筹码仅用于模拟练习。

在 Mac 上也可以直接双击 `start-online.command`：它会启动服务端并生成临时分享网址。下文的终端步骤适合想分别控制服务端和分享网址时使用。

## 同一台电脑先试玩

在 `multiplayer-poker` 目录执行：

```sh
npm install
npm start
```

浏览器打开 `http://127.0.0.1:3000`。如需换端口，使用 `PORT=3001 npm start`，网址也改为相应端口。

## 分享给其他网络的朋友

本机已安装 `cloudflared`。先保持上面的服务端运行，再开第二个终端执行：

```sh
cloudflared tunnel --url http://127.0.0.1:3000
```

终端会显示一个以 `https://` 开头、以 `.trycloudflare.com` 结尾的临时网址。把这个网址分享给玩家；他们可直接输入昵称、房间号并入座或观战。浏览器会使用加密的 `wss://` 连接，同一个网址负责页面和实时牌局。

这个临时网址在隧道进程停止后失效，再次运行会得到新网址。Mac、服务端和 `cloudflared` 都要保持运行，并防止电脑睡眠。Cloudflare 将 Quick Tunnel 定位为测试用途，它没有可用性保证，也限制同时在途的请求数量；如需长期稳定的网址，需要有 Cloudflare 账号与托管在 Cloudflare 的域名，再创建正式 Tunnel 并配置为 macOS 服务。

## 使用与安全

- 拿到临时网址的人都能访问网页。房间号只是进入相应牌桌的标识，不能当作密码；请仅分享给想邀请的人。
- 每位玩家的底牌应只发给本人，其他人只会看到依法摊牌或本人主动亮出的牌。不要把浏览器保存的重连凭证发给别人。
- 服务端在你的电脑上运行。关闭服务端、隧道或电脑，其他玩家会断线；重启服务端后，同一网址上的浏览器凭原重连凭证可回到原牌局。若临时隧道也重启，网址会变，浏览器不会自动把旧网址保存的凭证带到新网址。玩家可事先点房间内的“复制我的恢复码”自行保存，在新网址输入原房间号和恢复码，认回原座位。
- `data/` 中包含玩家凭证及未公开的牌序；`hand-records/` 包含每位参赛者的底牌与完整下注过程。这两个目录仅供本机管理者访问，不通过网页开放；切勿共享给玩家或上传到公开仓库。旧版已经结束的手牌无法还原未亮出的底牌，新记录从本次升级后结算的手牌起完整保存。
- 如临时网址打不开，先检查两个终端仍在运行，再确认本机 `http://127.0.0.1:3000` 可打开。若 `cloudflared` 无法连接 Cloudflare 网络，可能是当前网络或代理阻止了它的出站连接。

参考：[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)、[WebSocket 支持](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)、[macOS 正式 Tunnel 服务](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/)。
