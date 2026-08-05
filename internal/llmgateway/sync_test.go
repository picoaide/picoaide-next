package llmgateway

import (
	"database/sql"
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func syncTestDB(t *testing.T) *sql.DB {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/sync.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	enc, err := encryptSecret("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	p := &serverstore.GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: enc, Channel: "deepseek", Enabled: 1}
	if _, err := serverstore.AddGatewayProvider(db, p); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestSyncOnceAddsNewModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	models, err := ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v", models)
	}
}

func TestSyncOnceRemovesGoneModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	fetchFn2 := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn2); err != nil {
		t.Fatal(err)
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-pro" {
		t.Fatalf("models after removal = %+v", models)
	}
}

func TestSyncEmptyFetchKeepsModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	// transient upstream quirk: empty data list
	empty := func(url string) ([]byte, error) {
		return []byte(`{"data":[]}`), nil
	}
	if _, err := SyncOnce(db, empty); err != nil {
		t.Fatal(err)
	}
	models, _ := ListModels(db)
	if len(models) != 2 {
		t.Fatalf("empty fetch wiped models: %+v", models)
	}
}

func TestSyncOnceFetchFailureSkips(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return nil, fmt.Errorf("boom")
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatalf("SyncOnce should tolerate fetch failure, got %v", err)
	}
	models, _ := ListModels(db)
	if len(models) != 0 {
		t.Fatalf("no models expected, got %+v", models)
	}
}
