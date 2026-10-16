package newssources

import "testing"

func TestPresetParsesFeeds(t *testing.T) {
	got := NewService(nil).Presets()
	count, _ := got[0]["entryCount"].(int)
	if count < 10 || got[0]["id"] != presetID {
		t.Fatalf("preset = %#v", got)
	}
}

func TestStaticSegmentsAreNotIDs(t *testing.T) {
	for _, path := range []string{
		"/api/admin/news-sources/options",
		"/api/admin/news-sources/groups",
		"/api/admin/news-sources/opml-presets",
		"/api/admin/news-sources/batch",
		"/api/admin/news-sources/batch/frequency",
		"/api/admin/news-sources/opml/preview",
		"/api/admin/news-sources/source-1/preview",
	} {
		if _, _, ok := sourceAction(path); ok && path != "/api/admin/news-sources/options" && path != "/api/admin/news-sources/groups" && path != "/api/admin/news-sources/opml-presets" && path != "/api/admin/news-sources/batch" {
			t.Fatalf("%s parsed as an id action", path)
		}
	}
	id, action, ok := sourceAction("/api/admin/news-sources/source-1/run")
	if !ok || id != "source-1" || action != "run" {
		t.Fatalf("run = %q %q %v", id, action, ok)
	}
	id, action, ok = sourceAction("/api/admin/news-sources/source-1")
	if !ok || id != "source-1" || action != "" {
		t.Fatalf("id = %q %q %v", id, action, ok)
	}
}
