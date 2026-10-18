package authfactors

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// generateRecoveryCodes mirrors auth-flow.utils.generateRecoveryCodes: each
// code is ten uppercase hex characters drawn from five crypto/rand bytes. The
// plaintext is returned to the caller exactly once and is never stored, logged,
// cached or audited.
func generateRecoveryCodes(count int) ([]string, error) {
	codes := make([]string, 0, count)
	for index := 0; index < count; index++ {
		buf := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		codes = append(codes, strings.ToUpper(hex.EncodeToString(buf)))
	}
	return codes, nil
}

// hashOpaqueToken is the stored recovery-code representation: the lowercase hex
// SHA-256 of the normalized code. The interoperability protocol is deliberately
// unchanged (no bcrypt, no extra salt).
func hashOpaqueToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// normalizeRecoveryCode mirrors `code.trim().toUpperCase()` on the recovery-code
// branch. It is only used for the recovery-code lookup: the TOTP branch keeps
// accepting exactly six digits.
func normalizeRecoveryCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

// hashRecoveryCode is the lookup hash for a user supplied recovery code.
func hashRecoveryCode(code string) string {
	return hashOpaqueToken(normalizeRecoveryCode(code))
}
