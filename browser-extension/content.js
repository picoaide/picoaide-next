// PicoAide 浏览器桥 - content script(仅兜底唤醒)
// CDP 模式(0.2.0)下操作改由 chrome.debugger 执行,这里只负责页面加载时唤醒后台,
// 抵消 MV3 service worker 空闲被杀导致的连接断开。

chrome.runtime.sendMessage({ type: 'bridge-wake' }).catch(() => {})
