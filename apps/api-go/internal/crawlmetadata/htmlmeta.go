package crawlmetadata

import (
	"strings"

	"golang.org/x/net/html"
)

// parsedMetadata is the parseMetadata result. Pointer fields stay nil when the
// source would produce undefined.
type parsedMetadata struct {
	Title       *string
	Description *string
	Keywords    *[]string
	Author      *string
	MetaTags    []Tag
	OpenGraph   []Tag
	JSONLd      []string
}

const (
	maxMetadataTags       = 25
	maxKeywords           = 15
	maxJSONLdScripts      = 5
	jsonLdScriptTypeValue = "application/ld+json"
)

// parseMetadata reproduces the Cheerio parseMetadata semantics with one HTML5
// DOM parse and one document-order traversal of the head subtree: the first
// title, every meta tag (name first, then property), the first
// description/keywords/author, and up to five JSON-LD scripts. Collecting
// everything in a single pass keeps the first/continue/truncate semantics while
// avoiding a second parse or a per-field traversal.
func parseMetadata(htmlBody string, config normalizedConfig) parsedMetadata {
	parsed := parsedMetadata{
		MetaTags:  []Tag{},
		OpenGraph: []Tag{},
		JSONLd:    []string{},
	}
	document, err := html.Parse(strings.NewReader(htmlBody))
	if err != nil {
		return parsed
	}
	head := findFirstElement(document, "head")
	if head == nil {
		return parsed
	}

	titleSeen := false
	for _, node := range elementDescendants(head) {
		switch node.Data {
		case "title":
			if titleSeen {
				continue
			}
			titleSeen = true
			if text := jsTrim(nodeText(node)); text != "" {
				parsed.Title = &text
			}
		case "meta":
			parsed.applyMetaElement(node, config)
		case "script":
			if !config.includeJSONLd || len(parsed.JSONLd) >= maxJSONLdScripts {
				continue
			}
			if findAttribute(node, "type") != jsonLdScriptTypeValue {
				continue
			}
			raw := jsTrim(nodeText(node))
			if raw == "" {
				continue
			}
			if compact, ok := stringifyCompactJSON(raw); ok {
				parsed.JSONLd = append(parsed.JSONLd, compact)
			} else {
				// Invalid JSON keeps the trimmed source text, exactly like the
				// source which never drops malformed script bodies.
				parsed.JSONLd = append(parsed.JSONLd, raw)
			}
		}
	}

	parsed.MetaTags = sliceUpTo(parsed.MetaTags, maxMetadataTags)
	parsed.OpenGraph = sliceUpTo(parsed.OpenGraph, maxMetadataTags)
	return parsed
}

// applyMetaElement handles one meta element: name wins over property, an empty
// content is skipped, OpenGraph/Twitter names are diverted while
// includeOpenGraph is on, and description/keywords/author are still extracted
// when includeMeta is off.
func (parsed *parsedMetadata) applyMetaElement(node *html.Node, config normalizedConfig) {
	rawName := findAttribute(node, "name")
	if rawName == "" {
		rawName = findAttribute(node, "property")
	}
	content := jsTrim(findAttribute(node, "content"))
	if rawName == "" || content == "" {
		return
	}
	// A whitespace-only name survives the source check and is only trimmed
	// afterwards, so it can still produce a tag with an empty name.
	name := jsTrim(rawName)

	lowered := strings.ToLower(name)
	if config.includeOpenGraph && (strings.HasPrefix(lowered, "og:") || strings.HasPrefix(lowered, "twitter:")) {
		parsed.OpenGraph = append(parsed.OpenGraph, Tag{Name: name, Value: content})
		return
	}
	if config.includeMeta {
		parsed.MetaTags = append(parsed.MetaTags, Tag{Name: name, Value: content})
	}
	switch lowered {
	case "description":
		if parsed.Description == nil {
			parsed.Description = &content
		}
	case "keywords":
		if parsed.Keywords == nil {
			keywords := []string{}
			for _, keyword := range strings.Split(content, ",") {
				trimmed := jsTrim(keyword)
				if trimmed != "" {
					keywords = append(keywords, trimmed)
				}
				if len(keywords) >= maxKeywords {
					break
				}
			}
			parsed.Keywords = &keywords
		}
	case "author":
		if parsed.Author == nil {
			parsed.Author = &content
		}
	}
}

// findFirstElement returns the first element with the given tag name.
func findFirstElement(node *html.Node, name string) *html.Node {
	if node.Type == html.ElementNode && node.Data == name {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := findFirstElement(child, name); found != nil {
			return found
		}
	}
	return nil
}

// elementDescendants returns every element below node in document order.
func elementDescendants(node *html.Node) []*html.Node {
	out := []*html.Node{}
	stack := []*html.Node{}
	for child := node.LastChild; child != nil; child = child.PrevSibling {
		stack = append(stack, child)
	}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if current.Type == html.ElementNode {
			out = append(out, current)
		}
		for child := current.LastChild; child != nil; child = child.PrevSibling {
			stack = append(stack, child)
		}
	}
	return out
}

// nodeText concatenates the text nodes below node, which is Cheerio's .text().
func nodeText(node *html.Node) string {
	var builder strings.Builder
	var walk func(*html.Node)
	walk = func(current *html.Node) {
		if current.Type == html.TextNode {
			builder.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return builder.String()
}

// findAttribute returns the attribute value ("" when absent). HTML parsing
// lowercases attribute names, as parse5 does.
func findAttribute(node *html.Node, name string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

// jsTrim removes the JavaScript trim() whitespace set, which includes U+FEFF.
func jsTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff':
			return true
		}
		return r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' ||
			r == '\u3000' || r == '\u1680' || r == '\u202f' || r == '\u205f' || r == '\u0085'
	})
}
