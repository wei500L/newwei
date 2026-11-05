package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
)

// JSON request-body read failures. ReadJSON classifies the reason instead of
// writing a response so each package keeps its own 400/413 envelope and message
// wording, which differ across routes (Nest ValidationPipe shapes are not
// uniform).
var (
	// ErrBodyTooLarge reports a body over the caller's limit.
	ErrBodyTooLarge = errors.New("httpx: request body too large")
	// ErrInvalidJSON reports a body that is not valid JSON.
	ErrInvalidJSON = errors.New("httpx: invalid JSON body")
	// ErrUnsupportedMediaType reports a non-JSON request Content-Type.
	ErrUnsupportedMediaType = errors.New("httpx: unsupported media type")
)

// WriteRawJSON writes an already-encoded JSON body with the JSON content type.
// It is for handlers that build the bytes themselves (sql/json.RawMessage
// passthrough, compact JS-compatible encoders) and must keep their exact bytes,
// including the absence of a trailing newline.
func WriteRawJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ReadJSON reads and validates a JSON request body. maxBytes is supplied by the
// caller because the per-route limits differ (for example rbacapi uses 10 MiB).
//
// The returned error is one of ErrBodyTooLarge, ErrInvalidJSON or
// ErrUnsupportedMediaType. Callers are expected to write the response itself so
// the exact status/message contract of each route is preserved.
func ReadJSON(w http.ResponseWriter, r *http.Request, maxBytes int64) ([]byte, error) {
	if r.Body == nil {
		return nil, ErrInvalidJSON
	}
	if !IsJSONContentType(r.Header.Get("Content-Type")) {
		return nil, ErrUnsupportedMediaType
	}
	reader := http.MaxBytesReader(w, r.Body, maxBytes)
	data, err := io.ReadAll(reader)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return nil, ErrBodyTooLarge
		}
		return nil, ErrInvalidJSON
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, ErrInvalidJSON
	}
	if !json.Valid(data) {
		return nil, ErrInvalidJSON
	}
	return data, nil
}

// IsJSONContentType reports whether value's media type is JSON. It accepts the
// application/json and +json families (for example application/ld+json) and
// ignores parameters such as charset, matching the per-package jsonContent
// helpers it replaces.
func IsJSONContentType(value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(value)
	if err != nil {
		return false
	}
	mediaType = strings.ToLower(mediaType)
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}
