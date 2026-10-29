/**
 * dsh-lan-gateway —— 浏览器那一半：设置面板「局域网网关」。
 *
 * 面板只做四件事：
 *   1. 显示当前可用的局域网地址（一键复制 / 直接打开）
 *   2. 改监听方式（自动 / 固定 IP）与端口 —— 保存后宿主当场重绑，不用重启 dsh
 *   3. 访问密钥：开启 / 修改 / 随机生成 / 关闭，并可复制「带密钥的登录链接」
 *   4. 自动刷新（可关、可调间隔）+ 立即刷新 + 最近访问记录
 *
 * 宿主那一半（lib/index.js）负责真正的 listener、反代与密钥校验；这里不碰网络。
 */

window.__ModuleLoader__.load({
  id: 'dsh-lan-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/lan-gateway'
    const REFRESH_CHOICES = [
      { value: 0, label: '关闭' },
      { value: 1000, label: '1 秒' },
      { value: 2000, label: '2 秒' },
      { value: 3000, label: '3 秒' },
      { value: 5000, label: '5 秒' },
      { value: 10000, label: '10 秒' },
      { value: 30000, label: '30 秒' }
    ]

    const CSS = `
.lgw-root { display: flex; flex-direction: column; gap: 16px; padding: 2px 2px 32px;
  font-size: 13px; line-height: 1.6; color: inherit; }
.lgw-root * { box-sizing: border-box; }
.lgw-hero { border: 1px solid rgba(128,128,128,.3); border-radius: 14px; padding: 16px 18px;
  background: linear-gradient(135deg, rgba(59,130,246,.10), rgba(139,92,246,.07)); }
.lgw-herohead { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.lgw-herohead b { font-size: 15px; }
.lgw-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.lgw-dot.ok { background: #21a366; box-shadow: 0 0 0 3px rgba(33,163,102,.2); }
.lgw-dot.bad { background: #e03131; box-shadow: 0 0 0 3px rgba(224,49,49,.2); }
.lgw-dot.warn { background: #e0a72a; box-shadow: 0 0 0 3px rgba(224,167,42,.2); }
.lgw-url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 17px; font-weight: 600;
  padding: 9px 12px; border-radius: 10px; background: rgba(128,128,128,.15); word-break: break-all; }
.lgw-big { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lgw-card { border: 1px solid rgba(128,128,128,.28); border-radius: 12px; padding: 14px 16px; }
.lgw-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.lgw-title { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 14px; font-weight: 600; margin: 0 0 10px; }
.lgw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.lgw-row:first-of-type { margin-top: 0; }
.lgw-note { font-size: 12px; opacity: .66; }
.lgw-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: rgba(128,128,128,.14); padding: 2px 5px; border-radius: 5px; }
.lgw-list { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }
.lgw-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lgw-iface { font-size: 11px; opacity: .6; min-width: 52px; }
.lgw-btn { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(128,128,128,.42); background: transparent; color: inherit; white-space: nowrap; }
.lgw-btn:hover { background: rgba(128,128,128,.14); }
.lgw-btn:active { transform: translateY(1px); }
.lgw-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.lgw-btn.primary:hover { background: #1d4ed8; }
.lgw-btn.danger { border-color: rgba(224,49,49,.5); color: #e03131; }
.lgw-btn.on { background: rgba(37,99,235,.16); border-color: rgba(37,99,235,.55); color: #1d4ed8; font-weight: 600; }
.lgw-input { font: inherit; font-size: 13px; padding: 6px 9px; border-radius: 8px; color: inherit;
  border: 1px solid rgba(128,128,128,.42); background: rgba(128,128,128,.07); min-width: 0; }
.lgw-input:focus { outline: 2px solid rgba(37,99,235,.6); outline-offset: 1px; }
.lgw-input.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lgw-grow { flex: 1 1 160px; }
.lgw-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(128,128,128,.36); opacity: .9; }
.lgw-pill.on { background: rgba(33,163,102,.16); border-color: rgba(33,163,102,.5); color: #1c7c4f; }
.lgw-pill.off { background: rgba(128,128,128,.14); }
.lgw-msg { font-size: 12px; margin-top: 8px; }
.lgw-msg.bad { color: #e03131; }
.lgw-msg.ok { color: #1c7c4f; }
.lgw-log { display: flex; flex-direction: column; gap: 3px; font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lgw-logrow { display: flex; gap: 8px; white-space: nowrap; overflow: hidden; }
.lgw-path { overflow: hidden; text-overflow: ellipsis; opacity: .74; }
.lgw-s2 { color: #1c7c4f; }
.lgw-s4 { color: #e8590c; }
.lgw-toast { position: fixed; right: 18px; bottom: 22px; z-index: 60; padding: 9px 14px; border-radius: 10px;
  background: rgba(24,26,30,.92); color: #fff; font-size: 12.5px; box-shadow: 0 8px 26px rgba(0,0,0,.28); }
.lgw-empty { font-size: 12px; opacity: .6; }
`

    function toastFactory() {
      let setter = null
      return {
        bind(fn) {
          setter = fn
        },
        show(text) {
          setter?.(text)
        }
      }
    }
    const toastBus = toastFactory()

    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 非安全上下文（http + 非 localhost）没有 clipboard API */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    async function request(path, init) {
      const res = await fetch(`${API}${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init
      })
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) {
        const reason = body?.error ?? `HTTP ${res.status}`
        throw new Error(reason)
      }
      return body
    }

    function Dot({ state }) {
      const kind = state.error ? 'bad' : state.listening ? 'ok' : 'warn'
      return h('span', { className: `lgw-dot ${kind}` })
    }

    function Card({ title, right, children }) {
      return h('section', { className: 'lgw-card' }, h('div', { className: 'lgw-title' }, h('span', null, title), right ?? null), children)
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [toast, setToast] = useState('')

      // 监听表单
      const [mode, setMode] = useState('auto')
      const [host, setHost] = useState('')
      const [port, setPort] = useState('')
      // 密钥表单
      const [keyDraft, setKeyDraft] = useState('')
      const [revealed, setRevealed] = useState(null)

      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        toastBus.bind((text) => {
          setToast(text)
          setTimeout(() => setToast(''), 1600)
        })
      }, [])

      const applyState = useCallback((next) => {
        if (!alive.current || next === null || typeof next !== 'object') return
        setState(next)
        setError(next.error ?? '')
        if (next.settings) {
          setMode(next.settings.mode ?? 'auto')
          setHost(next.settings.host ?? '')
          setPort(String(next.settings.port ?? ''))
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          applyState(await request('/state'))
        } catch (err) {
          if (alive.current) setError(err instanceof Error ? err.message : String(err))
        }
      }, [applyState])

      // 首次加载
      useEffect(() => {
        refresh()
      }, [refresh])

      // 自动刷新：间隔由服务端设置决定（0 = 关闭）
      const interval = state?.settings?.autoRefreshMs ?? 3000
      useEffect(() => {
        if (interval <= 0) return undefined
        const timer = setInterval(refresh, interval)
        return () => clearInterval(timer)
      }, [interval, refresh])

      const run = useCallback(
        async (label, fn) => {
          setBusy(label)
          setNotice(null)
          try {
            const result = await fn()
            if (result !== undefined && result !== null) applyState(result)
            setNotice({ ok: true, text: `${label}成功` })
            return result
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err)
            setNotice({ ok: false, text: `${label}失败：${text}` })
            return undefined
          } finally {
            if (alive.current) setBusy('')
          }
        },
        [applyState]
      )

      const copy = useCallback(async (text, what) => {
        const ok = await copyText(text)
        toastBus.show(ok ? `已复制${what ?? ''}` : '复制失败，请手动选中')
      }, [])

      async function saveListener() {
        const body = { mode, port: Number(port) }
        if (mode === 'fixed') body.host = host.trim()
        await run('保存监听设置', () => request('/settings', { method: 'POST', body: JSON.stringify(body) }))
      }

      async function saveKey() {
        const key = keyDraft.trim()
        if (key === '') return
        const result = await run('设置密钥', () => request('/key', { method: 'POST', body: JSON.stringify({ action: 'set', key }) }))
        if (result) setKeyDraft('')
      }

      async function randomizeKey() {
        const result = await run('生成随机密钥', () => request('/key', { method: 'POST', body: JSON.stringify({ action: 'random' }) }))
        const key = result?.key
        if (typeof key === 'string' && key !== '') {
          setKeyDraft(key)
          await copy(key, '新密钥')
        }
      }

      async function disableKey() {
        const result = await run('关闭密钥', () => request('/key', { method: 'POST', body: JSON.stringify({ action: 'clear' }) }))
        if (result) setRevealed(null)
      }

      async function revealKey() {
        if (revealed !== null) {
          setRevealed(null)
          return
        }
        const value = state?.auth?.key
        if (typeof value === 'string' && value !== '') {
          setRevealed(value)
          return
        }
        if (state?.auth?.enabled) {
          setNotice({ ok: false, text: '密钥只在本机（127.0.0.1）的面板上显示；现在是在别的设备上打开的。' })
          return
        }
        setNotice({ ok: false, text: '当前没有开启密钥。' })
      }

      async function saveRefresh(value) {
        await run('保存刷新间隔', () => request('/settings', { method: 'POST', body: JSON.stringify({ autoRefreshMs: value }) }))
      }

      const usable = state?.usableAddresses ?? []
      const primary = state?.primaryUrl ?? null
      const authOn = state?.auth?.enabled === true
      const loginUrl = primary && authOn && typeof state?.auth?.key === 'string' && state.auth.key !== ''
        ? `${primary}?key=${encodeURIComponent(state.auth.key)}`
        : null

      return h(
        'div',
        { className: 'lgw-root' },
        h('style', null, CSS),
        toast === '' ? null : h('div', { className: 'lgw-toast' }, toast),

        // ── 顶部状态 + 地址 ──
        h(
          'div',
          { className: 'lgw-hero' },
          h(
            'div',
            { className: 'lgw-herohead' },
            h(Dot, { state: state ?? {} }),
            h('b', null, state?.listening ? '局域网入口运行中' : state === null ? '读取状态…' : '未在监听'),
            h(
              'span',
              { className: `lgw-pill ${authOn ? 'on' : 'off'}` },
              authOn ? `访问密钥：开（记住 ${state?.auth?.sessionDays ?? 30} 天）` : '访问密钥：关闭'
            ),
            state?.fallbackFrom
              ? h('span', { className: 'lgw-pill' }, `固定 IP ${state.fallbackFrom} 已不在本机，已自动切全接口`)
              : null
          ),
          primary
            ? h(
                'div',
                { className: 'lgw-big' },
                h('span', { className: 'lgw-url' }, primary),
                h('button', { className: 'lgw-btn primary', onClick: () => copy(primary, '地址') }, '复制'),
                h('a', { className: 'lgw-btn', href: primary, target: '_blank', rel: 'noreferrer' }, '打开')
              )
            : h('div', { className: 'lgw-empty' }, '没有检测到局域网 IPv4：确认 Wi-Fi 已连接、且不是纯流量环境。'),
          h(
            'div',
            { className: 'lgw-row' },
            h('span', { className: 'lgw-note' },
              `监听 ${state?.boundHost ?? '—'}:${state?.boundPort ?? '—'}　·　转发到 ${state?.innerOrigin ?? '—'}`),
            h('button', { className: 'lgw-btn', onClick: () => refresh() }, '立即刷新'),
            busy === '' ? null : h('span', { className: 'lgw-note' }, `${busy}…`)
          ),
          error === '' ? null : h('div', { className: 'lgw-msg bad' }, error)
        ),

        // ── 地址列表 ──
        usable.length > 1
          ? h(
              Card,
              { title: '全部可用地址' },
              h(
                'div',
                { className: 'lgw-list' },
                usable.map((entry) =>
                  h(
                    'div',
                    { key: entry.url, className: 'lgw-item' },
                    h('span', { className: 'lgw-iface' }, entry.iface),
                    h('span', { className: 'lgw-code' }, entry.url),
                    h('button', { className: 'lgw-btn', onClick: () => copy(entry.url, '地址') }, '复制')
                  )
                )
              )
            )
          : null,

        // ── 三张设置卡 ──
        h(
          'div',
          { className: 'lgw-cards' },

          // 监听
          h(
            Card,
            { title: '监听方式' },
            h(
              'div',
              { className: 'lgw-row' },
              h('button', { className: `lgw-btn ${mode === 'auto' ? 'on' : ''}`, onClick: () => setMode('auto') }, '自动（跟随网络）'),
              h('button', { className: `lgw-btn ${mode === 'fixed' ? 'on' : ''}`, onClick: () => setMode('fixed') }, '固定 IP')
            ),
            mode === 'fixed'
              ? h(
                  'div',
                  { className: 'lgw-row' },
                  h(
                    'select',
                    { className: 'lgw-input lgw-grow', value: host, onChange: (event) => setHost(event.target.value) },
                    h('option', { value: '' }, '选择一块网卡…'),
                    (state?.addresses ?? []).map((entry) =>
                      h('option', { key: entry.address, value: entry.address }, `${entry.iface}　${entry.address}`)
                    )
                  )
                )
              : h('div', { className: 'lgw-note' }, '绑 0.0.0.0：换 Wi-Fi、换 IP 都不用改配置，面板地址会跟着变。'),
            h(
              'div',
              { className: 'lgw-row' },
              h('span', { className: 'lgw-note' }, '端口'),
              h('input', {
                className: 'lgw-input mono',
                style: { width: '92px' },
                value: port,
                inputMode: 'numeric',
                onChange: (event) => setPort(event.target.value.replace(/[^0-9]/g, ''))
              }),
              h('button', { className: 'lgw-btn primary', onClick: saveListener }, '保存并重绑')
            )
          ),

          // 密钥
          h(
            Card,
            {
              title: '访问密钥',
              right: h('span', { className: `lgw-pill ${authOn ? 'on' : 'off'}` }, authOn ? '已开启' : '已关闭')
            },
            h(
              'div',
              { className: 'lgw-row' },
              h('input', {
                className: 'lgw-input mono lgw-grow',
                type: 'text',
                placeholder: authOn ? '输入新密钥可直接替换' : '留空即免密；输入后点设置',
                value: keyDraft,
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => setKeyDraft(event.target.value)
              }),
              h('button', { className: 'lgw-btn primary', onClick: saveKey }, '设置')
            ),
            h(
              'div',
              { className: 'lgw-row' },
              h('button', { className: 'lgw-btn', onClick: randomizeKey }, '生成随机密钥'),
              h('button', { className: 'lgw-btn', onClick: revealKey }, revealed === null ? '显示当前密钥' : '隐藏'),
              authOn ? h('button', { className: 'lgw-btn danger', onClick: disableKey }, '关闭密钥') : null
            ),
            revealed === null
              ? null
              : h(
                  'div',
                  { className: 'lgw-row' },
                  h('span', { className: 'lgw-code' }, revealed),
                  h('button', { className: 'lgw-btn', onClick: () => copy(revealed, '密钥') }, '复制')
                ),
            loginUrl
              ? h(
                  'div',
                  { className: 'lgw-row' },
                  h('button', { className: 'lgw-btn', onClick: () => copy(loginUrl, '带密钥的链接') }, '复制带密钥的链接'),
                  h('span', { className: 'lgw-note' }, '手机 2 打开这条链接会自动登录并记住，不用手敲密钥')
                )
              : h('div', { className: 'lgw-note' }, authOn ? '登录一次记住 30 天；改密钥或关闭后所有设备需要重新登录。' : '当前同一 Wi-Fi 下任何设备都能直接打开（和 dsh 本机默认一致）。'),
            h('div', { className: 'lgw-note' }, `设置落盘：${state?.settingsPath ?? '—'}（权限 600）`)
          ),

          // 刷新
          h(
            Card,
            { title: '面板刷新' },
            h(
              'div',
              { className: 'lgw-row' },
              ...REFRESH_CHOICES.map((choice) =>
                h(
                  'button',
                  {
                    key: choice.value,
                    className: `lgw-btn ${interval === choice.value ? 'on' : ''}`,
                    onClick: () => saveRefresh(choice.value)
                  },
                  choice.label
                )
              )
            ),
            h('div', { className: 'lgw-note' }, '只影响这个面板的轮询频率，不影响网关本身。')
          )
        ),

        notice === null ? null : h('div', { className: `lgw-msg ${notice.ok ? 'ok' : 'bad'}` }, notice.text),

        // ── 最近访问 ──
        h(
          Card,
          { title: '最近访问' },
          (state?.recent?.length ?? 0) === 0
            ? h('div', { className: 'lgw-empty' }, '还没有外部请求。让另一台设备打开上面的地址，这里会立刻出现它的每一次请求与状态码。')
            : h(
                'div',
                { className: 'lgw-log' },
                (state.recent ?? []).slice(0, 10).map((row, index) =>
                  h(
                    'div',
                    { key: `${row.at}-${index}`, className: 'lgw-logrow' },
                    h('span', null, String(row.at ?? '').slice(11, 19)),
                    h('span', null, String(row.ip ?? '?').padEnd(14)),
                    h('span', { className: Number(row.status) >= 400 ? 'lgw-s4' : 'lgw-s2' }, String(row.status ?? '')),
                    h('span', { className: 'lgw-path' }, String(row.path ?? '').slice(0, 72))
                  )
                )
              )
        )
      )
    }

    function apply(ctx) {
      // label 必须是函数：设置页是按「调用 label()」渲染导航项的。
      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'lan-gateway',
              order: 36,
              label: () => '局域网网关'
            },
            Panel
          )
        } catch (error) {
          console.error('[lan-gateway] 设置面板注册失败', error)
          return () => {}
        }
      })
    }

    return { name: 'lan-gateway', inject: ['slots'], apply }
  }
})
