# 构建与部署

## 1. Makefile 目标

```bash
make test              # go test ./... -count=1(服务端全量)
make test-server       # 服务端各域测试(serverauth/llmgateway/marketplace/knowledge/serverstore)
make test-client       # cd desktop && npm test && npm run typecheck
make build-server      # go build -o bin/picoaide-server ./cmd/server
make build-client      # cd desktop && npm run build(electron-vite → desktop/out/)
make build-desktop     # cd desktop && npm run build && npx electron-builder --dir
make webadmin          # cd webadmin && npm run build(产物嵌入服务端二进制)
make check             # gofmt 校验 + go vet + make test + make test-client
make pkg-linux         # bash scripts/pkg-linux.sh
make pkg-windows       # bash scripts/pkg-windows.sh
make pkg-macos         # bash scripts/pkg-macos.sh
```

## 2. 服务端构建与部署

### 构建

```bash
make build-server
```

服务端为单二进制,webadmin 静态资源通过 `go:embed` 内嵌(需先 `make webadmin` 构建)。

### 运行参数

```bash
PICOAI_ADMIN_PASSWORD=xxx bin/picoaide-server \
  -addr :8080 \
  -data ./data \
  --bootstrap-admin admin
```

| 参数/环境变量 | 说明 |
|------|------|
| `-addr` | 监听地址,默认 `:8080` |
| `-data` | 数据目录(0700),默认 `./data`;内含 `picoaide.db`(SQLite)、master key 文件、`skills-cache/` |
| `--bootstrap-admin` | 初始超管用户名;首次启动时用 `PICOAI_ADMIN_PASSWORD` 创建(已存在则校验其为管理员);**首次启动后不可重复创建** |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码(**必须**与 `--bootstrap-admin` 同时提供,否则启动失败) |
| `PICOAI_MASTER_KEY` | 可选;不设置时首次启动自动生成随机 master key 写入 `data/` 下(0700)。**备份该文件**,丢失后已加密的网关/商城凭证无法解密 |

### 生产建议

- 服务端放在企业内网,前置 HTTPS(反向代理终结 TLS);登录页拒绝非 HTTPS 远程地址。
- 迁移/备份:单文件 SQLite,直接备份 `data/picoaide.db` + master key 文件。
- 假上游联调:无外网/无 key 环境 `bash scripts/mock-upstream.go` 起 mock 上游,验证网关链路。

## 3. 客户端构建与安装

```bash
cd desktop
npm ci          # postinstall 自动执行 electron-rebuild(better-sqlite3 原生模块)
npm run dev     # electron-vite 开发(窗口自动起)
npm run build   # 产物 → desktop/out/
npx electron .  # 生产模式运行(需先 build)
```

安装包(三平台):`make pkg-linux` / `make pkg-windows` / `make pkg-macos`(脚本产出 deb/AppImage、NSIS、dmg;由 CI 矩阵产出)。

员工使用流程:安装客户端 → 输入服务端地址(HTTPS)与账号登录 → 零配置直接使用。客户端无"模型/网关/插件"配置入口;唯一本地配置 = 可访问目录(安全边界)+ 建议安装管理 + 刷新按钮。

### 浏览器插件安装(浏览器操作能力)

- `browser-extension/` 为 Chrome MV3 插件:在 `chrome://extensions` 开启开发者模式 → "加载已解压的扩展程序" 选择该目录(或企业组策略下发)。
- 插件默认直连 `ws://127.0.0.1:54321`,零配置;未装插件时 `browser_*` 工具报错降级,`web_fetch` 兜底。

## 4. CI

`.github/workflows/ci.yml`,push/PR 触发,三个 job:

| Job | 环境 | 内容 |
|-----|------|------|
| `server` | ubuntu, Go 1.24 | `make test-server` + `go build ./...` |
| `desktop` | ubuntu, Node 20 | `npm ci && npm test && npm run typecheck && npm run build` |
| `webadmin` | ubuntu, Node 20 | `npm ci && npm run build` |

打包产物(NSIS/dmg/deb+AppImage)由 CI 矩阵产出,本地以 `make pkg-*` 复现。

## 5. 管理页访问

`http(s)://<server>/admin/`(webadmin SPA;未构建时返回 "webadmin 未构建")。管理员登录后管理用户/网关/用量/商城/知识库。
