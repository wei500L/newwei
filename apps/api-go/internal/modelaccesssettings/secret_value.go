package modelaccesssettings

import (
	"bytes"
	"encoding/json"
)

// secretValue is the named discriminated union of every stored secret shape:
// absent, null, plaintext string, system-settings:v1 envelope, or an
// unrecognized JSON value.
//
// It replaces the loose `unknown` the NestJS services carry. Two properties are
// load-bearing:
//
//   - absent and null are different states: a PUT whose body omits
//     model-service.internalToken keeps the stored value, while an explicit null
//     clears it;
//   - a value read from the database is re-serialized verbatim (`raw`) so an
//     untouched encrypted envelope round-trips byte-for-byte instead of being
//     re-encoded from a parsed struct.
type secretValue struct {
	kind      secretKind
	plain     string
	encrypted encryptedSecret
	raw       json.RawMessage
}

// secretValueAbsent reports that the JSON key was not present.
func secretValueAbsent() secretValue {
	return secretValue{kind: secretAbsent}
}

// secretValueNull is the explicit JSON null.
func secretValueNull() secretValue {
	return secretValue{kind: secretNull}
}

// secretValuePlain wraps a freshly produced plaintext secret.
func secretValuePlain(value string) secretValue {
	return secretValue{kind: secretPlain, plain: value}
}

// secretValueEncrypted wraps a freshly produced v1 envelope.
func secretValueEncrypted(payload encryptedSecret) secretValue {
	return secretValue{kind: secretEncrypted, encrypted: payload}
}

// secretValueFromRaw classifies one stored JSON value. It never fails: an
// unrecognized shape becomes secretOther, which is preserved but never treated as
// a usable secret.
func secretValueFromRaw(raw json.RawMessage) secretValue {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return secretValueAbsent()
	}
	if jsonIsNull(trimmed) {
		return secretValueNull()
	}
	if jsonIsString(trimmed) {
		text, ok := jsonString(trimmed)
		if !ok {
			return secretValue{kind: secretOther, raw: trimmed}
		}
		return secretValue{kind: secretPlain, plain: text, raw: trimmed}
	}
	if trimmed[0] == '{' {
		if payload, ok := isEncryptedSecretShape(trimmed); ok {
			return secretValue{kind: secretEncrypted, encrypted: payload, raw: trimmed}
		}
	}
	return secretValue{kind: secretOther, raw: trimmed}
}

// MarshalJSON renders the stored form. The byte order of a fresh envelope is the
// NestJS field order; a database-sourced value keeps its original bytes.
func (v secretValue) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case secretPlain:
		return json.Marshal(v.plain)
	case secretEncrypted:
		if len(v.raw) > 0 {
			return v.raw, nil
		}
		return json.Marshal(v.encrypted)
	case secretOther:
		if len(v.raw) > 0 {
			return v.raw, nil
		}
		return []byte("null"), nil
	default:
		// absent and null both serialize as null: the caller must resolve an
		// absent stored token before persisting (resolveNextToken does).
		return []byte("null"), nil
	}
}

// resolvePlaintext mirrors ModelServiceSettingsService.resolveToken: it returns
// the usable (JS-trimmed) secret, or ok=false when the shape is unusable, the key
// is missing/invalid, or decryption fails.
//
// The caller logs a warning and falls back to the environment token in that case;
// a broken stored secret must never turn a read into a 500.
//
// This is NOT the OpenAI key path: those apply stripBearerPrefix (which is not the
// same as trim, because the bearer match runs before the trim) and therefore use
// decryptRaw/plain directly.
func (v secretValue) resolvePlaintext(key []byte, keyPresent bool) (string, bool) {
	plain := ""
	switch v.kind {
	case secretPlain:
		plain = v.plain
	case secretEncrypted:
		decrypted, ok := v.decryptRaw(key)
		if !ok {
			return "", false
		}
		plain = decrypted
	default:
		return "", false
	}
	trimmed := jsTrimSpace(plain)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// decryptRaw returns the decrypted plaintext without any normalization, so each
// caller can apply its own rule. ok is false when the value is not an encrypted
// envelope or the key does not decrypt it.
func (v secretValue) decryptRaw(key []byte) (string, bool) {
	if v.kind != secretEncrypted {
		return "", false
	}
	plain, err := decryptStringValueV1(v.encrypted, key)
	if err != nil {
		return "", false
	}
	return plain, true
}

// truthy mirrors JavaScript truthiness of the stored value. countStoredKeys uses
// it for the wrapped-entry rule (`if (entry.value) count += 1`).
func (v secretValue) truthy() bool {
	switch v.kind {
	case secretAbsent, secretNull:
		return false
	case secretPlain:
		return v.plain != ""
	case secretEncrypted:
		return true
	default:
		return jsonTruthyJSON(v.raw)
	}
}

// parseOpenAiKeyEntry classifies one raw entry of the stored openaiApiKeys
// array into its discriminated union:
//
//	falsy value                       -> unusable
//	JSON string                       -> legacy plaintext
//	system-settings:v1 object         -> legacy encrypted
//	{fingerprint: string, value: ...} -> wrapped (the current write format)
//	anything else                     -> unusable
//
// The wrapped predicate is checked exactly like isStoredOpenAiKeyEntryV1:
// fingerprint must be a string AND the "value" key must be present (a null value
// counts as present).
func parseOpenAiKeyEntry(raw json.RawMessage) openAiKeyEntry {
	trimmed := bytes.TrimSpace(raw)
	if !jsonTruthyJSON(trimmed) {
		return openAiKeyEntry{kind: openAiKeyUnusable}
	}
	if jsonIsString(trimmed) {
		text, ok := jsonString(trimmed)
		if !ok {
			return openAiKeyEntry{kind: openAiKeyUnusable}
		}
		return openAiKeyEntry{kind: openAiKeyLegacyPlain, plain: text}
	}
	if trimmed[0] != '{' {
		return openAiKeyEntry{kind: openAiKeyUnusable}
	}
	if payload, ok := isEncryptedSecretShape(trimmed); ok {
		return openAiKeyEntry{
			kind:      openAiKeyLegacyEncrypted,
			encrypted: secretValue{kind: secretEncrypted, encrypted: payload, raw: trimmed},
		}
	}
	var wrapper struct {
		Fingerprint json.RawMessage `json:"fingerprint"`
		Value       json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(trimmed, &wrapper); err != nil {
		return openAiKeyEntry{kind: openAiKeyUnusable}
	}
	if !jsonIsString(wrapper.Fingerprint) || wrapper.Value == nil {
		// Not a wrapped entry: `{}`, a bare number, an array or an object without
		// the "value" key all fall here.
		return openAiKeyEntry{kind: openAiKeyUnusable}
	}
	fingerprint, _ := jsonString(wrapper.Fingerprint)
	return openAiKeyEntry{
		kind: openAiKeyWrapped,
		wrapped: wrappedOpenAiKey{
			fingerprint: fingerprint,
			value:       secretValueFromRaw(wrapper.Value),
		},
	}
}

// parseOpenAiKeyEntries classifies a whole stored array in source order.
func parseOpenAiKeyEntries(entries []json.RawMessage) []openAiKeyEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]openAiKeyEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, parseOpenAiKeyEntry(entry))
	}
	return out
}
