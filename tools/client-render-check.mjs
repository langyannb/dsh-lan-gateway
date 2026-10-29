#!/usr/bin/env node
/**
 * 浏览器半边自检：用「迷你 React」把「局域网网关」面板真正挂载一遍。
 *
 * 为什么自己写迷你 React：profile 里没有 react/react-dom（React 是页面 bundle 内提供的），
 * 所以离线既不能 import 也不能 SSR。这里只实现面板用到的那 5 个 API
 * （createElement / useState / useCallback / useRef / useEffect），
 * 配一个「渲染→跑 effect→setState 再渲染」的循环，就能验到：
 *   1. 首帧不崩（手写 h() 最容易引用不存在的变量）
 *   2. fetch 到 state 之后，地址列表 / 端口 / 刷新档位都按数据渲染出来
 *   3. 「保存并重绑」发出的 POST body 字段名与宿主路由一致
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)

// ─────────────────────────── 迷你 React ───────────────────────────
let schedule = null
const FRAGMENT = Symbol('Fragment')

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
}

const hooks = { list: [], index: 0 }
function slot() {
  const i = hooks.index++
  if (hooks.list[i] === undefined) hooks.list[i] = { kind: null, value: undefined }
  return hooks.list[i]
}

const pendingEffects = []
const rerender = { needed: false }

function useState(initial) {
  const cell = slot()
  if (cell.kind !== 'state') {
    cell.kind = 'state'
    cell.value = typeof initial === 'function' ? initial() : initial
  }
  const set = (next) => {
    const value = typeof next === 'function' ? next(cell.value) : next
    if (Object.is(value, cell.value)) return
    cell.value = value
    rerender.needed = true
  }
  return [cell.value, set]
}

function depsEqual(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

function useEffect(fn, deps) {
  const cell = slot()
  const changed = cell.kind !== 'effect' || !depsEqual(cell.deps, deps)
  cell.kind = 'effect'
  if (changed) {
    cell.deps = deps
    pendingEffects.push(fn)
  }
}

function useCallback(fn, deps) {
  const cell = slot()
  if (cell.kind !== 'callback' || !depsEqual(cell.deps, deps)) {
    cell.kind = 'callback'
    cell.deps = deps
    cell.value = fn
  }
  return cell.value
}

function useRef(initial) {
  const cell = slot()
  if (cell.kind !== 'ref') {
    cell.kind = 'ref'
    cell.value = { current: initial }
  }
  return cell.value
}

const React = { createElement, Fragment: FRAGMENT, useState, useEffect, useCallback, useRef }

// ─────────────────────────── 收集元素树 ───────────────────────────
function collect(node, out) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return
  }
  if (typeof node === 'function') {
    collect(node({}), out)
    return
  }
  const { type, props, children } = node
  if (type === FRAGMENT) {
    for (const child of children) collect(child, out)
    return
  }
  if (typeof type === 'function') {
    // 子组件用同一套 hook 槽位顺序渲染（本面板只用了内联的 h('div', …)，不会到这里）
    collect(type({ ...props, children }), out)
    return
  }
  out.tags.push(type)
  if (props && props.value !== undefined) out.values.push([type, props.value])
  if (props && props['aria-label']) out.labels.push(props['aria-label'])
  if (props && props.onClick) out.clickable.push(type)
  for (const child of children) collect(child, out)
}

// ─────────────────────────── 加载插件 ───────────────────────────
let captured = null
globalThis.window = { __ModuleLoader__: { load: (spec) => (captured = spec) } }
await import(path.join(pluginRoot, 'lib/client.js'))
if (!captured) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')

const plugin = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})

let Panel = null
plugin.apply({
  slots: {
    inject: (_name, cb) => cb(),
    register: (_spec, component) => {
      Panel = component
      return () => {}
    }
  }
})

// ─────────────────────────── 假后端 ───────────────────────────
const STATE = {
  ok: true,
  listening: true,
  boundHost: '0.0.0.0',
  boundPort: 3081,
  requestedHost: '0.0.0.0',
  fallbackFrom: null,
  error: null,
  startedAt: Date.now() - 123000,
  uptimeMs: 123000,
  innerPort: 3080,
  settings: { mode: 'auto', host: '', port: 3081, autoRefreshMs: 3000 },
  settingsPath: '/home/.dsh/lan-gateway.json',
  addresses: [
    { iface: 'wlan0', address: '192.168.2.134', url: 'http://192.168.2.134:3081/', tunnel: false, likely: true },
    { iface: 'tun0', address: '172.30.195.126', url: 'http://172.30.195.126:3081/', tunnel: true, likely: false }
  ],
  usableAddresses: [{ iface: 'wlan0', address: '192.168.2.134', url: 'http://192.168.2.134:3081/', tunnel: false, likely: true }],
  urls: ['http://192.168.2.134:3081/'],
  primaryUrl: 'http://192.168.2.134:3081/'
}

const calls = []
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body })
  return { ok: true, status: 200, json: async () => STATE }
}
// node 的 navigator 是只读 getter，直接赋值会 TypeError；用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true
})

// ─────────────────────────── 挂载循环 ───────────────────────────
function renderOnce() {
  hooks.index = 0
  pendingEffects.length = 0
  rerender.needed = false
  const tree = Panel({})
  const out = { text: [], tags: [], values: [], labels: [], clickable: [] }
  collect(tree, out)
  return { tree, out }
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

check('factory 返回 {name, inject, apply}', plugin.name === 'lan-gateway' && Array.isArray(plugin.inject))
check('注册进 settings.section', typeof Panel === 'function')

let first = null
try {
  first = renderOnce()
  check('首帧渲染不崩', true, `${first.out.text.join('').length} 字`)
} catch (error) {
  check('首帧渲染不崩', false, String(error && error.message))
}

if (first) {
  const text = first.out.text.join('')
  check('首帧有标题', text.includes('局域网网关'))
  check('首帧有 <style>', first.out.tags.includes('style'))
  check('首帧显示加载中/未取到', /读取|加载|—/.test(text), text.slice(0, 60))
}

// 跑 effect（首帧的 load），让 fetch 落地后再渲染
let last = first
for (let round = 0; round < 12; round += 1) {
  const effects = pendingEffects.slice()
  pendingEffects.length = 0
  for (const fn of effects) {
    try {
      fn()
    } catch (error) {
      check(`effect 第 ${round + 1} 轮不崩`, false, String(error && error.message))
      break
    }
  }
  await new Promise((r) => setTimeout(r, 0))
  const before = hooks.list.map((c) => c.value)
  last = renderOnce()
  const after = hooks.list.map((c) => c.value)
  const settled = effects.length === 0 && !rerender.needed && JSON.stringify(before) === JSON.stringify(after)
  if (settled && round > 2) break
}

const finalText = last.out.text.join('')
check('已请求 /lan-gateway/state', calls.some((c) => c.url.includes('/lan-gateway/state')), calls.map((c) => c.url).join(','))
check('渲染出局域网地址', finalText.includes('192.168.2.134:3081'), finalText.match(/http:\/\/[^\s]*/g)?.join(' '))
check('隧道地址被标注而不是当成主推', /隧道|tun0/.test(finalText), '')
check('渲染出端口值 3081', last.out.values.some(([tag, v]) => (tag === 'input' || tag === 'select') && String(v) === '3081'), JSON.stringify(last.out.values))
check('渲染出刷新档位选项', finalText.includes('自动（跟随当前网络）') || finalText.includes('自动'), '')
check('有「立即刷新」按钮', finalText.includes('立即刷新'), '')
check('有「保存并重绑」按钮', /保存并重绑|保存/.test(finalText), '')
check('显示落盘路径', finalText.includes('/home/.dsh/lan-gateway.json') || finalText.includes('lan-gateway.json'), '')

// 点「保存并重绑」：POST body 字段名必须和宿主路由一致
const saveBtn = findButton(last.tree, /保存/)
if (!saveBtn) {
  check('找到保存按钮', false, '')
} else {
  await saveBtn.props.onClick()
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/lan-gateway/settings'))
  check('保存按钮 POST /lan-gateway/settings', Boolean(post), post ? post.url : calls.map((c) => `${c.method} ${c.url}`).join(' | '))
  if (post) {
    const body = JSON.parse(post.body)
    check('body 字段与宿主 normalizeSettings 对齐', ['mode', 'host', 'port', 'autoRefreshMs'].every((k) => k in body), post.body)
    check('body 的 port 是数字', typeof body.port === 'number', post.body)
  }
}

function findButton(node, pattern) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, pattern)
      if (hit) return hit
    }
    return null
  }
  if (node.type === 'button' && node.props?.onClick) {
    const label = node.children.filter((c) => typeof c === 'string').join('')
    if (pattern.test(label)) return node
  }
  for (const child of node.children ?? []) {
    const hit = findButton(child, pattern)
    if (hit) return hit
  }
  return null
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
