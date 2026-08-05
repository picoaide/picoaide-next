import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 取路径最后一段(兼容 / 与 \)
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
