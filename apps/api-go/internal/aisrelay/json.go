package aisrelay

import (
	"bytes"
	"encoding/json"
)

// JSON rendering shared by the HTTP surface, the snapshot cache and the upstream
// subscribe message. The bytes are part of the contract: consumers poll the snapshot
// continuously and will diff the two implementations while both are deployed.

// encodeJSJSON serialises value the way JSON.stringify renders the relay payloads.
//
// encoding/json escapes <, > and & as \\u003c, \\u003e and \\u0026 by default, which
// JSON.stringify leaves untouched, so a vessel named "A&B" would otherwise differ
// between the two relays. It also always escapes the Unicode line separators U+2028 and
// U+2029, which JSON.stringify emits raw; unescapeLineSeparators undoes exactly those.
func encodeJSJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	// Encode appends a newline, which Node's JSON.stringify does not produce.
	return unescapeLineSeparators(bytes.TrimRight(buffer.Bytes(), "\n")), nil
}

// unescapeLineSeparators replaces the escaped U+2028/U+2029 sequences that
// encoding/json always produces with the raw UTF-8 bytes that JSON.stringify emits.
//
// A backslash that is itself escaped (odd number of preceding backslashes) is left
// alone, so a payload that literally contains the text "\\u2028" still round-trips.
func unescapeLineSeparators(encoded []byte) []byte {
	if !bytes.Contains(encoded, []byte(`\u202`)) {
		return encoded
	}
	unescaped := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); index++ {
		if encoded[index] == '\\' && index+5 < len(encoded) {
			escape := string(encoded[index+1 : index+6])
			if escape == "u2028" || escape == "u2029" {
				backslashes := 0
				for cursor := len(unescaped) - 1; cursor >= 0 && unescaped[cursor] == '\\'; cursor-- {
					backslashes++
				}
				if backslashes%2 == 0 {
					if escape == "u2028" {
						unescaped = append(unescaped, "\u2028"...)
					} else {
						unescaped = append(unescaped, "\u2029"...)
					}
					index += 5
					continue
				}
			}
		}
		unescaped = append(unescaped, encoded[index])
	}
	return unescaped
}

// marshalSnapshot renders a snapshot for the response cache. A failure is impossible
// for the relay's own payload types, so a nil result only means the caller has to
// rebuild the body, never that the response should be an error.
func marshalSnapshot(snapshot *Snapshot) []byte {
	encoded, err := encodeJSJSON(snapshot)
	if err != nil {
		return nil
	}
	return encoded
}
