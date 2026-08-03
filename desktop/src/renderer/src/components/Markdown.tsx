import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { cn } from '../lib/utils'
import 'highlight.js/styles/github-dark.css'

// chatbox 式 Markdown 渲染(清单 2.1/2.2):GFM + 代码高亮 + 代码块复制按钮
// ponytail: 用 rehype-highlight(轻);代码块固定深色主题,浅色 UI 下同样清晰,后续可升 shiki
function MarkdownContent({ content }: { content: string }) {
  const [copied, setCopied] = useState<string | null>(null)

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(code.slice(0, 40))
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // 剪贴板不可用时静默
    }
  }

  return (
    <div
      className={cn(
        'markdown-body text-sm leading-relaxed',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium',
        '[&_td]:border [&_td]:px-2 [&_td]:py-1',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_pre]:relative [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3',
        '[&_code]:rounded [&_code]:bg-muted/80 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_a]:text-primary [&_a]:underline',
        '[&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1],[&_h2],[&_h3]:mt-2 [&_h1],[&_h2],[&_h3]:font-semibold',
        '[&_hr]:my-3 [&_hr]:border-muted',
        '[&_input[type=checkbox]]:mr-1',
        '[&_img]:max-w-full [&_img]:rounded-md'
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} />
          ),
          pre: ({ children }) => {
            let code = ''
            try {
              const el = (children as React.ReactElement<{ children?: string }>)?.props?.children
              code = typeof el === 'string' ? el : ''
            } catch {
              code = ''
            }
            return (
              <div className="group/pre relative">
                <button
                  type="button"
                  className="absolute right-2 top-2 z-10 rounded border bg-background/80 p-1 opacity-0 transition-opacity group-hover/pre:opacity-100"
                  title="复制代码"
                  onClick={() => void copyCode(code)}
                >
                  {copied === code.slice(0, 40) ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <pre>{children}</pre>
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownContent)
