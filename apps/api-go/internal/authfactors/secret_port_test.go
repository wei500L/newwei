package authfactors

import (
	"context"
	"testing"
)

// TestLoginSecretPortRoundTrip locks the exported codec onto the existing
// system-settings v1 envelope: the OIDC handoff uses the same format as the
// authenticated configuration and MFA factor storage.
func TestLoginSecretPortRoundTrip(t *testing.T) {
	service := &Service{cfg: Config{EncryptionKeyRaw: testKeyHex, EncryptionKeyPresent: true}}
	encoded, err := service.EncodeLoginSecret(context.Background(), "opaque-token")
	if err != nil {
		t.Fatal(err)
	}
	if parseStoredSecret(encoded).kind != secretEnvelope {
		t.Fatalf("encoded value is not an envelope: %s", encoded)
	}
	decoded, found, err := service.DecodeLoginSecret(context.Background(), encoded)
	if err != nil || !found || decoded != "opaque-token" {
		t.Fatalf("decoded=%q found=%v err=%v", decoded, found, err)
	}

	plain, found, err := service.DecodeLoginSecret(context.Background(), []byte(`"plain-token"`))
	if err != nil || !found || plain != "plain-token" {
		t.Fatalf("plaintext decoded=%q found=%v err=%v", plain, found, err)
	}
}
