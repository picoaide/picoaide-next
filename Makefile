BIN := bin/picoaide-server

.PHONY: test test-server test-client build-server build-client build-desktop webadmin check pkg-linux pkg-windows pkg-macos

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
