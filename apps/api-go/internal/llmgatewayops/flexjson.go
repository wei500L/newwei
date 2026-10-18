package llmgatewayops

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// This file implements the small ordered JSON value used for the two expandable
// leaves of proxy-model-info (litellm_params and model_info). The leaves are
// arbitrary upstream JSON, so they cannot be a fixed struct; they must still be
// sanitized recursively (drop api_key/apiKey/Authorization/authorization and
// redact Bearer/sk- inside strings) while keeping the upstream key order, which a
// Go map would lose.

// flexKind discriminates the JSON value.
type flexKind int

const (
	// flexNull is the JSON literal null.
	flexNull flexKind = iota
	// flexBool is true/false.
	flexBool
	// flexNumber keeps the numeric token exactly as received.
	flexNumber
	// flexString is a JSON string.
	flexString
	// flexArray is an ordered JSON array.
	flexArray
	// flexObject is an ordered JSON object.
	flexObject
)

// flexMember is one ordered object member.
type flexMember struct {
	Key   string
	Value flexValue
}

// flexValue is one ordered JSON value.
type flexValue struct {
	kind    flexKind
	boolean bool
	number  json.Number
	text    string
	array   []flexValue
	object  []flexMember
}

// errFlexDecode reports a token stream that does not form one JSON value.
var errFlexDecode = errors.New("llmgatewayops: invalid json value")

// parseFlexValue decodes exactly one JSON value preserving member order.
func parseFlexValue(raw []byte) (flexValue, error) {
	decoder := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(raw)))
	decoder.UseNumber()
	value, err := decodeFlexValue(decoder)
	if err != nil {
		return flexValue{}, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return flexValue{}, errFlexDecode
	}
	return value, nil
}

// decodeFlexValue reads one value from the decoder.
func decodeFlexValue(decoder *json.Decoder) (flexValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return flexValue{}, errFlexDecode
	}
	switch typed := token.(type) {
	case json.Delim:
		switch typed {
		case '[':
			items := make([]flexValue, 0, 4)
			for decoder.More() {
				item, err := decodeFlexValue(decoder)
				if err != nil {
					return flexValue{}, err
				}
				items = append(items, item)
			}
			if _, err := decoder.Token(); err != nil {
				return flexValue{}, errFlexDecode
			}
			return flexValue{kind: flexArray, array: items}, nil
		case '{':
			members := make([]flexMember, 0, 8)
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return flexValue{}, errFlexDecode
				}
				key, ok := keyToken.(string)
				if !ok {
					return flexValue{}, errFlexDecode
				}
				value, err := decodeFlexValue(decoder)
				if err != nil {
					return flexValue{}, err
				}
				members = append(members, flexMember{Key: key, Value: value})
			}
			if _, err := decoder.Token(); err != nil {
				return flexValue{}, errFlexDecode
			}
			return flexValue{kind: flexObject, object: members}, nil
		default:
			return flexValue{}, errFlexDecode
		}
	case string:
		return flexValue{kind: flexString, text: typed}, nil
	case json.Number:
		return flexValue{kind: flexNumber, number: typed}, nil
	case bool:
		return flexValue{kind: flexBool, boolean: typed}, nil
	case nil:
		return flexValue{kind: flexNull}, nil
	default:
		return flexValue{}, errFlexDecode
	}
}

// MarshalJSON renders the value with its original member order.
func (v flexValue) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case flexNull:
		return []byte("null"), nil
	case flexBool:
		if v.boolean {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case flexNumber:
		if v.number == "" {
			return []byte("0"), nil
		}
		return []byte(v.number), nil
	case flexString:
		return json.Marshal(v.text)
	case flexArray:
		builder := bytes.Buffer{}
		builder.WriteByte('[')
		for index, item := range v.array {
			if index > 0 {
				builder.WriteByte(',')
			}
			encoded, err := item.MarshalJSON()
			if err != nil {
				return nil, err
			}
			builder.Write(encoded)
		}
		builder.WriteByte(']')
		return builder.Bytes(), nil
	default:
		builder := bytes.Buffer{}
		builder.WriteByte('{')
		for index, member := range v.object {
			if index > 0 {
				builder.WriteByte(',')
			}
			key, err := json.Marshal(member.Key)
			if err != nil {
				return nil, err
			}
			builder.Write(key)
			builder.WriteByte(':')
			encoded, err := member.Value.MarshalJSON()
			if err != nil {
				return nil, err
			}
			builder.Write(encoded)
		}
		builder.WriteByte('}')
		return builder.Bytes(), nil
	}
}

// sanitizedModelInfoValue drops the credential members and redacts secret
// substrings, recursively. It mirrors sanitizeProxyModelInfoValue.
func sanitizedModelInfoValue(value flexValue) flexValue {
	switch value.kind {
	case flexString:
		return flexValue{kind: flexString, text: redactSensitiveText(value.text)}
	case flexArray:
		items := make([]flexValue, 0, len(value.array))
		for _, item := range value.array {
			items = append(items, sanitizedModelInfoValue(item))
		}
		return flexValue{kind: flexArray, array: items}
	case flexObject:
		members := make([]flexMember, 0, len(value.object))
		for _, member := range value.object {
			if isCredentialMember(member.Key) {
				continue
			}
			members = append(members, flexMember{Key: member.Key, Value: sanitizedModelInfoValue(member.Value)})
		}
		return flexValue{kind: flexObject, object: members}
	default:
		return value
	}
}

// isCredentialMember reports the four member names the source strips.
func isCredentialMember(key string) bool {
	switch key {
	case "api_key", "apiKey", "Authorization", "authorization":
		return true
	default:
		return false
	}
}

// flexStringMember reads one string member of an object value.
func flexStringMember(value flexValue, key string) (string, bool) {
	if value.kind != flexObject {
		return "", false
	}
	for _, member := range value.object {
		if member.Key != key {
			continue
		}
		if member.Value.kind != flexString {
			return "", false
		}
		return member.Value.text, true
	}
	return "", false
}

// flexMemberOf returns one member value.
func flexMemberOf(value flexValue, key string) (flexValue, bool) {
	if value.kind != flexObject {
		return flexValue{}, false
	}
	for _, member := range value.object {
		if member.Key == key {
			return member.Value, true
		}
	}
	return flexValue{}, false
}

// trimEndNonEmpty mirrors normalizeNonEmptyString: trailing whitespace is
// dropped and an empty result becomes absent.
func trimEndNonEmpty(value string) *string {
	trimmed := strings.TrimRight(value, " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
