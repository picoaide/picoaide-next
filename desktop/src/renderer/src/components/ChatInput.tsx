import { useEffect, useRef, useState } from 'react'
import { Clock, FileText, Send, Square, Sparkles } from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { cn } from '../lib/utils'
import { useChatStore, type Mode } from '../stores/chat'

import { parseCommandLine, parseMentionLine, type ChatboxLine } from '../lib/chatbox'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'plan', label: '计划', hint: '只读调研后输出计划,你确认后再执行' },
  { id: 'craft', label: '执行', hint: '完整智能体:自主调用文件/终端/浏览器等工具完成任务' },
]

const MAX_ROWS = 8
const LINE_HEIGHT = 24

export default function ChatInput() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const streaming = useChatStore((s) => s.streaming)
  const mode = useChatStore((s) => s.mode)
  const setMode = useChatStore((s) => s.setMode)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const cancel = useChatStore((s) => s.cancel)
  const approvePlan = useChatStore((s) => s.approvePlan)
  const loadConversations = useChatStore((s) => s.loadConversations)
  const activeId = useChatStore((s) => s.activeId)
  const activeProjectId = useChatStore((s) => s.activeProjectId)
  const conversations = useChatStore((s) => s.conversations)
  const pendingQuote = useChatStore((s) => s.pendingQuote)
  const consumeQuote = useChatStore((s) => s.consumeQuote)
  const [files, setFiles] = useState<string[]>([])
  const [installedSkills, setInstalledSkills] = useState<string[]>([])
  const activeStatus = activeId === null ? null : (conversations.find((c) => c.id === activeId)?.status ?? null)
  const planning = activeStatus === 'planning' && !streaming

  // @ 文件候选:项目目录 + 可访问目录文件(主进程组装,懒加载)
  useEffect(() => {
    void window.picoaide
      .workspaceListFiles()
      .then(setFiles)
      .catch(() => setFiles([]))
  }, [activeProjectId])

  // 已装技能(用于 @ 技能提及)
  useEffect(() => {
    void window.picoaide
      .pluginSkillsList()
      .then((r) => setInstalledSkills(Object.keys(r.installed)))
      .catch(() => setInstalledSkills([]))
  }, [])

  // 引用消息(chatbox 语义):以 blockquote 前缀插入输入框
  useEffect(() => {
    if (pendingQuote) {
      setValue((v) => {
        const quote = pendingQuote.split('\n').map((l) => `> ${l}`).join('\n')
        return v.length === 0 ? quote + '\n\n' : v + '\n\n' + quote + '\n\n'
      })
      consumeQuote()
      textareaRef.current?.focus()
    }
  }, [pendingQuote, consumeQuote])

  // 空状态示例提示词:点击后填入输入框
  const pendingPrompt = useChatStore((s) => s.pendingPrompt)
  const consumePrompt = useChatStore((s) => s.consumePrompt)
  useEffect(() => {
    if (pendingPrompt) {
      setValue((v) => (v.length === 0 ? pendingPrompt : v))
      consumePrompt()
      textareaRef.current?.focus()
    }
  }, [pendingPrompt, consumePrompt])

  // / 命令候选 = 本地已装技能(服务端 bootstrap.skills 只是商店建议清单,未安装的不可用)
  const commandItems = installedSkills
  const line: ChatboxLine =
    value.trim() === '' ? null : (parseCommandLine(value, commandItems) ?? parseMentionLine(value, files, installedSkills))
  // /xxx 无匹配(parse 返回 null)时也要弹出菜单给出反馈,否则用户以为没有命令菜单
  const slashNoMatch = !line && /^\/\S*$/.test(value.trim())

  const applySuggestion = (l: ChatboxLine, text: string) => {
    if (!l) return
    if (l.kind === 'command') {
      setValue(`使用技能 ${text}:`)
    } else {
      // 替换行尾 @查询
      const base = value.replace(/@[^\s]*$/, '')
      setValue(`${base}@${text} `)
    }
    textareaRef.current?.focus()
  }

  const send = () => {
    const text = value.trim()
    if (!text) return
    setHistory((h) => [...h, text].slice(-20))
    setHistoryIdx(-1)
    setValue('')
    void sendMessage(text)
  }

  const onApprove = async (ok: boolean) => {
    if (activeId === null || busy) return
    setBusy(true)
    await approvePlan(activeId, ok)
    await loadConversations()
    setBusy(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter 发送(chatbox 快捷键)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      // Enter 直接选择首个 / 命令(Codex 式快捷确认)
      if (line && line.kind === 'command' && line.items.length > 0) {
        applySuggestion(line, line.items[0])
        return
      }
      send()
      return
    }
    // ↑ 空输入时找回历史
    if (e.key === 'ArrowUp' && !e.shiftKey && value === '' && history.length > 0) {
      e.preventDefault()
      const idx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(idx)
      setValue(history[idx])
      return
    }
    // ↓ 遍历到末尾后回到空输入
    if (e.key === 'ArrowDown' && historyIdx !== -1) {
      e.preventDefault()
      if (historyIdx === history.length - 1) {
        setHistoryIdx(-1)
        setValue('')
      } else {
        setHistoryIdx(historyIdx + 1)
        setValue(history[historyIdx + 1])
      }
    }
  }

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_ROWS * LINE_HEIGHT) + 'px'
  }

  const suggestions = line
    ? line.kind === 'command'
      ? line.items.map((i) => ({ id: `cmd-${i}`, text: i, icon: <Sparkles className="h-3.5 w-3.5" /> }))
      : [
          ...line.files.map((f) => ({ id: `f-${f}`, text: f, icon: <FileText className="h-3.5 w-3.5" /> })),
          ...line.skills.map((s) => ({ id: `s-${s}`, text: s, icon: <Sparkles className="h-3.5 w-3.5" /> })),
        ]
    : []
  const showMenu = !!line || slashNoMatch
  const emptyHint = slashNoMatch || (line && line.kind === 'command' && line.items.length === 0)
    ? '无可用技能,请到 设置 → 技能 从服务端商城安装'
    : line && line.kind === 'mention' && line.files.length === 0 && line.skills.length === 0
      ? '无匹配的文件或技能'
      : null

  const basename = (p: string) => p.split(/[\\/]/).pop() || p

  return (
    <div className="border-t bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-1">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="h-7 rounded-full">
              {MODES.map((m) => (
                <TabsTrigger key={m.id} value={m.id} title={m.hint} className="rounded-full px-3 text-xs">
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {planning ? (
          <div className="flex items-center justify-center gap-3 rounded-md border bg-muted/30 px-3 py-3">
            <span className="text-sm text-muted-foreground">计划已生成,确认后开始执行</span>
            <Button size="sm" disabled={busy} onClick={() => void onApprove(true)}>
              执行计划
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onApprove(false)}>
              取消
            </Button>
          </div>
        ) : (
          <div className="relative">
            {showMenu && (
              <div className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                {suggestions.length > 0 ? (
                  suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                      title={s.text}
                      onClick={() => applySuggestion(line!, s.text)}
                    >
                      {s.icon}
                      <span className="truncate">{basename(s.text)}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-muted-foreground">{emptyHint}</div>
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={textareaRef}
                value={value}
                rows={2}
                placeholder="输入消息,Enter 发送,Shift+Enter 换行;/ 使用技能,@ 提及文件或技能"
                className="resize-none overflow-hidden"
                onChange={(e) => {
                  setValue(e.target.value)
                  autoResize(e.target)
                }}
                onKeyDown={onKeyDown}
              />
              {streaming ? (
                <>
                  <Button
                    type="button"
                    size="icon"
                    disabled={!value.trim()}
                    className="h-8 w-8 rounded-full"
                    title="正在回复中,发送将排队,当前步骤完成后自动处理"
                    onClick={send}
                  >
                    <Clock className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-full" title="停止" onClick={() => void cancel()}>
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <Button type="button" size="icon" className="h-8 w-8 rounded-full" disabled={!value.trim()} onClick={send} title="发送">
                  <Send className={cn('h-3.5 w-3.5')} />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
