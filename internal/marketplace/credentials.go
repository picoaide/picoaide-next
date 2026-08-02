package marketplace

import (
	"log"
	"strings"

	"github.com/picoaide/picoaide/internal/util"
)

// sensitiveEnvKeys: values under these keys (case-insensitive) are encrypted
// at rest. Empty values are left untouched.
var sensitiveEnvKeys = map[string]bool{
	"app_id":     true,
	"app_secret": true,
	"token":      true,
	"api_key":    true,
	"password":   true,
	"secret":     true,
	"key":        true,
}

// EncryptEnv encrypts sensitive values with the master key; values already
// carrying the "enc:v1:" prefix pass through unchanged.
func EncryptEnv(key []byte, env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		if v != "" && !strings.HasPrefix(v, util.EncPrefix) && sensitiveEnvKeys[strings.ToLower(k)] {
			out[k] = util.Encrypt(key, v)
		} else {
			out[k] = v
		}
	}
	return out
}

// DecryptEnv reverses EncryptEnv. Values that fail to decrypt are returned
// unchanged with a log line — a bad value must never take the server down.
func DecryptEnv(key []byte, env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		if strings.HasPrefix(v, util.EncPrefix) {
			pt, err := util.Decrypt(key, v)
			if err != nil {
				log.Printf("marketplace: decrypt %s failed: %v", k, err)
				out[k] = v
				continue
			}
			out[k] = pt
		} else {
			out[k] = v
		}
	}
	return out
}
