package infrastructuresettings

import (
	"bytes"
	"encoding/json"
)

// secretValueKind discriminates the four shapes a stored secret value can have.
type secretValueKind int

const (
	// secretAbsent is the JSON literal null (or a missing member).
	secretAbsent secretValueKind = iota
	// secretPlaintext is a stored string. It may be empty: the strict reader
	// keeps empty legacy plaintext values as-is.
	secretPlaintext
	// secretEncrypted is a well-formed v1 envelope.
	secretEncrypted
	// secretInvalid is any other shape (number, boolean, array, malformed
	// envelope). The read paths fall back to the environment value; the strict
	// parser rejects it.
	secretInvalid
)

// storedSecretValue is the named discriminated union every read path uses
// instead of inspecting raw JSON inline.
type storedSecretValue struct {
	kind      secretValueKind
	plaintext string
	encrypted encryptedStringValueV1
}

// parseStoredSecretValue classifies one stored JSON value.
func parseStoredSecretValue(raw json.RawMessage) storedSecretValue {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return storedSecretValue{kind: secretAbsent}
	}
	switch trimmed[0] {
	case '"':
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return storedSecretValue{kind: secretInvalid}
		}
		return storedSecretValue{kind: secretPlaintext, plaintext: text}
	case '{':
		var envelope encryptedStringValueV1
		if err := json.Unmarshal(trimmed, &envelope); err != nil {
			return storedSecretValue{kind: secretInvalid}
		}
		if !envelope.valid() {
			return storedSecretValue{kind: secretInvalid}
		}
		return storedSecretValue{kind: secretEncrypted, encrypted: envelope}
	default:
		return storedSecretValue{kind: secretInvalid}
	}
}
