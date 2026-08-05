// semanticSnapshot 的 Node 级功能测试(零依赖,最小 DOM mock):
// 从 background.js 提取语义快照纯函数(与 toString 注入页面的是同一份代码),
// 断言语义标注/输入框 placeholder/链接/表格/截断/异常捕获。
// 运行:node browser-extension/snapshot.test.js
const fs = require('fs')
const vm = require('vm')
const assert = require('assert')

const src = fs.readFileSync(__dirname + '/background.js', 'utf8')
const ctx = {
  chrome: {
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: { onAlarm: { addListener: () => {} }, create: () => {} },
    runtime: { onStartup: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    debugger: { onEvent: { addListener: () => {} }, detach: () => {}, attach: () => {}, sendCommand: () => {} },
  },
  WebSocket: function () {},
  setTimeout,
  clearTimeout,
  console,
}
vm.createContext(ctx)
vm.runInContext(src + '\nthis.__getSnapshot = () => semanticSnapshot', ctx)
const semanticSnapshot = ctx.__getSnapshot()

function el(tag, props = {}, childNodes = []) {
  const e = { nodeType: 1, tagName: tag.toUpperCase(), childNodes }
  e.children = childNodes.filter((c) => c.nodeType === 1)
  e.getAttribute = (name) => (props[name] !== undefined ? props[name] : null)
  e.querySelector = (sel) =>
    sel === 'img' ? e.children.find((c) => c.tagName === 'IMG') || null : null
  if (!(e.tagName in { INPUT: 1, TEXTAREA: 1, SELECT: 1 })) {
    const text = childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : '')).join('')
    if (!('innerText' in props)) e.innerText = props.textContent !== undefined ? props.textContent : text
  }
  for (const [k, v] of Object.entries(props)) e[k] = v
  return e
}
const txt = (s) => ({ nodeType: 3, nodeValue: s })

// 1. 语义元素标注 + 输入框可操作性信息
const doc = {
  body: el('body', {}, [
    el('h1', {}, [txt('商品列表')]),
    el('button', {}, [txt('搜索')]),
    el('input', { type: 'search', placeholder: '搜索商品', value: '' }),
    el('input', { type: 'text', placeholder: '用户名', value: 'alice' }),
    el('a', { href: 'https://example.com/page?x=1' }, [txt('下一页')]),
    el('img', { alt: '商品图' }),
    el('li', {}, [txt('京东自营 手机')]),
    el('table', {}, [
      el('tr', {}, [el('td', {}, [txt('单价')]), el('td', {}, [txt('100')])]),
    ]),
    el('p', {}, [txt('这是一个超过十五个字符的正文段落文本用于测试快照')]),
  ]),
}
ctx.document = doc
const out = semanticSnapshot()
for (const expected of [
  '[H1] 商品列表',
  '[BUTTON] 搜索',
  '[INPUT:search] placeholder="搜索商品"',
  '[INPUT:text] placeholder="用户名" value="alice"',
  '[LINK] 下一页 https://example.com/page?x=1',
  '[IMG] 商品图',
  '[LI] 京东自营 手机',
  '[TABLE]',
  '[ROW] 单价 | 100',
  '[TEXT] 这是一个超过十五个字符的正文段落文本用于测试快照',
]) {
  assert.ok(out.includes(expected), '缺少行: ' + expected + '\n---\n' + out)
}

// 2. 去重:相同行只输出一次
const doc2 = { body: el('body', {}, [el('button', {}, [txt('x')]), el('button', {}, [txt('x')])]) }
ctx.document = doc2
const out2 = semanticSnapshot()
assert.strictEqual((out2.match(/\[BUTTON\] x/g) || []).length, 1)

// 3. 截断:超过 300 个语义节点 → 尾部注明省略数
const many = []
for (let i = 0; i < 400; i++) many.push(el('a', { href: 'http://a/' + i }, [txt('x')]))
ctx.document = { body: el('body', {}, many) }
const out3 = semanticSnapshot()
assert.ok(out3.includes('[snapshot truncated:'), '缺少截断标记')
assert.ok(out3.length <= 6200, '超出预算: ' + out3.length)
assert.ok(!out3.includes('http://a/399'), '截断后不应含尾部内容')

// 4. 页面异常 → 返回部分结果 + 错误标记
const bad = el('h1', {}, [txt('ok')])
Object.defineProperty(bad, 'innerText', { get() { throw new Error('boom') } })
ctx.document = { body: el('body', {}, [el('p', {}, [txt('这是一个超过十五个字符的正文段落文本测试部分结果')]), bad]) }
const out4 = semanticSnapshot()
assert.ok(out4.includes('[TEXT]'), '异常前已收集的行应保留')
assert.ok(out4.includes('[snapshot error] boom'), '缺少错误标记:\n' + out4)

console.log('semanticSnapshot tests: OK')
