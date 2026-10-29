// 活体验证：对本机已加载的 lan-gateway 做一次真实探测。
// 在 dsh 重启（设置 → 通用 → 重启 DSH）之后运行：
//   node /data/data/com.termux/files/home/dsh-plugins/dsh-lan-gateway/tools/verify-live.mjs
import http from 'node:http'
import os from 'node:os'

const PORT = Number(process.argv[2] ?? 3081)

function lanAddresses() {
  const out = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address)
    }
  }
  return out
}

const get = (host, path) =>
  new Promise((resolve) => {
    const q = http.request({ host, port: PORT, path, headers: { accept: 'text/html' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    q.on('error', (e) => resolve({ status: 0, body: e.code ?? e.message }))
    q.setTimeout(8000, () => q.destroy(new Error('timeout')))
    q.end()
  })

const upgrade = (host) =>
  new Promise((resolve) => {
    const q = http.request({
      host,
      port: PORT,
      path: '/api/remote.mux',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13'
      }
    })
    q.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    q.on('response', (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    q.on('error', (e) => resolve(e.code ?? e.message))
    q.setTimeout(8000, () => q.destroy(new Error('timeout')))
    q.end()
  })

let bad = 0
for (const host of ['127.0.0.1', ...lanAddresses()]) {
  const index = await get(host, '/')
  const okIndex = index.status === 200 && index.body.includes('<div id="root">')
  const status = await upgrade(host)
  const okWs = status === 101
  console.log(
    `${okIndex && okWs ? 'PASS' : 'FAIL'}  http://${host}:${PORT}/  index=${index.status} websocket=${status}` +
      (okIndex ? '' : `  body=${index.body.slice(0, 80).replace(/\n/g, ' ')}`)
  )
  if (!(okIndex && okWs)) bad++
}
process.exit(bad === 0 ? 0 : 1)
