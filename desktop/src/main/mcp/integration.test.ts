import { describe, expect, it } from 'vitest'
import { isHighRiskTool, pluginToolName } from './integration'

describe('isHighRiskTool (启发式动词表, best-effort 减噪,非安全边界)', () => {
  const cases: [string, string | undefined, boolean][] = [
    ['delete_record', undefined, true],
    ['remove_item', undefined, true],
    ['write_file', undefined, true],
    ['exec_command', undefined, true],
    ['shell_run', undefined, true],
    ['http_request', undefined, true],
    ['post_message', undefined, true],
    ['purge_cache', undefined, true],
    ['sync_now', undefined, true],
    ['truncate_log', undefined, true],
    ['unlink_old', undefined, true],
    ['rm', undefined, true],
    ['send_email', undefined, true],
    ['upload_photo', undefined, true],
    ['post_status', undefined, true],
    ['run', 'Executes a shell command', true],
    ['read_record', undefined, false],
    ['list_records', undefined, false],
    ['get_page', 'Fetch a webpage and return text', false],
    ['mock_echo', '回显输入', false],
  ]
  for (const [name, description, expected] of cases) {
    it(`${name}${description ? ` (${description})` : ''} → ${expected ? '高危' : '非高危'}`, () => {
      expect(isHighRiskTool(name, description)).toBe(expected)
    })
  }
})

describe('pluginToolName', () => {
  it('前缀插件名并清理非法字符', () => {
    expect(pluginToolName('my-plugin', 'read.file')).toBe('my-plugin_read_file')
  })
})
