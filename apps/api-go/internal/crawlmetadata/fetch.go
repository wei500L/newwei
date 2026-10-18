package crawlmetadata

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// metadataUserAgent is the MetadataBot user agent the source sends. The fetch
// never forwards caller Authorization or Cookie headers.
const metadataUserAgent = "MetadataBot/1.0 (+https://github.com/unclecode/crawl4ai) crawl-metadata-service"

// fetchResponse is FetchResponse. HasBody distinguishes a real (possibly empty)
// body from the 304 response, exactly like the source's `typeof body ===
// "string"` check.
type fetchResponse struct {
	Status       int
	Body         string
	HasBody      bool
	ETag         string
	LastModified string
}

// fetchWithStatus performs a real GET with manual redirect handling. Every hop
// is validated against the shared SSRF rules before the request is issued, so a
// safe initial URL cannot be redirected into an internal address or a cloud
// metadata endpoint. Redirects are resolved relative to the current URL with a
// five hop ceiling. The timeout covers the whole call and is never reset per
// hop, matching the source's single AbortController.
func (s *Service) fetchWithStatus(ctx context.Context, rawURL string, timeoutMs int, extraHeaders map[string]string) (fetchResponse, error) {
	if timeoutMs <= 0 {
		timeoutMs = requestTimeoutMs
	}
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	current := rawURL
	for hop := 0; hop <= metadataMaxRedirect; hop++ {
		reason, ok := newssources.ValidateOutboundTargetURL(requestCtx, current)
		if !ok {
			return fetchResponse{}, errors.New("Blocked metadata target (potential SSRF): " + reason)
		}
		request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, current, nil)
		if err != nil {
			return fetchResponse{}, networkFetchError(err)
		}
		request.Header.Set("User-Agent", metadataUserAgent)
		for name, value := range extraHeaders {
			request.Header.Set(name, value)
		}
		response, err := s.httpClient().Do(request)
		if err != nil {
			// Node's fetch reports "fetch failed" with a cause; Go reports the
			// transport error (DNS, dial, TLS, context deadline) directly. The
			// text differs, the failed result and its boundary do not.
			return fetchResponse{}, networkFetchError(err)
		}
		location := response.Header.Get("Location")
		if response.StatusCode >= 300 && response.StatusCode < 400 && location != "" {
			_ = response.Body.Close()
			next, err := resolveRedirect(current, location)
			if err != nil {
				return fetchResponse{}, errors.New("Metadata request failed: invalid redirect")
			}
			current = next
			continue
		}
		etag := strings.TrimSpace(response.Header.Get("ETag"))
		lastModified := strings.TrimSpace(response.Header.Get("Last-Modified"))
		if response.StatusCode == http.StatusNotModified {
			_ = response.Body.Close()
			return fetchResponse{Status: response.StatusCode, ETag: etag, LastModified: lastModified}, nil
		}
		buffer, err := io.ReadAll(response.Body)
		autoDecompressed := response.Uncompressed
		_ = response.Body.Close()
		if err != nil {
			return fetchResponse{}, networkFetchError(err)
		}
		// The transport already decodes a Content-Encoding it negotiated
		// itself; only a .gz URL or an explicit gzip content type/encoding
		// still needs a manual gunzip.
		shouldGunzip := !autoDecompressed && (strings.HasSuffix(strings.ToLower(current), ".gz") ||
			strings.Contains(strings.ToLower(response.Header.Get("Content-Encoding")), "gzip") ||
			strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "gzip"))
		body := decodePossiblyGzippedPayload(buffer, shouldGunzip)
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return fetchResponse{}, fmt.Errorf("Metadata request failed with status %d", response.StatusCode)
		}
		return fetchResponse{
			Status:       response.StatusCode,
			Body:         body,
			HasBody:      true,
			ETag:         etag,
			LastModified: lastModified,
		}, nil
	}
	return fetchResponse{}, errors.New("Metadata request failed: too many redirects")
}

// decodePossiblyGzippedPayload mirrors decodePossiblyGzippedPayload: a gunzip
// failure falls back to the raw bytes decoded as UTF-8.
func decodePossiblyGzippedPayload(buffer []byte, shouldGunzip bool) string {
	if shouldGunzip {
		reader, err := gzip.NewReader(bytes.NewReader(buffer))
		if err == nil {
			if decoded, err := io.ReadAll(reader); err == nil {
				_ = reader.Close()
				return string(decoded)
			}
			_ = reader.Close()
		}
	}
	return string(buffer)
}

// resolveRedirect implements new URL(location, currentUrl).toString().
func resolveRedirect(current, location string) (string, error) {
	base, err := url.Parse(current)
	if err != nil {
		return "", err
	}
	reference, err := url.Parse(location)
	if err != nil {
		return "", err
	}
	return base.ResolveReference(reference).String(), nil
}

// networkFetchError wraps a platform failure without inventing Node's wording.
func networkFetchError(err error) error {
	return errors.New("Metadata request failed: " + err.Error())
}

// fetchMaybe is the optional conditional fetch used for robots.txt and sitemap
// files only. It sends the cached validators, reuses a 304 body, refetches
// unconditionally when a 304 has no cached body, and keeps the parsed sitemap
// payload whenever the body is byte-identical. Every failure path returns
// "no body" so discovery can skip an unreachable or malformed document.
func (s *Service) fetchMaybe(ctx context.Context, rawURL string, timeoutMs int) (string, bool) {
	state := s.readDiscoveryHTTPState(ctx, rawURL)
	var conditional map[string]string
	if state != nil {
		if state.ETag != "" {
			conditional = map[string]string{"If-None-Match": state.ETag}
		}
		if state.LastModified != "" {
			if conditional == nil {
				conditional = map[string]string{}
			}
			conditional["If-Modified-Since"] = state.LastModified
		}
	}

	response, err := s.fetchWithStatus(ctx, rawURL, timeoutMs, conditional)
	if err != nil {
		return "", false
	}

	if response.Status == http.StatusNotModified {
		if body, ok := state.cachedBody(); ok {
			s.writeDiscoveryHTTPState(ctx, rawURL, discoveryHTTPState{
				ETag:                 firstNonEmpty(response.ETag, state.ETag),
				LastModified:         firstNonEmpty(response.LastModified, state.LastModified),
				Body:                 &body,
				ParsedSitemapPayload: state.ParsedSitemapPayload,
				UpdatedAt:            time.Now().UnixMilli(),
			})
			return body, true
		}
		// No cached body to reuse: the source retries once without validators
		// and, because there was no body to compare, drops any parsed payload.
		refreshed, err := s.fetchWithStatus(ctx, rawURL, timeoutMs, nil)
		if err != nil || !refreshed.HasBody {
			return "", false
		}
		body := refreshed.Body
		s.writeDiscoveryHTTPState(ctx, rawURL, discoveryHTTPState{
			ETag:         refreshed.ETag,
			LastModified: refreshed.LastModified,
			Body:         &body,
			UpdatedAt:    time.Now().UnixMilli(),
		})
		return body, true
	}

	if !response.HasBody {
		return "", false
	}
	// A 200 replaces the validators with whatever the server sent (including
	// dropping them) and keeps the parsed payload only for an identical body.
	var parsed *parsedSitemapPayload
	if cached, ok := state.cachedBody(); ok && cached == response.Body {
		parsed = state.ParsedSitemapPayload
	}
	body := response.Body
	s.writeDiscoveryHTTPState(ctx, rawURL, discoveryHTTPState{
		ETag:                 response.ETag,
		LastModified:         response.LastModified,
		Body:                 &body,
		ParsedSitemapPayload: parsed,
		UpdatedAt:            time.Now().UnixMilli(),
	})
	return body, true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
