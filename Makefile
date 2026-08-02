BIN := bin/picoaide-server

# 服务端镜像名(GHCR,与仓库同名);TAG 默认 latest
IMAGE ?= ghcr.io/picoaide/picoaide-server
TAG ?= latest

.PHONY: test test-server test-client build-server build-client build-desktop webadmin docker-image check pkg-linux pkg-windows pkg-macos

test:
	go test ./... -count=1

test-server:
	go test ./internal/serverauth/... ./internal/llmgateway/... ./internal/marketplace/... ./internal/knowledge/... ./internal/serverstore/... -count=1

test-client:
	cd desktop && npm test && npm run typecheck

build-server:
	go build -o $(BIN) ./cmd/server

build-client:
	cd desktop && npm run build

build-desktop:
	cd desktop && npm run build && npx electron-builder --dir

webadmin:
	cd webadmin && npm run build

# 服务端 Docker 镜像(计划 Task 4.6):本地验证单平台;CI 用 buildx 出 amd64/arm64
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
