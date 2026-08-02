// Mock CDP bridge server for smoke_plugin.spec.ts.
//
// Plays the role of the desktop client: the extension connects to
// ws://127.0.0.1:54321 (fixed port), we issue JSON-RPC browser.* requests,
// the extension executes them in the real active tab and replies. We record
// every received method + connection so the spec can assert auto-connect and
// the full bridge protocol round-trip — no desktop app needed.
//
// ws is a dependency of desktop/, so resolve it explicitly.
// Usage: node scripts/e2e/mock-cdp-server.js [port]  (standalone debug mode)

const path = require('path')
const { WebSocketServer } = require(path.resolve(__dirname, '../../desktop/node_modules/ws'))

function startMockCdpServer(port) {
  const state = { connections: 0, methods: [], ws: null, nextId: 1, pending: new Map() }
  const wss = new WebSocketServer({ host: '127.0.0.1', port })

  wss.on('connection', (ws) => {
    state.connections++
    state.ws = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      // a reply has an id and no method; a request has both
      if (msg && msg.id != null && typeof msg.method !== 'string') {
        const p = state.pending.get(msg.id)
        if (p) {
          state.pending.delete(msg.id)
          clearTimeout(p.timer)
          p.resolve(msg)
        }
      }
    })
    ws.on('close', () => {
      if (state.ws === ws) state.ws = null
    })
    ws.on('error', () => {})
  })
  wss.on('error', (err) => {
    // surface EADDRINUSE to the caller via a rejected request instead of crashing
    state.error = err
  })

  function request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (state.error) return reject(state.error)
      const id = state.nextId++
      const timer = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error('timeout: no reply for ' + method + ' (id ' + id + ')'))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timer })

      const send = () => {
        if (!state.ws || state.ws.readyState !== 1) {
          state.pending.delete(id)
          clearTimeout(timer)
          reject(new Error('extension not connected'))
          return
        }
        state.methods.push(method)
        state.ws.send(JSON.stringify({ id, method, params: params || {} }))
      }
      // tolerate a service-worker restart: wait a moment for a fresh
      // connection before giving up (extension reconnects automatically)
      const trySend = (attemptsLeft) => {
        if (state.ws && state.ws.readyState === 1) return send()
        if (attemptsLeft <= 0) {
          state.pending.delete(id)
          clearTimeout(timer)
          return reject(new Error('extension not connected'))
        }
        setTimeout(() => trySend(attemptsLeft - 1), 500)
      }
      trySend(10)
    })
  }

  function close() {
    for (const p of state.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('mock cdp server closed'))
    }
    state.pending.clear()
    return new Promise((resolve) => wss.close(resolve))
  }

  return { state, request, close }
}

module.exports = { startMockCdpServer }

if (require.main === module) {
  const server = startMockCdpServer(Number(process.argv[2] || 54321))
  console.log('mock-cdp-server listening on 127.0.0.1:' + (process.argv[2] || 54321))
  setInterval(() => {
    console.log(`connections=%d methods=%j`, server.state.connections, server.state.methods)
  }, 2000)
}
