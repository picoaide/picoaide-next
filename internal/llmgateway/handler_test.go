package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

const upstreamKey = "sk-upstream-test"

// fakeUpstream is an OpenAI-compatible upstream for tests.
type fakeUpstream struct {
	baseURL    string
	srv        *httptest.Server
	gotBody    atomic.Value
	gotAuth    atomic.Value
	requests   atomic.Int64
	streamResp string
	nonStream  string
	status     int
	first500   bool
	firstDelay time.Duration
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	f := &fakeUpstream{
		streamResp: `data: {"choices":[{"delta":{"content":"hi"}}]}

data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}

data: [DONE]

`,
		nonStream: `{"id":"x","object":"chat.completion","usage":{"prompt_tokens":8,"completion_tokens":3}}`,
		status:    http.StatusOK,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.gotBody.Store(string(body))
		f.gotAuth.Store(r.Header.Get("Authorization"))
		f.requests.Add(1)
		if f.first500 && f.requests.Load() == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		if f.firstDelay > 0 {
			time.Sleep(f.firstDelay)
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), `"stream":true`) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(f.status)
			fmt.Fprint(w, f.streamResp)
			return
		}
		w.WriteHeader(f.status)
		fmt.Fprint(w, f.nonStream)
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL
	return f
}

func newGateway(t *testing.T, f *fakeUpstream) (*gin.Engine, *sql.DB, string) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/gw.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	// seed provider + model (handles empty f for pure-auth tests)
	if f != nil {
		if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('fake', ?, ?, '["deepseek-chat"]')`, f.baseURL, upstreamKey); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-chat', 1, 'DeepSeek Chat')`); err != nil {
			t.Fatal(err)
		}
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, token
}

func doPost(t *testing.T, r http.Handler, path, body, token string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if ctx != nil {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(ctx)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestProxyNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if got := f.gotBody.Load().(string); got != body {
		t.Fatalf("body not forwarded identically: %q", got)
	}
	if got := f.gotAuth.Load().(string); got != "Bearer "+upstreamKey {
		t.Fatalf("auth = %q, want upstream key", got)
	}
	if got := w.Body.String(); got != f.nonStream {
		t.Fatalf("response not passthrough: %q", got)
	}
}

func TestProxyStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if got := w.Body.String(); got != f.streamResp {
		t.Fatalf("stream not passthrough:\ngot:  %q\nwant: %q", got, f.streamResp)
	}

	// pending row inserted then backfilled with tokens from final chunk
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("usage pt=%d ct=%d", pt, ct)
	}
}

func TestProxyStreamClientDisconnectKeepsPendingRow(t *testing.T) {
	f := newFakeUpstream(t)
	f.firstDelay = 100 * time.Millisecond // give the client time to disconnect mid-stream
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}`

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() { r.ServeHTTP(w, req); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel() // simulate client disconnect
	<-done

	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("usage rows = %d, want 1 pending", n)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 0 || ct != 0 {
		t.Fatalf("pending row not left as-is: pt=%d ct=%d", pt, ct)
	}
}

func TestProxyRecordsUsageNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 8 || ct != 3 {
		t.Fatalf("usage pt=%d ct=%d", pt, ct)
	}
}

func TestProxyUnauthorized(t *testing.T) {
	r, _, _ := newGateway(t, nil)
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "AUTH_REQUIRED" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyRetryOnceThen502(t *testing.T) {
	f := newFakeUpstream(t)
	f.status = http.StatusInternalServerError
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	if n := f.requests.Load(); n != 2 {
		t.Fatalf("upstream calls = %d, want exactly 2 (initial + 1 retry)", n)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "UPSTREAM" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyRetryRecovers(t *testing.T) {
	f := newFakeUpstream(t)
	f.first500 = true
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 2 {
		t.Fatalf("upstream calls = %d, want 2", n)
	}
}

func TestProxyRateLimited(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	if err := serverstore.SetSetting(db, "gateway.rate_limit", "2"); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d status = %d", i+1, w.Code)
		}
	}
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "RATE_LIMITED" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyModelNotFound(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions", `{"model":"nope","messages":[]}`, token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "NOT_FOUND" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyInvalidBody(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions", `not-json`, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestDecryptSecretHookUsedByLoadUpstreams(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/hook.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('p', 'http://x', 'encrypted:abc', '["m"]')`); err != nil {
		t.Fatal(err)
	}
	defer func(prev func(string) (string, error)) { DecryptSecret = prev }(DecryptSecret)
	DecryptSecret = func(s string) (string, error) { return "decrypted-" + s, nil }

	ups, err := LoadUpstreams(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 1 || ups[0].APIKey != "decrypted-encrypted:abc" {
		t.Fatalf("upstreams = %+v", ups)
	}
}

func TestMatchModel(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/match.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('a', 'http://a', 'k', '["m1","m2"]'), ('b', 'http://b', 'k', '["m3"]')`); err != nil {
		t.Fatal(err)
	}

	up, err := MatchModel(db, "m2")
	if err != nil {
		t.Fatal(err)
	}
	if up.Name != "a" || up.BaseURL != "http://a" {
		t.Fatalf("upstream = %+v", up)
	}
	if _, err := MatchModel(db, "nope"); !errors.Is(err, serverstore.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
