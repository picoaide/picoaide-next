import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // ai SDK v7 及 zod 为 ESM-only,Node CJS require 会 ERR_REQUIRE_ESM → 排除外置,由 Rollup 打进 CJS 包
    plugins: [
      externalizeDepsPlugin({
        exclude: ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/sandbox-just-bash', 'zod'],
      }),
    ],
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    build: {
      rollupOptions: {
        output: { inlineDynamicImports: false },
        // just-bash 惰性 import 的原生压缩 codec(xz/zstd,默认禁用);
        // 声明 external 避免 rollup 在 CI 干净安装下尝试解析原生模块
        external: ['node-liblzma', '@mongodb-js/zstd'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
