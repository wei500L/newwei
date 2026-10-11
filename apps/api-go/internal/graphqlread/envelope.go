package graphqlread

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
)

const maxBodyBytes int64 = 10 << 20

type graphRequest struct {
	Query         string
	QueryPresent  bool
	OperationName *string
	Variables     map[string]any
	Persisted     *persistedQuery
}

type persistedQuery struct {
	Version   float64
	Hash      string
	VersionOK bool
}

func readLimitedBody(r *http.Request) ([]byte, bool, error) {
	if r.Body == nil {
		return nil, false, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(body)) > maxBodyBytes {
		return body, true, nil
	}
	return body, false, nil
}

func restoreBody(r *http.Request, body []byte) {
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(body)), nil
	}
}

func isUpgrade(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("Upgrade")) != ""
}

func isMultipart(r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && strings.HasPrefix(mediaType, "multipart/")
}

func isJSONArray(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	return len(trimmed) > 0 && trimmed[0] == '['
}

func contentType(accept string) string {
	lower := strings.ToLower(accept)
	if strings.Contains(lower, "application/graphql-response+json") && !strings.Contains(lower, "application/graphql-response+json;q=0") {
		return "application/graphql-response+json"
	}
	return "application/json"
}

// csrfBlocked matches Apollo Server 4 preventCsrf. application/json is allowed.
// GET requests must send apollo-require-preflight or x-apollo-operation-name.
func csrfBlocked(r *http.Request) bool {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err == nil {
		switch mediaType {
		case "application/x-www-form-urlencoded", "multipart/form-data", "text/plain":
		default:
			return false
		}
	}
	for _, header := range []string{"x-apollo-operation-name", "apollo-require-preflight"} {
		if strings.TrimSpace(r.Header.Get(header)) != "" {
			return false
		}
	}
	return true
}

func parseGraphRequest(r *http.Request, body []byte) (graphRequest, error) {
	if r.Method == http.MethodGet {
		return parseURLParams(r)
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err == nil && mediaType == "application/graphql" {
		req, err := parseURLParams(r)
		if err != nil {
			return graphRequest{}, err
		}
		req.Query = string(body)
		req.QueryPresent = true
		return req, nil
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return parseURLParams(r)
	}
	base, err := parseURLParams(r)
	if err != nil {
		return graphRequest{}, err
	}
	return parseJSONBody(body, base)
}

func parseURLParams(r *http.Request) (graphRequest, error) {
	var req graphRequest
	values := r.URL.Query()
	if _, ok := values["query"]; ok {
		req.Query = values.Get("query")
		req.QueryPresent = true
	}
	if _, ok := values["operationName"]; ok {
		name := values.Get("operationName")
		req.OperationName = &name
	}
	if raw := values.Get("variables"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &req.Variables); err != nil {
			return graphRequest{}, err
		}
	}
	if raw := values.Get("extensions"); raw != "" {
		var extensions map[string]any
		if err := json.Unmarshal([]byte(raw), &extensions); err != nil {
			return graphRequest{}, err
		}
		req.Persisted = persistedFromExtensions(extensions)
	}
	return req, nil
}

func parseJSONBody(body []byte, base graphRequest) (graphRequest, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return graphRequest{}, err
	}
	if raw, ok := payload["query"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var query string
		if err := json.Unmarshal(raw, &query); err != nil {
			return graphRequest{}, err
		}
		base.Query = query
		base.QueryPresent = true
	}
	if raw, ok := payload["operationName"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var name string
		if err := json.Unmarshal(raw, &name); err != nil {
			return graphRequest{}, err
		}
		base.OperationName = &name
	}
	if raw, ok := payload["variables"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var variables map[string]any
		if err := decoder.Decode(&variables); err != nil {
			return graphRequest{}, err
		}
		base.Variables = variables
	}
	if raw, ok := payload["extensions"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var extensions map[string]any
		if err := json.Unmarshal(raw, &extensions); err != nil {
			return graphRequest{}, err
		}
		base.Persisted = persistedFromExtensions(extensions)
	}
	return base, nil
}

func persistedFromExtensions(extensions map[string]any) *persistedQuery {
	if extensions == nil {
		return nil
	}
	raw, ok := extensions["persistedQuery"].(map[string]any)
	if !ok || raw == nil {
		return nil
	}
	query := &persistedQuery{}
	switch version := raw["version"].(type) {
	case float64:
		query.Version = version
		query.VersionOK = version == 1
	case json.Number:
		parsed, err := version.Float64()
		query.Version = parsed
		query.VersionOK = err == nil && parsed == 1
	}
	if hash, ok := raw["sha256Hash"].(string); ok {
		query.Hash = hash
	}
	return query
}

func clientIP(r *http.Request, trustProxy string) string {
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	host = strings.TrimPrefix(host, "::ffff:")
	trust := strings.TrimSpace(trustProxy)
	if trust == "" {
		if host == "" {
			return "anonymous"
		}
		return host
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded == "" {
		if host == "" {
			return "anonymous"
		}
		return host
	}
	parts := strings.Split(forwarded, ",")
	hops := 1
	if parsed, err := strconvAtoi(trust); err == nil && parsed > 0 {
		hops = parsed
	}
	index := len(parts) - hops
	if index < 0 {
		index = 0
	}
	ip := strings.TrimSpace(parts[index])
	ip = strings.TrimPrefix(ip, "::ffff:")
	if ip == "" {
		return "anonymous"
	}
	return ip
}

func strconvAtoi(value string) (int, error) {
	n := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, io.ErrUnexpectedEOF
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}
