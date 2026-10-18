package crawlmetadata

import (
	"context"
	"strings"
	"testing"
)

func TestValidateRequestAcceptsDomainBranch(t *testing.T) {
	input, err := validateRequest(context.Background(), []byte(`{"domain":"example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Source != "" || input.Domain != "example.com" {
		t.Fatalf("input = %+v", input)
	}
	if input.MaxURLs != nil || input.Concurrency != nil || input.ScoreThreshold != nil {
		t.Fatalf("absent optional fields must stay nil: %+v", input)
	}
	if input.ExtractJSONLd != nil || input.ExtractOpenGraph != nil || input.ExtractStandardMeta != nil {
		t.Fatalf("absent extract switches must stay nil: %+v", input)
	}

	input, err = validateRequest(context.Background(), []byte(`{"source":"sitemap","domain":"example.com","urls":["not validated"],"maxUrls":5,"concurrency":3,"scoreThreshold":0.5,"extractJsonLd":false,"extractOpenGraph":true,"extractStandardMeta":false,"pattern":"*/news/*","query":"Alpha"}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.MaxURLs == nil || *input.MaxURLs != 5 || input.Concurrency == nil || *input.Concurrency != 3 {
		t.Fatalf("input = %+v", input)
	}
	if input.ScoreThreshold == nil || *input.ScoreThreshold != 0.5 {
		t.Fatalf("scoreThreshold = %v", input.ScoreThreshold)
	}
	if input.ExtractJSONLd == nil || *input.ExtractJSONLd || input.ExtractOpenGraph == nil || !*input.ExtractOpenGraph {
		t.Fatalf("extract switches = %+v", input)
	}
	if input.ExtractStandardMeta == nil || *input.ExtractStandardMeta {
		t.Fatalf("extractStandardMeta = %v", input.ExtractStandardMeta)
	}
	// The pattern is not applied to the explicit url list, but it is still
	// resolved from the DTO.
	if input.Pattern != "*/news/*" || input.Query != "Alpha" {
		t.Fatalf("pattern/query = %+v", input)
	}
}

func TestValidateRequestNullBehavesLikeAbsent(t *testing.T) {
	input, err := validateRequest(context.Background(), []byte(`{"source":null,"domain":"example.com","maxUrls":null,"extractJsonLd":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.Source != "" || input.MaxURLs != nil || input.ExtractJSONLd != nil {
		t.Fatalf("null values must stay unset: %+v", input)
	}
}

func TestValidateRequestUnknownPropertyIsRejectedFirst(t *testing.T) {
	_, err := validateRequest(context.Background(), []byte(`{"extra":1,"domain":"example.com"}`))
	if err == nil || err.Error() != "property extra should not exist" {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateRequestDomainBranchMessages(t *testing.T) {
	_, err := validateRequest(context.Background(), []byte(`{}`))
	want := "domain must be a public hostname (no IPs, localhost, or private TLDs); " +
		"domain must be shorter than or equal to 255 characters; domain must be a string"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v want %q", err, want)
	}

	for _, body := range []string{
		`{"domain":"1.2.3.4"}`,
		`{"domain":"localhost"}`,
		`{"domain":"intranet.local"}`,
		`{"domain":"https://example.com"}`,
		`{"domain":"example.com/path"}`,
	} {
		if _, err := validateRequest(context.Background(), []byte(body)); err == nil ||
			!strings.Contains(err.Error(), "domain must be a public hostname") {
			t.Fatalf("body %s error = %v", body, err)
		}
	}

	// source "urls" skips the domain validation entirely, and every other
	// source value keeps it.
	if _, err := validateRequest(context.Background(), []byte(`{"source":"urls","urls":["https://8.8.8.8/a"]}`)); err != nil {
		t.Fatalf("source urls must not require a domain: %v", err)
	}
	if _, err := validateRequest(context.Background(), []byte(`{"source":"other","urls":["https://8.8.8.8/a"]}`)); err == nil ||
		!strings.Contains(err.Error(), "source must be one of the following values: sitemap, urls") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateRequestURLListBranch(t *testing.T) {
	_, err := validateRequest(context.Background(), []byte(`{"source":"urls"}`))
	want := "each url must include http/https scheme; " +
		"urls must contain no more than 200 elements; urls must contain at least 1 elements; " +
		"urls must be an array; URL must be a string"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v want %q", err, want)
	}

	_, err = validateRequest(context.Background(), []byte(`{"source":"urls","urls":[]}`))
	if err == nil || err.Error() != "urls must contain at least 1 elements" {
		t.Fatalf("error = %v", err)
	}

	_, err = validateRequest(context.Background(), []byte(`{"source":"urls","urls":["http://localhost/metadata"]}`))
	if err == nil || err.Error() != "Localhost is not allowed: localhost" {
		t.Fatalf("error = %v", err)
	}

	_, err = validateRequest(context.Background(), []byte(`{"source":"urls","urls":["ftp://example.com/a"]}`))
	if err == nil || !strings.Contains(err.Error(), "each url must include http/https scheme") {
		t.Fatalf("error = %v", err)
	}

	input, err := validateRequest(context.Background(), []byte(`{"source":"urls","urls":["https://8.8.8.8/a","https://8.8.8.8/b"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(input.URLs) != 2 || input.URLs[0] != "https://8.8.8.8/a" {
		t.Fatalf("urls = %v", input.URLs)
	}
}

func TestValidateRequestNumericAndLengthBounds(t *testing.T) {
	cases := map[string]string{
		`{"domain":"example.com","maxUrls":0}`:                         "maxUrls must not be less than 1",
		`{"domain":"example.com","maxUrls":201}`:                       "maxUrls must not be greater than 200",
		`{"domain":"example.com","maxUrls":1.5}`:                       "maxUrls must be an integer number",
		`{"domain":"example.com","maxUrls":"5"}`:                       "maxUrls must not be greater than 200; maxUrls must not be less than 1; maxUrls must be an integer number",
		`{"domain":"example.com","concurrency":11}`:                    "concurrency must not be greater than 10",
		`{"domain":"example.com","concurrency":0}`:                     "concurrency must not be less than 1",
		`{"domain":"example.com","scoreThreshold":2}`:                  "scoreThreshold must not be greater than 1",
		`{"domain":"example.com","scoreThreshold":-1}`:                 "scoreThreshold must not be less than 0",
		`{"domain":"example.com","scoreThreshold":"x"}`:                "scoreThreshold must not be greater than 1; scoreThreshold must not be less than 0; scoreThreshold must be a number",
		`{"domain":"example.com","extractJsonLd":"true"}`:              "extractJsonLd must be a boolean value",
		`{"domain":"example.com","extractOpenGraph":1}`:                "extractOpenGraph must be a boolean value",
		`{"domain":"example.com","extractStandardMeta":null}`:          "",
		`{"domain":"example.com","pattern":"` + longString(256) + `"}`: "pattern must be shorter than or equal to 255 characters",
		`{"domain":"example.com","query":"` + longString(161) + `"}`:   "query must be shorter than or equal to 160 characters",
		`{"domain":"example.com","pattern":123}`:                       "pattern must be shorter than or equal to 255 characters; pattern must be a string",
	}
	for body, want := range cases {
		_, err := validateRequest(context.Background(), []byte(body))
		if want == "" {
			if err != nil {
				t.Fatalf("body %s should be accepted: %v", body, err)
			}
			continue
		}
		if err == nil || err.Error() != want {
			t.Fatalf("body %s error = %v want %q", body, err, want)
		}
	}
}

func TestValidateRequestMalformedBody(t *testing.T) {
	_, err := validateRequest(context.Background(), []byte(`{"domain":`))
	if err == nil || err.Error() != invalidJSONMessage {
		t.Fatalf("error = %v", err)
	}
	if _, err := validateRequest(context.Background(), []byte(`[]`)); err == nil ||
		!strings.Contains(err.Error(), "domain must be a public hostname") {
		t.Fatalf("a non-object body must behave like an empty object: %v", err)
	}
	if _, err := validateRequest(context.Background(), []byte(``)); err == nil ||
		!strings.Contains(err.Error(), "domain must be a public hostname") {
		t.Fatalf("an empty body must behave like an empty object: %v", err)
	}
}

func TestRESTHostnameGuard(t *testing.T) {
	for _, value := range []string{"example.com", "sub.example.co.uk", "Example.COM", "xn--bcher-kva.example"} {
		if !isRESTHostname(value) {
			t.Fatalf("%q must be accepted", value)
		}
	}
	for _, value := range []string{"", "1.2.3.4", "localhost", "host.local", "host.internal", "host.lan", "example..com", "-bad.com", "https://example.com"} {
		if isRESTHostname(value) {
			t.Fatalf("%q must be rejected", value)
		}
	}
}

func TestRESTResultShapeOmitsAbsentOptionalFields(t *testing.T) {
	title := "One"
	response := restResponse{
		OrgID: "org-1",
		Total: 1,
		Results: toRESTResults([]Result{{
			URL:       "https://example.com/a",
			Status:    StatusSuccess,
			Title:     &title,
			MetaTags:  []Tag{},
			OpenGraph: []Tag{},
			JSONLd:    []string{},
		}}),
	}
	payload, err := marshalJSCompact(response)
	if err != nil {
		t.Fatal(err)
	}
	body := string(payload)
	if !strings.Contains(body, `"orgId":"org-1"`) || !strings.Contains(body, `"total":1`) {
		t.Fatalf("body = %s", body)
	}
	for _, absent := range []string{"httpStatus", "fetchedAt", "description", "keywords", "author", "relevanceScore", "error"} {
		if strings.Contains(body, `"`+absent+`"`) {
			t.Fatalf("body %s must omit %s", body, absent)
		}
	}
	if !strings.Contains(body, `"metaTags":[]`) || !strings.Contains(body, `"openGraph":[]`) || !strings.Contains(body, `"jsonLd":[]`) {
		t.Fatalf("empty list fields must be rendered: %s", body)
	}

	empty := []string{}
	response.Results = toRESTResults([]Result{{
		URL: "https://example.com/a", Status: StatusSuccess, Keywords: &empty,
		MetaTags: []Tag{}, OpenGraph: []Tag{}, JSONLd: []string{},
	}})
	payload, err = marshalJSCompact(response)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"keywords":[]`) {
		t.Fatalf("an empty keyword list must be rendered: %s", payload)
	}
}

func longString(length int) string {
	return strings.Repeat("a", length)
}
