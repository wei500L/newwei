package newsnowsources

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"strings"
)

// rssItem is the subset of an RSS/Atom entry rss2json exposes to providers.
type rssItem struct {
	Title       string
	Description string
	Link        string
	Created     string
}

// rssDocument is the parsed feed.
type rssDocument struct {
	Title       string
	Description string
	Link        string
	Image       string
	UpdatedTime string
	Items       []rssItem
}

// xmlElement is a generic XML node. It is a JSON/XML boundary helper; business
// items are mapped out of it into named structs immediately.
type xmlElement struct {
	Name     string
	Attrs    map[string]string
	Children []*xmlElement
	text     strings.Builder
}

// textValue returns the concatenated character data of the element.
func (e *xmlElement) textValue() string {
	if e == nil {
		return ""
	}
	return e.text.String()
}

// child returns the first child with the given local name.
func (e *xmlElement) child(name string) *xmlElement {
	if e == nil {
		return nil
	}
	for _, child := range e.Children {
		if child.Name == name {
			return child
		}
	}
	return nil
}

// childrenNamed returns all children with the given local name.
func (e *xmlElement) childrenNamed(name string) []*xmlElement {
	if e == nil {
		return nil
	}
	out := make([]*xmlElement, 0)
	for _, child := range e.Children {
		if child.Name == name {
			out = append(out, child)
		}
	}
	return out
}

// attr returns one attribute value.
func (e *xmlElement) attr(name string) (string, bool) {
	if e == nil {
		return "", false
	}
	value, ok := e.Attrs[name]
	return value, ok
}

// parseXMLTree decodes a document into the generic tree.
func parseXMLTree(body []byte) (*xmlElement, error) {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var root *xmlElement
	stack := make([]*xmlElement, 0, 8)
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			element := &xmlElement{Name: value.Name.Local, Attrs: make(map[string]string, len(value.Attr))}
			for _, attr := range value.Attr {
				element.Attrs[attr.Name.Local] = attr.Value
			}
			if len(stack) == 0 {
				if root == nil {
					root = element
				}
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, element)
			}
			stack = append(stack, element)
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].text.Write([]byte(value))
			}
		}
	}
	if root == nil {
		return nil, errors.New("newsnowsources: empty xml document")
	}
	return root, nil
}

// rssURLPattern mirrors /^https?:\/\/[^\s$.?#].\S*/i.
var rssURLPattern = regexp.MustCompile(`(?i)^https?://[^\s$.?#]\S*`)

// fetchRSS mirrors rss2json: fetch, parse RSS 2.0 or Atom, and flatten the
// channel/feed fields the providers consume.
func fetchRSS(ctx context.Context, client *fetchClient, url string) (*rssDocument, error) {
	if !rssURLPattern.MatchString(url) {
		return nil, nil
	}
	body, err := client.get(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	root, err := parseXMLTree(body)
	if err != nil {
		return nil, err
	}

	channel := root.child("channel")
	if channel == nil {
		if root.Name == "feed" {
			channel = root
		} else {
			channel = root.child("rss").child("channel")
		}
	}
	if channel == nil {
		return nil, errors.New("newsnowsources: rss channel not found")
	}

	document := &rssDocument{
		Title:       channel.child("title").textValue(),
		Description: channel.child("description").textValue(),
		Link:        linkValue(channel.child("link")),
		Image:       feedImage(channel),
	}
	if updated := channel.child("lastBuildDate"); updated != nil {
		document.UpdatedTime = updated.textValue()
	} else if updated := channel.child("updated"); updated != nil {
		document.UpdatedTime = updated.textValue()
	}

	entries := channel.childrenNamed("item")
	if len(entries) == 0 {
		entries = channel.childrenNamed("entry")
	}
	for _, entry := range entries {
		document.Items = append(document.Items, rssItem{
			Title:       entry.child("title").textValue(),
			Description: firstPresentText(entry.child("summary"), entry.child("description")),
			Link:        linkValue(entry.child("link")),
			Created:     firstPresentText(entry.child("updated"), entry.child("pubDate"), entry.child("created")),
		})
	}
	return document, nil
}

// firstPresentText returns the first non-nil element's text, mirroring `a ?? b`.
func firstPresentText(elements ...*xmlElement) string {
	for _, element := range elements {
		if element != nil {
			return element.textValue()
		}
	}
	return ""
}

// linkValue handles both `<link>url</link>` and Atom `<link href="..."/>`.
func linkValue(element *xmlElement) string {
	if element == nil {
		return ""
	}
	if href, ok := element.attr("href"); ok {
		return href
	}
	return element.textValue()
}

// feedImage mirrors the rss2json image resolution. Namespace prefixes are
// stripped by encoding/xml, so an `<itunes:image href>` and an RSS
// `<image><url>` both surface as "image"; the href form is the iTunes one.
func feedImage(channel *xmlElement) string {
	image := channel.child("image")
	if image == nil {
		return ""
	}
	if href, ok := image.attr("href"); ok {
		return href
	}
	return image.child("url").textValue()
}
