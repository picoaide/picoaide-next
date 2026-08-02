// PicoAide 浏览器桥 - 后台 service worker
// 零配置:固定直连本机客户端的 CDP WebSocket 服务(ws://127.0.0.1:54321),无 options 页。
// 断线指数退避重连(1s→2s→4s…上限 30s);SV 空闲被杀后由 content.js 的 wake 消息拉起。

const CDP_URL = 'ws://127.0.0.1:54321'
const MAX_RETRY_DELAY = 30000

let ws = null
let retryDelay = 1000
let retryTimer = null

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
    clearTimeout(retryTimer)
    retryTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
  }
}

function ensureConnected() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    clearTimeout(retryTimer)
    retryDelay = 1000
    connect()
  }
}

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

async function dispatch(method, params) {
  switch (method) {
    case 'browser.tabInfo': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab) throw new Error('未找到活动标签页')
      return { url: tab.url, title: tab.title }
    }
    case 'browser.getContent':
      return tabMessage({ action: 'getContent' })
    case 'browser.click':
      return tabMessage({ action: 'click', selector: params.selector })
    case 'browser.type':
      return tabMessage({ action: 'type', selector: params.selector, text: params.text })
    case 'browser.navigate':
      return tabMessage({ action: 'navigate', url: params.url })
    case 'browser.scroll':
      return tabMessage({ action: 'scroll', direction: params.direction })
    case 'browser.executeScript':
      return tabMessage({ action: 'executeScript', code: params.code })
    default:
      throw new Error('未知方法: ' + method)
  }
}

async function tabMessage(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined) throw new Error('未找到活动标签页')
  let resp
  try {
    resp = await chrome.tabs.sendMessage(tab.id, payload)
  } catch {
    throw new Error('页面未响应,请刷新页面后重试(浏览器内部页面不可操作)')
  }
  if (!resp || resp.ok === false) throw new Error(resp && resp.error ? resp.error : '页面执行失败')
  return resp.result
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'bridge-wake') {
    ensureConnected()
    sendResponse({ ok: true })
  }
  return false
})

connect()
