// PicoAide 浏览器桥 - content script(每个页面注入,执行实际 DOM 操作)
// 页面加载时向后台发 wake 消息,确保 SV 存活并维持 CDP 连接(零配置)。

chrome.runtime.sendMessage({ type: 'bridge-wake' }).catch(() => {})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === 'navigate') {
    // 先回执再导航:导航会销毁本脚本上下文,回执必须在跳转前发出
    sendResponse({ ok: true, result: true })
    setTimeout(() => {
      location.href = msg.url
    }, 0)
    return false
  }
  try {
    sendResponse({ ok: true, result: handle(msg) })
  } catch (err) {
    sendResponse({ ok: false, error: err.message || String(err) })
  }
  return false
})

function handle(msg) {
  switch (msg.action) {
    case 'getContent':
      // innerText 只含渲染文本,script/style 天然不在其中;截断防止超大消息
      return document.body ? document.body.innerText.slice(0, 200000) : ''
    case 'click': {
      const el = document.querySelector(msg.selector)
      if (!el) throw new Error('元素未找到: ' + msg.selector)
      el.click()
      return true
    }
    case 'type': {
      const el = document.querySelector(msg.selector)
      if (!el) throw new Error('元素未找到: ' + msg.selector)
      el.focus()
      // 用原生 setter 触发 input 事件,React/Vue 等框架才能感知
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, msg.text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    case 'scroll':
      window.scrollBy({ top: msg.direction === 'down' ? 500 : -500, behavior: 'smooth' })
      return true
    case 'executeScript':
      return runCode(msg.code)
    default:
      throw new Error('未知动作: ' + (msg && msg.action))
  }
}

// ponytail: new Function 在 content script 隔离世界里执行,能操作 DOM 但看不到页面自身
// JS 的全局变量;需要完全页面上下文时再改为注入 <script> 标签,当前用法已覆盖绝大多数场景。
function runCode(code) {
  const result = new Function(code)()
  if (result === undefined) return null
  try {
    return JSON.parse(JSON.stringify(result)) // 结构化克隆前的序列化校验(函数/DOM 节点不可回传)
  } catch {
    return String(result)
  }
}
