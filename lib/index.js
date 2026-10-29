/**
 * dsh-lan-gateway —— 把本机的 dsh web 借给同一局域网里的其它设备用。
 *
 * 打开  http://<本机局域网 IP>:<port>/  就能用，不需要 dsh 自己的 URL token、
 * 不需要配对、不需要在每台设备上折腾。默认**不设密钥**（和 dsh 平时一样开箱即用），
 * 也可以在面板里打开「访问密钥」——支持自定义密钥、随机生成、随时关闭，
 * 登录一次记住 N 天。
 *
 * 反代做法（不改 dsh 核心，也不把 dsh 自己的 webserver 绑到 0.0.0.0）：
 *
 *   1. 插件自己开一个 node:http 监听 <host>:<port>（默认 0.0.0.0:3081）。
 *      这是我们自己的 listener，不受 dsh webserver「必须是一块具体网卡」的校验约束。
 *   2. 每个进来的 HTTP 请求都反代到 127.0.0.1:<dsh 的端口>：把 Host 改写回
 *      127.0.0.1:<port>、丢掉 Origin/Referer、置 sec-fetch-site: same-origin，
 *      于是 dsh 的 Host/Origin 围栏直接放行。
 *   3. 用 ctx.connection.authenticatedUrl() 拿到本进程的 launch-token URL，
 *      对 127.0.0.1 发一次 GET（redirect: manual）换出内层 `dsh-auth-*` cookie
 *      并缓存起来；之后每条内层请求都带上它 —— 浏览器的鉴权完全由网关代办。
 *   4. WebSocket（/api/remote.mux）走 raw socket 反代，同样带 cookie。
 *   5. 访问密钥（可选）在**反代之前**校验：没登录就只给一个登录页，
 *      登录成功后发一个 HttpOnly 的会话 cookie，反代与 WS 升级都要过这一关。
 *
 * 监听地址自动跟随网络：mode=auto 绑 0.0.0.0；mode=fixed 时若那个 IP 已不属于本机
 * （换网后的典型症状 EADDRNOTAVAIL），自动退化成 0.0.0.0 并如实上报，绝不把人锁在门外；
 * 每 20 秒巡检一次网卡，IP 变了会自己重绑，不用重启 dsh。
 *
 * 面板 API 挂在 dsh 自己的 webserver 上（/lan-gateway/*），所以本机打开
 * http://127.0.0.1:3080/lan-gateway/state 与手机打开
 * http://<局域网IP>:3081/lan-gateway/state 看到的是同一份状态。
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 逐跳头，绝不跨跳转发。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** 内层只有这几条 WebSocket 头需要转发。 */
const WS_FORWARD_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']

/** 内层 cookie 的缓存寿命（远小于 dsh 的 30 天，够用且能自愈）。 */
const CREDENTIAL_TTL_MS = 10 * 60 * 1000

/** 小于这个体积的请求体先收全，好让内层 401 时能带同一条体重放。 */
const REPLAY_LIMIT_BYTES = 1024 * 1024

const INNER_HOST = '127.0.0.1'

/** 面板 API 的路径前缀（同时是 dsh webserver 上的路由）。 */
const PANEL_PATH = '/lan-gateway'

/** 面板 POST 体的上限。 */
const PANEL_BODY_LIMIT = 64 * 1024

/** 网卡巡检间隔：IP 漂移/回来自动重绑。 */
const WATCH_MS = 20 * 1000

const DEFAULT_PORT = 3081
const DEFAULT_REFRESH_MS = 3000

/** 访问密钥相关。 */
const LOGIN_PATH = '/__lgw/login'
const LOGOUT_PATH = '/__lgw/logout'
const SESSION_COOKIE = 'lgw_session'
const DEFAULT_SESSION_DAYS = 30
const MAX_KEY_LENGTH = 128
const MAX_LOGIN_BODY = 8 * 1024
/** 同一来源连续试错的上限与观察窗口：超过就暂时锁住，挡住脚本穷举。 */
const MAX_FAILS = 6
const FAIL_WINDOW_MS = 10 * 60 * 1000
const LOCK_MS = 60 * 1000

export const name = 'lan-gateway'
export const inject = ['webServer', 'connection']

/** dsh 的家目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 把任意输入规整成完整设置对象；老配置只有 host 也能升级上来。 */
function normalizeSettings(raw) {
  const out = {
    mode: 'auto',
    host: '',
    port: DEFAULT_PORT,
    autoRefreshMs: DEFAULT_REFRESH_MS,
    accessKey: '',
    sessionDays: DEFAULT_SESSION_DAYS
  }
  let modeGiven = false
  if (raw !== null && typeof raw === 'object') {
    if (raw.mode === 'fixed' || raw.mode === 'auto') {
      out.mode = raw.mode
      modeGiven = true
    }
    if (typeof raw.host === 'string') out.host = raw.host.trim()
    const port = Number(raw.port)
    if (Number.isInteger(port) && port > 0 && port <= 65535) out.port = port
    const refresh = Number(raw.autoRefreshMs)
    if (Number.isInteger(refresh) && refresh >= 0 && refresh <= 600000) out.autoRefreshMs = refresh
    if (typeof raw.accessKey === 'string') out.accessKey = raw.accessKey.trim().slice(0, MAX_KEY_LENGTH)
    const days = Number(raw.sessionDays)
    if (Number.isInteger(days) && days >= 1 && days <= 365) out.sessionDays = days
  }
  // 老配置（只有 host、没有 mode）才做推断：具体 IP ⇒ 固定模式，0.0.0.0/空 ⇒ 自动。
  // 调用方明确给了 mode 就必须尊重它——否则面板上选「自动」会被 host 反推回「固定」。
  if (!modeGiven) {
    if (out.host !== '' && out.host !== '0.0.0.0') out.mode = 'fixed'
  }
  if (out.mode === 'fixed' && (out.host === '' || out.host === '0.0.0.0')) out.mode = 'auto'
  return out
}

/** 读落盘设置；坏了就当没有，绝不因为一个坏 JSON 让插件起不来。 */
function readSavedSettings(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return normalizeSettings(parsed)
  } catch {
    return undefined
  }
}

/** 原子写落盘设置；失败只回报原因，不影响内存里已经生效的配置。 */
function writeSavedSettings(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    // 密钥落盘后必须是 0600：同机其它用户不该读到它。
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* 有些文件系统（FAT）不支持 */
    }
    fs.renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 本机所有非回环 IPv4，附带网卡名与「像不像真的局域网」。 */
function lanAddresses(port) {
  const out = []
  const interfaces = os.networkInterfaces()
  for (const [iface, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      const tunnel = /^(tun|tap|ppp|utun|ipsec|rmnet|ccmni|dummy|wg|zt|tailscale)/i.test(iface)
      const likely = !tunnel && /^(wlan|eth|ap|swlan|rndis|wifi)/i.test(iface)
      out.push({ iface, address: entry.address, url: `http://${entry.address}:${port}/`, likely, tunnel })
    }
  }
  out.sort((a, b) => Number(b.likely) - Number(a.likely) || Number(a.tunnel) - Number(b.tunnel) || a.iface.localeCompare(b.iface))
  return out
}

/** 某个地址现在还在不在本机网卡上。 */
function addressExists(address) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && entry.address === address) return true
    }
  }
  return false
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > PANEL_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function readTextBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendHtml(res, status, html, extraHeaders = {}) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...extraHeaders
  })
  res.end(body)
}

/** 从 Cookie 头里取一条。 */
function cookieValue(header, cookieName) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const segment of header.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.startsWith(`${cookieName}=`)) return trimmed.slice(cookieName.length + 1)
  }
  return undefined
}

/** 会话签名用的派生密钥：accessKey 一换，旧会话自然全部失效。 */
function sessionSecret(accessKey) {
  return crypto.createHash('sha256').update(`dsh-lan-gateway:session:v1:${accessKey}`).digest()
}

/** 无状态会话令牌：`<过期时间戳>.<HMAC>`，服务端不存任何会话表。 */
function issueSession(accessKey, days) {
  const expiresAt = Date.now() + days * 86_400_000
  const payload = Buffer.from(String(expiresAt)).toString('base64url')
  const mac = crypto.createHmac('sha256', sessionSecret(accessKey)).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verifySession(token, accessKey) {
  if (typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return false
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)
  const want = crypto.createHmac('sha256', sessionSecret(accessKey)).update(payload).digest('base64url')
  if (mac.length !== want.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false
  const expiresAt = Number(Buffer.from(payload, 'base64url').toString('utf8'))
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

/** 定长比较，不泄露「前几位对了」这种信息。 */
function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest()
  const b = crypto.createHash('sha256').update(String(expected)).digest()
  return crypto.timingSafeEqual(a, b)
}

function randomKey() {
  return crypto.randomBytes(18).toString('base64url')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** 登录页：不依赖任何前端资源，手机 2 的浏览器打开就能输。 */
function loginPageHtml({ next, error, lockedForMs, sessionDays }) {
  const notice =
    lockedForMs > 0
      ? `<p class="err">试错次数太多，请 ${Math.ceil(lockedForMs / 1000)} 秒后再试。</p>`
      : error === ''
        ? ''
        : `<p class="err">${escapeHtml(error)}</p>`
  const days = sessionDays === 1 ? '1 天' : `${sessionDays} 天`
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>需要访问密钥 · dsh</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
    background: #f6f7f9; color: #1c1f24; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8eaed; } }
  .card { width: 100%; max-width: 360px; background: rgba(255,255,255,.86); border: 1px solid rgba(128,128,128,.28);
    border-radius: 16px; padding: 26px 24px; box-shadow: 0 12px 40px rgba(0,0,0,.10); }
  @media (prefers-color-scheme: dark) { .card { background: rgba(255,255,255,.045); } }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .3px; }
  .sub { margin: 0 0 18px; font-size: 13px; opacity: .68; }
  label { display: block; font-size: 12px; opacity: .75; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 11px 12px; font-size: 16px; border-radius: 10px;
    border: 1px solid rgba(128,128,128,.42); background: transparent; color: inherit; }
  input[type=password]:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 11px 12px; font-size: 15px; font-weight: 600;
    border: 0; border-radius: 10px; background: #2563eb; color: #fff; }
  button:active { transform: translateY(1px); }
  .err { margin: 12px 0 0; font-size: 13px; color: #d9480f; }
  .hint { margin: 14px 0 0; font-size: 12px; opacity: .6; }
</style></head>
<body><main class="card">
  <h1>dsh</h1>
  <p class="sub">这台设备开启了访问密钥，输入后即可进入。</p>
  <form method="post" action="${LOGIN_PATH}" autocomplete="off">
    <label for="k">访问密钥</label>
    <input id="k" name="key" type="password" inputmode="text" autocomplete="current-password"
      autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit">进入</button>
  </form>
  ${notice}
  <p class="hint">验证通过后这台设备会记住 ${days}，可在 dsh 面板「局域网网关」里修改或关闭密钥。</p>
</main></body></html>`
}

export function apply(ctx, config = {}) {
  const settingsPath = path.join(dshHome(), 'lan-gateway.json')
  let settings = { ...normalizeSettings(config), ...(readSavedSettings(settingsPath) ?? {}) }

  /** 当前 listener 与它对外暴露的事实。 */
  let current = null
  const state = {
    listening: false,
    boundHost: null,
    boundPort: null,
    requestedHost: null,
    fallbackFrom: null,
    error: null,
    startedAt: 0,
    wsOpen: 0,
    wsTotal: 0
  }

  /** 最近的反代访问：面板用它回答「另一台手机到底请求了什么、成没成」。 */
  const RECENT_LIMIT = 40
  const recent = []

  function noteRecent(entry) {
    recent.unshift(entry)
    if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
  }

  function peerOf(req) {
    const raw = req.socket?.remoteAddress ?? ''
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw
  }

  function isLoopbackPeer(req) {
    const peer = peerOf(req)
    return peer === '127.0.0.1' || peer === '::1'
  }

  /** 登录失败计数（按来源 IP），用来挡脚本穷举。 */
  const failures = new Map()

  function failureState(ip) {
    const now = Date.now()
    const record = failures.get(ip)
    if (record === undefined) return { fails: 0, lockedForMs: 0 }
    if (record.lockedUntil > now) return { fails: record.fails, lockedForMs: record.lockedUntil - now }
    if (now - record.firstAt > FAIL_WINDOW_MS) {
      failures.delete(ip)
      return { fails: 0, lockedForMs: 0 }
    }
    return { fails: record.fails, lockedForMs: 0 }
  }

  function noteFailure(ip) {
    const now = Date.now()
    const record = failures.get(ip)
    if (record === undefined || now - record.firstAt > FAIL_WINDOW_MS) {
      failures.set(ip, { fails: 1, firstAt: now, lockedUntil: 0 })
      return
    }
    record.fails += 1
    if (record.fails >= MAX_FAILS) {
      record.lockedUntil = now + LOCK_MS
      record.fails = 0
      record.firstAt = now
    }
  }

  function sessionCookieHeader(token) {
    const maxAge = settings.sessionDays * 86_400
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
  }

  function clearCookieHeader() {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  }

  function authorized(req) {
    if (settings.accessKey === '') return true
    const token = cookieValue(req.headers.cookie, SESSION_COOKIE)
    return token !== undefined && verifySession(token, settings.accessKey)
  }

  let credential // 'dsh-auth-xxx=...'
  let credentialAt = 0
  let redeeming

  /** dsh 自己的监听端口；webserver 还没 listen 完时返回 undefined。 */
  function innerPort() {
    const port = ctx.webServer?.port
    return typeof port === 'number' && port > 0 ? port : undefined
  }

  /** 往 127.0.0.1 发一次 GET（不走全局 fetch，免得被 dsh 装的环境代理接管）。 */
  function getLoopback(pathname, headers) {
    const port = innerPort()
    return new Promise((resolve, reject) => {
      if (port === undefined) {
        reject(new Error('dsh web listener is not ready yet'))
        return
      }
      const req = http.request({ host: INNER_HOST, port, path: pathname, method: 'GET', headers }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** 从 set-cookie 里挑出 `dsh-auth-` 那条（Node 把它给成数组）。 */
  function pickAuthCookie(setCookie) {
    const entries = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : []
    for (const entry of entries) {
      const pair = String(entry).split(';')[0].trim()
      if (pair.startsWith('dsh-auth-')) return pair
    }
    return undefined
  }

  /** 换出（或复用）内层 dsh-auth cookie；并发请求共用同一次兑换。 */
  async function innerCredential({ force = false } = {}) {
    if (!force && credential !== undefined && Date.now() - credentialAt < CREDENTIAL_TTL_MS) return credential
    if (redeeming !== undefined) return redeeming
    redeeming = (async () => {
      const port = innerPort()
      if (port === undefined) throw new Error('dsh web listener is not ready yet')
      const url = new URL(ctx.connection.authenticatedUrl(`http://${INNER_HOST}:${port}/`))
      const res = await getLoopback(`${url.pathname}${url.search}`, {
        host: `${INNER_HOST}:${port}`,
        'sec-fetch-site': 'same-origin',
        accept: 'text/html'
      })
      const cookie = pickAuthCookie(res.headers['set-cookie'])
      if (cookie === undefined) throw new Error(`could not redeem an inner browser credential (HTTP ${res.status})`)
      credential = cookie
      credentialAt = Date.now()
      return cookie
    })()
    try {
      return await redeeming
    } finally {
      redeeming = undefined
    }
  }

  /** 内层请求头 = 浏览器头去掉围栏相关项，再补 loopback 形状与内层 cookie。 */
  function innerHeaders(req, cookie) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'cookie') continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    headers.host = `${INNER_HOST}:${innerPort()}`
    headers['sec-fetch-site'] = 'same-origin'

    // 浏览器自己的 cookie 照转，但 `dsh-auth-*` 与网关自己的会话 cookie 一律不转：
    // 前者换成网关兑换出来的那条，后者留在网关这一层。
    const browserCookie = req.headers.cookie
    const kept =
      typeof browserCookie === 'string'
        ? browserCookie
            .split(';')
            .map((segment) => segment.trim())
            .filter((segment) => segment !== '' && !segment.startsWith('dsh-auth-') && !segment.startsWith(`${SESSION_COOKIE}=`))
        : []
    if (cookie !== undefined) kept.push(cookie)
    if (kept.length > 0) headers.cookie = kept.join('; ')
    return headers
  }

  /** 回给浏览器的头：只留内容相关的那几条，外加上游自己的非 dsh-auth cookie。 */
  function responseHeaders(upstream) {
    const headers = {}
    const setCookie = []
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'set-cookie') {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (!String(entry).trimStart().startsWith('dsh-auth-')) setCookie.push(entry)
        }
        continue
      }
      if (HOP_BY_HOP.has(lower)) continue
      headers[lower] = value
    }
    if (setCookie.length > 0) headers['set-cookie'] = setCookie
    return headers
  }

  function fail(res, error) {
    if (res.headersSent) {
      res.destroy?.()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`lan-gateway: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  /** 这一条能不能重放：无体方法随便重放；有小体积体就先缓存下来再发。 */
  function replayable(req) {
    const method = req.method ?? 'GET'
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  }

  /** 反代一次普通 HTTP 请求；内层 401 就重换一次 cookie 再试。 */
  function forward(req, res, attempt = 0, buffered) {
    const startedMs = Date.now()
    const meta = {
      ip: peerOf(req),
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      ua: String(req.headers['user-agent'] ?? '').slice(0, 48)
    }
    res.once('finish', () => {
      const status = res.statusCode
      noteRecent({ ...meta, status, at: new Date().toISOString(), ms: Date.now() - startedMs })
      if (status >= 400) {
        console.warn(`[lan-gateway] ${meta.ip} ${meta.method} ${meta.path} -> ${status}`)
      }
    })
    innerCredential().then(
      (cookie) => {
        const upstream = http.request(
          {
            host: INNER_HOST,
            port: innerPort(),
            path: req.url ?? '/',
            method: req.method ?? 'GET',
            headers: innerHeaders(req, cookie)
          },
          (inner) => {
            if (inner.statusCode === 401 && attempt === 0) {
              if (replayable(req)) {
                inner.resume()
                innerCredential({ force: true })
                  .then(() => forward(req, res, attempt + 1))
                  .catch((error) => fail(res, error))
                return
              }
              if (buffered !== undefined) {
                inner.resume()
                innerCredential({ force: true })
                  .then(() => forward(req, res, attempt + 1, buffered))
                  .catch((error) => fail(res, error))
                return
              }
              // 大体积体已经流走了，重放不了：先换 cookie，让客户端自己重试。
              inner.resume()
              innerCredential({ force: true }).catch(() => {})
              res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' })
              res.end('lan-gateway: renewing credential, retry\n')
              return
            }
            res.writeHead(inner.statusCode ?? 502, inner.statusMessage, responseHeaders(inner))
            inner.pipe(res)
          }
        )
        upstream.on('error', (error) => fail(res, error))

        if (buffered !== undefined) {
          upstream.end(buffered)
          return
        }

        // 小体积体先收全：这样 401 时还能带同一条体重放给内层。
        const declared = Number(req.headers['content-length'])
        if (!replayable(req) && Number.isFinite(declared) && declared > 0 && declared <= REPLAY_LIMIT_BYTES) {
          const chunks = []
          let size = 0
          let aborted = false
          req.on('data', (chunk) => {
            size += chunk.length
            if (size > REPLAY_LIMIT_BYTES) {
              // 声明值和实际不符，退回流式转发。
              aborted = true
              for (const held of chunks) upstream.write(held)
              chunks.length = 0
              upstream.write(chunk)
              return
            }
            if (!aborted) chunks.push(chunk)
          })
          req.on('end', () => {
            if (aborted) upstream.end()
            else upstream.end(Buffer.concat(chunks))
          })
          req.on('aborted', () => upstream.destroy())
          return
        }

        req.on('aborted', () => upstream.destroy())
        req.pipe(upstream)
      },
      (error) => fail(res, error)
    )
  }

  /** WebSocket 升级：手写握手，带内层 cookie，然后双向 pipe。 */
  function forwardUpgrade(req, socket, head, attempt = 0) {
    innerCredential().then(
      (cookie) => {
        const port = innerPort()
        const headers = {
          host: `${INNER_HOST}:${port}`,
          upgrade: 'websocket',
          connection: 'Upgrade',
          cookie,
          'sec-fetch-site': 'same-origin'
        }
        for (const headerName of WS_FORWARD_HEADERS) {
          const value = req.headers[headerName]
          if (typeof value === 'string' && value !== '') headers[headerName] = value
        }
        const upstream = http.request({ host: INNER_HOST, port, path: req.url ?? '/', method: 'GET', headers })

        upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
          const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage || 'Switching Protocols'}`]
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue
            if (key.toLowerCase() === 'set-cookie') continue
            lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          }
          state.wsTotal += 1
          state.wsOpen += 1
          noteRecent({ ip: peerOf(req), method: 'WS', path: req.url ?? '/', status: res.statusCode ?? 101, at: new Date().toISOString(), ms: 0 })
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (upstreamHead.length > 0) socket.write(upstreamHead)
          if (head.length > 0) upstreamSocket.write(head)

          upstreamSocket.pipe(socket)
          socket.pipe(upstreamSocket)

          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            state.wsOpen = Math.max(0, state.wsOpen - 1)
            upstreamSocket.destroy()
            socket.destroy()
          }
          upstreamSocket.on('error', close)
          upstreamSocket.on('close', close)
          socket.on('error', close)
          socket.on('close', close)
        })

        upstream.on('response', (res) => {
          res.resume()
          if (res.statusCode === 401 && attempt === 0) {
            innerCredential({ force: true })
              .then(() => forwardUpgrade(req, socket, head, attempt + 1))
              .catch(() => socket.destroy())
            return
          }
          noteRecent({ ip: peerOf(req), method: 'WS', path: req.url ?? '/', status: res.statusCode ?? 502, at: new Date().toISOString(), ms: 0 })
          socket.end(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage || 'Bad Gateway'}\r\n\r\n`)
        })

        upstream.on('error', () => socket.destroy())
        upstream.end()
      },
      () => socket.destroy()
    )
  }

  // ─────────────────────── 访问密钥（网关自己的登录页） ───────────────────────

  /** 未被授权时的回应：浏览器给登录页，接口给 401。 */
  function deny(req, res) {
    const method = req.method ?? 'GET'
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html') && (method === 'GET' || method === 'HEAD')
    if (!wantsHtml) {
      const body = 'lan-gateway: access key required\n'
      res.writeHead(401, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
      return
    }
    const target = req.url ?? '/'
    const query = target.startsWith('/') ? `?next=${encodeURIComponent(target)}` : ''
    res.writeHead(303, { location: `${LOGIN_PATH}${query}`, 'cache-control': 'no-store' })
    res.end()
  }

  function loginRedirectTarget(raw) {
    if (typeof raw !== 'string') return '/'
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/'
    if (trimmed.startsWith(LOGIN_PATH) || trimmed.startsWith(LOGOUT_PATH)) return '/'
    return trimmed
  }

  /**
   * 网关自己处理的路由。返回 true 表示这条请求已经在本地结束，不再反代。
   *   GET  /__lgw/login   登录页
   *   POST /__lgw/login   校验密钥 → 发会话 cookie → 303
   *   GET  /__lgw/logout  清会话
   *   任意  ?key=<密钥>    一次性带密钥进来（手机上少敲一次，登录后立刻从 URL 里消失）
   */
  async function handleLocalRoute(req, res) {
    const method = req.method ?? 'GET'
    let url
    try {
      url = new URL(req.url ?? '/', 'http://placeholder')
    } catch {
      return false
    }
    const pathname = url.pathname

    if (pathname === LOGIN_PATH && (method === 'GET' || method === 'HEAD')) {
      const next = loginRedirectTarget(url.searchParams.get('next') ?? '/')
      const locked = failureState(peerOf(req)).lockedForMs
      sendHtml(
        res,
        200,
        loginPageHtml({ next, error: url.searchParams.get('error') ?? '', lockedForMs: locked, sessionDays: settings.sessionDays })
      )
      return true
    }

    if (pathname === LOGIN_PATH && method === 'POST') {
      let form
      try {
        form = new URLSearchParams(await readTextBody(req, MAX_LOGIN_BODY))
      } catch {
        sendHtml(res, 413, loginPageHtml({ next: '/', error: '请求体太大', lockedForMs: 0, sessionDays: settings.sessionDays }))
        return true
      }
      const ip = peerOf(req)
      const locked = failureState(ip).lockedForMs
      if (locked > 0) {
        sendHtml(res, 429, loginPageHtml({ next: '/', error: '', lockedForMs: locked, sessionDays: settings.sessionDays }))
        return true
      }
      const next = loginRedirectTarget(form.get('next') ?? '/')
      const given = form.get('key') ?? ''
      if (settings.accessKey === '') {
        res.writeHead(303, { location: next, 'cache-control': 'no-store' })
        res.end()
        return true
      }
      if (!sameSecret(given, settings.accessKey)) {
        noteFailure(ip)
        const after = failureState(ip)
        noteRecent({ ip, method, path: LOGIN_PATH, status: 401, at: new Date().toISOString(), ms: 0 })
        sendHtml(
          res,
          after.lockedForMs > 0 ? 429 : 401,
          loginPageHtml({
            next,
            error: after.lockedForMs > 0 ? '' : '密钥不对，再试一次。',
            lockedForMs: after.lockedForMs,
            sessionDays: settings.sessionDays
          })
        )
        return true
      }
      failures.delete(ip)
      noteRecent({ ip, method, path: LOGIN_PATH, status: 303, at: new Date().toISOString(), ms: 0 })
      res.writeHead(303, {
        location: next,
        'cache-control': 'no-store',
        'set-cookie': sessionCookieHeader(issueSession(settings.accessKey, settings.sessionDays))
      })
      res.end()
      return true
    }

    if (pathname === LOGOUT_PATH) {
      res.writeHead(303, { location: LOGIN_PATH, 'cache-control': 'no-store', 'set-cookie': clearCookieHeader() })
      res.end()
      return true
    }

    // ?key= 一把梭：密钥对了就发会话并把这个参数从 URL 里摘掉。
    const quick = url.searchParams.get('key')
    if (quick !== null && settings.accessKey !== '') {
      if (sameSecret(quick, settings.accessKey)) {
        url.searchParams.delete('key')
        failures.delete(peerOf(req))
        res.writeHead(303, {
          location: `${url.pathname}${url.search}`,
          'cache-control': 'no-store',
          'set-cookie': sessionCookieHeader(issueSession(settings.accessKey, settings.sessionDays))
        })
        res.end()
        return true
      }
      noteFailure(peerOf(req))
    }

    return false
  }

  // ─────────────────────────── listener 生命周期 ───────────────────────────

  function makeServer() {
    const server = http.createServer((req, res) => {
      handleLocalRoute(req, res).then(
        (handled) => {
          if (handled) return
          if (!authorized(req)) {
            deny(req, res)
            return
          }
          forward(req, res)
        },
        (error) => fail(res, error)
      )
    })
    server.on('upgrade', (req, socket, head) => {
      if (!authorized(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        return
      }
      forwardUpgrade(req, socket, head)
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    // 记下来：重绑时要能只杀「已经空闲」的，不能把正在处理的那条（尤其是
    // 「保存并重绑」自己那条请求）一起掐死——那是浏览器看到 ERR_EMPTY_RESPONSE 的真因。
    const sockets = new Set()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.lgwSockets = sockets
    return server
  }

  /** 现在应该绑哪个地址：auto ⇒ 0.0.0.0；fixed 但那个 IP 已经不在本机 ⇒ 退回 0.0.0.0。 */
  function desiredHost() {
    if (settings.mode !== 'fixed') return '0.0.0.0'
    const host = typeof settings.host === 'string' ? settings.host.trim() : ''
    if (host === '' || host === '0.0.0.0') return '0.0.0.0'
    return addressExists(host) ? host : '0.0.0.0'
  }

  /**
   * 停掉当前 listener。要点：
   *   · `close()` 会**立刻停止 accept**（端口马上可被新 listener 复用）；
   *   · 只 `closeIdleConnections()`，**绝不能** closeAllConnections —— 面板「保存并重绑」
   *     这条 POST 自己的连接就在里面，掐了它浏览器只能看到空响应；
   *   · 还没断的（含正在跑的 WS 长连接）给 5 秒收尾期，超时才强拆。
   */
  function stopListener() {
    const server = current
    current = null
    state.listening = false
    state.boundHost = null
    state.boundPort = null
    if (server === null) return
    server.removeAllListeners('error')
    server.on('error', () => {})
    try {
      server.close(() => {})
    } catch {
      /* 已经在关了 */
    }
    try {
      server.closeIdleConnections?.()
    } catch {
      /* 老 node 没有这个 API */
    }
    const leftovers = [...(server.lgwSockets ?? [])]
    if (leftovers.length > 0) {
      const timer = setTimeout(() => {
        for (const socket of leftovers) {
          try {
            socket.destroy()
          } catch {
            /* 已经关了 */
          }
        }
      }, 5000)
      timer.unref?.()
    }
  }

  /**
   * 绑一次。返回 Promise：绑定成功 / 彻底失败（含回退也失败）后 resolve。
   * 面板的「保存并重绑」必须等它 —— listen() 是异步的，不等就会把上一轮的空状态
   * 当成新状态回给浏览器（表现为「点了保存但地址还是 null」）。
   */
  let settleListen = null
  function finishListen() {
    const done = settleListen
    settleListen = null
    if (done !== null && done !== undefined) done()
  }

  function listen(host, port, canFallback) {
    const server = makeServer()
    current = server
    state.requestedHost = host

    server.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      state.listening = false
      state.error = `${host}:${port} 监听失败：${message}`
      // EADDRINUSE 换地址也救不了；其它失败（换网后 IP 不属于本机）退回全接口。
      const retryable = error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES'
      try {
        server.close(() => {})
      } catch {
        /* ignore */
      }
      if (canFallback && retryable && host !== '0.0.0.0') {
        state.fallbackFrom = host
        console.warn(`[lan-gateway] ${host} 绑不上（${message}），自动退回 0.0.0.0:${port}`)
        listen('0.0.0.0', port, false)
        return
      }
      finishListen()
    })

    server.on('listening', () => {
      const address = server.address()
      state.listening = true
      state.error = null
      state.boundHost = host
      state.boundPort = typeof address === 'object' && address !== null ? address.port : port
      state.startedAt = Date.now()
      if (host !== '0.0.0.0') state.fallbackFrom = null
      else if (settings.mode === 'fixed' && typeof settings.host === 'string' && settings.host.trim() !== '') state.fallbackFrom = settings.host.trim()
      else state.fallbackFrom = null
      const urls = lanAddresses(state.boundPort)
        .filter((entry) => !entry.tunnel)
        .map((entry) => entry.url)
      const gate = settings.accessKey === '' ? '免密' : '需要访问密钥'
      console.log(`[lan-gateway] 局域网入口就绪（监听 ${host}:${state.boundPort}，${gate}）：${urls.join('  ') || '(没有找到局域网 IPv4)'}`)
      finishListen()
    })

    try {
      server.listen(port, host)
    } catch (error) {
      state.error = `${host}:${port} 监听失败：${error instanceof Error ? error.message : String(error)}`
      finishListen()
    }
  }

  /**
   * 重新按当前设置绑一遍（改配置、巡检发现漂移、面板手动重绑都走这里）。
   * await 到「这一次绑定有结论」为止：成功、或回退失败，最多等 2 秒兜底。
   */
  function restartListener(reason) {
    stopListener()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        console.log(`[lan-gateway] 重绑完成（${reason}）：${state.listening ? `监听 ${state.boundHost}:${state.boundPort}` : `失败 ${state.error ?? ''}`}`)
        resolve()
      }
      const timer = setTimeout(done, 2000)
      timer.unref?.()
      settleListen = done
      listen(desiredHost(), settings.port, true)
    })
  }

  // ─────────────────────────── 面板 API ───────────────────────────

  function describe({ revealKey = false } = {}) {
    const port = state.boundPort ?? settings.port
    const addresses = lanAddresses(port)
    const usable = addresses.filter((entry) => !entry.tunnel)
    const fallback = state.fallbackFrom
    return {
      ok: state.error === null,
      plugin: name,
      version: 2,
      listening: state.listening,
      boundHost: state.boundHost,
      boundPort: state.boundPort,
      requestedHost: state.requestedHost,
      fallbackFrom: fallback,
      error: state.error,
      startedAt: state.startedAt,
      uptimeMs: state.startedAt === 0 ? 0 : Date.now() - state.startedAt,
      innerPort: innerPort() ?? null,
      innerOrigin: innerPort() === undefined ? null : `http://${INNER_HOST}:${innerPort()}`,
      settings: {
        mode: settings.mode,
        host: settings.host,
        port: settings.port,
        autoRefreshMs: settings.autoRefreshMs,
        sessionDays: settings.sessionDays
      },
      // 密钥本身只在「本机回环」上看得到：手机 2 即使已经登录，也读不到明文。
      auth: {
        enabled: settings.accessKey !== '',
        sessionDays: settings.sessionDays,
        loginPath: LOGIN_PATH,
        logoutPath: LOGOUT_PATH,
        keyHint: settings.accessKey === '' ? null : `${settings.accessKey.slice(0, 2)}…${settings.accessKey.length} 位`,
        key: revealKey ? settings.accessKey : undefined
      },
      settingsPath,
      credentialCachedAt: credentialAt,
      addresses,
      usableAddresses: usable,
      primaryUrl: usable.length > 0 ? usable[0].url : null,
      panelPath: PANEL_PATH,
      ws: { open: state.wsOpen, total: state.wsTotal },
      recent: recent.slice(0, 25)
    }
  }

  async function handlePanel(req, res) {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if ((method === 'GET' || method === 'HEAD') && (pathname === `${PANEL_PATH}/state` || pathname === `${PANEL_PATH}/api/state`)) {
        sendJson(res, 200, describe({ revealKey: isLoopbackPeer(req) }))
        return
      }

      if (method === 'POST' && (pathname === `${PANEL_PATH}/settings` || pathname === `${PANEL_PATH}/api/settings`)) {
        const body = await readJsonBody(req)
        const next = normalizeSettings({ ...settings, ...body })
        if (next.mode === 'fixed' && (next.host === '' || next.host === '0.0.0.0')) {
          sendJson(res, 400, { ok: false, error: '固定模式需要一个具体 IP；想跟随网络请选「自动」' })
          return
        }
        const keyChanged = next.accessKey !== settings.accessKey
        settings = next
        const saved = writeSavedSettings(settingsPath, settings)
        await restartListener('settings changed')
        if (keyChanged) {
          // 换了/关了密钥，旧会话一律作废（存储里的派生密钥已经变了）。
          failures.clear()
        }
        const payload = describe({ revealKey: isLoopbackPeer(req) })
        sendJson(res, 200, { ...payload, saved, keyChanged })
        return
      }

      if (method === 'POST' && (pathname === `${PANEL_PATH}/key` || pathname === `${PANEL_PATH}/api/key`)) {
        const body = await readJsonBody(req)
        const action = String(body.action ?? '')
        if (action === 'random') {
          sendJson(res, 200, { ok: true, key: randomKey() })
          return
        }
        if (action === 'clear') {
          settings = { ...settings, accessKey: '' }
          const saved = writeSavedSettings(settingsPath, settings)
          failures.clear()
          sendJson(res, 200, { ...describe({ revealKey: isLoopbackPeer(req) }), saved, keyChanged: true })
          return
        }
        if (action === 'set') {
          const key = String(body.key ?? '').trim()
          if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
            sendJson(res, 400, { ok: false, error: `密钥长度需要在 1~${MAX_KEY_LENGTH} 之间` })
            return
          }
          settings = { ...settings, accessKey: key }
          const saved = writeSavedSettings(settingsPath, settings)
          failures.clear()
          sendJson(res, 200, { ...describe({ revealKey: isLoopbackPeer(req) }), saved, keyChanged: true })
          return
        }
        sendJson(res, 400, { ok: false, error: `unknown key action: ${action}` })
        return
      }

      if (method === 'POST' && (pathname === `${PANEL_PATH}/rebind` || pathname === `${PANEL_PATH}/api/rebind`)) {
        await restartListener('manual rebind')
        sendJson(res, 200, describe({ revealKey: isLoopbackPeer(req) }))
        return
      }

      if (method === 'POST' && (pathname === `${PANEL_PATH}/credential` || pathname === `${PANEL_PATH}/api/credential`)) {
        credential = undefined
        credentialAt = 0
        try {
          await innerCredential({ force: true })
        } catch (error) {
          sendJson(res, 502, { ...describe(), ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        sendJson(res, 200, describe({ revealKey: isLoopbackPeer(req) }))
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown lan-gateway endpoint: ${method} ${pathname}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ─────────────────────────── 装配 ───────────────────────────

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PANEL_PATH, handler: handlePanel })
    return () => {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }, 'lan-gateway: panel api')

  ctx.effect(() => {
    restartListener('startup')

    const timer = setInterval(() => {
      const want = desiredHost()
      if (state.listening && state.boundHost === want) return
      if (state.boundHost === want) return
      restartListener('network changed')
    }, WATCH_MS)
    timer.unref?.()

    return () => {
      clearInterval(timer)
      stopListener()
    }
  }, 'lan-gateway: listener')

  ctx.logger?.info?.(
    `lan-gateway: mode=${settings.mode} port=${settings.port} auth=${settings.accessKey === '' ? 'off' : 'key'} settings=${settingsPath}`
  )
}
