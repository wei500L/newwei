package crawloptions

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// This file ports crawl-config-policy.ts and crawl4ai-llm.guard.ts. Both walk
// the schema-less crawl options document, so they decode JSON into an ordered
// tree: JavaScript Object.entries order decides which five paths a rejection
// message lists, and a Go map would randomise it.

// ConfigIssue is one rejected path, matching CrawlConfigPolicyIssue.
type ConfigIssue struct {
	Path    string
	Message string
}

// PolicyError is the NestJS BadRequestException payload produced by a policy
// check. The REST and GraphQL layers map it to 400.
type PolicyError struct {
	Message string
}

// Error implements error.
func (e *PolicyError) Error() string { return e.Message }

// FindUnsupportedProxyIssues is findUnsupportedProxyIssues.
func FindUnsupportedProxyIssues(value json.RawMessage, path string) []ConfigIssue {
	node, ok := parseOrderedJSON(value)
	if !ok || node.kind != kindObject {
		return nil
	}
	issues := make([]ConfigIssue, 0, 2)
	if _, found := node.member("proxyUrl"); found {
		issues = append(issues, ConfigIssue{
			Path:    path + ".proxyUrl",
			Message: "custom upstream proxies are not supported",
		})
	}
	if _, found := node.member("proxyConfig"); found {
		issues = append(issues, ConfigIssue{
			Path:    path + ".proxyConfig",
			Message: "custom upstream proxies are not supported",
		})
	}
	return issues
}

// AssertNoUnsupportedProxy is assertNoUnsupportedProxy.
func AssertNoUnsupportedProxy(value json.RawMessage, path string) error {
	issues := FindUnsupportedProxyIssues(value, path)
	if len(issues) == 0 {
		return nil
	}
	parts := make([]string, 0, len(issues))
	for _, issue := range issues {
		parts = append(parts, issue.Path+": "+issue.Message)
	}
	return &PolicyError{Message: "Unsupported crawl config: " + strings.Join(parts, "; ")}
}

// disallowedNormalizedKeys is DISALLOWED_NORMALIZED_KEYS.
var disallowedNormalizedKeys = map[string]bool{
	"extractionstrategy": true,
	"llmconfig":          true,
}

// AssertNoCrawl4aiLlmOptions is assertNoCrawl4aiLlmOptions.
func AssertNoCrawl4aiLlmOptions(value json.RawMessage, label string) error {
	if label == "" {
		label = "crawlOptions"
	}
	node, ok := parseOrderedJSON(value)
	if !ok {
		return nil
	}
	blocked := findDisallowedKeys(node, "")
	if len(blocked) == 0 {
		return nil
	}
	listed := blocked
	if len(listed) > 5 {
		listed = listed[:5]
	}
	suffix := ""
	if len(blocked) > 5 {
		suffix = fmt.Sprintf(" (+%d more)", len(blocked)-5)
	}
	return &PolicyError{Message: fmt.Sprintf(
		"%s contains crawl4ai LLM extraction settings (%s%s). "+
			"The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead.",
		label, strings.Join(listed, ", "), suffix)}
}

// findDisallowedKeys walks the tree depth-first in JavaScript property order.
func findDisallowedKeys(node *jsonNode, prefix string) []string {
	if node == nil {
		return nil
	}
	switch node.kind {
	case kindArray:
		hits := make([]string, 0)
		for index, entry := range node.array {
			hits = append(hits, findDisallowedKeys(entry, fmt.Sprintf("%s[%d]", prefix, index))...)
		}
		return hits
	case kindObject:
		hits := make([]string, 0)
		for _, member := range node.object {
			normalized := normalizePolicyKey(member.key)
			path := member.key
			if prefix != "" {
				path = prefix + "." + member.key
			}
			if disallowedNormalizedKeys[normalized] {
				hits = append(hits, path)
			}
			if normalized == "type" && member.value.kind == kindString &&
				isDisallowedStrategyType(path, member.value.text) {
				hits = append(hits, path)
			}
			hits = append(hits, findDisallowedKeys(member.value, path)...)
		}
		return hits
	default:
		return nil
	}
}

func normalizePolicyKey(key string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(key) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func isDisallowedStrategyType(path, value string) bool {
	normalizedPath := normalizePolicyKey(path)
	normalizedValue := normalizePolicyKey(value)
	if !strings.Contains(normalizedValue, "llm") {
		return false
	}
	return strings.Contains(normalizedPath, "strategy") || strings.Contains(normalizedPath, "extraction")
}

// ---------------------------------------------------------------------------
// ordered JSON tree
// ---------------------------------------------------------------------------

type jsonKind byte

const (
	kindNull jsonKind = iota
	kindBool
	kindNumber
	kindString
	kindArray
	kindObject
)

type jsonMember struct {
	key   string
	value *jsonNode
}

type jsonNode struct {
	kind   jsonKind
	text   string
	bool   bool
	number float64
	array  []*jsonNode
	object []jsonMember
}

func (n *jsonNode) member(key string) (*jsonNode, bool) {
	for _, member := range n.object {
		if member.key == key {
			return member.value, true
		}
	}
	return nil, false
}

// parseOrderedJSON decodes one JSON document preserving object key order.
func parseOrderedJSON(raw json.RawMessage) (*jsonNode, bool) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	node, err := decodeNode(decoder)
	if err != nil {
		return nil, false
	}
	// Reject trailing content the way JSON.parse does.
	if _, err := decoder.Token(); err != io.EOF {
		return nil, false
	}
	return node, true
}

func decodeNode(decoder *json.Decoder) (*jsonNode, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case nil:
		return &jsonNode{kind: kindNull}, nil
	case bool:
		return &jsonNode{kind: kindBool, bool: typed}, nil
	case string:
		return &jsonNode{kind: kindString, text: typed}, nil
	case json.Number:
		value, err := typed.Float64()
		if err != nil {
			return nil, err
		}
		return &jsonNode{kind: kindNumber, number: value}, nil
	case json.Delim:
		switch typed {
		case '[':
			node := &jsonNode{kind: kindArray}
			for decoder.More() {
				entry, err := decodeNode(decoder)
				if err != nil {
					return nil, err
				}
				node.array = append(node.array, entry)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return node, nil
		case '{':
			node := &jsonNode{kind: kindObject}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("crawloptions: object key is not a string")
				}
				value, err := decodeNode(decoder)
				if err != nil {
					return nil, err
				}
				node.object = append(node.object, jsonMember{key: key, value: value})
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return node, nil
		}
	}
	return nil, fmt.Errorf("crawloptions: unexpected JSON token")
}
