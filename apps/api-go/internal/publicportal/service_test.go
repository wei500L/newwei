package publicportal

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParsePublicOrgSlugDoesNotInventAnOrg(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"string", `"Portal-Public"`, "portal-public"},
		{"object", `{"slug":" Portal-Public "}`, "portal-public"},
		{"blank string", `""`, ""},
		{"blank object", `{"slug":"  "}`, ""},
		{"number", `1`, ""},
		{"null", `null`, ""},
		{"array", `["portal-public"]`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePublicOrgSlug([]byte(tc.raw)); got != tc.want {
				t.Fatalf("parse = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeSlugSegmentStripsMarks(t *testing.T) {
	if got := sanitizeSlugSegment("Café Stories"); got != "cafe-stories" {
		t.Fatalf("slug = %q", got)
	}
	if got := sanitizeSlugSegment("   "); got != "story" {
		t.Fatalf("blank slug = %q", got)
	}
}

func TestHomeWithoutConfiguredOrgDoesNotReadEvents(t *testing.T) {
	store := &fakeStore{rows: []EventRow{{
		ID: "evt-other", OrgID: "org-other", Status: "active",
		Title: "Should stay private", Summary: "secret",
	}}}
	home, err := NewService(store).Home(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.pages != 0 {
		t.Fatalf("listed %d pages without a public org", store.pages)
	}
	if home.Org != nil || home.FeaturedStory != nil || len(home.LatestStories) != 0 || len(home.Channels) != 0 {
		t.Fatalf("home = %+v", home)
	}
}

func TestListDropsOtherOrgArchivedAndUnqualified(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	pub := "org-portal-pub"
	store := &fakeStore{
		org: &Org{ID: pub, Slug: "portal-public", Name: "Portal"},
		rows: []EventRow{
			{ID: "evt-markets", OrgID: pub, Status: "active", Title: "Portal Markets Brief", Summary: "markets body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
			{ID: "evt-archived", OrgID: pub, Status: "archived", Title: "Portal Archived Leak", Summary: "archived body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
			{ID: "evt-other", OrgID: "org-other", Status: "active", Title: "Portal Other Org Leak", Summary: "other body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
			{ID: "evt-blog", OrgID: pub, Status: "active", Title: "Portal Blog Leak", Summary: "blog body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
			{ID: "evt-thin", OrgID: pub, Status: "active", Title: "Portal Thin", Summary: "thin body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
			{ID: "evt-blank", OrgID: pub, Status: "active", Title: "   ", Summary: "blank body", PrimaryTopic: "Markets", LastAt: now, StartAt: now},
		},
		counts: map[string]int{
			"evt-markets":  2,
			"evt-archived": 2,
			"evt-other":    2,
			"evt-blog":     2,
			"evt-thin":     1,
			"evt-blank":    2,
		},
		auth: []AuthorityItem{
			{EventID: "evt-markets", URL: "https://www.portal-fixture.example/a"},
			{EventID: "evt-markets", URL: "https://news.portal-fixture.example/b"},
			{EventID: "evt-archived", URL: "https://www.portal-fixture.example/a"},
			{EventID: "evt-archived", URL: "https://news.portal-fixture.example/b"},
			{EventID: "evt-other", URL: "https://www.portal-fixture.example/a"},
			{EventID: "evt-other", URL: "https://news.portal-fixture.example/b"},
			{EventID: "evt-blog", URL: "https://medium.com/a"},
			{EventID: "evt-blog", URL: "https://medium.com/b"},
			{EventID: "evt-thin", URL: "https://www.portal-fixture.example/a"},
			{EventID: "evt-blank", URL: "https://www.portal-fixture.example/a"},
			{EventID: "evt-blank", URL: "https://news.portal-fixture.example/b"},
		},
		policy: parseSourcePolicy([]byte(`{
			"version": 2,
			"activeRevision": 1,
			"updatedAt": "2026-01-01T00:00:00.000Z",
			"delta": {
				"authoritativeDomainsAdd": ["portal-fixture.example"],
				"authoritativeDomainsRemove": [],
				"authoritativeLabelsAdd": [],
				"authoritativeLabelsRemove": [],
				"blogDomainsAdd": [],
				"blogDomainsRemove": [],
				"blogLabelsAdd": [],
				"blogLabelsRemove": []
			},
			"revisions": []
		}`)),
	}
	svc := NewService(store)
	svc.now = func() time.Time { return now }
	home, err := svc.Home(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if home.Org == nil || home.Org.ID != pub {
		t.Fatalf("org = %+v", home.Org)
	}
	if home.FeaturedStory == nil || home.FeaturedStory.ID != "evt-markets" {
		t.Fatalf("featured = %+v", home.FeaturedStory)
	}
	if home.FeaturedStory.SourceType != "authoritative" || home.FeaturedStory.CredibilityScore < minCredibility {
		t.Fatalf("authority = %+v", home.FeaturedStory)
	}
	if len(home.LatestStories) != 0 {
		t.Fatalf("latest = %+v", home.LatestStories)
	}
	blob := home.FeaturedStory.Title
	for _, story := range home.LatestStories {
		blob += story.Title
	}
	for _, banned := range []string{"Archived Leak", "Other Org", "Blog Leak", "Thin"} {
		if strings.Contains(blob, banned) {
			t.Fatalf("response contains %s: %+v", banned, home)
		}
	}
}

type fakeStore struct {
	org    *Org
	rows   []EventRow
	counts map[string]int
	auth   []AuthorityItem
	policy matcher
	pages  int
}

func (f *fakeStore) PublicOrg(context.Context) (*Org, error) { return f.org, nil }

func (f *fakeStore) ListEventPage(context.Context, string, *PageCursor, string) ([]EventRow, error) {
	f.pages++
	if f.pages > 1 {
		return nil, nil
	}
	return f.rows, nil
}

func (f *fakeStore) ItemCounts(_ context.Context, _ string, ids []string) (map[string]int, error) {
	out := map[string]int{}
	for _, id := range ids {
		out[id] = f.counts[id]
	}
	return out, nil
}

func (f *fakeStore) HeatItems(context.Context, string, []string, time.Time) ([]HeatItem, error) {
	return nil, nil
}

func (f *fakeStore) AuthorityItems(context.Context, string, []string, time.Time) ([]AuthorityItem, error) {
	return f.auth, nil
}

func (f *fakeStore) SourcePolicy(context.Context, string) (matcher, error) {
	return f.policy, nil
}
