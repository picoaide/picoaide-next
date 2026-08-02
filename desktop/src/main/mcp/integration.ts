// MCP plugin → engine integration helpers (used by index.ts tool registry).
import { createMcpRunner, type McpRunner, type RunnerConfig } from './runner'
import { toAiSdkTool, isHighRiskTool, type McpToolLike } from './adapter'
import { installedMcpList, defaultMcpDir, type McpInstalledRecord } from './installer'

export { createMcpRunner, toAiSdkTool, isHighRiskTool }
export type { McpRunner, McpInstalledRecord }

export { installedMcpList, defaultMcpDir }

// connectRunner initializes a runner and lists its tools.
export async function connectRunner(runner: McpRunner): Promise<{
  runner: McpRunner
  tools: McpToolLike[]
  callTool: (name: string, args: unknown) => ReturnType<McpRunner['callTool']>
}> {
  const tools = await runner.listTools()
  return {
    runner,
    tools,
    callTool: (name, args) => runner.callTool(name, args),
  }
}

// pluginToolName sanitizes a plugin tool name into a safe AI-SDK tool id.
export function pluginToolName(plugin: string, tool: string): string {
  return `${plugin}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export type { RunnerConfig }
