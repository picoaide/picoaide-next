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
  try {
    const result = await dispatch(msg.method, msg.params || {})
    send({ id: msg.id, result: result === undefined ? null : result })
  } catch (err) {
    send({ id: msg.id, error: { code: -32000, message: err.message || String(err) } })
  }
}

// ---- CDP(chrome.debugger)模式 ----

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined) throw new Error('未找到活动标签页')
  return tab
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

async function detachIfAttached() {
  if (attachedTabId === null) return
  try {
    await chrome.debugger.detach({ tabId: attachedTabId })
  } catch {
    // 忽略
  }
  attachedTabId = null
}

// 发送 CDP 命令:attach 失败(如 chrome:// 等内部页面)时给出明确错误
async function cdp(command, params) {
  const tab = await activeTab()
  if (tab.id === undefined) throw new Error('未找到活动标签页')
  await attach(tab.id)
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: tab.id }, command, params || {}, (result) => {
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

const q = (selector) => JSON.stringify(selector)

async function dispatch(method, params) {
  switch (method) {
    case 'browser.tabInfo': {
      const tab = await activeTab()
      return { url: tab.url, title: tab.title }
    }
    case 'browser.getContent':
      return evaluate("document.body ? document.body.innerText.slice(0, 200000) : ''")
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
