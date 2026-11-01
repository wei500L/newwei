package crawlmetadata

// sitemap_discovery_test.go covers the named seed-discovery entry point:
// the four discovery modes, the robots/common-path seed order, the per-call
// timeout (deadline and cancellation), and the diagnostics counters. Every
// request is answered by the stubbed transport in testhelpers_test.go using the
// public IP literal siteOrigin, so the production SSRF rules stay active and no
// request leaves the process.

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func newSitemapDiscovery(t *testing.T, routes *siteRoutes) (*Discovery, *stubTransport, *memoryStateStore) {
	t.Helper()
	service, transport, store := newDiscoveryService(t, routes)
	return NewDiscovery(service, nil, nil), transport, store
}

func candidateURLs(candidates []DiscoveryCandidate) []string {
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, candidate.URL)
	}
	return out
}

func TestSitemapDiscoveryRobotsSeedMethodAndDiagnostics(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil,
		"Sitemap: "+siteOrigin+"/sitemap-a.xml\n"))
	routes.set(siteOrigin+"/sitemap-a.xml", textResponse(200, nil, sitemapIndex(siteOrigin+"/child.xml")))
	routes.set(siteOrigin+"/child.xml", textResponse(200, nil, urlset(siteOrigin+"/p1", siteOrigin+"/p2")))
	discovery, transport, _ := newSitemapDiscovery(t, routes)

	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain:        siteOrigin,
		MaxURLs:       intPtr(10),
		DiscoveryMode: SitemapDiscoveryModeRobots,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if got := strings.Join(candidateURLs(result.Candidates), ","); got != siteOrigin+"/p1,"+siteOrigin+"/p2" {
		t.Fatalf("candidates = %v", candidateURLs(result.Candidates))
	}
	diagnostics := result.Diagnostics
	if diagnostics.DiscoveryMode != SitemapDiscoveryModeRobots {
		t.Fatalf("discoveryMode = %q", diagnostics.DiscoveryMode)
	}
	if diagnostics.SeedMethod != SitemapSeedMethodRobots {
		t.Fatalf("seedMethod = %q", diagnostics.SeedMethod)
	}
	if diagnostics.RobotsURL != siteOrigin+"/robots.txt" {
		t.Fatalf("robotsUrl = %q", diagnostics.RobotsURL)
	}
	if strings.Join(diagnostics.RobotsDiscoveredSitemaps, ",") != siteOrigin+"/sitemap-a.xml" {
		t.Fatalf("robotsDiscoveredSitemaps = %v", diagnostics.RobotsDiscoveredSitemaps)
	}
	// The root sitemap is attempted+fetched before the fetch, the child only once
	// its fetch succeeds. Both documents parse, so parsedSitemaps is 2.
	if strings.Join(diagnostics.AttemptedSitemaps, ",") != siteOrigin+"/sitemap-a.xml,"+siteOrigin+"/child.xml" {
		t.Fatalf("attemptedSitemaps = %v", diagnostics.AttemptedSitemaps)
	}
	if strings.Join(diagnostics.FetchedSitemaps, ",") != siteOrigin+"/sitemap-a.xml,"+siteOrigin+"/child.xml" {
		t.Fatalf("fetchedSitemaps = %v", diagnostics.FetchedSitemaps)
	}
	if diagnostics.ParsedSitemaps != 2 || diagnostics.CandidateCount != 2 {
		t.Fatalf("parsed=%d candidates=%d", diagnostics.ParsedSitemaps, diagnostics.CandidateCount)
	}
	// The first request is robots and the common paths are never requested once
	// robots declares a sitemap.
	if got := transport.requests()[0]; got != "GET "+siteOrigin+"/robots.txt" {
		t.Fatalf("first request = %q", got)
	}
	for _, request := range transport.requests() {
		if strings.Contains(request, "/sitemap.xml") {
			t.Fatalf("common path requested after robots discovery: %v", transport.requests())
		}
	}
}

func TestSitemapDiscoveryCommonPathsSkipsRobots(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, urlset(siteOrigin+"/p1")))
	discovery, transport, _ := newSitemapDiscovery(t, routes)

	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain:        siteOrigin,
		MaxURLs:       intPtr(10),
		DiscoveryMode: SitemapDiscoveryModeCommonPaths,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if got := strings.Join(candidateURLs(result.Candidates), ","); got != siteOrigin+"/p1" {
		t.Fatalf("candidates = %v", candidateURLs(result.Candidates))
	}
	if result.Diagnostics.SeedMethod != SitemapSeedMethodCommonPaths {
		t.Fatalf("seedMethod = %q", result.Diagnostics.SeedMethod)
	}
	if result.Diagnostics.RobotsURL != siteOrigin+"/robots.txt" {
		t.Fatalf("robotsUrl = %q", result.Diagnostics.RobotsURL)
	}
	if len(result.Diagnostics.RobotsDiscoveredSitemaps) != 0 {
		t.Fatalf("robotsDiscoveredSitemaps = %v", result.Diagnostics.RobotsDiscoveredSitemaps)
	}
	for _, request := range transport.requests() {
		if strings.Contains(request, "/robots.txt") {
			t.Fatalf("common_paths must not request robots.txt: %v", transport.requests())
		}
	}
	// The first attempted seed is the first common path, in order.
	if len(result.Diagnostics.AttemptedSitemaps) == 0 || result.Diagnostics.AttemptedSitemaps[0] != siteOrigin+"/sitemap.xml" {
		t.Fatalf("attemptedSitemaps = %v", result.Diagnostics.AttemptedSitemaps)
	}
}

func TestSitemapDiscoverySitemapOnlyReadsRobotsAndFallsBack(t *testing.T) {
	// When robots declares a sitemap, sitemap_only behaves like robots.
	withRobots := newSiteRoutes()
	withRobots.set(siteOrigin+"/robots.txt", textResponse(200, nil, "Sitemap: "+siteOrigin+"/from-robots.xml\n"))
	withRobots.set(siteOrigin+"/from-robots.xml", textResponse(200, nil, urlset(siteOrigin+"/r1")))
	discovery, transport, _ := newSitemapDiscovery(t, withRobots)
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), DiscoveryMode: SitemapDiscoveryModeSitemapOnly,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if result.Diagnostics.SeedMethod != SitemapSeedMethodRobots {
		t.Fatalf("sitemap_only seedMethod = %q, want robots", result.Diagnostics.SeedMethod)
	}
	if got := strings.Join(candidateURLs(result.Candidates), ","); got != siteOrigin+"/r1" {
		t.Fatalf("candidates = %v", candidateURLs(result.Candidates))
	}
	if got := transport.requests()[0]; got != "GET "+siteOrigin+"/robots.txt" {
		t.Fatalf("sitemap_only must read robots first, first request = %q", got)
	}

	// When robots yields nothing, sitemap_only falls back to the common paths
	// (the name does not mean "one XML document only").
	fallback := newSiteRoutes()
	fallback.set(siteOrigin+"/robots.txt", textResponse(200, nil, "# no sitemap line\n"))
	fallback.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, urlset(siteOrigin+"/c1")))
	discoveryFallback, _, _ := newSitemapDiscovery(t, fallback)
	fallbackResult, err := discoveryFallback.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), DiscoveryMode: SitemapDiscoveryModeSitemapOnly,
	})
	if err != nil {
		t.Fatalf("discover fallback: %v", err)
	}
	if fallbackResult.Diagnostics.SeedMethod != SitemapSeedMethodCommonPaths {
		t.Fatalf("fallback seedMethod = %q, want common_paths", fallbackResult.Diagnostics.SeedMethod)
	}
	if got := strings.Join(candidateURLs(fallbackResult.Candidates), ","); got != siteOrigin+"/c1" {
		t.Fatalf("fallback candidates = %v", candidateURLs(fallbackResult.Candidates))
	}
}

func TestSitemapDiscoveryDisabledFetchesNothing(t *testing.T) {
	routes := newSiteRoutes()
	discovery, transport, _ := newSitemapDiscovery(t, routes)
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), DiscoveryMode: SitemapDiscoveryModeDisabled,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(result.Candidates) != 0 {
		t.Fatalf("disabled candidates = %v", candidateURLs(result.Candidates))
	}
	if len(transport.requests()) != 0 {
		t.Fatalf("disabled must not fetch, requests = %v", transport.requests())
	}
	diagnostics := result.Diagnostics
	if diagnostics.DiscoveryMode != SitemapDiscoveryModeDisabled || diagnostics.SeedMethod != SitemapSeedMethodNone {
		t.Fatalf("diagnostics = %+v", diagnostics)
	}
	if diagnostics.RobotsURL != "" || len(diagnostics.AttemptedSitemaps) != 0 || diagnostics.CandidateCount != 0 {
		t.Fatalf("disabled diagnostics = %+v", diagnostics)
	}
}

func TestSitemapDiscoveryNoDomainReturnsEmptyShape(t *testing.T) {
	routes := newSiteRoutes()
	discovery, transport, _ := newSitemapDiscovery(t, routes)
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: "", DiscoveryMode: SitemapDiscoveryModeRobots,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(result.Candidates) != 0 || len(transport.requests()) != 0 {
		t.Fatalf("no-domain candidates=%v requests=%v", result.Candidates, transport.requests())
	}
	if result.Diagnostics.SeedMethod != SitemapSeedMethodNone || result.Diagnostics.CandidateCount != 0 {
		t.Fatalf("no-domain diagnostics = %+v", result.Diagnostics)
	}
	if result.Diagnostics.RobotsDiscoveredSitemaps == nil ||
		result.Diagnostics.AttemptedSitemaps == nil || result.Diagnostics.FetchedSitemaps == nil {
		t.Fatalf("no-domain diagnostics arrays must be empty, not nil: %+v", result.Diagnostics)
	}
}

func TestSitemapDiscoveryPerCallTimeoutReachesRequestContext(t *testing.T) {
	var deadline time.Duration
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil, "# none\n"))
	routes.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, urlset(siteOrigin+"/p1")))
	service, _ := newStubService(t, func(req *http.Request) (*http.Response, error) {
		if dl, ok := req.Context().Deadline(); ok {
			deadline = time.Until(dl)
		}
		return routes.respond(req)
	})
	discovery := NewDiscovery(service, nil, nil)

	timeout := 2500
	if _, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), RequestTimeoutMs: &timeout,
		DiscoveryMode: SitemapDiscoveryModeRobots,
	}); err != nil {
		t.Fatalf("discover: %v", err)
	}
	// The per-call timeout (not the shared 15s default) must be the request
	// deadline, proving the override enters the HTTP/cancel chain.
	if deadline <= 0 || deadline > 3*time.Second {
		t.Fatalf("request deadline = %v, want ~2.5s", deadline)
	}
}

func TestSitemapDiscoveryPerCallTimeoutCancelsRequest(t *testing.T) {
	robots := "Sitemap: " + siteOrigin + "/blocked.xml\n"
	service, _ := newStubService(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.String() == siteOrigin+"/robots.txt" {
			return textResponse(200, nil, robots), nil
		}
		// Block until the per-call deadline fires, then report the cancellation.
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	discovery := NewDiscovery(service, nil, nil)
	timeout := 1000
	started := time.Now()
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), RequestTimeoutMs: &timeout,
		DiscoveryMode: SitemapDiscoveryModeRobots,
	})
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("request returned after %v, want the ~1s timeout to fire", elapsed)
	}
	if len(result.Candidates) != 0 {
		t.Fatalf("timed-out discovery candidates = %v", candidateURLs(result.Candidates))
	}
	// robots was read, so the seed method is robots; the single declared sitemap
	// was attempted but its fetch timed out, so it is not fetched or parsed.
	if result.Diagnostics.SeedMethod != SitemapSeedMethodRobots {
		t.Fatalf("seedMethod = %q", result.Diagnostics.SeedMethod)
	}
	if strings.Join(result.Diagnostics.AttemptedSitemaps, ",") != siteOrigin+"/blocked.xml" {
		t.Fatalf("attemptedSitemaps = %v", result.Diagnostics.AttemptedSitemaps)
	}
	if len(result.Diagnostics.FetchedSitemaps) != 0 || result.Diagnostics.ParsedSitemaps != 0 {
		t.Fatalf("timeout diagnostics = %+v", result.Diagnostics)
	}
}

func TestSitemapDiscoveryAppliesPatternMaxURLsAndFreshness(t *testing.T) {
	cutoff := time.Date(2024, 6, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	body := `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
		`<url><loc>` + siteOrigin + `/article/old</loc><lastmod>2024-01-01T00:00:00Z</lastmod></url>` +
		`<url><loc>` + siteOrigin + `/article/new-1</loc><lastmod>2024-09-01T00:00:00Z</lastmod></url>` +
		`<url><loc>` + siteOrigin + `/article/new-2</loc><lastmod>2024-09-02T00:00:00Z</lastmod></url>` +
		`<url><loc>` + siteOrigin + `/skip/new-3</loc><lastmod>2024-09-03T00:00:00Z</lastmod></url>` +
		`</urlset>`
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil, "# none\n"))
	routes.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, body))
	discovery, _, _ := newSitemapDiscovery(t, routes)

	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain:            siteOrigin,
		Pattern:           "*article*",
		MaxURLs:           intPtr(1),
		FreshnessCutoffTs: &cutoff,
		DiscoveryMode:     SitemapDiscoveryModeRobots,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	got := candidateURLs(result.Candidates)
	if len(got) != 1 || got[0] != siteOrigin+"/article/new-1" {
		t.Fatalf("candidates = %v, want only the first fresh article", got)
	}
	if result.Diagnostics.CandidateCount != 1 {
		t.Fatalf("candidateCount = %d", result.Diagnostics.CandidateCount)
	}
	// The old and pattern-mismatched entries are filtered, not counted.
	if result.Diagnostics.ParsedSitemaps != 1 {
		t.Fatalf("parsedSitemaps = %d", result.Diagnostics.ParsedSitemaps)
	}
}

func TestSitemapDiscoveryMalformedSitemapIsFetchedNotParsed(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil, "# none\n"))
	routes.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, "<urlset><url><loc>https://x/a</loc>"))
	discovery, _, _ := newSitemapDiscovery(t, routes)
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), DiscoveryMode: SitemapDiscoveryModeRobots,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(result.Candidates) != 0 || result.Diagnostics.CandidateCount != 0 {
		t.Fatalf("malformed candidates = %v", candidateURLs(result.Candidates))
	}
	if result.Diagnostics.ParsedSitemaps != 0 {
		t.Fatalf("parsedSitemaps = %d, want 0", result.Diagnostics.ParsedSitemaps)
	}
	fetched := strings.Join(result.Diagnostics.FetchedSitemaps, ",")
	if !strings.Contains(fetched, "/sitemap.xml") {
		t.Fatalf("fetchedSitemaps = %v, want the malformed document recorded as fetched", result.Diagnostics.FetchedSitemaps)
	}
}

func TestSitemapDiscoveryCacheHitStillCountsParsedDocument(t *testing.T) {
	body := urlset(siteOrigin + "/p1")
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil, "Sitemap: "+siteOrigin+"/sitemap.xml\n"))
	routes.set(siteOrigin+"/sitemap.xml", textResponse(http.StatusNotModified, map[string]string{
		"ETag": `"v1"`,
	}, ""))
	discovery, _, store := newSitemapDiscovery(t, routes)
	parsed := parsedSitemapPayload{URLs: []parsedSitemapURL{{Loc: siteOrigin + "/p1"}}, ChildSitemaps: []parsedSitemapIndexEntry{}}
	store.states[siteOrigin+"/sitemap.xml"] = discoveryHTTPState{
		ETag: `"v1"`, Body: &body, ParsedSitemapPayload: &parsed,
	}
	result, err := discovery.DiscoverSitemapCandidatesForSeed(context.Background(), SitemapDiscoveryOptions{
		Domain: siteOrigin, MaxURLs: intPtr(10), DiscoveryMode: SitemapDiscoveryModeRobots,
	})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if got := strings.Join(candidateURLs(result.Candidates), ","); got != siteOrigin+"/p1" {
		t.Fatalf("cached candidates = %v", candidateURLs(result.Candidates))
	}
	// A cache hit still counts as one parsed document and one fetched sitemap.
	if result.Diagnostics.ParsedSitemaps != 1 {
		t.Fatalf("parsedSitemaps = %d, want 1", result.Diagnostics.ParsedSitemaps)
	}
	if strings.Join(result.Diagnostics.FetchedSitemaps, ",") != siteOrigin+"/sitemap.xml" {
		t.Fatalf("fetchedSitemaps = %v", result.Diagnostics.FetchedSitemaps)
	}
}
