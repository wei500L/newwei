package newsnowsources

import (
	"bytes"
	"fmt"
	"strings"

	"golang.org/x/net/html"
)

// This file implements the small HTML traversal layer the migrated providers
// need. It replaces cheerio with a typed node walker and a compact selector
// subset: tag, .class, #id, [attr], [attr=value], [attr$=value], [attr^=value],
// [attr*=value], :first-child and :nth-child(n), combined with descendant and
// child (`>`) combinators. The reachable providers use exactly these forms.

// parseHTML parses one document.
func parseHTML(body []byte) (*html.Node, error) {
	root, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	return root, nil
}

// parseHTMLFragment parses an HTML fragment inside a div context.
func parseHTMLFragment(fragment string) (*html.Node, error) {
	context := &html.Node{Type: html.ElementNode, Data: "div"}
	nodes, err := html.ParseFragment(strings.NewReader(fragment), context)
	if err != nil {
		return nil, err
	}
	wrapper := &html.Node{Type: html.ElementNode, Data: "div"}
	for _, node := range nodes {
		wrapper.AppendChild(node)
	}
	return wrapper, nil
}

// attrCond is one attribute predicate.
type attrCond struct {
	name  string
	op    byte // 0 = presence, '=', '$', '^', '*'
	value string
}

// selectorPart matches one element.
type selectorPart struct {
	tag     string
	id      string
	classes []string
	attrs   []attrCond
	nth     int // 1-based :nth-child, 0 = unused
	first   bool
}

// selectorStep adds the combinator relative to the previous match.
type selectorStep struct {
	part  selectorPart
	child bool
}

// selectAll returns matching elements in document order.
func selectAll(root *html.Node, selector string) []*html.Node {
	steps, err := parseSelector(selector)
	if err != nil || len(steps) == 0 {
		return nil
	}
	current := []*html.Node{root}
	for index, step := range steps {
		next := make([]*html.Node, 0)
		for _, base := range current {
			if step.child {
				for child := base.FirstChild; child != nil; child = child.NextSibling {
					if child.Type == html.ElementNode && matchesPart(child, step.part) {
						next = append(next, child)
					}
				}
				continue
			}
			if index == 0 {
				walkDescendants(base, func(node *html.Node) {
					if matchesPart(node, step.part) {
						next = append(next, node)
					}
				})
				continue
			}
			// A descendant step after a matched set: walk each subtree.
			walkDescendants(base, func(node *html.Node) {
				if matchesPart(node, step.part) {
					next = append(next, node)
				}
			})
		}
		current = next
		if len(current) == 0 {
			return nil
		}
	}
	return current
}

// selectFirst returns the first match.
func selectFirst(root *html.Node, selector string) *html.Node {
	nodes := selectAll(root, selector)
	if len(nodes) == 0 {
		return nil
	}
	return nodes[0]
}

// walkDescendants visits element descendants in pre-order.
func walkDescendants(root *html.Node, visit func(*html.Node)) {
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.ElementNode {
			visit(child)
		}
		walkDescendants(child, visit)
	}
}

// matchesPart checks id/class/tag/attribute/pseudo constraints.
func matchesPart(node *html.Node, part selectorPart) bool {
	if node.Type != html.ElementNode {
		return false
	}
	if part.tag != "" && !strings.EqualFold(node.Data, part.tag) {
		return false
	}
	if part.id != "" && attrValue(node, "id") != part.id {
		return false
	}
	if len(part.classes) > 0 {
		classes := strings.Fields(attrValue(node, "class"))
		set := make(map[string]struct{}, len(classes))
		for _, class := range classes {
			set[class] = struct{}{}
		}
		for _, required := range part.classes {
			if _, ok := set[required]; !ok {
				return false
			}
		}
	}
	for _, cond := range part.attrs {
		actual := attrValue(node, cond.name)
		if cond.op == 0 {
			if actual == "" && !hasAttr(node, cond.name) {
				return false
			}
			continue
		}
		switch cond.op {
		case '=':
			if actual != cond.value {
				return false
			}
		case '$':
			if !strings.HasSuffix(actual, cond.value) {
				return false
			}
		case '^':
			if !strings.HasPrefix(actual, cond.value) {
				return false
			}
		case '*':
			if !strings.Contains(actual, cond.value) {
				return false
			}
		}
	}
	if part.first || part.nth > 0 {
		index := elementIndex(node)
		if part.first && index != 1 {
			return false
		}
		if part.nth > 0 && index != part.nth {
			return false
		}
	}
	return true
}

// elementIndex returns the 1-based position among element siblings.
func elementIndex(node *html.Node) int {
	index := 0
	for sibling := node.Parent.FirstChild; sibling != nil; sibling = sibling.NextSibling {
		if sibling.Type == html.ElementNode {
			index++
			if sibling == node {
				return index
			}
		}
	}
	return 0
}

// attrValue returns an attribute value or "".
func attrValue(node *html.Node, name string) string {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, name) {
			return attr.Val
		}
	}
	return ""
}

// hasAttr reports whether an attribute exists, including an empty value.
func hasAttr(node *html.Node, name string) bool {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, name) {
			return true
		}
	}
	return false
}

// nodeText mirrors cheerio .text(): the concatenation of all descendant text
// nodes, without trimming.
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

// trimText is nodeText followed by strings.TrimSpace (cheerio .text().trim()).
func trimText(node *html.Node) string { return strings.TrimSpace(nodeText(node)) }

// parseSelector tokenises the supported selector subset.
func parseSelector(selector string) ([]selectorStep, error) {
	steps := make([]selectorStep, 0, 4)
	index := 0
	child := false
	for index < len(selector) {
		switch selector[index] {
		case ' ', '\t', '\n', '\r':
			index++
			continue
		case '>':
			child = true
			index++
			continue
		}
		start := index
		depth := 0
		for index < len(selector) {
			ch := selector[index]
			if ch == '[' {
				depth++
			} else if ch == ']' && depth > 0 {
				depth--
			} else if depth == 0 && (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '>') {
				break
			}
			index++
		}
		part, err := parseSelectorPart(selector[start:index])
		if err != nil {
			return nil, err
		}
		steps = append(steps, selectorStep{part: part, child: child})
		child = false
	}
	return steps, nil
}

// parseSelectorPart parses one compound selector.
func parseSelectorPart(token string) (selectorPart, error) {
	part := selectorPart{}
	index := 0
	if index < len(token) && token[index] == '*' {
		index++
	}
	start := index
	for index < len(token) {
		ch := token[index]
		if ch == '.' || ch == '#' || ch == '[' || ch == ':' {
			break
		}
		index++
	}
	part.tag = token[start:index]

	for index < len(token) {
		switch token[index] {
		case '.':
			index++
			start = index
			for index < len(token) && !isSelectorDelimiter(token[index]) {
				index++
			}
			if start == index {
				return part, fmt.Errorf("newsnowsources: empty class in selector %q", token)
			}
			part.classes = append(part.classes, token[start:index])
		case '#':
			index++
			start = index
			for index < len(token) && !isSelectorDelimiter(token[index]) {
				index++
			}
			part.id = token[start:index]
		case '[':
			end := strings.IndexByte(token[index:], ']')
			if end < 0 {
				return part, fmt.Errorf("newsnowsources: unterminated attribute selector %q", token)
			}
			cond, err := parseAttrCond(token[index+1 : index+end])
			if err != nil {
				return part, err
			}
			part.attrs = append(part.attrs, cond)
			index += end + 1
		case ':':
			index++
			start = index
			for index < len(token) && token[index] != ':' {
				if token[index] == '(' {
					depth := 1
					index++
					for index < len(token) && depth > 0 {
						if token[index] == '(' {
							depth++
						} else if token[index] == ')' {
							depth--
						}
						index++
					}
					continue
				}
				index++
			}
			pseudo := token[start:index]
			switch {
			case pseudo == "first-child":
				part.first = true
			case strings.HasPrefix(pseudo, "nth-child(") && strings.HasSuffix(pseudo, ")"):
				var nth int
				if _, err := fmt.Sscanf(pseudo[len("nth-child("):len(pseudo)-1], "%d", &nth); err != nil || nth <= 0 {
					return part, fmt.Errorf("newsnowsources: unsupported pseudo %q", pseudo)
				}
				part.nth = nth
			default:
				return part, fmt.Errorf("newsnowsources: unsupported pseudo %q", pseudo)
			}
		default:
			return part, fmt.Errorf("newsnowsources: unexpected selector character %q", token[index])
		}
	}
	return part, nil
}

// isSelectorDelimiter reports the characters ending a class/id token.
func isSelectorDelimiter(ch byte) bool {
	switch ch {
	case '.', '#', '[', ':', '(', ')':
		return true
	default:
		return false
	}
}

// parseAttrCond parses one [attr op value] expression.
func parseAttrCond(raw string) (attrCond, error) {
	for index := 0; index < len(raw); index++ {
		switch raw[index] {
		case '$', '^', '*':
			if index+1 < len(raw) && raw[index+1] == '=' {
				return attrCond{name: raw[:index], op: raw[index], value: unquoteAttr(raw[index+2:])}, nil
			}
		case '=':
			return attrCond{name: raw[:index], op: '=', value: unquoteAttr(raw[index+1:])}, nil
		}
	}
	name := strings.TrimSpace(raw)
	if name == "" {
		return attrCond{}, fmt.Errorf("newsnowsources: empty attribute selector")
	}
	return attrCond{name: name}, nil
}

// unquoteAttr strips optional quotes around an attribute value.
func unquoteAttr(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 {
		if (trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') ||
			(trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'') {
			return trimmed[1 : len(trimmed)-1]
		}
	}
	return trimmed
}
