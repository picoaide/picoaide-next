package marketplace

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/util"
)

func TestEncryptEnvSensitiveKeys(t *testing.T) {
	key, err := util.EnsureMasterKey(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	encrypted := func(v string) bool { return strings.HasPrefix(v, util.EncPrefix) }
	env := map[string]string{
		"Authorization": "Bearer tok",
		"X-API-KEY":     "k123",
		"client_secret": "cs",
		"APP_ID":        "pub",
		"TIMEOUT":       "30",
		"API_KEY":       "ak",
		"TOKEN":         "tk",
		"PASSWORD":      "pw",
		"URL":           "http://x",
		"ENDPOINT":      "plain",
	}
	enc := EncryptEnv(key, env)
	for _, k := range []string{"Authorization", "X-API-KEY", "client_secret", "API_KEY", "TOKEN", "PASSWORD"} {
		if got := enc[k]; !encrypted(got) {
			t.Fatalf("%s = %q, want encrypted", k, got)
		}
	}
	for _, k := range []string{"APP_ID", "TIMEOUT", "URL", "ENDPOINT"} {
		if got := enc[k]; encrypted(got) {
			t.Fatalf("%s = %q, should not be encrypted", k, got)
		}
	}
	// decrypt round-trip restores the original values
	dec := DecryptEnv(key, enc)
	if dec["Authorization"] != "Bearer tok" || dec["X-API-KEY"] != "k123" {
		t.Fatalf("round trip mismatch: %+v", dec)
	}
}
