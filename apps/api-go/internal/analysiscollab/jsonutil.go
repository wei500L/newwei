package analysiscollab

import (
	"bytes"
	"encoding/json"
	"errors"
)

var errNotObject = errors.New("not a json object")

func bytesTrim(raw []byte) []byte {
	return bytes.TrimSpace(raw)
}

func jsonUnmarshal(raw []byte, dest any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return dec.Decode(dest)
}
