package authlogin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// hashSHA256Hex is the shared opaque-token hash: a lowercase hex SHA-256 with no
// salt. It is used for the email-code hash, the password-reset token hash and
// the refresh grace-cache key segment, all of which NestJS computes with
// crypto.createHash("sha256").update(value).digest("hex").
func hashSHA256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

// hashEmailCode is the code hash stored in the cached payload. The plaintext is
// never persisted.
func hashEmailCode(code string) string { return hashSHA256Hex(code) }

// hashPassword produces the cost-10 bcrypt hash NestJS writes, with the same
// Node-compatible byte handling the reused account-security port uses.
func hashPassword(password string) (string, error) {
	return accountsecurity.HashLoginPassword(password)
}

// marshalRaw encodes a named struct into the json.RawMessage the cache and audit
// writers accept. Every caller passes a struct, never a map, so the payload
// shape stays reviewable.
func marshalRaw(value any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}
