// 测试用 mock MCP stdio server:newline-delimited JSON-RPC over stdin/stdout。
// 支持 initialize/tools/list/tools/call/ping;tools/call 收到 mock_crash 时进程退出
// (用于 runner 的崩溃自动重启测试)。
'use strict'

const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (typeof id !== 'number' && typeof id !== 'string') return

  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
        },
      })
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} })
    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'mock_echo',
              description: '回显输入',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        },
      })
    case 'tools/call': {
      const tool = params?.name
      const args = params?.arguments ?? {}
      if (tool === 'mock_crash') {
        setTimeout(() => process.exit(1), 20)
        return
      }
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `echo:${args.text ?? ''}` }],
        },
      })
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})
