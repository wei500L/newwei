package newsbehavior

import (
	"bytes"
	"encoding/json"
)

func marshalJS(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func jsQuote(value string) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	// JSON.stringify 会把 U+2028 / U+2029 写成转义，encoding/json 不会。
	quoted := bytes.TrimRight(buf.Bytes(), "\n")
	quoted = bytes.ReplaceAll(quoted, []byte("\u2028"), []byte(`\u2028`))
	quoted = bytes.ReplaceAll(quoted, []byte("\u2029"), []byte(`\u2029`))
	return quoted, nil
}
