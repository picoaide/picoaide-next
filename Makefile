BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-server
TAG ?= latest

.PHONY: test test-server test-client build-server build-client build-desktop webadmin docker-image check pkg-linux pkg-windows pkg-macos dev-env test-ui test-e2e

dev-env:
	bash scripts/dev-env.sh

# UI 组件测试(Vitest + Testing Library):客户端 renderer + webadmin
test-ui:
	cd desktop && ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/vitest/vitest.mjs run --config vitest.config.ts
	cd webadmin && npm test

# 浏览器/Electron E2E(依赖 dev-env 已启动: make dev-env)
# webadmin 用真实浏览器;Electron 场景串行(--workers=1,共享 dev-env)
test-e2e:
	cd desktop && npx playwright test --config ../scripts/e2e --workers=1 smoke_client_full.spec.ts
	cd desktop && npx playwright test --config ../scripts/e2e admin_ui.spec.ts
	go test ./... -count=1

test-server:
	go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/knowledge/... ./internal/serverstore/... -count=1

test-client:
	cd desktop && npm test && npm run typecheck

# webadmin 是编译进 Go 二进制的临时产物:build-server 自动先构建,不单独编译
build-server: webadmin
	go build -o $(BIN) ./cmd/server

build-client:
	cd desktop && npm run build

build-desktop:
	cd desktop && npm run build && npx electron-builder --dir

webadmin:
	cd webadmin && npm run build

# 服务端 Docker 镜像(计划 Task 4.6):本地验证单平台;CI 用 buildx 出 amd64
# 用法:make docker-image 或 make docker-image IMAGE=ghcr.io/picoaide/picoaide-server TAG=v0.4.0
docker-image:
	docker build -t $(IMAGE):$(TAG) .

check:
	gofmt -l cmd internal | grep -v '^$$' && exit 1 || true
	go vet ./cmd/... ./internal/...
	$(MAKE) test
	$(MAKE) test-client

pkg-linux:
	bash scripts/pkg-linux.sh

pkg-windows:
	bash scripts/pkg-windows.sh

pkg-macos:
	bash scripts/pkg-macos.sh
