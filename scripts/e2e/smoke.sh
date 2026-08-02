#!/usr/bin/env bash
# PicoAide server E2E smoke: scripted version of the plan's 1.17 curl chain,
# with jq assertions. Every step must pass; any failure exits non-zero.
#
# Usage: bash scripts/e2e/smoke.sh
# Env overrides: SERVER_PORT (default 18080), MOCK_PORT (default 18081),
# PICOAI_ADMIN_PASSWORD (default Admin@123), PICOAI_SERVER_BIN, PICOAI_MOCK_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_PORT="${SERVER_PORT:-18080}"
MOCK_PORT="${MOCK_PORT:-18081}"
ADMIN_PASSWORD="${PICOAI_ADMIN_PASSWORD:-Admin@123}"
SERVER_BIN="${PICOAI_SERVER_BIN:-$ROOT/bin/picoaide-server}"
MOCK_BIN="${PICOAI_MOCK_BIN:-/tmp/picoaide-mock-upstream}"

BASE="http://127.0.0.1:$SERVER_PORT"
WORK="$(mktemp -d /tmp/pa-smoke.XXXXXX)"
JAR="$WORK/cookies.jar"
SERVER_PID=""
MOCK_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

# assert <desc> <jq-expr> <json-file>  — fails unless expr is truthy
assert() {
  local desc="$1" expr="$2" file="$3"
  if ! jq -e "$expr" "$file" >/dev/null 2>&1; then
    echo "SMOKE FAIL: $desc (jq '$expr' false on $(cat "$file" | head -c 300))" >&2
    exit 1
  fi
  echo "ok: $desc"
}

need() { command -v "$1" >/dev/null 2>&1 || fail "missing dependency: $1"; }
need curl; need jq

wait_http() { # wait_http <base> <timeout-sec>
  local url="$1" t="$2"
  for _ in $(seq 1 "$((t * 2))"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"
    [ "$code" != "000" ] && return 0
    sleep 0.5
  done
  return 1
}

echo "== build =="
[ -x "$SERVER_BIN" ] || (make -C "$ROOT" build-server) || fail "build server failed"
[ -x "$MOCK_BIN" ] || (cd "$ROOT" && go build -o "$MOCK_BIN" ./scripts/mock-upstream.go) || fail "build mock upstream failed"

echo "== start servers =="
"$MOCK_BIN" -addr ":$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!
PICOAI_ADMIN_PASSWORD="$ADMIN_PASSWORD" "$SERVER_BIN" -addr ":$SERVER_PORT" -data "$WORK/data" --bootstrap-admin admin >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

wait_http "$BASE/" 15 || { cat "$WORK/server.log" >&2; fail "server did not start on :$SERVER_PORT"; }
wait_http "http://127.0.0.1:$MOCK_PORT/" 5 || { cat "$WORK/mock.log" >&2; fail "mock upstream did not start on :$MOCK_PORT"; }

echo "== 1. user login =="
curl -s -XPOST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" >"$WORK/login.json"
assert "user login returns token" '.token | length > 0' "$WORK/login.json"
TOKEN="$(jq -r .token "$WORK/login.json")"

echo "== 2. admin login =="
curl -s -c "$JAR" -XPOST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" >"$WORK/admin_login.json"
assert "admin login returns csrf_token" '.csrf_token | length > 0' "$WORK/admin_login.json"
CSRF="$(jq -r .csrf_token "$WORK/admin_login.json")"
ADMIN_HDR=(-b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json')

echo "== 3. configure mock provider + model + default model =="
curl -s -XPOST "$BASE/api/admin/providers" "${ADMIN_HDR[@]}" \
  -d "{\"name\":\"mock\",\"base_url\":\"http://127.0.0.1:$MOCK_PORT\",\"api_key\":\"sk-mock\",\"models\":[\"mock-chat\"]}" >"$WORK/provider.json"
assert "provider created" '.provider.id == 1' "$WORK/provider.json"
curl -s -XPOST "$BASE/api/admin/models" "${ADMIN_HDR[@]}" \
  -d '{"name":"mock-chat","provider_id":1,"display_name":"Mock Chat"}' >"$WORK/model.json"
assert "model created" '.model.id == 1' "$WORK/model.json"
curl -s -XPUT "$BASE/api/admin/gateway" "${ADMIN_HDR[@]}" \
  -d '{"default_model":"mock-chat","allow_private":true}' >"$WORK/gateway.json"
assert "default model set" '.ok == true' "$WORK/gateway.json"

echo "== 4. bootstrap =="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/config/bootstrap" >"$WORK/bootstrap.json"
assert "bootstrap default_model=mock-chat" '.default_model == "mock-chat"' "$WORK/bootstrap.json"
assert "bootstrap lists the model" '.models[0].id == "mock-chat"' "$WORK/bootstrap.json"

echo "== 5. gateway non-stream chat =="
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -XPOST "$BASE/v1/chat/completions" \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}],"stream":false}' >"$WORK/chat.json"
assert "non-stream content echoes mock upstream" '.choices[0].message.content | contains("mock upstream echo")' "$WORK/chat.json"

echo "== 6. gateway stream =="
curl -sN -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -XPOST "$BASE/v1/chat/completions" \
  -d '{"model":"mock-chat","messages":[{"role":"user","content":"hi"}],"stream":true}' >"$WORK/stream.txt"
DATA_LINES="$(grep -c '^data:' "$WORK/stream.txt")"
[ "$DATA_LINES" -ge 3 ] || fail "stream: expected >=3 data: lines, got $DATA_LINES"
echo "ok: stream has $DATA_LINES data: lines"

echo "== 7. marketplace (empty ok) =="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/marketplace/skills" >"$WORK/skills.json"
assert "skills list is an array" '.skills | type == "array"' "$WORK/skills.json"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/marketplace/mcp" >"$WORK/mcp.json"
assert "mcp list is an array" '.mcp | type == "array"' "$WORK/mcp.json"

echo "== 8. knowledge base tools/list (4 tools) =="
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -XPOST "$BASE/api/mcp/knowledge/message" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' >"$WORK/tools.json"
assert "tools/list returns result" '.result != null' "$WORK/tools.json"
assert "tools/list has exactly 4 tools" '.result.content[0].text | fromjson | length == 4' "$WORK/tools.json"
assert "tools include kb_search" '.result.content[0].text | fromjson | map(.name) | index("kb_search") != null' "$WORK/tools.json"
assert "tools include kb_upload" '.result.content[0].text | fromjson | map(.name) | index("kb_upload") != null' "$WORK/tools.json"

echo "== 9. usage aggregation (>= 2 requests) =="
curl -s -b "$JAR" "$BASE/api/admin/usage?group=day" >"$WORK/usage.json"
assert "usage rows present" '.rows | length >= 1' "$WORK/usage.json"
assert "usage requests >= 2 (stream + non-stream)" '[.rows[].requests] | add >= 2' "$WORK/usage.json"

echo "SMOKE PASS: server E2E chain green"
