// PicoAide 浏览器桥 - 后台 service worker(CDP 模式)
// 连接:固定直连本机客户端的 CDP WebSocket 服务(ws://127.0.0.1:54321),零配置。
// 保活:chrome.alarms 每 30s 唤醒(抵消 MV3 service worker 空闲被杀),断线指数退避自动重连;
//       content.js 页面加载时发 bridge-wake 兜底。
// 执行:通过 chrome.debugger(CDP)attach 活动标签页,用 Runtime.evaluate/Page.navigate 执行操作,
//       不依赖 content script(可操作浏览器内部页面,且连接由浏览器原生管理)。

const CDP_URL = 'ws://127.0.0.1:54321'
const MAX_RETRY_DELAY = 30000
const KEEPALIVE_MINUTES = 0.5

let ws = null
let retryDelay = 1000
let retryTimer = null
let attachedTabId = null
// 本次操作序列固定的目标标签页:首个操作记录并复用(Agent 多步操作中用户切标签不串台)。
// 手动切标签后的行为保持现状:targetTabId 为空时按当前活动标签;目标标签被关闭后
// 后续操作报错(Agent 可见),由用户重新发起恢复 —— 设计权衡,注释说明
let targetTabId = null

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'on' : 'off' })
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#16a34a' : '#6b7280' })
}

function connect() {
  ws = new WebSocket(CDP_URL)
  ws.onopen = () => {
    retryDelay = 1000
    setBadge(true)
  }
  ws.onmessage = (ev) => handleMessage(ev.data)
  ws.onerror = () => {}
  ws.onclose = () => {
    setBadge(false)
    scheduleRetry()
  }
}

// MV3 service worker 空闲约 30s 被杀,WebSocket 随之断开且定时器全部消失;
// chrome.alarms 是唯一可靠的周期唤醒手段,onAlarm 里检查连接并重连。
function scheduleRetry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    setBadge(false)
    connect()
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
  }, retryDelay)
}

function ensureConnected() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    clearTimeout(retryTimer)
    retryDelay = 1000
    connect()
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'picoaide-keepalive') ensureConnected()
})
chrome.runtime.onStartup.addListener(() => ensureConnected())
chrome.alarms.create('picoaide-keepalive', { periodInMinutes: KEEPALIVE_MINUTES })

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

async function handleMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (!msg || typeof msg.id === 'undefined' || typeof msg.method !== 'string') return
  // 简单 promise 队列串行化 dispatch:并发请求(如 dialog 与后续操作、双 attach)会互踩
  // 竞态(attach detach/重、pendingDialogAction 覆盖);单标签页场景串行足够
  const run = dispatchQueue.then(() => dispatch(msg.method, msg.params || {}))
  dispatchQueue = run.then(() => undefined, () => undefined)
  try {
    const result = await run
    send({ id: msg.id, result: result === undefined ? null : result })
  } catch (err) {
    send({ id: msg.id, error: { code: -32000, message: err.message || String(err) } })
  }
}

// ---- CDP(chrome.debugger)模式 ----
let dispatchQueue = Promise.resolve()

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined) throw new Error('未找到活动标签页')
  return tab
}

// 首个操作固定目标标签页并复用(B-4);navigate 在目标标签内导航,目标不变
async function ensureTargetTab() {
  if (targetTabId !== null) return targetTabId
  const tab = await activeTab()
  if (tab.id === undefined) throw new Error('未找到活动标签页')
  targetTabId = tab.id
  return targetTabId
}

async function attach(tabId) {
  if (attachedTabId === tabId) return
  try {
    await chrome.debugger.detach({ tabId: attachedTabId })
  } catch {
    // 之前没 attach 或已 detach,忽略
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(String(chrome.runtime.lastError.message)))
      else resolve()
    })
  })
  attachedTabId = tabId
}

// 发送 CDP 命令:attach 失败(如 chrome:// 等内部页面)时给出明确错误;
// 统一 10s 超时(插件侧不无限挂起)。dialog 事件处理走 chrome.debugger.sendCommand
// 直发,不经过此包装(弹窗阻塞页面时需立即处理,排队会与挂起命令互锁)
async function cdp(command, params) {
  const tabId = await ensureTargetTab()
  await attach(tabId)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 命令超时: ' + command)), 10000)
    chrome.debugger.sendCommand({ tabId }, command, params || {}, (result) => {
      clearTimeout(timer)
      if (chrome.runtime.lastError) reject(new Error(String(chrome.runtime.lastError.message)))
      else resolve(result)
    })
  })
}

// 在页面上下文中执行 JS 并取回可序列化结果(CDP 的 Runtime.evaluate)
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception && r.exceptionDetails.exception.description
      ? r.exceptionDetails.exception.description
      : r.exceptionDetails.text || '页面执行失败'
    throw new Error(String(detail).slice(0, 500))
  }
  return r.result && r.result.value
}

// 语义快照(纯函数,经 toString 序列化注入页面上下文执行,无外部依赖):
// 输出 accessibility 式语义树文本,信息密度高、token 少,供 LLM 读取当前页结构。
// 只走 body;限深 6、上限 300 个语义节点;≤6000 字符,超出尾部截断并注明;
// 交互元素(按钮/输入框/链接)标注 placeholder/aria-label/value,可配合 browser_fill 语义定位。
function semanticSnapshot() {
  const BUDGET = 6000
  const LIMIT = 300
  const DEPTH = 6
  const SCAN_CAP = 5000
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, IFRAME: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1, BR: 1, HR: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, EMBED: 1, OBJECT: 1, SOURCE: 1, TRACK: 1 }
  const LEAF = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, IMG: 1, LI: 1, TR: 1 }
  const lines = []
  const seen = {}
  let chars = 0
  let emitted = 0
  let omitted = 0
  let scanned = 0
  const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  // textContent 而非 innerText:innerText 会触发 O(子树) 布局计算(快照级联放大),textContent 纯读
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const esc = (s) => s.replace(/"/g, '&quot;')
  const emit = (s) => {
    if (seen[s]) return
    seen[s] = true
    if (chars >= BUDGET) { omitted++; return }
    chars += s.length + 1
    lines.push(s)
  }
  const walk = (node, depth) => {
    if (!node || node.nodeType !== 1 || depth > DEPTH) return
    if (++scanned > SCAN_CAP) return
    const tag = node.tagName
    if (SKIP[tag]) return
    let line = null
    const h = tag.match(/^H([1-6])$/)
    if (h) {
      const t = text(node)
      if (t) line = '[H' + h[1] + '] ' + cap(t, 120)
    } else if (tag === 'A') {
      let t = text(node)
      if (!t) {
        // 限制作用域:只找带 alt 的图(链接内图通常至多一个),避免整棵子树扫描
        const img = node.querySelector('img[alt]')
        t = (img && img.getAttribute('alt')) || ''
      }
      let href = node.getAttribute('href') || ''
      if (href.indexOf('javascript:') === 0) href = ''
      if (t || href) line = '[LINK] ' + (t ? cap(t, 100) + ' ' : '') + cap(href, 80)
    } else if (tag === 'BUTTON') {
      const t = text(node) || node.getAttribute('aria-label') || node.value || ''
      if (t) line = '[BUTTON] ' + cap(t, 100)
    } else if (tag === 'INPUT') {
      const type = node.type || 'text'
      const attrs = []
      if (node.placeholder) attrs.push('placeholder="' + esc(cap(node.placeholder, 50)) + '"')
      const al = node.getAttribute('aria-label')
      if (al) attrs.push('aria-label="' + esc(cap(al, 50)) + '"')
      const v = node.value
      if (v !== undefined && v !== null && v !== '' && /^(text|search|email|password|number|tel|url|date|time)$/.test(type))
        attrs.push('value="' + esc(cap(String(v), 40)) + '"')
      line = '[INPUT:' + type + ']' + (attrs.length ? ' ' + attrs.join(' ') : '')
    } else if (tag === 'TEXTAREA') {
      const al = node.placeholder || node.getAttribute('aria-label') || ''
      line = '[TEXTAREA]' + (al ? ' placeholder="' + esc(cap(al, 50)) + '"' : '')
    } else if (tag === 'SELECT') {
      const al = node.getAttribute('aria-label') || ''
      const so = node.selectedOptions
      let sel = ''
      if (so && so.length) sel = cap((so[0].textContent || '').trim(), 30)
      line = '[SELECT]' + (al ? ' aria-label="' + esc(cap(al, 50)) + '"' : '') + (sel ? ' selected="' + esc(sel) + '"' : '')
    } else if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || ''
      if (alt) line = '[IMG] ' + cap(alt, 120)
    } else if (tag === 'LI') {
      const t = text(node)
      if (t) line = '[LI] ' + cap(t, 120)
    } else if (tag === 'TR') {
      const cells = []
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i]
        if (c.tagName === 'TD' || c.tagName === 'TH') cells.push(cap(text(c), 40))
      }
      if (cells.length) line = '[ROW] ' + cells.join(' | ')
    } else if (tag === 'TABLE') {
      line = '[TABLE]'
    } else {
      let t = ''
      for (let i = 0; i < node.childNodes.length; i++) {
        if (node.childNodes[i].nodeType === 3) t += node.childNodes[i].nodeValue
      }
      t = t.replace(/\s+/g, ' ').trim()
      if (t.length > 15) line = '[TEXT] ' + cap(t, 200)
    }
    if (line) {
      if (emitted >= LIMIT) { omitted++; return }
      emitted++
      emit(line)
    }
    if (LEAF[tag] || h) return
    const kids = node.childNodes
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1)
  }
  try {
    walk(document.body, 0)
  } catch (e) {
    lines.push('[snapshot error] ' + cap(String((e && e.message) || e), 80))
  }
  if (omitted > 0) lines.push('[snapshot truncated: ' + omitted + ' nodes omitted]')
  return lines.join('\n')
}

const q = (selector) => JSON.stringify(selector)

// 语义定位(纯函数,经 toString 序列化注入页面上下文执行):
// 按 label[for=id] 文本/placeholder/aria-label 匹配表单元素,均失败回退 CSS selector。
// 返回 (root) => element|null;与 cdp_server 的 browser.* 转发协议无关,便于将来单测。
function locate({ label, placeholder, ariaLabel, selector }) {
  const norm = (s) => (s || '').trim().toLowerCase()
  return (root) => {
    if (label || placeholder || ariaLabel) {
      for (const el of root.querySelectorAll('input, textarea, select')) {
        if (label && el.id) {
          const labelEl = root.querySelector('label[for="' + el.id + '"]')
          if (labelEl && norm(labelEl.textContent) === norm(label)) return el
        }
        if (placeholder && norm(el.getAttribute('placeholder')) === norm(placeholder)) return el
        if (ariaLabel && norm(el.getAttribute('aria-label')) === norm(ariaLabel)) return el
      }
    }
    return selector ? root.querySelector(selector) : null
  }
}

// 单字段 selector 同时按 label/placeholder/aria-label 尝试(语义优先),失败回退 CSS 选择器
const findExpr = (selector) =>
  `(${locate.toString()})(${JSON.stringify({ label: selector, placeholder: selector, ariaLabel: selector, selector })})`

// JS 弹窗(alert/confirm/prompt)统一拦截:弹窗会阻塞页面 JS,Agent 无法自行点掉;
// browser.dialog 先武装 pendingDialogAction,弹窗一开即按 action 处理(未武装默认 dismiss 防阻塞页面)。
let pendingDialogAction = null
let pendingDialogResolve = null
let dialogTimer = null

chrome.debugger.onEvent.addListener((source, method) => {
  if (method !== 'Page.javascriptDialogOpening') return
  const action = pendingDialogAction || 'dismiss'
  if (pendingDialogResolve) {
    clearTimeout(dialogTimer)
    const resolve = pendingDialogResolve
    pendingDialogResolve = null
    pendingDialogAction = null
    resolve(action === 'accept' ? 'accepted' : 'dismissed')
  }
  chrome.debugger.sendCommand(
    { tabId: source.tabId },
    'Page.handleJavaScriptDialog',
    { accept: action === 'accept' },
    () => {},
  )
})

async function dispatch(method, params) {
  switch (method) {
    case 'browser.tabInfo': {
      // 固定目标标签页的最新 URL/标题(navigate 后保持原目标,不跟手动切换)
      const tabId = await ensureTargetTab()
      const tab = await chrome.tabs.get(tabId)
      return { url: tab.url, title: tab.title }
    }
    case 'browser.getContent':
      // 默认返回语义快照(结构化、省 token);mode:'text' 兼容旧行为返回原始文本
      // (textContent 而非 innerText:避免大页面快照触发布局计算)
      return evaluate(
        params.mode === 'text'
          ? "document.body ? document.body.textContent.slice(0, 200000) : ''"
          : `(() => { try { return (${semanticSnapshot.toString()})() } catch (e) { return '[snapshot error] ' + String((e && e.message) || e).slice(0, 100) } })()`,
      )
    case 'browser.click':
      return evaluate(
        `(() => { const el = document.querySelector(${q(params.selector)}); if (!el) throw new Error('元素未找到: ${q(params.selector)}'); el.click(); return true })()`,
      )
    case 'browser.type':
      return evaluate(
        `(() => {
          const el = document.querySelector(${q(params.selector)});
          if (!el) throw new Error('元素未找到: ${q(params.selector)}');
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(params.text)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
      )
    case 'browser.navigate': {
      await cdp('Page.navigate', { url: params.url })
      return true
    }
    case 'browser.scroll':
      return evaluate(
        `(() => { window.scrollBy({ top: ${params.direction === 'down' ? 500 : -500}, behavior: 'smooth' }); return true })()`,
      )
    case 'browser.executeScript':
      return evaluate(
        `(() => { const fn = new Function(${q(String(params.code))}); const r = fn(); if (r === undefined) return null; try { return JSON.parse(JSON.stringify(r)); } catch { return String(r); } })()`,
      )
    case 'browser.fill':
      return evaluate(
        `(() => {
          const el = ${findExpr(params.selector)}(document);
          if (!el) throw new Error('元素未找到: ${q(params.selector)}');
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(params.value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
      )
    case 'browser.select':
      return evaluate(
        `(() => {
          const el = ${findExpr(params.selector)}(document);
          if (!el) throw new Error('元素未找到: ${q(params.selector)}');
          const target = ${q(params.value)};
          let index = -1;
          for (const opt of el.options) {
            if (opt.value === target || (opt.textContent || '').trim() === target) { index = opt.index; break; }
          }
          if (index === -1) throw new Error('选项未找到: ' + target);
          el.selectedIndex = index;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
      )
    case 'browser.waitFor': {
      const timeoutMs = Math.min(params.timeoutMs || 10000, 60000)
      return evaluate(
        `new Promise((resolve, reject) => {
          const find = ${findExpr(params.selector)};
          const deadline = Date.now() + ${timeoutMs};
          const tick = () => {
            if (find(document)) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('等待超时: ${q(params.selector)}'));
            setTimeout(tick, 200);
          };
          tick();
        })`,
      )
    }
    case 'browser.dialog':
      // 先确保活动标签已 attach 且 Page 域已启用(弹窗事件才能送达)
      await cdp('Page.enable')
      return new Promise((resolve) => {
        pendingDialogAction = params.action === 'accept' ? 'accept' : 'dismiss'
        pendingDialogResolve = resolve
        dialogTimer = setTimeout(() => {
          pendingDialogAction = null
          pendingDialogResolve = null
          resolve('no dialog')
        }, 10000)
      })
    default:
      throw new Error('未知方法: ' + method)
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'bridge-wake') {
    ensureConnected()
    sendResponse({ ok: true })
  }
  return false
})

connect()
