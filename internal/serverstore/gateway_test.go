package serverstore

import (
	"testing"
)

func TestGatewayProviderChannelField(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := AddGatewayProvider(db, &GatewayProvider{
		Name:      "deepseek-provider",
		BaseURL:   "https://api.deepseek.com",
		APIKeyEnc: "enc-key",
		Models:    []string{"deepseek-chat"},
		Enabled:   1,
		Channel:   "deepseek",
	})
	if err != nil {
		t.Fatalf("AddGatewayProvider: %v", err)
	}

	p, err := GetGatewayProvider(db, id)
	if err != nil {
		t.Fatalf("GetGatewayProvider: %v", err)
	}
	if p.Channel != "deepseek" {
		t.Fatalf("Channel = %q, want %q", p.Channel, "deepseek")
	}
}

func TestSyncProviderModelAndRemoveMissing(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p := &GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "enc:x", Channel: "deepseek", Enabled: 1}
	pid, err := AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-flash", `{"context_length":1048576}`); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-pro", `{"max_output":393216}`); err != nil {
		t.Fatal(err)
	}
	removed, err := RemoveMissingProviderModels(db, pid, []string{"deepseek-v4-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].Name != "deepseek-v4-pro" {
		t.Fatalf("models = %+v", models)
	}
	// default_model 被删时重置为空
	if err := SetSetting(db, "gateway.default_model", "deepseek-v4-pro"); err != nil {
		t.Fatal(err)
	}
	removed, err = RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed2 = %d", removed)
	}
	v, ok, _ := GetSetting(db, "gateway.default_model")
	if !ok || v != "" {
		t.Fatalf("default_model = %q ok=%v", v, ok)
	}
}
