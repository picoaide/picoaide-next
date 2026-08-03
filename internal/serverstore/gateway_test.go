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
