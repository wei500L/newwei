package crawlmetadata

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"strings"
)

// This file ports discoverRssUrls/discoverRssCandidates and the RSS/Atom payload
// extraction of apps/api/src/modules/crawl/crawl-metadata.service.ts:337-429 and
// :2645-3022.
//
// The NestJS parser is fast-xml-parser with ignoreAttributes:false,
// attributeNamePrefix:"", allowBooleanAttributes:true and trimValues:true. Go's
// encoding/xml resolves namespace prefixes to URLs, which would erase the
// `content:encoded` / `dc:creator` / `dc:date` keys the source reads by literal
// name, so this parser uses RawToken (prefixes stay as written) and keeps a
// small element tree with the same text/attribute accessors. The behaviour that
// matters for discovery is identical: element text wins over the href/url
// attribute, CDATA is text, and a repeated element keeps document order.

// XML tree -----------------------------------------------------------------

type xmlNode struct {
	name     string
	attrs    map[string]string
	children []*xmlNode
	text     strings.Builder
}

func (n *xmlNode) child(name string) *xmlNode {
	for _, entry := range n.children {
		if entry.name == name {
			return entry
		}
	}
	return nil
}

func (n *xmlNode) childrenNamed(name string) []*xmlNode {
	out := []*xmlNode{}
	for _, entry := range n.children {
		if entry.name == name {
			out = append(out, entry)
		}
	}
	return out
}

func (n *xmlNode) attribute(name string) string {
	if n.attrs == nil {
		return ""
	}
	return n.attrs[name]
}

func (n *xmlNode) trimmedText() string {
	return jsTrim(n.text.String())
}

// parseXMLTree builds the element tree. A malformed document is a parse failure
// (the source catches it and returns no entries).
func parseXMLTree(body string) (*xmlNode, error) {
	decoder := xml.NewDecoder(strings.NewReader(body))
	decoder.Strict = false
	root := &xmlNode{name: "#document"}
	stack := []*xmlNode{root}
	for {
		token, err := decoder.RawToken()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		switch typed := token.(type) {
		case xml.StartElement:
			node := &xmlNode{name: rawQName(typed.Name), attrs: map[string]string{}}
			for _, attr := range typed.Attr {
				name := rawQName(attr.Name)
				if name == "xmlns" || strings.HasPrefix(name, "xmlns:") {
					continue
				}
				node.attrs[name] = attr.Value
			}
			parent := stack[len(stack)-1]
			parent.children = append(parent.children, node)
			stack = append(stack, node)
		case xml.CharData:
			stack[len(stack)-1].text.Write([]byte(typed))
		case xml.EndElement:
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return root, nil
}

// rawQName renders the element name as written, including its namespace prefix.
func rawQName(name xml.Name) string {
	if name.Space == "" {
		return name.Local
	}
	return name.Space + ":" + name.Local
}

// rssText implements extractRssText: element text first, then href/url.
func rssText(node *xmlNode) *string {
	if trimmed := node.trimmedText(); trimmed != "" {
		return &trimmed
	}
	for _, attribute := range []string{"href", "url"} {
		value := jsTrim(node.attribute(attribute))
		if value != "" {
			return &value
		}
	}
	return nil
}

// rssAuthor implements extractRssAuthor: text, then name / dc:creator / author
// children.
func rssAuthor(node *xmlNode) *string {
	if text := rssText(node); text != nil {
		return text
	}
	for _, name := range []string{"name", "dc:creator", "author"} {
		if child := node.child(name); child != nil {
			if text := rssText(child); text != nil {
				return text
			}
		}
	}
	return nil
}

// firstPresent returns the first of the named children that exists, mirroring
// the `record.a ?? record.b` chain (existence, not emptiness).
func firstPresent(node *xmlNode, names ...string) *xmlNode {
	for _, name := range names {
		if child := node.child(name); child != nil {
			return child
		}
	}
	return nil
}

// rssTimestamp parses the first present timestamp element.
func rssTimestamp(node *xmlNode, names ...string) *int64 {
	entry := firstPresent(node, names...)
	if entry == nil {
		return nil
	}
	text := rssText(entry)
	if text == nil {
		return nil
	}
	return parseJSTimestamp(*text)
}

// extractFromRSSPayload implements extractFromRssPayload. The document order is
// preserved and duplicate URLs are dropped by the caller's seen set.
func extractFromRSSPayload(xmlBody, feedURL string) []rssDiscoveryEntry {
	document, err := parseXMLTree(xmlBody)
	if err != nil {
		return []rssDiscoveryEntry{}
	}
	collected := []rssDiscoveryEntry{}
	seen := map[string]bool{}

	// RSS 2.0: rss.channel.item[] with the rss.item[] fallback (the source takes
	// channel.item first and only then rss.item).
	if rss := document.child("rss"); rss != nil {
		items := []*xmlNode{}
		if channel := rss.child("channel"); channel != nil {
			items = channel.childrenNamed("item")
		}
		if len(items) == 0 {
			items = rss.childrenNamed("item")
		}
		for _, item := range items {
			var linkRaw *string
			if link := item.child("link"); link != nil {
				linkRaw = rssText(link)
			}
			if linkRaw == nil {
				if guid := item.child("guid"); guid != nil {
					linkRaw = rssText(guid)
				}
			}
			var description *string
			if node := firstPresent(item, "description", "summary"); node != nil {
				description = rssText(node)
			}
			var content *string
			if node := firstPresent(item, "content:encoded", "content"); node != nil {
				content = rssText(node)
			}
			var author *string
			if node := item.child("author"); node != nil {
				author = rssAuthor(node)
			}
			if author == nil {
				if node := item.child("dc:creator"); node != nil {
					author = rssText(node)
				}
			}
			var title *string
			if node := item.child("title"); node != nil {
				title = rssText(node)
			}
			pushRSSDiscoveryEntry(&collected, seen, feedURL, rssLinkInput{
				RawURL:        linkRaw,
				Title:         title,
				Description:   description,
				Content:       content,
				Author:        author,
				PublishedAtTs: rssTimestamp(item, "pubDate", "published", "updated", "created", "issued", "dc:date"),
			})
		}
	}

	// Atom: feed.entry[].link[@href].
	if feed := document.child("feed"); feed != nil {
		for _, entry := range feed.childrenNamed("entry") {
			picked := pickAtomLink(entry.childrenNamed("link"))
			var title *string
			if node := entry.child("title"); node != nil {
				title = rssText(node)
			}
			var description *string
			if node := firstPresent(entry, "summary", "description"); node != nil {
				description = rssText(node)
			}
			var content *string
			if node := entry.child("content"); node != nil {
				content = rssText(node)
			}
			var author *string
			if node := entry.child("author"); node != nil {
				author = rssAuthor(node)
			}
			if author == nil {
				if node := entry.child("dc:creator"); node != nil {
					author = rssText(node)
				}
			}
			pushRSSDiscoveryEntry(&collected, seen, feedURL, rssLinkInput{
				RawURL:        picked,
				Title:         title,
				Description:   description,
				Content:       content,
				Author:        author,
				PublishedAtTs: rssTimestamp(entry, "published", "updated", "created", "issued", "dc:date"),
			})
		}
	}

	return collected
}

// pickAtomLink implements the Atom link selection: the first plain-text link, or
// the first link whose rel is empty or "alternate".
func pickAtomLink(links []*xmlNode) *string {
	for _, link := range links {
		if len(link.children) == 0 && len(link.attrs) == 0 {
			if text := rssText(link); text != nil {
				return text
			}
			continue
		}
		rel := strings.ToLower(jsTrim(link.attribute("rel")))
		href := rssText(link)
		if href == nil {
			continue
		}
		if rel == "" || rel == "alternate" {
			return href
		}
	}
	return nil
}

// rssLinkInput is the pushRssDiscoveryEntry argument set.
type rssLinkInput struct {
	RawURL        *string
	Title         *string
	Description   *string
	Content       *string
	Author        *string
	PublishedAtTs *int64
}

// pushRSSDiscoveryEntry implements pushRssDiscoveryEntry: resolve against the
// feed URL, require http(s), drop repeats and keep the first occurrence.
func pushRSSDiscoveryEntry(collected *[]rssDiscoveryEntry, seen map[string]bool, feedURL string, input rssLinkInput) {
	if input.RawURL == nil || *input.RawURL == "" {
		return
	}
	resolved, ok := resolveRSSLink(*input.RawURL, feedURL)
	if !ok {
		return
	}
	if seen[resolved] {
		return
	}
	seen[resolved] = true
	entry := rssDiscoveryEntry{
		URL:           resolved,
		Title:         truncateText(input.Title, rssPrefetchMaxTitleChars),
		Description:   truncateText(input.Description, rssPrefetchMaxDescriptionChars),
		Content:       input.Content,
		Author:        truncateText(input.Author, rssPrefetchMaxAuthorChars),
		PublishedAtTs: input.PublishedAtTs,
	}
	*collected = append(*collected, entry)
}

// resolveRSSLink implements `new URL(rawUrl, feedUrl).toString()` plus the
// http(s) filter. The fragment is intentionally kept: the source does not strip
// it for RSS entries.
func resolveRSSLink(rawURL, feedURL string) (string, bool) {
	base, err := parseURL(feedURL)
	if err != nil {
		return "", false
	}
	reference, err := parseURLReference(rawURL)
	if err != nil {
		return "", false
	}
	resolved := base.ResolveReference(reference)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return "", false
	}
	return resolved.String(), true
}

// DiscoverRSSURLs ports discoverRssUrls. The caller gets the discovered URLs in
// feed order.
func (d *Discovery) DiscoverRSSURLs(ctx context.Context, input RSSDiscoveryInput) ([]string, error) {
	candidates, err := d.DiscoverRSSCandidates(ctx, input)
	if err != nil {
		return nil, err
	}
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		urls = append(urls, candidate.URL)
	}
	return urls, nil
}

// RSSDiscoveryInput is the discoverRssUrls/discoverRssCandidates argument set.
type RSSDiscoveryInput struct {
	FeedURL          string
	MaxURLs          *int
	RequestTimeoutMs *int
	RSSFetch         *RSSFetchOptions
}

// DiscoverRSSCandidates ports discoverRssCandidates: fetch the feed through the
// shared conditional HTTP state cache, parse RSS/Atom, cap at maxUrls and attach
// the prefetched article body when the feed carried one.
func (d *Discovery) DiscoverRSSCandidates(ctx context.Context, input RSSDiscoveryInput) ([]DiscoveryCandidate, error) {
	crawledAtTs := nowMillis()
	feedURL, ok := normalizeURL(input.FeedURL)
	if !ok {
		return []DiscoveryCandidate{}, nil
	}
	maxURLs := clampNumber(input.MaxURLs, 1, 200, 50)
	fetchOptions := normalizeRSSFetchOptions(input.RSSFetch)

	requestTimeoutMs := 0
	if input.RSSFetch != nil && input.RSSFetch.RequestTimeoutMs != nil {
		requestTimeoutMs = *fetchOptions.RequestTimeoutMs
	} else if input.RequestTimeoutMs != nil {
		requestTimeoutMs = maxInt(1000, *input.RequestTimeoutMs)
	} else {
		requestTimeoutMs = *fetchOptions.RequestTimeoutMs
	}

	body, ok := d.service.fetchMaybe(ctx, feedURL, requestTimeoutMs)
	if !ok {
		return []DiscoveryCandidate{}, nil
	}

	entries := extractFromRSSPayload(body, feedURL)
	if len(entries) > maxURLs {
		entries = entries[:maxURLs]
	}
	candidates := make([]DiscoveryCandidate, 0, len(entries))
	for _, entry := range entries {
		publishedAtTs := entry.PublishedAtTs
		if publishedAtTs == nil {
			publishedAtTs = parsePublishedAtFromURL(entry.URL)
		}
		candidates = append(candidates, DiscoveryCandidate{
			URL:               entry.URL,
			PublishedAtTs:     publishedAtTs,
			CrawledAtTs:       &crawledAtTs,
			PrefetchedArticle: resolveRSSPrefetchedContent(entry, fetchOptions),
		})
	}
	return candidates, nil
}
