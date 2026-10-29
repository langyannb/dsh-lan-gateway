#!/usr/bin/env node
/**
 * 离线自测：把 lib/index.js 的 apply() 跑起来，喂一个「假 ctx」+
 * 一个「假内层 dsh」（127.0.0.1 上的小服务器，模拟 token→cookie 兑换、
 * 缺 cookie 401、/api 需要鉴权、WS 升级），然后逐项核对面板 API 与反代行为。
 *
 * 为什么要有假内层：真实 dsh 的 launch token 只在本进程内存里，外部进程拿不到，
 * 所以离线台没法对着真 3080 跑「兑换 cookie」这条路。假内层把同一套契约
 * （GET /?token=… → 303 + set-cookie；缺 cookie → 401；/api → 要 cookie）
 * 复刻一遍，就能在不起 dsh、不碰真数据的前提下验完整条链路。
 *
 * 跑法：node tools/panel-selftest.mjs
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)

// ── 隔离落盘目录：绝不碰用户真的 ~/.dsh/lan-gateway.json ──
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-home-'))
process.env.DSH_HOME = tmpHome

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ════════════════════════ 假内层 dsh ════════════════════════
const COOKIE_NAME = 'dsh-auth-offlinetest'
const TOKEN = 'launch-token-offline'
let cookieValid = false
let mintCount = 0
let healArmed = true
const seen = { host: null, origin: null, secFetchSite: null, cookie: null }

function accept(req, res, body) {
  if (!cookieValid) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required')
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-inner': '1' })
  res.end(body)
}

const inner = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  seen.host = req.headers.host
  seen.origin = req.headers.origin ?? null
  seen.secFetchSite = req.headers['sec-fetch-site'] ?? null
  seen.cookie = req.headers.cookie ?? null

  // 兑换：/?token=…
  if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
    cookieValid = true
    mintCount += 1
    res.writeHead(303, {
      location: './',
      'set-cookie': `${COOKIE_NAME}=tok; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`
    })
    res.end()
    return
  }
  if (url.pathname === '/') {
    accept(req, res, '<!doctype html><html><body>inner-index</body></html>')
    return
  }
  if (url.pathname === '/asset.js') {
    accept(req, res, 'console.log("asset")')
    return
  }
  if (url.pathname === '/api/heal') {
    // 第一次故意 401 并把 cookie 作废，验证网关能否自动重换 cookie 后重放一次
    if (healArmed) {
      healArmed = false
      cookieValid = false
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('expired')
      return
    }
    accept(req, res, 'healed')
    return
  }
  if (url.pathname === '/api/echo') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => accept(req, res, Buffer.concat(chunks).toString('utf8')))
    return
  }
  accept(req, res, 'inner-generic')
})

inner.on('upgrade', (req, socket) => {
  const ok = cookieValid && String(req.headers.cookie ?? '').includes(`${COOKIE_NAME}=tok`)
  if (!ok) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const key = req.headers['sec-websocket-key']
  const digest = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`)
  // 收到任意客户端帧就回一条「未加掩码」的文本帧 pong：
  // 既证客户端→内层通了（不回就说明没收到），又证内层→客户端通了。
  socket.on('data', () => {
    const payload = Buffer.from('pong')
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
  })
})

const innerPort = await new Promise((resolve) => {
  inner.listen(0, '127.0.0.1', () => resolve(inner.address().port))
})

// ════════════════════════ 假 ctx ════════════════════════
const routes = []
const cleanups = []
const ctx = {
  webServer: {
    port: innerPort,
    get host() {
      return '127.0.0.1'
    },
    get protocol() {
      return 'http'
    },
    getOrigin: () => `http://127.0.0.1:${innerPort}`,
    register: (route) => {
      routes.push(route)
      return () => {}
    }
  },
  connection: {
    // 真实实现是拼 ?token=<launchToken>；这里给假内层认识的那个
    authenticatedUrl: (base) => {
      const u = new URL(base)
      u.searchParams.set('token', TOKEN)
      return u.href
    }
  },
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') cleanups.push(dispose)
  },
  on: () => () => {},
  logger: { info: () => {}, warn: () => {} }
}

const plugin = await import(path.join(pluginRoot, 'lib/index.js'))
plugin.apply(ctx, { mode: 'auto', host: '', port: 4101, autoRefreshMs: 1000 })
await new Promise((r) => setTimeout(r, 350))

check('注册了 /lan-gateway 前缀路由', routes.some((r) => r.path === '/lan-gateway' && r.kind === 'prefix'))

const panel = routes.find((r) => r.path === '/lan-gateway').handler

// 用假 req/res 调面板处理器（不经网络，验的是处理逻辑本身）
function callPanel(method, urlPath, body) {
  return new Promise((resolve) => {
    const req = new (class extends http.IncomingMessage {
      constructor() {
        super({})
        this.method = method
        this.url = urlPath
        this.headers = { 'content-type': 'application/json' }
      }
    })()
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code
        Object.assign(this.headers, headers ?? {})
      },
      end(payload) {
        chunks.push(payload ?? '')
        const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
        resolve({ status: this.statusCode, headers: this.headers, text })
      }
    }
    setImmediate(() => {
      if (body !== undefined) req.push(JSON.stringify(body))
      req.push(null)
      panel(req, res).catch((error) => resolve({ status: 500, text: String(error) }))
    })
  })
}

const state0 = await callPanel('GET', '/lan-gateway/state')
const json0 = JSON.parse(state0.text)
check('GET /state 200', state0.status === 200, `status=${state0.status}`)
check('初始监听 0.0.0.0:4101', json0.listening === true && json0.boundHost === '0.0.0.0' && json0.boundPort === 4101, `${json0.boundHost}:${json0.boundPort}`)
check('state 带内层端口与网卡列表', json0.innerPort === innerPort && Array.isArray(json0.addresses), `innerPort=${json0.innerPort} ifaces=${json0.addresses?.length}`)
check('state 带保存路径', typeof json0.settingsPath === 'string' && json0.settingsPath.startsWith(tmpHome), String(json0.settingsPath))

// 换端口（面板「自定义」）
const r1 = await callPanel('POST', '/lan-gateway/settings', { mode: 'auto', host: '', port: 4102, autoRefreshMs: 0 })
const json1 = JSON.parse(r1.text)
check('保存新端口后立刻监听 0.0.0.0:4102', json1.listening === true && json1.boundPort === 4102, `${json1.boundHost}:${json1.boundPort} err=${json1.error}`)
check('autoRefreshMs 落盘为 0', json1.settings?.autoRefreshMs === 0, String(json1.settings?.autoRefreshMs))

// 固定模式 + 一个本机不存在的 IP ⇒ 自动退回全接口（换网后的核心保护）
const stale = '192.168.123.250'
const r2 = await callPanel('POST', '/lan-gateway/settings', { mode: 'fixed', host: stale, port: 4102, autoRefreshMs: 0 })
const json2 = JSON.parse(r2.text)
check('固定 IP 不在本机 ⇒ 退回 0.0.0.0 仍在监听', json2.listening === true && json2.boundHost === '0.0.0.0', `${json2.boundHost}:${json2.boundPort} err=${json2.error}`)
check('并回报 fallbackFrom', json2.fallbackFrom === stale, String(json2.fallbackFrom))

// 选回自动：host 里的旧 IP 不能把 mode 反推回固定（这是修过的 bug）
const r3 = await callPanel('POST', '/lan-gateway/settings', { mode: 'auto', host: stale, port: 4102, autoRefreshMs: 0 })
const json3 = JSON.parse(r3.text)
check('显式选「自动」不会被旧 host 反推回固定', json3.settings?.mode === 'auto', `mode=${json3.settings?.mode}`)
check('自动模式下 fallbackFrom 清空', json3.fallbackFrom === null, String(json3.fallbackFrom))

const r4 = await callPanel('PUT', '/lan-gateway/settings', {})
check('未知方法 → 405/404 而不是崩', r4.status === 405 || r4.status === 404, `status=${r4.status}`)
const r5 = await callPanel('GET', '/lan-gateway/nope')
check('未知端点 → 404', r5.status === 404, `status=${r5.status}`)

const r6 = await callPanel('POST', '/lan-gateway/rebind', {})
check('POST /rebind 200 且仍在监听', r6.status === 200 && JSON.parse(r6.text).listening === true, `status=${r6.status}`)

const r7 = await callPanel('POST', '/lan-gateway/credential', {})
check('POST /credential 能换到凭据', r7.status === 200 && JSON.parse(r7.text).ok === true, `status=${r7.status}`)

// ════════════════════════ 真反代（经 127.0.0.1:4102） ════════════════════════
function get(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const gw = 4102
const p1 = await get(gw, '/')
check('反代首页 200 且是内层 HTML', p1.status === 200 && p1.body.toString().includes('inner-index'), `${p1.status} ${p1.body.length}B`)
check('Host 改写成 127.0.0.1:<innerPort>', seen.host === `127.0.0.1:${innerPort}`, String(seen.host))
check('Origin 被剥掉', seen.origin === null, String(seen.origin))
check('sec-fetch-site 置 same-origin', seen.secFetchSite === 'same-origin', String(seen.secFetchSite))
check('自动附带兑换来的 cookie', String(seen.cookie ?? '').includes(`${COOKIE_NAME}=tok`), String(seen.cookie))
check('浏览器自带的无关键 cookie 不外泄（只发内层那一条）', String(seen.cookie ?? '').split(';').length === 1, String(seen.cookie))

const p2 = await get(gw, '/asset.js')
check('静态资源透传字节一致', p2.status === 200 && p2.body.toString() === 'console.log("asset")', `${p2.status} ${p2.body.length}B`)

const p3 = await get(gw, '/api/echo', { method: 'POST', body: JSON.stringify({ hello: 'lan' }), headers: { 'content-type': 'application/json' } })
check('POST 体透传（含 401 重放路径）', p3.status === 200 && p3.body.toString() === '{"hello":"lan"}', `${p3.status} ${p3.body.toString()}`)

// 让内层把 cookie 作废，验证网关自动重换一次
const p4 = await get(gw, '/api/heal')
check('内层 401 后自动重换 cookie 并重放', p4.status === 200 && p4.body.toString() === 'healed', `${p4.status} ${p4.body.toString()} mint=${mintCount}`)
check('确实多兑了一次凭据', mintCount >= 2, `mint=${mintCount}`)

// WS 升级
const wsResult = await new Promise((resolve) => {
  const key = crypto.randomBytes(16).toString('base64')
  const socket = net.connect(gw, '127.0.0.1', () => {
    socket.write(
      'GET /api/remote.mux HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${gw}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    )
  })
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => {
    socket.destroy()
    resolve({ status: 0, echoed: false })
  }, 3000)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const text = buf.toString('latin1')
    const head = text.indexOf('\r\n\r\n')
    if (head < 0) return
    if (!text.startsWith('HTTP/1.1 101')) {
      clearTimeout(timer)
      socket.destroy()
      resolve({ status: Number(text.split(' ')[1]), echoed: false })
      return
    }
    // 握手完成 → 发一个 masked 文本帧，看有没有原样回显
    const payload = Buffer.from('ping')
    const mask = crypto.randomBytes(4)
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))])
    socket.write(frame)
    setTimeout(() => {
      clearTimeout(timer)
      const after = buf.toString('latin1').slice(head + 4)
      socket.destroy()
      resolve({ status: 101, echoed: after.includes('pong') })
    }, 400)
  })
  socket.on('error', () => resolve({ status: 0, echoed: false }))
})
check('WS 升级 101', wsResult.status === 101, `status=${wsResult.status}`)
check('WS 帧双向透传', wsResult.echoed === true, String(wsResult.echoed))

// ════════════════════════ 访问密钥 ════════════════════════
function postForm(port, urlPath, fields) {
  const body = new URLSearchParams(fields).toString()
  return get(port, urlPath, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }
  })
}

function wsHandshake(port, cookie) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ]
      if (cookie) lines.push(`Cookie: ${cookie}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(0)
    }, 2500)
    socket.on('data', (chunk) => {
      clearTimeout(timer)
      const text = chunk.toString('latin1')
      socket.destroy()
      const match = /^HTTP\/1\.1 (\d{3})/.exec(text)
      resolve(match ? Number(match[1]) : 0)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
  })
}

const KEY = 'test-key-abcdef'
const k1 = await callPanel('POST', '/lan-gateway/key', { action: 'set', key: KEY })
const j1 = JSON.parse(k1.text)
check('设置密钥成功', k1.status === 200 && j1.auth?.enabled === true, `status=${k1.status} enabled=${j1.auth?.enabled}`)
check('面板不回传密钥明文（非回环调用）', j1.auth?.key === undefined && typeof j1.auth?.keyHint === 'string', String(j1.auth?.keyHint))

const a1 = await get(gw, '/', { headers: { accept: 'text/html' } })
check('开了密钥后：页面请求 303 去登录页', a1.status === 303 && String(a1.headers.location ?? '').startsWith('/__lgw/login'), `${a1.status} ${a1.headers.location ?? ''}`)

const a2 = await get(gw, '/__lgw/login', { headers: { accept: 'text/html' } })
const loginHtml = a2.body.toString()
check(
  '登录页可打开且含密码输入框',
  a2.status === 200 && loginHtml.includes('action="/__lgw/login"') && loginHtml.includes('type="password"') && loginHtml.includes('name="key"'),
  `${a2.status} ${a2.body.length}B`
)

const a3 = await get(gw, '/api/echo')
check('接口请求未登录 → 401（不给 HTML）', a3.status === 401, `${a3.status} ${a3.body.toString().trim()}`)

const a4 = await postForm(gw, '/__lgw/login', { key: 'wrong-key', next: '/' })
check('错误密钥 → 401 且不发作会话', a4.status === 401 && !String(a4.headers['set-cookie'] ?? '').includes('lgw_session'), `${a4.status}`)

const a5 = await postForm(gw, '/__lgw/login', { key: KEY, next: '/' })
const sess = String(a5.headers['set-cookie'] ?? '')
check('正确密钥 → 303 并发作 HttpOnly 会话', a5.status === 303 && sess.startsWith('lgw_session=') && /HttpOnly/.test(sess) && /SameSite=Lax/.test(sess), `${a5.status} ${sess.slice(0, 42)}`)

const cookie = sess.split(';')[0]
const a6 = await get(gw, '/', { headers: { accept: 'text/html', cookie } })
check('带会话可以正常打开首页', a6.status === 200 && a6.body.toString().includes('inner-index'), `${a6.status} ${a6.body.length}B`)
check('会话 cookie 不会被转发给内层', !String(seen.cookie ?? '').includes('lgw_session'), String(seen.cookie))

const a7 = await get(gw, `/?key=${encodeURIComponent(KEY)}`, { headers: { accept: 'text/html' } })
check('?key= 一次性登录 → 303 且摘掉 key', a7.status === 303 && String(a7.headers.location ?? '') === '/' && String(a7.headers['set-cookie'] ?? '').includes('lgw_session'), `${a7.status} ${a7.headers.location ?? ''}`)

const a8 = await get(gw, '/', { headers: { accept: 'text/html' } }).then(() => true)
check('没有会话时仍要登录（不是永久放行）', a8 === true, 'redirected')

const a9 = await wsHandshake(gw, null)
check('未登录的 WebSocket 升级被拒（401）', a9 === 401, `status=${a9}`)
const a10 = await wsHandshake(gw, cookie)
check('带会话的 WebSocket 升级放行（101）', a10 === 101, `status=${a10}`)

const a11 = await get(gw, '/__lgw/logout', { headers: { accept: 'text/html' } })
check('注销清会话', a11.status === 303 && String(a11.headers['set-cookie'] ?? '').includes('Max-Age=0'), `${a11.status}`)

const k2 = await callPanel('POST', '/lan-gateway/key', { action: 'clear' })
const j2 = JSON.parse(k2.text)
check('关闭密钥成功', k2.status === 200 && j2.auth?.enabled === false, `enabled=${j2.auth?.enabled}`)
const a12 = await get(gw, '/')
check('关掉密钥后恢复免密直通', a12.status === 200, `${a12.status}`)

const k3 = await callPanel('POST', '/lan-gateway/key', { action: 'random' })
const j3 = JSON.parse(k3.text)
check('随机密钥可用且够长', k3.status === 200 && typeof j3.key === 'string' && j3.key.length >= 16, `${j3.key?.length ?? 0} 位`)

const k4 = await callPanel('POST', '/lan-gateway/key', { action: 'set', key: '' })
check('空密钥被拒（关闭要用 clear）', k4.status === 400, `status=${k4.status}`)

// 停监听：effect 清理后端口必须释放
for (const dispose of cleanups) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}
await new Promise((r) => setTimeout(r, 200))
const closed = await get(gw, '/').then(() => false).catch(() => true)
check('dispose 后端口已释放', closed === true, String(closed))

inner.close()
fs.rmSync(tmpHome, { recursive: true, force: true })

// 台子里有真实 socket（WS 代理），收尾后直接退，别等 event loop 自然清空
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ''}`)
  process.exit(1)
}
process.exit(0)
