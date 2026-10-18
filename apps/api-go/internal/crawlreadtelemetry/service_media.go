package crawlreadtelemetry

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

// Media asset signing and content-type constants, copied from
// crawl-media-asset.service.ts.
const (
	minSignedURLTTLSeconds     = 30
	maxSignedURLTTLSeconds     = 86_400
	defaultSignedURLTTLSeconds = 300
	defaultBinaryContentType   = "application/octet-stream"

	// signatureWindowMs is MAX_SIGNED_URL_TTL_SECONDS * 1000.
	signatureWindowMs = int64(maxSignedURLTTLSeconds) * 1000
)

// contentTypeAliases maps shorthand and non-canonical content types onto their
// canonical form, mirroring CONTENT_TYPE_ALIASES.
var contentTypeAliases = map[string]string{
	"image/jpg": "image/jpeg",
	"image/svg": "image/svg+xml",
	"audio/mp3": "audio/mpeg",
	"jpg":       "image/jpeg",
	"jpeg":      "image/jpeg",
	"png":       "image/png",
	"webp":      "image/webp",
	"gif":       "image/gif",
	"svg":       "image/svg+xml",
	"svg+xml":   "image/svg+xml",
	"avif":      "image/avif",
	"bmp":       "image/bmp",
	"mp4":       "video/mp4",
	"webm":      "video/webm",
	"ogg":       "audio/ogg",
	"wav":       "audio/wav",
	"mp3":       "audio/mpeg",
	"mpeg":      "audio/mpeg",
	"aac":       "audio/aac",
	"flac":      "audio/flac",
}

// inlinePreviewContentTypes is the union of the three inline allow lists.
// image/svg+xml is deliberately absent: SVG is always served as an attachment.
var inlinePreviewContentTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/webp":      true,
	"image/gif":       true,
	"image/avif":      true,
	"image/bmp":       true,
	"video/mp4":       true,
	"video/webm":      true,
	"video/ogg":       true,
	"video/quicktime": true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"audio/wav":       true,
	"audio/webm":      true,
	"audio/aac":       true,
	"audio/flac":      true,
}

// crawlMediaDeliveryPayload is the resolved delivery for one asset.
type crawlMediaDeliveryPayload struct {
	ContentType string
	InlineSafe  bool
	Bytes       int
	FileName    string
	RedirectURL string
	Data        []byte
}

// crawlMediaAssetRow is one MySQL CrawlMediaAsset row (plus the joined blob)
// used by the detail hydration.
type crawlMediaAssetRow struct {
	ID           string
	ResultID     string
	Provider     string
	Kind         string
	SourceURL    string
	Bytes        int
	ContentType  sql.NullString
	StorageKey   sql.NullString
	Width        sql.NullInt64
	Height       sql.NullInt64
	Alt          sql.NullString
	Title        sql.NullString
	Desc         sql.NullString
	Poster       sql.NullString
	Format       sql.NullString
	MetadataJSON []byte
}

// serveMediaAsset handles GET /api/crawl-media-assets/:assetId/:mode. The route
// is public; authenticity comes exclusively from the HMAC query signature.
func (h *Handler) serveMediaAsset(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.svc == nil {
		writeServiceError(w, r, fmt.Errorf("%w: mysql is not configured", errDatabase))
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, crawlMediaAssetsPrefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeServiceError(w, r, newStatusError(http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path))
		return
	}
	assetID, modeRaw := parts[0], parts[1]

	mode := CrawlMediaAccessMode(modeRaw)
	if mode != CrawlMediaAccessModePreview && mode != CrawlMediaAccessModeDownload {
		writeServiceError(w, r, newStatusError(http.StatusNotFound, "Unsupported crawl media access mode"))
		return
	}

	expiresRaw, _ := querySingle(r, "exp")
	orgRaw, _ := querySingle(r, "org")
	userRaw, _ := querySingle(r, "user")
	signature, _ := querySingle(r, "sig")

	if reason := h.svc.verifySignedAssetAccess(assetID, mode, expiresRaw, orgRaw, userRaw, signature); reason != "" {
		writeServiceError(w, r, newStatusError(http.StatusBadRequest, reason))
		return
	}

	orgID := normalizeAccessScopeValue(orgRaw)
	payload, err := h.svc.getAssetDeliveryPayload(r.Context(), assetID, mode, orgID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if payload == nil {
		writeServiceError(w, r, newStatusError(http.StatusNotFound, "Crawl media asset not found"))
		return
	}
	if payload.RedirectURL != "" {
		http.Redirect(w, r, payload.RedirectURL, http.StatusFound)
		return
	}
	if len(payload.Data) == 0 {
		writeServiceError(w, r, newStatusError(http.StatusNotFound, "Crawl media payload is unavailable"))
		return
	}

	disposition := "attachment"
	if mode == CrawlMediaAccessModePreview && payload.InlineSafe {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", payload.ContentType)
	w.Header().Set("Content-Length", strconv.Itoa(payload.Bytes))
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if disposition == "inline" {
		// SVG is not on the inline allow list, so inline responses are limited
		// to raster images, video and audio; the CSP sandbox contains any
		// residual script execution risk.
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	}
	w.Header().Set("Content-Disposition", buildContentDisposition(disposition, payload.FileName))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload.Data)
}

// verifySignedAssetAccess mirrors verifySignedAssetAccess. It returns the exact
// NestJS rejection reason, or an empty string when the signature is valid.
func (s *Service) verifySignedAssetAccess(
	assetID string,
	mode CrawlMediaAccessMode,
	expiresRaw, orgRaw, userRaw, signature string,
) string {
	if signature == "" {
		return "Missing signature"
	}
	orgID := normalizeAccessScopeValue(orgRaw)
	userID := normalizeAccessScopeValue(userRaw)
	if orgID == "" || userID == "" {
		return "Missing access scope"
	}
	expiresAtMs, ok := parseExpiresAtMs(expiresRaw)
	if !ok {
		return "Invalid expires timestamp"
	}
	now := time.Now().UnixMilli()
	if expiresAtMs <= now {
		return "Signature expired"
	}
	if expiresAtMs-now > signatureWindowMs {
		return "Signature window too large"
	}
	expected := s.signAssetAccess(assetID, mode, expiresAtMs, orgID, userID)
	if !safeCompareSignatures(expected, signature) {
		return "Invalid signature"
	}
	return ""
}

// normalizeAccessScopeValue trims and bounds an access-scope identifier,
// returning an empty string when it is missing or longer than 191 characters.
func normalizeAccessScopeValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > 191 {
		return ""
	}
	return trimmed
}

// parseExpiresAtMs mirrors Number.parseInt(value.trim(), 10): a leading
// integer prefix is accepted and trailing characters are ignored. A missing or
// digit-free value is rejected.
func parseExpiresAtMs(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	index := 0
	if trimmed[0] == '+' || trimmed[0] == '-' {
		index++
	}
	start := index
	for index < len(trimmed) && trimmed[index] >= '0' && trimmed[index] <= '9' {
		index++
	}
	if index == start {
		return 0, false
	}
	parsed, err := strconv.ParseInt(trimmed[:index], 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// safeCompareSignatures compares two base64url signatures in constant time
// after the same length pre-check NestJS performs.
func safeCompareSignatures(expected, actual string) bool {
	normalized := strings.TrimSpace(actual)
	if normalized == "" || len(normalized) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(normalized)) == 1
}

// signAssetAccess computes the HMAC-SHA256 base64url signature over
// "<assetId>:<mode>:<expiresAtMs>:<orgId>:<userId>" with JWT_SECRET as the key.
func (s *Service) signAssetAccess(assetID string, mode CrawlMediaAccessMode, expiresAtMs int64, orgID, userID string) string {
	payload := assetID + ":" + string(mode) + ":" + strconv.FormatInt(expiresAtMs, 10) + ":" + orgID + ":" + userID
	mac := hmac.New(sha256.New, []byte(s.jwtSecret))
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// buildSignedAssetURL renders the relative preview/download URL embedded in a
// crawl result. The exp/org/user/sig query parameters are the HMAC contract.
func (s *Service) buildSignedAssetURL(assetID string, mode CrawlMediaAccessMode, expiresAtMs int64, orgID, userID string) string {
	signature := s.signAssetAccess(assetID, mode, expiresAtMs, orgID, userID)
	return crawlMediaAssetsPrefix + assetID + "/" + string(mode) +
		"?exp=" + strconv.FormatInt(expiresAtMs, 10) +
		"&org=" + url.QueryEscape(orgID) +
		"&user=" + url.QueryEscape(userID) +
		"&sig=" + signature
}

// resolveDeliveryContentType maps aliases and downgrades everything that is not
// image/*, video/* or audio/* to application/octet-stream.
func resolveDeliveryContentType(value sql.NullString) string {
	if resolved := sanitizeStoredContentType(value); resolved != "" {
		return resolved
	}
	return defaultBinaryContentType
}

// sanitizeStoredContentType normalizes a stored content type and keeps it only
// when it is an image, video or audio type.
func sanitizeStoredContentType(value sql.NullString) string {
	normalized := normalizeContentType(value)
	if normalized == "" {
		return ""
	}
	if strings.HasPrefix(normalized, "image/") || strings.HasPrefix(normalized, "video/") || strings.HasPrefix(normalized, "audio/") {
		return normalized
	}
	return ""
}

// normalizeContentType strips parameters, lowercases, resolves aliases and
// validates the "type/subtype" shape.
func normalizeContentType(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	base := value.String
	if index := strings.Index(base, ";"); index >= 0 {
		base = base[:index]
	}
	normalized := strings.ToLower(strings.TrimSpace(base))
	if normalized == "" {
		return ""
	}
	if alias, ok := contentTypeAliases[normalized]; ok {
		normalized = alias
	}
	if !isValidContentType(normalized) {
		return ""
	}
	return normalized
}

// isValidContentType is the CONTENT_TYPE_PATTERN equivalent.
func isValidContentType(value string) bool {
	slash := strings.Index(value, "/")
	if slash <= 0 || slash == len(value)-1 {
		return false
	}
	for _, part := range []string{value[:slash], value[slash+1:]} {
		for _, char := range part {
			if !isContentTypeChar(char) {
				return false
			}
		}
	}
	return true
}

// isContentTypeChar is the character class of CONTENT_TYPE_PATTERN.
func isContentTypeChar(char rune) bool {
	if char >= 'a' && char <= 'z' {
		return true
	}
	if char >= '0' && char <= '9' {
		return true
	}
	switch char {
	case '!', '#', '$', '&', '^', '_', '.', '+', '-':
		return true
	default:
		return false
	}
}

// isInlinePreviewContentType reports whether the content type may be served
// inline. SVG is intentionally excluded.
func isInlinePreviewContentType(contentType string) bool {
	return inlinePreviewContentTypes[contentType]
}

// pickExtension chooses the file extension for a content type or format,
// mirroring pickExtension.
func pickExtension(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	normalized := strings.ToLower(value.String)
	switch {
	case strings.Contains(normalized, "jpeg"):
		return "jpg"
	case strings.Contains(normalized, "png"):
		return "png"
	case strings.Contains(normalized, "webp"):
		return "webp"
	case strings.Contains(normalized, "gif"):
		return "gif"
	case strings.Contains(normalized, "svg"):
		return "svg"
	case strings.Contains(normalized, "mp4"):
		return "mp4"
	case strings.Contains(normalized, "webm"):
		return "webm"
	case strings.Contains(normalized, "mpeg"):
		return "mp3"
	default:
		return ""
	}
}

// buildAssetFileName mirrors buildAssetFileName: "<kind>-<id>[.<ext>]".
func buildAssetFileName(kind, id string, contentType, format sql.NullString) string {
	extension := pickExtension(contentType)
	if extension == "" {
		extension = pickExtension(format)
	}
	suffix := ""
	if extension != "" {
		suffix = "." + extension
	}
	return kind + "-" + id + suffix
}

// buildContentDisposition renders a sanitized Content-Disposition header value.
func buildContentDisposition(disposition, fileName string) string {
	return disposition + `; filename="` + escapeFileName(fileName) + `"`
}

// escapeFileName replaces the two characters that could break out of the
// quoted-string header value.
func escapeFileName(value string) string {
	replacer := strings.NewReplacer(`\`, "_", `"`, "_")
	return replacer.Replace(value)
}

// normalizeSignedURLTTL mirrors normalizeSignedUrlTtl.
func normalizeSignedURLTTL(value float64) int {
	seconds := int(value)
	if seconds < minSignedURLTTLSeconds {
		seconds = minSignedURLTTLSeconds
	}
	if seconds > maxSignedURLTTLSeconds {
		seconds = maxSignedURLTTLSeconds
	}
	return seconds
}

// crawlMediaDeliveryRecord is the strongly typed projection of one
// CrawlMediaAsset row (plus the joined and legacy blob payloads) that the
// delivery resolution needs.
type crawlMediaDeliveryRecord struct {
	ID          string
	Provider    string
	Kind        string
	ContentType sql.NullString
	Format      sql.NullString
	Bytes       int
	StorageKey  sql.NullString
	JoinedBlob  []byte
	LegacyBlob  []byte
}

// getAssetDeliveryPayload loads one asset and resolves its delivery. It returns
// (nil, nil) when the asset does not exist or has no payload, matching the
// controller's 404 branches.
func (s *Service) getAssetDeliveryPayload(
	ctx context.Context,
	assetID string,
	mode CrawlMediaAccessMode,
	orgID string,
) (*crawlMediaDeliveryPayload, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	var record crawlMediaDeliveryRecord
	// Identifiers are quoted because `desc` is a MySQL reserved word and the
	// column names must survive unquoted keyword lookups.
	err := s.db.QueryRowContext(ctx,
		"SELECT a.`id`, a.`provider`, a.`kind`, a.`contentType`, a.`format`, a.`bytes`, a.`storageKey`, "+
			"a.`blobData` AS legacyBlobData, b.`blobData` AS joinedBlobData "+
			"FROM CrawlMediaAsset a "+
			"LEFT JOIN CrawlMediaBlob b ON b.`id` = a.`blobId` "+
			"WHERE a.`id` = ? AND a.`orgId` = ?", assetID, orgID,
	).Scan(&record.ID, &record.Provider, &record.Kind, &record.ContentType, &record.Format,
		&record.Bytes, &record.StorageKey, &record.LegacyBlob, &record.JoinedBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return s.resolveDelivery(ctx, record, mode)
}

// resolveDelivery turns one loaded record into the delivery payload. It is the
// single place where the mysql/S3 branch decision is made, so the branch cannot
// diverge between the controller path and the tests.
func (s *Service) resolveDelivery(
	ctx context.Context,
	record crawlMediaDeliveryRecord,
	mode CrawlMediaAccessMode,
) (*crawlMediaDeliveryPayload, error) {
	resolvedType := resolveDeliveryContentType(record.ContentType)
	inlineSafe := isInlinePreviewContentType(resolvedType)
	fileName := buildAssetFileName(record.Kind, record.ID, record.ContentType, record.Format)

	if CrawlImageStorageProvider(record.Provider) == CrawlImageStorageProviderMySQL {
		// Prefer the joined CrawlMediaBlob payload, then the legacy inline blob.
		data := record.JoinedBlob
		if len(data) == 0 {
			data = record.LegacyBlob
		}
		if len(data) == 0 {
			return nil, nil
		}
		return &crawlMediaDeliveryPayload{
			ContentType: resolvedType,
			InlineSafe:  inlineSafe,
			Bytes:       len(data),
			FileName:    fileName,
			Data:        data,
		}, nil
	}

	// The S3 branch follows the record's own provider. A record that belongs to
	// S3 must be served from its own storageKey even when the global
	// crawl_image_storage setting currently says mysql.
	if !record.StorageKey.Valid || record.StorageKey.String == "" {
		log.Printf("crawl read telemetry: S3 crawl media asset %s is missing storage key", record.ID)
		return nil, nil
	}
	client, err := s.storageClient(ctx)
	if err != nil {
		// An incomplete configuration is the NestJS BadRequestException (400);
		// a configuration read failure keeps the existing service error
		// semantics. Either way the asset is NOT reported as missing.
		return nil, err
	}
	responseDisposition := "attachment"
	if mode == CrawlMediaAccessModePreview && inlineSafe {
		responseDisposition = "inline"
	}
	// No explicit TTL: createObjectReadUrl uses the configured presigned TTL,
	// exactly like the NestJS media controller path.
	redirectURL, err := client.CreateObjectReadURL(ctx, record.StorageKey.String, objectstorage.ReadURLOptions{
		ResponseContentType:        resolvedType,
		ResponseContentDisposition: buildContentDisposition(responseDisposition, fileName),
		ResponseCacheControl:       storagePresignCacheControl,
	})
	if err != nil {
		return nil, err
	}
	return &crawlMediaDeliveryPayload{
		ContentType: resolvedType,
		InlineSafe:  inlineSafe,
		Bytes:       record.Bytes,
		FileName:    fileName,
		RedirectURL: redirectURL,
	}, nil
}

// listAssetsForTask loads the media assets of one crawl task and renders the
// signed URLs embedded in the detail response. MySQL records get HMAC URLs; S3
// records get presigned URLs from their own storageKey (both via the single
// storage snapshot passed in by the caller).
//
// The query always filters by orgId AND taskId (cross-tenant isolation fix): an
// asset that belongs to another organisation must never receive a signature
// scoped to the caller's orgId. Assets of results outside the requested
// (limited) result set are dropped in memory so the projection matches the
// NestJS listAssetsByResultIds contract.
func (s *Service) listAssetsForTask(
	ctx context.Context,
	orgID, userID, taskID string,
	resultIDs []string,
	ttlSeconds int,
	storageClient *objectstorage.Client,
) (map[string][]CrawlStoredMediaAsset, error) {
	grouped := make(map[string][]CrawlStoredMediaAsset)
	if len(resultIDs) == 0 {
		return grouped, nil
	}
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	requested := make(map[string]bool, len(resultIDs))
	for _, resultID := range resultIDs {
		requested[resultID] = true
	}

	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`, `resultId`, `provider`, `kind`, `sourceUrl`, `bytes`, `contentType`, `storageKey`, "+
			"`width`, `height`, `alt`, `title`, `desc`, `poster`, `format`, `metadata` "+
			"FROM CrawlMediaAsset "+
			"WHERE `orgId` = ? AND `taskId` = ? "+
			"ORDER BY `createdAt` ASC", orgID, taskID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	defer rows.Close()

	expiresAtMs := time.Now().UnixMilli() + int64(ttlSeconds)*1000
	for rows.Next() {
		var row crawlMediaAssetRow
		if err := rows.Scan(
			&row.ID, &row.ResultID, &row.Provider, &row.Kind, &row.SourceURL, &row.Bytes,
			&row.ContentType, &row.StorageKey, &row.Width, &row.Height, &row.Alt, &row.Title,
			&row.Desc, &row.Poster, &row.Format, &row.MetadataJSON,
		); err != nil {
			return nil, fmt.Errorf("%w: %v", errDatabase, err)
		}
		if !requested[row.ResultID] {
			continue
		}
		asset := s.buildStoredMediaAsset(ctx, row, expiresAtMs, orgID, userID, ttlSeconds, storageClient)
		grouped[row.ResultID] = append(grouped[row.ResultID], asset)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return grouped, nil
}

// buildStoredMediaAsset renders one CrawlStoredMediaAsset with signed URLs.
// The MySQL branch signs the HMAC delivery route; the S3 branch presigns the
// object with the record's own storageKey. An unknown provider keeps the record
// identity and no URL, which is the pre-existing behaviour.
func (s *Service) buildStoredMediaAsset(
	ctx context.Context,
	row crawlMediaAssetRow,
	expiresAtMs int64,
	orgID, userID string,
	ttlSeconds int,
	storageClient *objectstorage.Client,
) CrawlStoredMediaAsset {
	contentType := resolveDeliveryContentType(row.ContentType)
	inlineSafe := isInlinePreviewContentType(contentType)

	asset := CrawlStoredMediaAsset{
		ID:              row.ID,
		Kind:            row.Kind,
		SourceURL:       row.SourceURL,
		Bytes:           row.Bytes,
		ContentType:     contentType,
		StorageProvider: CrawlImageStorageProvider(row.Provider),
		Width:           intPtrFromNull(row.Width),
		Height:          intPtrFromNull(row.Height),
		Alt:             stringPtrFromNull(row.Alt),
		Title:           stringPtrFromNull(row.Title),
		Desc:            stringPtrFromNull(row.Desc),
		Poster:          stringPtrFromNull(row.Poster),
		Format:          stringPtrFromNull(row.Format),
		Metadata:        objectJSONOrNull(row.MetadataJSON),
	}
	if row.StorageKey.Valid && row.StorageKey.String != "" {
		asset.StorageKey = &row.StorageKey.String
	}

	switch asset.StorageProvider {
	case CrawlImageStorageProviderS3:
		// The S3 URL is minted from the record's own object key; a signing or
		// configuration failure leaves the URL unset and the asset intact.
		fileName := buildAssetFileName(row.Kind, row.ID, row.ContentType, row.Format)
		attachStoredS3URLs(ctx, storageClient, &asset, row, contentType, inlineSafe, fileName, ttlSeconds)
		return asset
	case CrawlImageStorageProviderMySQL:
		// Only the MySQL provider is served by the HMAC route.
		if inlineSafe {
			previewURL := s.buildSignedAssetURL(row.ID, CrawlMediaAccessModePreview, expiresAtMs, orgID, userID)
			asset.PreviewURL = &previewURL
		}
		downloadURL := s.buildSignedAssetURL(row.ID, CrawlMediaAccessModeDownload, expiresAtMs, orgID, userID)
		asset.DownloadURL = &downloadURL
		return asset
	default:
		return asset
	}
}

// intPtrFromNull converts a nullable SQL integer into a JSON pointer.
func intPtrFromNull(value sql.NullInt64) *int {
	if !value.Valid {
		return nil
	}
	converted := int(value.Int64)
	return &converted
}

// stringPtrFromNull converts a nullable SQL string into a JSON pointer. An
// empty string stays nil so the key is omitted, matching `?? undefined`.
func stringPtrFromNull(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	converted := value.String
	return &converted
}
