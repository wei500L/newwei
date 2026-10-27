package newssources

import (
	"strings"
	"testing"
)

// TestParseOPMLDoesNotExpandEntities pins the XML safety property: encoding/xml
// never expands a DTD entity, so an entity-expansion payload ("billion laughs")
// is rejected as an undefined entity instead of being expanded.
func TestParseOPMLDoesNotExpandEntities(t *testing.T) {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0"?><!DOCTYPE opml [<!ENTITY a "aaaaaaaaaa">]>`)
	builder.WriteString(`<opml><body><outline text="&a;" xmlUrl="https://example.com/feed"/></body></opml>`)
	parsed := parseOPML(builder.String())
	if len(parsed.entries) != 0 {
		t.Fatalf("entries = %#v, want none", parsed.entries)
	}
}

// TestParseOPMLGroupsAndNameFallback keeps the outline walk the NestJS parser
// performs: a feed inherits its parent outline label as the group, and a missing
// text/title falls back to htmlUrl then xmlUrl.
func TestParseOPMLGroupsAndNameFallback(t *testing.T) {
	raw := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Feeds</title></head>
  <body>
    <outline text="Blogs">
      <outline type="rss" xmlUrl="https://a.example/feed" htmlUrl="https://a.example"/>
    </outline>
    <outline type="rss" text="B" htmlUrl="https://b.example"/>
    <outline type="rss" xmlUrl="https://c.example/feed"/>
  </body>
</opml>`
	parsed := parseOPML(raw)
	if parsed.title != "Feeds" {
		t.Fatalf("title = %q", parsed.title)
	}
	if len(parsed.entries) != 3 {
		t.Fatalf("entries = %#v", parsed.entries)
	}
	first := parsed.entries[0]
	if first.group != "Blogs" {
		t.Fatalf("group = %#v, want Blogs", first.group)
	}
	if first.name != "https://a.example" {
		t.Fatalf("name = %q, want the htmlUrl fallback", first.name)
	}
	if parsed.entries[1].group != nil {
		t.Fatalf("second group = %#v, want nil", parsed.entries[1].group)
	}
	if parsed.entries[2].name != "https://c.example/feed" {
		t.Fatalf("third name = %q, want the xmlUrl fallback", parsed.entries[2].name)
	}
}
