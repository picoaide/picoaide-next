#!/usr/bin/env bash
# 客户端全流程 E2E:起服务端 + mock 上游 + 配置默认模型 → Playwright 驱动真实 Electron
# 用法:bash scripts/e2e/run_full_client_e2e.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

SERVER_PORT="${SERVER_PORT:-18080}"
MOCK_PORT="${MOCK_PORT:-18081}"
DATA_DIR="$(mktemp -d /tmp/pa-e2e-server-XXXXXX)"
ADMIN_PASSWORD="${PICOAI_ADMIN_PASSWORD:-Admin@123}"

cleanup() {
  kill "${SERVER_PID:-}" "${MOCK_PID:-}" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "== build mock upstream + server =="
go build -o "$DATA_DIR/mock-upstream" ./scripts/mock-upstream.go
make build-server >/dev/null

"$DATA_DIR/mock-upstream" -addr ":$MOCK_PORT" &
MOCK_PID=$!
PICOAI_ADMIN_PASSWORD="$ADMIN_PASSWORD" ./bin/picoaide-server -addr ":$SERVER_PORT" -data "$DATA_DIR/data" --bootstrap-admin admin &
SERVER_PID=$!
sleep 1.5

TOKEN=$(curl -s -XPOST "localhost:$SERVER_PORT/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r .token)
CSRF=$(curl -s -c /tmp/pa-e2e.jar -XPOST "localhost:$SERVER_PORT/api/admin/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r .csrf_token)
curl -s -b /tmp/pa-e2e.jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -XPOST "localhost:$SERVER_PORT/api/admin/providers" \
  -d "{\"name\":\"mock\",\"base_url\":\"http://127.0.0.1:$MOCK_PORT\",\"api_key\":\"e2e-key\",\"models\":[\"mock-chat\"]}" >/dev/null
curl -s -b /tmp/pa-e2e.jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -XPOST "localhost:$SERVER_PORT/api/admin/models" \
  -d '{"name":"mock-chat","provider_id":1,"display_name":"Mock Chat"}' >/dev/null
curl -s -b /tmp/pa-e2e.jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -XPUT "localhost:$SERVER_PORT/api/admin/gateway" -d '{"default_model":"mock-chat"}' >/dev/null
echo "== server ready on :$SERVER_PORT =="

cd desktop
PICOAI_SERVER_URL="http://127.0.0.1:$SERVER_PORT" PICOAI_E2E_USER=admin PICOAI_E2E_PASSWORD="$ADMIN_PASSWORD" \
  timeout 300 xvfb-run -a npx playwright test --config ../scripts/e2e smoke_client_full.spec.ts
