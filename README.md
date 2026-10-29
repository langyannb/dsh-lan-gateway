# dsh-lan-gateway

把 **DeepSeek Harness（dsh）** 的 Web 界面借给同一个局域网里的其它设备用。

手机、平板、另一台电脑，打开 `http://<这台机器的局域网 IP>:3081/` 就是完整的 dsh ——
不用复制 URL token、不用配对、不用敲命令。附带一个设置页，能自动检测网卡、自动/手动刷新，
**可选开启访问密钥**（自定义 / 随机生成 / 随时关闭）。

> 默认免密直通（和 dsh 本机默认一致）。如果你要在别人的 Wi-Fi、公司网络、宿舍网里用，
> 建议在面板里打开「访问密钥」——见 [安全模型](#安全模型)。

---

## 为什么需要它

dsh web 默认只监听 `127.0.0.1`，而且**只接受具体网卡地址**（不接受 `0.0.0.0`），
启动时还会打印一条带一次性 token 的地址，token 只在那个进程里有效。
于是「用另一台手机看同一台机器上的 dsh」这件事，本来需要：改配置 → 重启 → 抄 token →
发现手机那边又要重新授权。手机和电脑不在同一进程里，这套就反复断。

这个插件把整条链路代办掉：

```
手机  http://192.168.1.23:3081
        │
        ▼
┌─────────────────────────────┐
│ dsh-lan-gateway（本插件）    │  自己开 listener（默认 0.0.0.0:3081）
│  ① 可选：校验访问密钥         │  没登录 → 只给一个登录页
│  ② 反代 HTTP                 │  Host 改写回 127.0.0.1:<port>
│  ③ 反代 WebSocket            │  /api/remote.mux 原样透传
│  ④ 代办 dsh 的内部凭据        │  用 connection.authenticatedUrl() 换 cookie
└─────────────────────────────┘
        │  127.0.0.1:3080（dsh 自己的 listener 保持不动）
        ▼
   dsh web（原样，未改一行核心代码）
```

不改 dsh 核心、不改 dsh 的 webserver 绑定、不往磁盘上写 launch token。
浏览器看到的页面、静态资源、`/api/*` 与 WebSocket 全部来自同一个 dsh 进程。

---

## 安装

### 方式 A：作为 profile bundle（推荐）

```bash
# 1) 放进任意目录
git clone https://github.com/langyannb/dsh-lan-gateway.git ~/dsh-plugins/dsh-lan-gateway

# 2) 让 profile 认到它（二选一）
#    · 有 plugin_manager 的话：
#        plugin_manager  action=install_bundle  target=~/dsh-plugins/dsh-lan-gateway
#    · 或者手工装配：
#        在 ~/.dsh/profiles/web/package.json 里
#          "dependencies": { "dsh-lan-gateway": "link:/绝对路径/dsh-lan-gateway" }
#          "dsh": { "profile": { "bundles": [ ..., "dsh-lan-gateway" ] } }
#        再建符号链接：
#          ln -s /绝对路径/dsh-lan-gateway ~/.dsh/profiles/web/node_modules/dsh-lan-gateway

# 3) 重启 dsh（profile patch 只在启动时应用）
dsh --profile web

# 4) 确认配置已合成
dsh --profile web --dump-config | grep -A 8 lan-gateway
```

### 方式 B：直接放进 profile 的依赖树

把本仓库复制成 `~/.dsh/profiles/web/node_modules/dsh-lan-gateway`，
再在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-lan-gateway"`，
重启即可（等价于方式 A 的第 2、3 步）。

装好后打开 dsh 的 Web UI →**设置**→**局域网网关**。

---

## 使用

面板里一眼能看到：

| 区域 | 说明 |
|---|---|
| 当前地址 | 大号显示 `http://<IP>:3081/`，一键复制 / 直接打开 |
| 监听方式 | **自动**（绑 `0.0.0.0`，换 Wi-Fi、换 IP 都不用改配置）/ **固定 IP**（只听某块网卡） |
| 端口 | 默认 `3081`，保存后宿主当场重绑，不用重启 dsh |
| 访问密钥 | 开启 / 替换 / 随机生成 / 关闭；可复制「带密钥的登录链接」 |
| 面板刷新 | 关闭 / 1 / 2 / 3 / 5 / 10 / 30 秒 + 立即刷新 |
| 最近访问 | 谁、什么时候、请求了什么、状态码多少（排查「手机打不开」就看这里） |

**自动跟随网络**：mode=auto 绑 `0.0.0.0`；mode=fixed 时如果那个 IP 已经不属于本机
（换网后典型的 `EADDRNOTAVAIL`），会自动退回 `0.0.0.0` 并在面板上报
「固定 IP x.x.x.x 已不在本机」，绝不把你锁在门外。另外每 20 秒巡检一次网卡，
IP 变了会自己重绑。

---

## 访问密钥

默认**关闭**（`accessKey: ''`）。三种开启方式：

1. **面板**：设置 → 局域网网关 → 访问密钥 → 输入 → 设置（或「生成随机密钥」）
2. **登录链接**：开启后点「复制带密钥的链接」，得到 `http://<IP>:3081/?key=xxxx`，
   另一台设备打开即自动登录，随后 `?key=` 会被从地址栏摘掉
3. **配置文件**：`~/.dsh/lan-gateway.json` 里写 `"accessKey": "..."`（权限 600）

细节：

- 会话 cookie `lgw_session`：`HttpOnly` + `SameSite=Lax` + HMAC 签名，默认记住 30 天（可改 1~365）
- 改密钥 / 关密钥会**立刻**让所有旧会话失效（签名密钥是从 accessKey 派生的）
- 同一来源连续错 6 次会锁 60 秒，挡脚本穷举；比较用定长比较，不泄露前缀
- 密钥明文**只在本机（127.0.0.1）的面板**上显示；从别的设备打开面板只看到 `ab…15 位`
- 忘记密钥：`~/.dsh/lan-gateway.json` 里把 `accessKey` 改成 `""`，重启 dsh

登录页是网关自己渲染的（不依赖任何前端资源），所以在手机上打开也很快：

```
┌──────────────┐
│ dsh          │
│ 这台设备开启了访问密钥，输入后即可进入。│
│ [ •••••• ]   │
│ [   进入   ] │
└──────────────┘
```

---

## 配置项

配置文件：`~/.dsh/lan-gateway.json`（面板改的东西落在这里，优先于 profile patch 里的默认值）
也可以用 `cordis.patch.yml` 里的 `config:` 设默认值。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `'auto' \| 'fixed'` | `auto` | auto 绑 `0.0.0.0`；fixed 绑 `host` |
| `host` | string | `''` | `mode=fixed` 时监听的具体 IP；消失后自动退回 `0.0.0.0` |
| `port` | 1–65535 | `3081` | 对外端口 |
| `autoRefreshMs` | 0–600000 | `3000` | 面板轮询间隔，`0` = 关闭 |
| `accessKey` | string(≤128) | `''` | 空 = 免密；非空 = 需要密钥 |
| `sessionDays` | 1–365 | `30` | 登录记住多少天 |

面板接口（挂在 dsh 自己的 listener 上，也可以直接 `curl`）：

```
GET  /lan-gateway/state         当前状态（地址、监听、密钥开关、最近访问）
POST /lan-gateway/settings      改 mode/host/port/autoRefreshMs/sessionDays
POST /lan-gateway/key           {action:"set"|"clear"|"random", key?}
POST /lan-gateway/rebind        按当前设置重绑
POST /lan-gateway/credential    强制重换内层凭据
```

---

## 安全模型

说清楚它做了什么、没做什么：

- **它不绕过 dsh 的任何鉴权**。网关只是替浏览器完成 dsh 本来要求的「token → cookie」那一步，
  然后把 cookie 放在内层请求上。dsh 侧仍然按自己的规则校验 Host / Origin / 会话。
- **默认免密 = 同一局域网里任何人都能用完整的 dsh**（能跑命令、读写文件）。
  这和「你自己在电脑前打开 dsh」是同一份权限。可信的家庭 Wi-Fi 通常没问题；
  **不可信网络请务必打开访问密钥**。
- 密钥只是网关这一层的门：拿到密钥的人等于拿到这台机器上的 dsh。密钥请当密码对待。
- 不要把这个端口映射到公网。它是按「局域网内可信」设计的：没有 TLS，密钥在明文 HTTP 上传输。
- `~/.dsh/lan-gateway.json` 落盘权限 600；密钥明文只在本机回环的面板上返回。

---

## 常见问题

**手机打不开，但本机能打开**
先看面板的「最近访问」：没有新纪录 ⇒ 请求根本没到这台机器（两台不在同一 Wi-Fi / IP 抄错了 /
路由器开了 AP 隔离）；有纪录但状态码不对 ⇒ 看那一行。

**换了个 Wi-Fi 就连不上**
面板「当前地址」跟着网络变（mode=auto）。如果必须用固定地址：让这台机器开热点，
另一台连热点（热点自己的地址是系统固定的），或去路由器里给它做静态 DHCP 绑定。

**端口被占用**
面板改端口即可；`EADDRINUSE` 时插件只打日志、不会把宿主带崩。

**Android / Termux 后台被杀**
网关跑在 dsh 进程里，dsh 被冻结就一起停。需要：电池优化白名单 + `termux-wake-lock`。

**为什么不用 TLS**
局域网内自签证书会被浏览器拦、还得逐台装信任，收益为零。需要加密就走
`ssh -L` 隧道或 Tailscale 之类的私有网络。

---

## 开发

```bash
npm test          # 离线自测：假 ctx + 假内层 dsh，46 项（反代 / 重放 / WS / 密钥 / 登录页）
```

自测不碰真实 dsh、不碰你的 `~/.dsh/lan-gateway.json`（用临时目录）。

需要 dsh ≥ 0.1.x（用到 `ctx.webServer.register`、`ctx.connection.authenticatedUrl`、
`ctx.slots.register`）与 Node ≥ 20。

---

## English

`dsh-lan-gateway` exposes this machine's dsh web UI to other devices on the same LAN
(`http://<host-ip>:3081/`) without copying launch tokens or pairing.

- Reverse-proxies HTTP and WebSocket to `127.0.0.1:<dsh-port>`, rewriting `Host` and
  redeeming the inner `dsh-auth-*` cookie via `connection.authenticatedUrl()`.
- Settings panel: interface detection, auto/manual refresh, listen mode & port,
  optional **access key** (custom / random / off) with a signed session cookie.
- Auto-follows network changes; falls back to `0.0.0.0` when a pinned IP disappears.

Install as a profile bundle, then restart dsh. `npm test` runs 46 offline checks.

---

## License

[MIT](LICENSE) © 2026 langyannb
