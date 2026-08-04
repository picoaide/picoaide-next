import { Toaster as Sonner } from 'sonner'

// shadcn 标准 toast(shadcn/ui sonner 封装):主题跟随系统(html.dark)
export function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        classNames: {
          toast: 'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
        },
      }}
    />
  )
}
