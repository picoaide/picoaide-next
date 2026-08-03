import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { math } from '@streamdown/math'
import { cjk } from '@streamdown/cjk'
import 'katex/dist/katex.min.css'
import 'streamdown/styles.css'

// chatbox 式 Markdown 渲染 → streamdown(react-markdown 的 AI 流式替代品):
// GFM + Shiki 代码高亮(复制按钮)+ KaTeX + Mermaid + CJK 断行,内置流式优化(不完整块安全渲染)
// 手写实现(约 150 行)整体删除,改用官方包(streamdown 2.5.0 最新)
function MarkdownContent({ content, isAnimating }: { content: string; isAnimating?: boolean }) {
  return (
    <Streamdown animated={isAnimating} isAnimating={isAnimating} plugins={{ code, mermaid, math, cjk }}>
      {content}
    </Streamdown>
  )
}

export default memo(MarkdownContent)
