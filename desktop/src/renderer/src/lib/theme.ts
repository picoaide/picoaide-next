// 强调色应用(chatbox accent color):hsl 值覆盖 --primary/--ring,浅色 foreground 恒白
export function applyAccent(color: string): void {
  const root = document.documentElement
  root.style.setProperty('--primary', color)
  root.style.setProperty('--primary-foreground', '210 40% 98%')
  root.style.setProperty('--ring', color)
}
