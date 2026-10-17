package authfactors

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// This file reproduces auth-flow.utils.ts byte for byte: RFC 4648 Base32
// without padding, RFC 6238 TOTP over HMAC-SHA1 with six digits and a 30 second
// period, and the exact otpauth URI NestJS renders. Only the standard library
// is used; no hash algorithm is implemented by hand.

// base32NoPadding is the RFC 4648 alphabet NestJS uses (A-Z, 2-7), without
// padding, so a 20 byte secret encodes to exactly 32 characters.
var base32NoPadding = base32.StdEncoding.WithPadding(base32.NoPadding)

// encodeBase32 renders bytes as unpadded uppercase Base32.
func encodeBase32(input []byte) string {
	return base32NoPadding.EncodeToString(input)
}

// decodeBase32 mirrors decodeBase32: trim, uppercase, drop trailing padding,
// then decode. An invalid character or an impossible length is an error, which
// callers treat as "the code cannot match".
func decodeBase32(input string) ([]byte, error) {
	normalized := strings.ToUpper(strings.TrimSpace(input))
	normalized = strings.TrimRight(normalized, "=")
	return base32NoPadding.DecodeString(normalized)
}

// generateTotpSecret draws 20 bytes from crypto/rand and encodes them as the
// 32 character Base32 secret NestJS produces. math/rand is never used.
func generateTotpSecret() (string, error) {
	buf := make([]byte, totpSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return encodeBase32(buf), nil
}

// generateTotpAt computes the six digit code for one counter value, preserving
// the dynamic truncation and the leading zeros.
func generateTotpAt(secret string, counter uint64) (string, error) {
	key, err := decodeBase32(secret)
	if err != nil {
		return "", err
	}
	var counterBytes [8]byte
	binary.BigEndian.PutUint64(counterBytes[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(counterBytes[:])
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 0x0f
	binaryValue := uint32(digest[offset]&0x7f)<<24 |
		uint32(digest[offset+1])<<16 |
		uint32(digest[offset+2])<<8 |
		uint32(digest[offset+3])
	return fmt.Sprintf("%0*d", totpCodeDigits, binaryValue%1_000_000), nil
}

// verifyTotpCode accepts a code that is exactly six ASCII digits after
// trimming and matches the counter for the previous, current or next 30 second
// step.
func verifyTotpCode(secret, code string) bool {
	normalized := strings.TrimSpace(code)
	if len(normalized) != totpCodeDigits {
		return false
	}
	for index := 0; index < len(normalized); index++ {
		if normalized[index] < '0' || normalized[index] > '9' {
			return false
		}
	}
	counter := time.Now().Unix() / totpPeriodSecond
	for offset := -totpWindow; offset <= totpWindow; offset++ {
		candidate, err := generateTotpAt(secret, uint64(counter+int64(offset)))
		if err != nil {
			return false
		}
		if candidate == normalized {
			return true
		}
	}
	return false
}

// encodeURIComponent reproduces JavaScript's encodeURIComponent: everything
// outside A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded from its UTF-8
// bytes with uppercase hex. Neither url.QueryEscape (which turns a space into
// "+") nor url.PathEscape (which leaves "+" and "&" alone) matches it.
func encodeURIComponent(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var builder strings.Builder
	builder.Grow(len(value))
	for index := 0; index < len(value); index++ {
		ch := value[index]
		if strings.IndexByte(unreserved, ch) >= 0 {
			builder.WriteByte(ch)
			continue
		}
		builder.WriteByte('%')
		builder.WriteString(strings.ToUpper(hex.EncodeToString([]byte{ch})))
	}
	return builder.String()
}

// buildOtpAuthURI renders the exact enrollment URI NestJS returns. The issuer
// label is fixed to "Modular"; the account name is the caller's real email.
func buildOtpAuthURI(accountName, secret string) string {
	issuer := encodeURIComponent(mfaIssuer)
	account := encodeURIComponent(accountName)
	encodedSecret := encodeURIComponent(secret)
	return "otpauth://totp/" + issuer + ":" + account +
		"?secret=" + encodedSecret +
		"&issuer=" + issuer +
		"&algorithm=SHA1&digits=6&period=30"
}
