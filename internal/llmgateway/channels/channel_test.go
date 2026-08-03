package channels

import (
	"context"
	"testing"
)

type stubChannel struct{ name, base string }

func (s stubChannel) Name() string                    { return s.name }
func (s stubChannel) BaseURL() string                 { return s.base }
func (s stubChannel) FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error) {
	return []ModelInfo{{ID: "m1"}}, nil
}
func (s stubChannel) RequestOverrides(modelID string) (map[string]any, []string) {
	return map[string]any{"thinking": map[string]any{"type": "enabled"}}, []string{"temperature"}
}
func (s stubChannel) DefaultModelCaps() (int64, int64) { return 1048576, 393216 }

func TestRegistryLookup(t *testing.T) {
	Register(stubChannel{name: "stub", base: "http://stub"})
	if _, ok := Get("stub"); !ok {
		t.Fatal("Get(stub) not found")
	}
	if _, ok := Get("nope"); ok {
		t.Fatal("Get(nope) should be missing")
	}
	if len(All()) == 0 {
		t.Fatal("All() empty")
	}
}

func TestParseOAIModels(t *testing.T) {
	body := []byte(`{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`)
	ms, err := ParseOAIModels(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "deepseek-v4-flash" || ms[0].DisplayName != "deepseek-v4-flash" {
		t.Fatalf("models = %+v", ms)
	}
}
