package infrastructuresettings

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// runtimeSecretsDocument builds one stored document from raw entry values.
func runtimeSecretsDocument(t *testing.T, entries []map[string]json.RawMessage) string {
	t.Helper()
	document := map[string]json.RawMessage{}
	document["version"] = json.RawMessage("1")
	encodedEntries := make([]json.RawMessage, 0, len(entries))
	for _, entry := range entries {
		encoded, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		encodedEntries = append(encodedEntries, encoded)
	}
	encoded, err := json.Marshal(encodedEntries)
	if err != nil {
		t.Fatal(err)
	}
	document["entries"] = encoded
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func runtimeSecretEntry(t *testing.T, sourceID, key string, value any) map[string]json.RawMessage {
	t.Helper()
	encodedValue, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := json.Marshal(sourceID)
	encodedKey, _ := json.Marshal(key)
	return map[string]json.RawMessage{
		"sourceId": source,
		"key":      encodedKey,
		"value":    encodedValue,
	}
}

func TestRuntimeReaderMergesRequestedThenResolved(t *testing.T) {
	keyRaw := "1111111111111111111111111111111111111111111111111111111111111111"
	key, err := decodeSystemSettingsKey(keyRaw)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := encryptStringValueV1("secret-token", key)
	if err != nil {
		t.Fatal(err)
	}
	document := runtimeSecretsDocument(t, []map[string]json.RawMessage{
		runtimeSecretEntry(t, "weibo", "cookie", "requested-cookie"),
		runtimeSecretEntry(t, "weibo-hot", "cookie", "resolved-cookie"),
		runtimeSecretEntry(t, "weibo-hot", "token", envelope),
	})
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: document})
	reader := NewRuntimeSecretReader(store.db(), keyRaw, true)

	secrets := reader.SecretsForSource(context.Background(), "weibo", "weibo-hot")
	if secrets["cookie"] != "resolved-cookie" {
		t.Fatalf("resolved source must override the shared key: %#v", secrets)
	}
	if secrets["token"] != "secret-token" {
		t.Fatalf("encrypted secret not decrypted: %#v", secrets)
	}
}

func TestRuntimeReaderSkipsEncryptedWithoutKey(t *testing.T) {
	keyRaw := "1111111111111111111111111111111111111111111111111111111111111111"
	key, _ := decodeSystemSettingsKey(keyRaw)
	envelope, _ := encryptStringValueV1("secret-token", key)
	document := runtimeSecretsDocument(t, []map[string]json.RawMessage{
		runtimeSecretEntry(t, "weibo", "cookie", "plain-cookie"),
		runtimeSecretEntry(t, "weibo", "token", envelope),
	})
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: document})
	reader := NewRuntimeSecretReader(store.db(), "not-a-valid-key", true)

	secrets := reader.SecretsForSource(context.Background(), "weibo", "")
	if secrets["cookie"] != "plain-cookie" {
		t.Fatalf("plaintext entry must survive a broken key: %#v", secrets)
	}
	if _, ok := secrets["token"]; ok {
		t.Fatalf("encrypted entry must be skipped without a valid key: %#v", secrets)
	}
}

func TestRuntimeReaderCachesForThirtySeconds(t *testing.T) {
	document := runtimeSecretsDocument(t, []map[string]json.RawMessage{
		runtimeSecretEntry(t, "weibo", "cookie", "first"),
	})
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: document})
	reader := NewRuntimeSecretReader(store.db(), "", false)
	reader.now = func() time.Time { return time.Unix(1000, 0) }

	if secrets := reader.SecretsForSource(context.Background(), "weibo", ""); secrets["cookie"] != "first" {
		t.Fatalf("unexpected first read: %#v", secrets)
	}
	store.settings[settingKeyRuntimeSecrets] = runtimeSecretsDocument(t, []map[string]json.RawMessage{
		runtimeSecretEntry(t, "weibo", "cookie", "second"),
	})
	if secrets := reader.SecretsForSource(context.Background(), "weibo", ""); secrets["cookie"] != "first" {
		t.Fatalf("cache must serve the first snapshot: %#v", secrets)
	}
	reader.now = func() time.Time { return time.Unix(1000+31, 0) }
	if secrets := reader.SecretsForSource(context.Background(), "weibo", ""); secrets["cookie"] != "second" {
		t.Fatalf("cache must expire after 30s: %#v", secrets)
	}
}

func TestRuntimeReaderInvalidDocumentYieldsEmpty(t *testing.T) {
	store := newFakeMySQL(map[string]string{settingKeyRuntimeSecrets: `{"version":2,"entries":[]}`})
	reader := NewRuntimeSecretReader(store.db(), "", false)
	if secrets := reader.SecretsForSource(context.Background(), "weibo", ""); len(secrets) != 0 {
		t.Fatalf("invalid stored document must degrade to empty, got %#v", secrets)
	}
}
