package llmgateway

import (
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestMatchModelRoutesChannelSyncedModels(t *testing.T) {
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/upstream.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	enc, err := encryptSecret("k")
	if err != nil {
		t.Fatal(err)
	}
	p := &serverstore.GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: enc, Channel: "deepseek", Enabled: 1}
	pid, err := serverstore.AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	// provider.models 列为空,模型只写入 models 表(渠道同步路径)
	if err := serverstore.SyncProviderModel(db, pid, "deepseek-v4-flash", "{}"); err != nil {
		t.Fatal(err)
	}

	up, err := MatchModel(db, "deepseek-v4-flash")
	if err != nil {
		t.Fatalf("MatchModel: %v", err)
	}
	if up.Channel != "deepseek" {
		t.Fatalf("channel = %q, want deepseek", up.Channel)
	}
	if up.Name != "deepseek" || up.BaseURL != "https://api.deepseek.com" {
		t.Fatalf("upstream = %+v", up)
	}
}
