package publicportal

import (
	"context"
	"encoding/json"
	"errors"
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
	org            *Org
	rows           []EventRow
	counts         map[string]int
	auth           []AuthorityItem
	policy         matcher
	pages          int
	event          *EventDetail
	timeline       []TimelineEntry
	items          []BriefItem
	articles       []ArticleRow
	loads          int
	saved          []byte
	articleOrg     string
	articleEvent   string
	articleIDs     []string
	gatewayJSON    []byte
	governanceJSON []byte
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

func (f *fakeStore) LoadEvent(context.Context, string, string) (*EventDetail, error) {
	f.loads++
	return f.event, nil
}

func (f *fakeStore) Timeline(context.Context, string, string, time.Time) ([]TimelineEntry, error) {
	return f.timeline, nil
}

func (f *fakeStore) BriefItems(context.Context, string, string, int) ([]BriefItem, error) {
	return f.items, nil
}

func (f *fakeStore) ReferencedArticles(_ context.Context, orgID, eventID string, articleIDs []string, _ int) ([]ArticleRow, error) {
	f.articleOrg = orgID
	f.articleEvent = eventID
	f.articleIDs = append([]string(nil), articleIDs...)
	return f.articles, nil
}

func (f *fakeStore) TimelineWindowDays(context.Context, string) int { return 30 }

func (f *fakeStore) SaveEventMetadata(_ context.Context, _, _ string, metadata []byte) error {
	f.saved = append([]byte(nil), metadata...)
	return nil
}

func (f *fakeStore) GatewaySettings(context.Context) ([]byte, []byte, error) {
	return f.gatewayJSON, f.governanceJSON, nil
}

type completerFunc func(context.Context, completionRequest) (string, error)

func (f completerFunc) Complete(ctx context.Context, req completionRequest) (string, error) {
	return f(ctx, req)
}

func TestExtractStoryIDKeepsCuidIntact(t *testing.T) {
	id := "cjld2cy6k0000qzrmn831i7rn"
	if extractStoryID(id) != id {
		t.Fatalf("id = %q", extractStoryID(id))
	}
	if got := extractStoryID(id + "-portal-markets-brief"); got != id {
		t.Fatalf("slug id = %q", got)
	}
	if extractStoryID("  ") != "" {
		t.Fatal("blank id")
	}
	if extractStoryID("evt-portal-markets") != "evt" {
		t.Fatal("hyphenated fixture id is not a cuid")
	}
}

func TestStoryDoesNotPublishWithoutPublicOrgOrQualification(t *testing.T) {
	id := "cjld2cy6k0000qzrmn831i7rn"
	store := &fakeStore{event: &EventDetail{EventRow: EventRow{
		ID: id, OrgID: "org-other", Status: "active", Title: "Leak", Summary: "secret",
	}}}
	svc := NewService(store)
	got, err := svc.Story(context.Background(), id)
	if err != nil || got != nil || store.loads != 0 {
		t.Fatalf("missing org got=%v err=%v loads=%d", got, err, store.loads)
	}

	store.org = &Org{ID: "org-portal-pub", Slug: "portal-public", Name: "Portal"}
	store.event.Status = "archived"
	store.event.OrgID = "org-portal-pub"
	got, err = svc.Story(context.Background(), id+"-leak")
	if err != nil || got != nil {
		t.Fatalf("archived got=%v err=%v", got, err)
	}

	store.event.Status = "active"
	store.event.OrgID = "org-other"
	got, err = svc.Story(context.Background(), id)
	if err != nil || got != nil {
		t.Fatalf("other org got=%v err=%v", got, err)
	}
}

func TestStoryBriefColdPathWritesCacheAndFailureIsNotSuccess(t *testing.T) {
	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)
	id := "cjld2cy6k0000qzrmn831i7rn"
	pub := "org-portal-pub"
	calls := 0
	store := qualifiedStoryStore(id, pub, now)
	svc := NewService(store)
	svc.now = func() time.Time { return now }
	svc.complete = completerFunc(func(_ context.Context, req completionRequest) (string, error) {
		calls++
		if !strings.Contains(req.User, "https://www.reuters.com/markets-a") {
			t.Fatalf("prompt = %s", req.User)
		}
		if req.Metadata["feature"] != "news_event_brief" {
			t.Fatalf("metadata = %#v", req.Metadata)
		}
		return `{"detailed_summary":"Detail text.","tldr":"Short.","key_points":[{"text":"Fact","citations":[1]}]}`, nil
	})

	got, err := svc.Story(context.Background(), id+"-portal-markets-brief")
	if err != nil || got == nil || got.Story.Brief == nil {
		t.Fatalf("story err=%v body=%+v", err, got)
	}
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
	if got.Story.ID != id || got.Story.Brief.Payload["tldr"] != "Short." {
		t.Fatalf("brief = %#v", got.Story.Brief)
	}
	if len(got.Story.Timeline) != 1 || len(got.Story.ReferencedArticles) != 1 {
		t.Fatalf("timeline/articles = %+v %+v", got.Story.Timeline, got.Story.ReferencedArticles)
	}
	if store.articleOrg != pub || store.articleEvent != id || !strings.Contains(strings.Join(store.articleIDs, ","), "art-other") {
		t.Fatalf("article query org=%s event=%s ids=%v", store.articleOrg, store.articleEvent, store.articleIDs)
	}
	var saved map[string]any
	if err := json.Unmarshal(store.saved, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["note"] != "keep" {
		t.Fatalf("metadata lost note: %s", store.saved)
	}
	if saved["briefV1"] == nil {
		t.Fatalf("brief not cached: %s", store.saved)
	}

	store.event.Metadata = append([]byte(nil), store.saved...)
	if _, err := svc.Story(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("cache hit called the model again: %d", calls)
	}

	store.event.Metadata = []byte(`{"note":"keep"}`)
	store.saved = nil
	svc.complete = completerFunc(func(context.Context, completionRequest) (string, error) {
		return "", errors.New("gateway down")
	})
	got, err = svc.Story(context.Background(), id)
	if err == nil || got != nil || store.saved != nil {
		t.Fatalf("failure got=%v err=%v saved=%s", got, err, store.saved)
	}
}

func qualifiedStoryStore(id, pub string, now time.Time) *fakeStore {
	return &fakeStore{
		org:    &Org{ID: pub, Slug: "portal-public", Name: "Portal"},
		policy: defaultMatcher(),
		counts: map[string]int{id: 2},
		auth: []AuthorityItem{
			{EventID: id, URL: "https://www.reuters.com/markets-a"},
			{EventID: id, URL: "https://apnews.com/markets-b"},
		},
		event: &EventDetail{
			EventRow: EventRow{
				ID: id, OrgID: pub, Status: "active",
				Title: "Portal Markets Brief", Summary: "Markets summary.",
				PrimaryTopic: "Markets", Language: "zh",
				StartAt: now, LastAt: now,
			},
			Metadata: []byte(`{"note":"keep"}`),
		},
		items: []BriefItem{{
			URL: "https://www.reuters.com/markets-a", SourceLabel: "Reuters",
			ArticleID: "art-1", ProcessedArticleID: "pa-1", Title: "Markets A",
			HasPublishedAt: true, PublishedAt: now, ProcessedAt: now,
		}},
		timeline: []TimelineEntry{{
			ID: "tl-1", BucketStart: now, Title: "Now", Summary: "Latest",
			ReferencedArticleIDs: []string{"art-1", "art-other"},
		}},
		articles: []ArticleRow{{
			ID: "art-1", URL: "https://www.reuters.com/markets-a", Title: "Markets A", SourceLabel: "Reuters",
		}},
	}
}
