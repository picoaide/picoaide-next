// ws 类型兜底:@types/ws 未随依赖安装(避免新增 node_modules 依赖),此处声明使用到的最小 API 面。
declare module 'ws' {
  export class WebSocket {
    constructor(url: string)
    static readonly OPEN: number
    readonly readyState: number
    send(data: string): void
    close(): void
    terminate(): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this
    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    off(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this
  }
  export class WebSocketServer {
    constructor(options: { port: number; host: string; maxPayload?: number })
    on(event: 'connection', listener: (ws: WebSocket) => void): this
    on(event: 'listening', listener: () => void): this
    on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): this
    close(callback?: () => void): void
    address(): { port: number } | null
  }
}
