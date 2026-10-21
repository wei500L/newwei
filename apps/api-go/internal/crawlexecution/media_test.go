package crawlexecution

// Unit tests for the media half of the crawl result persistence: collection
// normalization (the shape crawlreadtelemetry reads back), the download rules
// (content type, byte ceiling, timeout), the inline data URI branch and the
// per-result store loop. The download tests use httptest; the store uses the
// in-memory fakes from media_store_test.go.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	telemetry "github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// requireStringPtr fails the test when ptr is nil or holds another value.
func requireStringPtr(t *testing.T, ptr *string, want, label string) {
	t.Helper()
	if ptr == nil {
		t.Fatalf("%s is nil, want %q", label, want)
	}
	if *ptr != want {
		t.Fatalf("%s = %q, want %q", label, *ptr, want)
	}
}

// requireIntPtr fails the test when ptr is nil or holds another value.
func requireIntPtr(t *testing.T, ptr *int, want int, label string) {
	t.Helper()
	if ptr == nil {
		t.Fatalf("%s is nil, want %d", label, want)
	}
	if *ptr != want {
		t.Fatalf("%s = %d, want %d", label, *ptr, want)
	}
}

// bsonFieldValue returns one field of a bson.D.
func bsonFieldValue(t *testing.T, document bson.D, key string) any {
	t.Helper()
	for _, element := range document {
		if element.Key == key {
			return element.Value
		}
	}
	t.Fatalf("missing bson field %q in %v", key, document)
	return nil
}

// mediaRoundTripFunc adapts a function into an http.RoundTripper.
type mediaRoundTripFunc func(*http.Request) (*http.Response, error)

func (f mediaRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestNormalizeMediaCollection(t *testing.T) {
	raw := json.RawMessage(`{
		"images": [
			{"src":"https://cdn.example/a.jpg","alt":"A","title":"T","width":640,"height":480,"score":7.5,"type":"image","format":"image/jpeg","poster":"https://cdn.example/p.jpg","sizes":"100vw","srcset":"a.jpg 1x","sources":[{"srcset":"a.webp 1x","type":"image/webp","media":"(min-width: 800px)"}],"class":"hero","data-id":null},
			{"url":"https://cdn.example/b.png","description":"B","media_type":"image","mime":"image/png","thumbnail":"https://cdn.example/t.jpg","responsive_images":[{"src":"https://cdn.example/r.jpg"}]}
		],
		"videos":[{"href":"https://cdn.example/v.mp4","width":100.7,"title":"V"}],
		"audios":[{}],
		"invalid":{"src":"https://cdn.example/x.jpg"},
		"empty":[]
	}`)
	collection := normalizeMediaCollection(raw)
	if collection == nil {
		t.Fatal("collection is nil")
	}
	if len(collection.buckets) != 2 || collection.buckets[0].Kind != "images" || collection.buckets[1].Kind != "videos" {
		t.Fatalf("buckets = %#v", collection.buckets)
	}
	if len(collection.buckets[0].Items) != 2 {
		t.Fatalf("images = %d", len(collection.buckets[0].Items))
	}
	first := collection.buckets[0].Items[0]
	requireStringPtr(t, first.Src, "https://cdn.example/a.jpg", "src")
	requireStringPtr(t, first.Alt, "A", "alt")
	requireStringPtr(t, first.Title, "T", "title")
	requireStringPtr(t, first.Type, "image", "type")
	requireStringPtr(t, first.Format, "image/jpeg", "format")
	requireStringPtr(t, first.Poster, "https://cdn.example/p.jpg", "poster")
	requireStringPtr(t, first.Sizes, "100vw", "sizes")
	requireIntPtr(t, first.Width, 640, "width")
	requireIntPtr(t, first.Height, 480, "height")
	if first.Score == nil || *first.Score != 7.5 {
		t.Fatalf("score = %#v", first.Score)
	}
	if len(first.Srcset) != 1 || first.Srcset[0] != "a.jpg 1x" {
		t.Fatalf("srcset = %#v", first.Srcset)
	}
	if len(first.PictureSources) != 1 {
		t.Fatalf("pictureSources = %#v", first.PictureSources)
	}
	requireStringPtr(t, first.PictureSources[0].Srcset, "a.webp 1x", "picture srcset")
	requireStringPtr(t, first.PictureSources[0].Type, "image/webp", "picture type")
	requireStringPtr(t, first.PictureSources[0].Media, "(min-width: 800px)", "picture media")
	if len(first.Raw) != 2 || first.Raw[0].Key != "class" || string(first.Raw[0].Value) != `"hero"` {
		t.Fatalf("raw = %#v", first.Raw)
	}
	if first.Raw[1].Key != "data-id" || strings.TrimSpace(string(first.Raw[1].Value)) != "null" {
		t.Fatalf("null extra must be preserved: %#v", first.Raw[1])
	}

	second := collection.buckets[0].Items[1]
	requireStringPtr(t, second.Src, "https://cdn.example/b.png", "second src")
	requireStringPtr(t, second.Desc, "B", "second desc")
	requireStringPtr(t, second.Type, "image", "second type")
	requireStringPtr(t, second.Format, "image/png", "second format")
	requireStringPtr(t, second.Poster, "https://cdn.example/t.jpg", "second poster")
	if len(second.ResponsiveSources) != 1 {
		t.Fatalf("responsiveSources = %#v", second.ResponsiveSources)
	}
	requireStringPtr(t, second.ResponsiveSources[0].Src, "https://cdn.example/r.jpg", "responsive src")

	video := collection.buckets[1].Items[0]
	requireStringPtr(t, video.Src, "https://cdn.example/v.mp4", "video src")
	requireStringPtr(t, video.Title, "V", "video title")
	// Fractional widths are truncated so the crawlreadtelemetry int projection
	// can decode the stored document.
	requireIntPtr(t, video.Width, 100, "video width")
}

func TestNormalizeMediaCollectionRejectsNonObjects(t *testing.T) {
	for name, raw := range map[string]json.RawMessage{
		"empty":              nil,
		"null":               json.RawMessage(`null`),
		"array":              json.RawMessage(`[{"src":"https://cdn.example/a.jpg"}]`),
		"string":             json.RawMessage(`"images"`),
		"empty object":       json.RawMessage(`{}`),
		"no item array":      json.RawMessage(`{"images":{"src":"https://cdn.example/a.jpg"}}`),
		"only invalid items": json.RawMessage(`{"images":[{},[],"x",null]}`),
	} {
		if collection := normalizeMediaCollection(raw); collection != nil {
			t.Fatalf("%s: expected nil, got %#v", name, collection)
		}
	}
}

func TestNormalizeMediaStringList(t *testing.T) {
	if values := normalizeMediaStringList(json.RawMessage(`" a.jpg 1x "`)); len(values) != 1 || values[0] != "a.jpg 1x" {
		t.Fatalf("string list = %#v", values)
	}
	if values := normalizeMediaStringList(json.RawMessage(`["a 1x","","  ","b 2x"]`)); len(values) != 2 || values[0] != "a 1x" || values[1] != "b 2x" {
		t.Fatalf("array list = %#v", values)
	}
	many := make([]string, 0, 25)
	for index := 0; index < 25; index++ {
		many = append(many, fmt.Sprintf("x%d 1x", index))
	}
	encoded, err := json.Marshal(many)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if values := normalizeMediaStringList(encoded); len(values) != 20 {
		t.Fatalf("array list must be capped at 20: %d", len(values))
	}
	for name, raw := range map[string]json.RawMessage{
		"null":   json.RawMessage(`null`),
		"empty":  json.RawMessage(`""`),
		"number": json.RawMessage(`7`),
		"object": json.RawMessage(`{"a":1}`),
	} {
		if values := normalizeMediaStringList(raw); values != nil {
			t.Fatalf("%s: expected nil, got %#v", name, values)
		}
	}
}

func TestSanitizeStoredContentType(t *testing.T) {
	cases := []struct {
		input *string
		want  *string
	}{
		{nil, nil},
		{mediaTestStringPtr("image/jpg"), mediaTestStringPtr("image/jpeg")},
		{mediaTestStringPtr("IMAGE/PNG; charset=utf-8"), mediaTestStringPtr("image/png")},
		{mediaTestStringPtr(" image/webp "), mediaTestStringPtr("image/webp")},
		{mediaTestStringPtr("audio/mp3"), mediaTestStringPtr("audio/mpeg")},
		{mediaTestStringPtr("mp4"), mediaTestStringPtr("video/mp4")},
		{mediaTestStringPtr("svg"), mediaTestStringPtr("image/svg+xml")},
		{mediaTestStringPtr("image/svg+xml"), mediaTestStringPtr("image/svg+xml")},
		{mediaTestStringPtr("text/html"), nil},
		{mediaTestStringPtr("application/octet-stream"), nil},
		{mediaTestStringPtr("text/html; charset=utf-8"), nil},
		{mediaTestStringPtr("not a content type"), nil},
		{mediaTestStringPtr("image/"), nil},
		{mediaTestStringPtr("/png"), nil},
		{mediaTestStringPtr("image/png/extra"), nil},
		{mediaTestStringPtr("image/png;base64"), mediaTestStringPtr("image/png")},
	}
	for _, testCase := range cases {
		got := sanitizeStoredContentType(testCase.input)
		switch {
		case testCase.want == nil && got != nil:
			t.Fatalf("sanitize(%v) = %q, want nil", testCase.input, *got)
		case testCase.want != nil && got == nil:
			t.Fatalf("sanitize(%v) = nil, want %q", testCase.input, *testCase.want)
		case testCase.want != nil && *got != *testCase.want:
			t.Fatalf("sanitize(%v) = %q, want %q", testCase.input, *got, *testCase.want)
		}
	}
}

// mediaTestStringPtr is a small pointer helper for table tests.
func mediaTestStringPtr(value string) *string { return &value }

func TestPickExtension(t *testing.T) {
	cases := map[string]string{
		"image/jpeg":      "jpg",
		"image/jpg":       "",
		"image/png":       "png",
		"image/webp":      "webp",
		"image/gif":       "gif",
		"image/svg+xml":   "svg",
		"video/mp4":       "mp4",
		"video/webm":      "webm",
		"audio/mpeg":      "mp3",
		"application/pdf": "",
	}
	for input, want := range cases {
		contentType := input
		if got := pickExtension(&contentType); got != want {
			t.Fatalf("pickExtension(%q) = %q, want %q", input, got, want)
		}
	}
	if got := pickExtension(nil); got != "" {
		t.Fatalf("pickExtension(nil) = %q", got)
	}
}

func TestEstimateBase64DecodedBytes(t *testing.T) {
	cases := map[string]int{
		"AQID":   3,
		"AQI=":   2,
		"AQ==":   1,
		"AQ I D": 3,
		"AQ\nID": 3,
		"":       0,
		"!!!!":   0,
		"=":      0,
		"A":      0,
	}
	for input, want := range cases {
		if got := estimateBase64DecodedBytes(input); got != want {
			t.Fatalf("estimateBase64DecodedBytes(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestBuildInlineMediaAsset(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("abc"))
	format := "image/png"
	alt := "alt"
	item := mediaItem{Format: &format, Alt: &alt}
	asset := buildInlineMediaAsset("data:image/png;base64,"+payload, "images", item, 100)
	if asset == nil {
		t.Fatal("inline asset is nil")
	}
	if asset.SourceURL != "data-uri:inline" || asset.Bytes != 3 || string(asset.Data) != "abc" {
		t.Fatalf("inline asset = %#v", asset)
	}
	requireStringPtr(t, asset.ContentType, "image/png", "inline content type")
	requireStringPtr(t, asset.Format, "image/png", "inline format")
	requireStringPtr(t, asset.Alt, "alt", "inline alt")

	whitespace := "data:image/png;base64,YW Jj"
	if asset := buildInlineMediaAsset(whitespace, "images", item, 100); asset == nil || string(asset.Data) != "abc" {
		t.Fatalf("whitespace payload = %#v", asset)
	}
	if asset := buildInlineMediaAsset("data:image/png;base64,"+payload, "images", item, 2); asset != nil {
		t.Fatalf("payload over max bytes must be skipped: %#v", asset)
	}
	if asset := buildInlineMediaAsset("data:image/png;base64,"+payload, "images", item, 0); asset != nil {
		t.Fatalf("max bytes 0 disables inline assets: %#v", asset)
	}
	if asset := buildInlineMediaAsset("data:image/png,"+payload, "images", item, 100); asset != nil {
		t.Fatalf("non base64 data URI must be skipped: %#v", asset)
	}
	if asset := buildInlineMediaAsset("data:image/png;base64,@@@@", "images", item, 100); asset != nil {
		t.Fatalf("invalid base64 alphabet must be skipped: %#v", asset)
	}
	if asset := buildInlineMediaAsset("data:image/png;base64", "images", item, 100); asset != nil {
		t.Fatalf("data URI without comma must be skipped: %#v", asset)
	}
	oversizedURI := "data:image/png;base64," + strings.Repeat("A", 1100)
	if asset := buildInlineMediaAsset(oversizedURI, "images", item, 3); asset != nil {
		t.Fatalf("oversized data URI must be skipped: %#v", asset)
	}
}

func TestFetchMediaAsset(t *testing.T) {
	t.Run("success keeps the raw content type", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/jpeg; charset=binary")
			w.Header().Set("Content-Length", "4")
			_, _ = w.Write([]byte{0x01, 0x02, 0x03, 0x04})
		}))
		defer server.Close()
		asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100}, server.URL+"/a.jpg", "images", mediaItem{})
		if asset == nil {
			t.Fatal("asset is nil")
		}
		if asset.Kind != "images" || asset.SourceURL != server.URL+"/a.jpg" || asset.Bytes != 4 {
			t.Fatalf("asset = %#v", asset)
		}
		requireStringPtr(t, asset.ContentType, "image/jpeg; charset=binary", "download content type")
	})
	t.Run("content type falls back to the item format", func(t *testing.T) {
		format := "image/webp"
		client := &http.Client{Transport: mediaRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{},
				Body:       io.NopCloser(strings.NewReader("abc")),
				Request:    request,
			}, nil
		})}
		asset := fetchMediaAsset(context.Background(), client,
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100}, "https://cdn.example/a", "images", mediaItem{Format: &format})
		if asset == nil {
			t.Fatal("asset is nil")
		}
		requireStringPtr(t, asset.ContentType, "image/webp", "fallback content type")
	})
	t.Run("non image content type is downloaded", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html></html>"))
		}))
		defer server.Close()
		asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100}, server.URL+"/page", "images", mediaItem{})
		if asset == nil {
			t.Fatal("asset is nil")
		}
		// The content-type filter lives in the storage layer (sanitize), not in
		// the download.
		requireStringPtr(t, asset.ContentType, "text/html", "download content type")
	})
	t.Run("content length over the ceiling skips the asset", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Content-Length", "100")
			_, _ = w.Write([]byte{0x01})
		}))
		defer server.Close()
		if asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 10}, server.URL+"/a.png", "images", mediaItem{}); asset != nil {
			t.Fatalf("oversized asset = %#v", asset)
		}
	})
	t.Run("chunked body over the ceiling skips the asset", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			// Flushing before the first write removes the automatically computed
			// Content-Length, so the body-size guard is the one under test.
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			_, _ = w.Write(make([]byte, 20))
		}))
		defer server.Close()
		if asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 10}, server.URL+"/a.png", "images", mediaItem{}); asset != nil {
			t.Fatalf("oversized chunked asset = %#v", asset)
		}
	})
	t.Run("timeout skips the asset", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(120 * time.Millisecond)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte{0x01})
		}))
		defer server.Close()
		start := time.Now()
		asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 20, MaxBytes: 100}, server.URL+"/slow.png", "images", mediaItem{})
		if asset != nil {
			t.Fatalf("timed out asset = %#v", asset)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("timeout was not enforced: %v", elapsed)
		}
	})
	t.Run("non 2xx status skips the asset", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.NotFound(w, nil)
		}))
		defer server.Close()
		if asset := fetchMediaAsset(context.Background(), server.Client(),
			mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100}, server.URL+"/missing.png", "images", mediaItem{}); asset != nil {
			t.Fatalf("404 asset = %#v", asset)
		}
	})
}

func TestCollectCrawlMediaAssetsRespectsMaxPerResult(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x01, 0x02, 0x03})
	}))
	defer server.Close()
	raw := fmt.Sprintf(`{"images":[
		{"src":%q,"alt":"one"},
		{"src":%q,"alt":"two"},
		{"src":%q,"alt":"three"}
	]}`, server.URL+"/1.png", server.URL+"/2.png", server.URL+"/3.png")
	collection := normalizeMediaCollection(json.RawMessage(raw))
	repository := &fakeMediaRepository{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, server.Client())

	collectCrawlMediaAssets(context.Background(), mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100, MaxPerResult: 2},
		store, testTask(), "result-1", collection)

	if len(repository.mysqlRows) != 2 {
		t.Fatalf("stored = %d, want 2", len(repository.mysqlRows))
	}
	if repository.mysqlRows[0].SourceURL != server.URL+"/1.png" || repository.mysqlRows[1].SourceURL != server.URL+"/2.png" {
		t.Fatalf("stored order = %q, %q", repository.mysqlRows[0].SourceURL, repository.mysqlRows[1].SourceURL)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("downloads = %d, want 2", got)
	}
	if repository.mysqlRows[0].Alt == nil || *repository.mysqlRows[0].Alt != "one" {
		t.Fatalf("item metadata not carried into the asset: %#v", repository.mysqlRows[0].Alt)
	}
}

func TestCollectCrawlMediaAssetsDeduplicatesURLs(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x01})
	}))
	defer server.Close()
	raw := fmt.Sprintf(`{"images":[{"src":%q},{"src":%q}]}`, server.URL+"/same.png", server.URL+"/same.png")
	collection := normalizeMediaCollection(json.RawMessage(raw))
	repository := &fakeMediaRepository{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, server.Client())

	collectCrawlMediaAssets(context.Background(), mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100, MaxPerResult: 10},
		store, testTask(), "result-1", collection)

	if len(repository.mysqlRows) != 1 {
		t.Fatalf("stored = %d, want 1", len(repository.mysqlRows))
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("downloads = %d, want 1", got)
	}
}

func TestCollectCrawlMediaAssetsContinuesAfterFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x01})
	}))
	defer server.Close()
	raw := fmt.Sprintf(`{"images":[{"src":%q},{"src":%q}]}`, server.URL+"/1.png", server.URL+"/2.png")
	collection := normalizeMediaCollection(json.RawMessage(raw))
	repository := &fakeMediaRepository{mysqlErr: fmt.Errorf("deadlock"), mysqlErrCalls: 1}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, server.Client())

	collectCrawlMediaAssets(context.Background(), mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100, MaxPerResult: 10},
		store, testTask(), "result-1", collection)

	if len(repository.mysqlRows) != 1 || repository.mysqlRows[0].SourceURL != server.URL+"/2.png" {
		t.Fatalf("a store failure must not abort the remaining assets: %#v", repository.mysqlRows)
	}
}

func TestCollectCrawlMediaAssetsSkipsDownloadFailures(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		atomic.AddInt32(&hits, 1)
		if strings.HasSuffix(request.URL.Path, "/missing.png") {
			http.NotFound(w, request)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x01})
	}))
	defer server.Close()
	raw := fmt.Sprintf(`{"images":[{"src":%q},{"src":%q}]}`, server.URL+"/missing.png", server.URL+"/ok.png")
	collection := normalizeMediaCollection(json.RawMessage(raw))
	repository := &fakeMediaRepository{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, server.Client())

	collectCrawlMediaAssets(context.Background(), mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100, MaxPerResult: 10},
		store, testTask(), "result-1", collection)

	if len(repository.mysqlRows) != 1 || repository.mysqlRows[0].SourceURL != server.URL+"/ok.png" {
		t.Fatalf("download failures must be skipped: %#v", repository.mysqlRows)
	}
}

func TestMediaDocumentMatchesReadModel(t *testing.T) {
	collection := normalizeMediaCollection(json.RawMessage(`{
		"images":[{
			"src":"https://cdn.example/a.jpg",
			"alt":"A",
			"width":640,
			"height":480,
			"score":7.5,
			"srcset":["a.jpg 1x","a.jpg 2x"],
			"sources":[{"src":"https://cdn.example/a.webp","type":"image/webp"}],
			"class":"hero"
		}]
	}`))
	if collection == nil {
		t.Fatal("collection is nil")
	}
	document, err := collection.bsonDocument()
	if err != nil {
		t.Fatalf("bson document: %v", err)
	}
	if _, ok := bsonFieldValue(t, document, "images").(bson.A); !ok {
		t.Fatalf("images must encode as an array: %#v", bsonFieldValue(t, document, "images"))
	}
	encoded, err := bson.Marshal(bson.D{{Key: "media", Value: document}})
	if err != nil {
		t.Fatalf("marshal media document: %v", err)
	}
	var persisted struct {
		Media telemetry.CrawlMediaCollection `bson:"media"`
	}
	if err := bson.Unmarshal(encoded, &persisted); err != nil {
		t.Fatalf("unmarshal read model: %v", err)
	}
	items := persisted.Media["images"]
	if len(items) != 1 {
		t.Fatalf("read model items = %d", len(items))
	}
	item := items[0]
	requireStringPtr(t, item.Src, "https://cdn.example/a.jpg", "read src")
	requireStringPtr(t, item.Alt, "A", "read alt")
	if item.Width == nil || *item.Width != 640 || item.Height == nil || *item.Height != 480 {
		t.Fatalf("read dimensions = %#v/%#v", item.Width, item.Height)
	}
	if item.Score == nil || *item.Score != 7.5 {
		t.Fatalf("read score = %#v", item.Score)
	}
	if len(item.Srcset) != 2 {
		t.Fatalf("read srcset = %#v", item.Srcset)
	}
	if len(item.PictureSources) != 1 {
		t.Fatalf("read pictureSources = %#v", item.PictureSources)
	}
	requireStringPtr(t, item.PictureSources[0].Src, "https://cdn.example/a.webp", "read picture src")
	if !strings.Contains(string(item.Raw), `"class":"hero"`) {
		t.Fatalf("read raw = %s", item.Raw)
	}
}

func TestCollectCrawlMediaAssetsDoesNotMutateCollection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.NotFound(w, request)
	}))
	defer server.Close()
	raw := fmt.Sprintf(`{"images":[{"src":%q,"alt":"kept"},{"src":%q,"alt":"also-kept"}]}`,
		server.URL+"/missing-1.png", server.URL+"/missing-2.png")
	collection := normalizeMediaCollection(json.RawMessage(raw))
	if collection == nil {
		t.Fatal("collection is nil")
	}
	repository := &fakeMediaRepository{}
	store := newTestMediaStore(repository, &fakeMediaStorage{provider: objectstorage.ProviderMySQL}, nil, server.Client())

	collectCrawlMediaAssets(context.Background(), mediaConfig{FetchTimeoutMs: 1000, MaxBytes: 100, MaxPerResult: 10},
		store, testTask(), "result-1", collection)

	// The normalized collection is independent from the stored assets: a failed
	// download must not drop the media reference from CrawlResultContent.
	if len(repository.mysqlRows) != 0 {
		t.Fatalf("no asset should be stored: %#v", repository.mysqlRows)
	}
	if len(collection.buckets) != 1 || len(collection.buckets[0].Items) != 2 {
		t.Fatalf("collection mutated: %#v", collection.buckets)
	}
	requireStringPtr(t, collection.buckets[0].Items[0].Src, server.URL+"/missing-1.png", "kept src")
	requireStringPtr(t, collection.buckets[0].Items[1].Alt, "also-kept", "kept alt")
}
