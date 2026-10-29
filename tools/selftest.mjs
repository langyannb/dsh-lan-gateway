// 离线自测：用一个假的「内层 dsh」验证网关的兑换/反代/WS 三条链路。
// 不碰真实 dsh，也不需要真 launch token。
import http from 'node:http'
import { apply } from '../lib/index.js'

const INNER = 3999
let COOKIE = 'dsh-auth-selftest=ok'

// ---- 假内层 dsh ----
const inner = http.createServer((req, res) => {
  const host = req.headers.host
  if (host !== `127.0.0.1:${INNER}`) return res.writeHead(403).end('bad host')
  if (req.url.startsWith('/?token=abc')) {
    res.writeHead(303, { location: './', 'set-cookie': [`${COOKIE}; Path=/; HttpOnly`] })
    return res.end()
  }
  const authed = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).includes(COOKIE)
  if (req.method === 'POST' && req.url.startsWith('/api/echo')) {
    if (!authed) { req.resume(); return res.writeHead(401).end('unauthorized') }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echo: Buffer.concat(chunks).toString() }))
    })
    return
  }
  if (req.url.startsWith('/api')) {
    if (!authed) return res.writeHead(401).end('unauthorized')
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, url: req.url }))
  }
  if (!authed) return res.writeHead(401).end('need index auth')
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><body>inner index</body></html>')
})
inner.on('upgrade', (req, socket) => {
  const authed = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).includes(COOKIE)
  if (!authed) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  socket.on('data', (chunk) => socket.write(`echo:${chunk}`))
})

await new Promise((r) => inner.listen(INNER, '127.0.0.1', r))

// ---- 假 ctx ----
const disposers = []
const ctx = {
  webServer: { port: INNER, host: '127.0.0.1', protocol: 'http:' },
  connection: { authenticatedUrl: (base) => `${base}?token=abc` },
  effect: (fn, label) => { const d = fn(); disposers.push([label, d]); return d }
}
apply(ctx, { host: '127.0.0.1', port: 3998 })
await new Promise((r) => setTimeout(r, 300))

const get = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: 3998, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    q.on('error', reject)
    q.end()
  })

let fails = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!ok) fails++
}

const index = await get('/')
check('index 200（网关自动兑换内层 cookie）', index.status === 200 && index.body.includes('inner index'), `status=${index.status}`)

const api = await get('/api/x?y=1')
check('api 200（同一份 cookie 复用）', api.status === 200 && api.body.includes('"/api/x?y=1"'), `status=${api.status} body=${api.body.slice(0, 80)}`)

const apiNoCookieLeak = await get('/api/z', { cookie: 'other=1' })
check('浏览器自带的非 dsh cookie 不影响', apiNoCookieLeak.status === 200, `status=${apiNoCookieLeak.status}`)

const post = (path, body) =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8')
    const q = http.request(
      { host: '127.0.0.1', port: 3998, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      }
    )
    q.on('error', reject)
    q.end(payload)
  })

const echo = await post('/api/echo', '{"hello":"world"}')
check(
  'POST 体完整转发',
  echo.status === 200 && JSON.parse(echo.body).echo === '{"hello":"world"}',
  `status=${echo.status} body=${echo.body.slice(0, 60)}`
)

// 让内层换发新 cookie：网关应发现 401、重换一次、自动重放成功
COOKIE = 'dsh-auth-selftest=rotated'
const healed = await get('/api/heal')
check('内层 401 后自动重换 cookie 并重放', healed.status === 200 && healed.body.includes('"/api/heal"'), `status=${healed.status}`)

// WS
const ws = await new Promise((resolve) => {
  const q = http.request({
    host: '127.0.0.1', port: 3998, path: '/api/remote.mux',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }
  })
  q.on('upgrade', (res, socket) => {
    socket.write('hello')
    socket.once('data', (chunk) => { socket.destroy(); resolve({ status: res.statusCode, echo: chunk.toString() }) })
    setTimeout(() => { socket.destroy(); resolve({ status: res.statusCode, echo: '(timeout)' }) }, 1500)
  })
  q.on('response', (res) => resolve({ status: res.statusCode, echo: '(no upgrade)' }))
  q.on('error', (e) => resolve({ status: 0, echo: e.message }))
  q.end()
})
check('websocket 101 + 双向数据', ws.status === 101 && ws.echo === 'echo:hello', `status=${ws.status} echo=${ws.echo}`)

for (const [, d] of disposers.reverse()) { try { d?.() } catch {} }
inner.close()
process.exit(fails === 0 ? 0 : 1)
