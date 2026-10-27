package crawlreadtelemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// testJWTSecret is the HMAC key used by the media access tests.
const testJWTSecret = "test-jwt-secret"

// TestSignAndVerifySignedAssetAccess covers the HMAC contract: a freshly signed
// URL verifies, and every rejection reason matches the NestJS order and text.
func TestSignAndVerifySignedAssetAccess(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	mode := CrawlMediaAccessModePreview
	expiresAtMs := time.Now().UnixMilli() + 60_000
	expiresRaw := strconv.FormatInt(expiresAtMs, 10)
	signature := service.signAssetAccess("asset-1", mode, expiresAtMs, "org-1", "user-1")

	if reason := service.verifySignedAssetAccess("asset-1", mode, expiresRaw, "org-1", "user-1", signature); reason != "" {
		t.Fatalf("valid signature rejected: %s", reason)
	}

	cases := []struct {
		name                             string
		assetID                          string
		expiresRaw, orgRaw, userRaw, sig string
		want                             string
	}{
		{"missing signature", "asset-1", expiresRaw, "org-1", "user-1", "", "Missing signature"},
		{"missing org", "asset-1", expiresRaw, "", "user-1", signature, "Missing access scope"},
		{"missing user", "asset-1", expiresRaw, "org-1", "", signature, "Missing access scope"},
		{"bad expires", "asset-1", "not-a-number", "org-1", "user-1", signature, "Invalid expires timestamp"},
		{"expired", "asset-1", strconv.FormatInt(time.Now().UnixMilli()-1_000, 10), "org-1", "user-1", signature, "Signature expired"},
		{"window too large", "asset-1", strconv.FormatInt(time.Now().UnixMilli()+signatureWindowMs+60_000, 10), "org-1", "user-1", signature, "Signature window too large"},
		{"tampered asset", "asset-2", expiresRaw, "org-1", "user-1", signature, "Invalid signature"},
		{"tampered org", "asset-1", expiresRaw, "org-2", "user-1", signature, "Invalid signature"},
		{"tampered signature", "asset-1", expiresRaw, "org-1", "user-1", "AAAA", "Invalid signature"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := service.verifySignedAssetAccess(tc.assetID, mode, tc.expiresRaw, tc.orgRaw, tc.userRaw, tc.sig); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestParseExpiresAtMs covers the Number.parseInt prefix tolerance.
func TestParseExpiresAtMs(t *testing.T) {
	cases := []struct {
		raw  string
		want int64
		ok   bool
	}{
		{"123", 123, true},
		{"123abc", 123, true},
		{" 42 ", 42, true},
		{"+7", 7, true},
		{"-7", -7, true},
		{"abc", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseExpiresAtMs(tc.raw)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Fatalf("parseExpiresAtMs(%q) = (%d, %v), want (%d, %v)", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

// TestResolveDeliveryContentType covers alias mapping and the downgrade of every
// non media content type to application/octet-stream.
func TestResolveDeliveryContentType(t *testing.T) {
	cases := []struct {
		raw   string
		valid bool
		want  string
	}{
		{"image/png", true, "image/png"},
		{"image/jpg", true, "image/jpeg"},
		{"image/svg", true, "image/svg+xml"},
		{"svg", true, "image/svg+xml"},
		{"audio/mp3", true, "audio/mpeg"},
		{"video/mp4; charset=binary", true, "video/mp4"},
		{"IMAGE/PNG", true, "image/png"},
		{"text/html", true, defaultBinaryContentType},
		{"application/json", true, defaultBinaryContentType},
		{"not a content type", true, defaultBinaryContentType},
		{"", false, defaultBinaryContentType},
	}
	for _, tc := range cases {
		got := resolveDeliveryContentType(sql.NullString{String: tc.raw, Valid: tc.valid})
		if got != tc.want {
			t.Fatalf("resolveDeliveryContentType(%q, valid=%v) = %q, want %q", tc.raw, tc.valid, got, tc.want)
		}
	}
}

// TestIsInlinePreviewContentType pins the inline allow list: raster images,
// video and audio are inline, SVG never is.
func TestIsInlinePreviewContentType(t *testing.T) {
	cases := map[string]bool{
		"image/png":                true,
		"image/jpeg":               true,
		"image/avif":               true,
		"video/mp4":                true,
		"video/quicktime":          true,
		"audio/mpeg":               true,
		"image/svg+xml":            false,
		"application/octet-stream": false,
		"text/html":                false,
	}
	for contentType, want := range cases {
		if got := isInlinePreviewContentType(contentType); got != want {
			t.Fatalf("isInlinePreviewContentType(%q) = %v, want %v", contentType, got, want)
		}
	}
}

// TestBuildContentDisposition pins the attachment/inline header shape and the
// two escaped characters.
func TestBuildContentDisposition(t *testing.T) {
	if got := buildContentDisposition("attachment", `a"b\c.png`); got != `attachment; filename="a_b_c.png"` {
		t.Fatalf("attachment disposition = %q", got)
	}
	if got := buildContentDisposition("inline", "image-1.png"); got != `inline; filename="image-1.png"` {
		t.Fatalf("inline disposition = %q", got)
	}
}

// TestBuildAssetFileName covers the kind-id-extension shape. The content type
// argument is the already-resolved type, exactly like the NestJS callers.
func TestBuildAssetFileName(t *testing.T) {
	cases := []struct {
		kind, id, contentType, format, want string
	}{
		{"image", "asset-1", "image/png", "", "image-asset-1.png"},
		{"image", "asset-2", "image/svg+xml", "", "image-asset-2.svg"},
		{"video", "asset-3", "video/mp4", "", "video-asset-3.mp4"},
		{"audio", "asset-4", "audio/mpeg", "", "audio-asset-4.mp3"},
		{"file", "asset-5", "application/octet-stream", "webp", "file-asset-5.webp"},
		{"file", "asset-6", "", "", "file-asset-6"},
	}
	for _, tc := range cases {
		got := buildAssetFileName(tc.kind, tc.id, tc.contentType, tc.format)
		if got != tc.want {
			t.Fatalf("buildAssetFileName(%q, %q, %q, %q) = %q, want %q", tc.kind, tc.id, tc.contentType, tc.format, got, tc.want)
		}
	}
}

// TestResolveDeliveryFileNameUsesResolvedContentType pins the aliased stored
// value case: NestJS resolves "jpg" to image/jpeg before picking the extension,
// so the delivered file name must end in .jpg instead of falling back to the
// format column.
func TestResolveDeliveryFileNameUsesResolvedContentType(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	record := crawlMediaDeliveryRecord{
		ID:          "asset-7",
		Provider:    string(CrawlImageStorageProviderMySQL),
		Kind:        "image",
		ContentType: sql.NullString{String: "jpg", Valid: true},
		JoinedBlob:  []byte{0x89, 0x50},
	}
	payload, err := service.resolveDelivery(context.Background(), record, CrawlMediaAccessModeDownload)
	if err != nil {
		t.Fatalf("resolveDelivery: %v", err)
	}
	if payload == nil || payload.FileName != "image-asset-7.jpg" {
		t.Fatalf("file name = %+v", payload)
	}
	if payload.ContentType != "image/jpeg" {
		t.Fatalf("content type = %q", payload.ContentType)
	}
}

// TestStringPtrFromNullKeepsEmptyString pins the NestJS `?? undefined`
// projection: a present empty column value stays "", only NULL becomes null.
func TestStringPtrFromNullKeepsEmptyString(t *testing.T) {
	if got := stringPtrFromNull(sql.NullString{}); got != nil {
		t.Fatalf("NULL = %v, want nil", *got)
	}
	empty := stringPtrFromNull(sql.NullString{String: "", Valid: true})
	if empty == nil || *empty != "" {
		t.Fatalf("empty string = %v, want pointer to \"\"", empty)
	}
	value := stringPtrFromNull(sql.NullString{String: "kept", Valid: true})
	if value == nil || *value != "kept" {
		t.Fatalf("present value = %v", value)
	}
}

// TestNormalizeSignedURLTTL pins the 30..86400 clamp.
func TestNormalizeSignedURLTTL(t *testing.T) {
	cases := map[float64]int{
		0:      minSignedURLTTLSeconds,
		10:     minSignedURLTTLSeconds,
		300:    300,
		100000: maxSignedURLTTLSeconds,
	}
	for value, want := range cases {
		if got := normalizeSignedURLTTL(value); got != want {
			t.Fatalf("normalizeSignedURLTTL(%v) = %d, want %d", value, got, want)
		}
	}
}

// TestObjectJSONOrNull covers the config guard (object or null, never an array).
func TestObjectJSONOrNull(t *testing.T) {
	if got := objectJSONOrNull([]byte(`{"a":1}`)); string(got) != `{"a":1}` {
		t.Fatalf("object = %s", got)
	}
	for _, raw := range []string{"", "null", "[1,2]", `"text"`, "42"} {
		if got := objectJSONOrNull([]byte(raw)); got != nil {
			t.Fatalf("objectJSONOrNull(%q) = %s, want nil", raw, got)
		}
	}
	encoded, err := json.Marshal(objectJSONOrNull(nil))
	if err != nil || string(encoded) != "null" {
		t.Fatalf("nil RawJSON encoded as %s (err=%v)", encoded, err)
	}
}

// TestStringArrayFromJSON covers fromJsonArray: non-strings are dropped.
func TestStringArrayFromJSON(t *testing.T) {
	got := stringArrayFromJSON([]byte(`["a",2,null,"b"]`))
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("stringArrayFromJSON = %v", got)
	}
	if empty := stringArrayFromJSON(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("nil payload = %v, want empty non-nil slice", empty)
	}
	if notArray := stringArrayFromJSON([]byte(`{"a":1}`)); len(notArray) != 0 {
		t.Fatalf("object payload = %v, want empty slice", notArray)
	}
}

// TestJSTimeMarshal verifies the JavaScript Date.toISOString formatting.
func TestJSTimeMarshal(t *testing.T) {
	encoded, err := json.Marshal(JSTime{Time: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `"2026-10-17T12:00:00.000Z"` {
		t.Fatalf("JSTime = %s", encoded)
	}
	var roundTrip JSTime
	if err := json.Unmarshal([]byte(`"2026-10-17T12:00:00.000Z"`), &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !roundTrip.Equal(time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("JSTime round trip = %s", roundTrip.Time)
	}
}

// TestCrawlQualitySafeRatio pins the toFixed(4) parity.
func TestCrawlQualitySafeRatio(t *testing.T) {
	cases := []struct {
		numerator, denominator int
		want                   float64
	}{
		{1, 3, 0.3333},
		{2, 3, 0.6667},
		{1, 0, 0},
		{1, -1, 0},
		{0, 5, 0},
	}
	for _, tc := range cases {
		if got := crawlQualitySafeRatio(tc.numerator, tc.denominator); got != tc.want {
			t.Fatalf("crawlQualitySafeRatio(%d, %d) = %v, want %v", tc.numerator, tc.denominator, got, tc.want)
		}
	}
}

// TestCrawlQualitySourceProjection covers the matching and missing branches of
// getSourceSnapshot.
func TestCrawlQualitySourceProjection(t *testing.T) {
	base := CrawlQualityMetricsSnapshot{
		OrgID:     "org-1",
		TaskCount: 7,
		GroupedBySource: []CrawlQualityMetricsSourceSnapshot{
			{SourceID: "source-1", TaskCount: 3},
			{SourceID: "source-2", TaskCount: 4},
		},
		AlertThresholds: CrawlQualityAlertThresholds{PreflightFailureRateHigh: 0.15},
	}
	matched := crawlQualitySourceProjection(base, "source-2")
	if matched.TaskCount != 4 || len(matched.GroupedBySource) != 1 || matched.GroupedBySource[0].SourceID != "source-2" {
		t.Fatalf("matched projection = %+v", matched)
	}
	if matched.OrgID != "org-1" || matched.AlertThresholds.PreflightFailureRateHigh != 0.15 {
		t.Fatalf("matched projection lost the base fields: %+v", matched)
	}

	missing := crawlQualitySourceProjection(base, "source-9")
	if missing.TaskCount != 0 || len(missing.GroupedBySource) != 0 {
		t.Fatalf("missing projection = %+v", missing)
	}
	if missing.GroupedBySource == nil {
		t.Fatal("missing projection must serialize groupedBySource as []")
	}
	encoded, err := json.Marshal(missing)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(encoded) || !containsAll(string(encoded), `"groupedBySource":[]`, `"orgId":"org-1"`) {
		t.Fatalf("missing projection JSON = %s", encoded)
	}
}

// containsAll reports whether every needle appears in value.
func containsAll(value string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			return false
		}
	}
	return true
}

// TestRawJSONDecodesScalarsAndDocuments pins the BSON -> relaxed JSON contract
// of RawJSON: scalars, arrays and documents all survive the wrapper (the
// extended-JSON writer needs a document context to emit a scalar).
func TestRawJSONDecodesScalarsAndDocuments(t *testing.T) {
	document, err := bson.Marshal(bson.D{
		{Key: "text", Value: "hello"},
		{Key: "count", Value: int32(7)},
		{Key: "flag", Value: true},
		{Key: "ratio", Value: 1.5},
		{Key: "list", Value: []string{"a", "b"}},
		{Key: "nested", Value: bson.D{{Key: "k", Value: "v"}}},
		{Key: "nothing", Value: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Text    RawJSON `bson:"text"`
		Count   RawJSON `bson:"count"`
		Flag    RawJSON `bson:"flag"`
		Ratio   RawJSON `bson:"ratio"`
		List    RawJSON `bson:"list"`
		Nested  RawJSON `bson:"nested"`
		Nothing RawJSON `bson:"nothing"`
	}
	if err := bson.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		value RawJSON
		want  string
	}{
		"text":   {decoded.Text, `"hello"`},
		"count":  {decoded.Count, "7"},
		"flag":   {decoded.Flag, "true"},
		"ratio":  {decoded.Ratio, "1.5"},
		"list":   {decoded.List, `["a","b"]`},
		"nested": {decoded.Nested, `{"k":"v"}`},
		"null":   {decoded.Nothing, "null"},
	}
	for name, tc := range cases {
		encoded, err := json.Marshal(tc.value)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if string(encoded) != tc.want {
			t.Fatalf("%s = %s, want %s", name, encoded, tc.want)
		}
	}
}

// TestCrawlTableCellDecodesScalars pins the table-cell wrapper used by the
// crawlresultcontents tables Mixed field.
func TestCrawlTableCellDecodesScalars(t *testing.T) {
	document, err := bson.Marshal(bson.D{{Key: "cell", Value: "v"}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Cell CrawlTableCell `bson:"cell"`
	}
	if err := bson.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(decoded.Cell)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `"v"` {
		t.Fatalf("cell = %s, want \"v\"", encoded)
	}
}

// TestResolveMediaAccessKeepsRawOrgQueryValue pins the NestJS lookup contract of
// the public media route: the HMAC scope is trimmed before it is hashed, but the
// CrawlMediaAsset row is looked up by the RAW `org` query value. A padded scope
// that still verifies must not widen the database match.
func TestResolveMediaAccessKeepsRawOrgQueryValue(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	handler := NewHandler(nil, service)

	expiresAtMs := time.Now().UnixMilli() + 60_000
	signature := service.signAssetAccess("asset-1", CrawlMediaAccessModePreview, expiresAtMs, "org-1", "user-1")
	query := url.Values{
		"exp":  {strconv.FormatInt(expiresAtMs, 10)},
		"org":  {" org-1 "},
		"user": {"user-1"},
		"sig":  {signature},
	}
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/crawl-media-assets/asset-1/preview?"+query.Encode(),
		nil,
	)
	mode, lookupOrg, err := handler.resolveMediaAccess("asset-1", "preview", request)
	if err != nil {
		t.Fatalf("resolveMediaAccess: %v", err)
	}
	if mode != CrawlMediaAccessModePreview {
		t.Fatalf("mode = %q", mode)
	}
	if lookupOrg != " org-1 " {
		t.Fatalf("lookup org = %q, want the raw query value", lookupOrg)
	}
}

// TestResolveMediaAccessRejections pins the mode check order and the signature
// failure mapping onto the media route statuses.
func TestResolveMediaAccessRejections(t *testing.T) {
	service := &Service{jwtSecret: testJWTSecret}
	handler := NewHandler(nil, service)
	request := httptest.NewRequest(http.MethodGet, "/api/crawl-media-assets/asset-1/inline", nil)

	_, _, err := handler.resolveMediaAccess("asset-1", "inline", request)
	var typed *statusError
	if !errors.As(err, &typed) || typed.status != http.StatusNotFound ||
		typed.message != "Unsupported crawl media access mode" {
		t.Fatalf("unsupported mode error = %v", err)
	}

	_, _, err = handler.resolveMediaAccess("asset-1", "preview", request)
	if !errors.As(err, &typed) || typed.status != http.StatusBadRequest ||
		typed.message != "Missing signature" {
		t.Fatalf("missing signature error = %v", err)
	}
}
