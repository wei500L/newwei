package situationmonitors

import (
	"context"
	"errors"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
)

// A Service without a geocoder skips provider lookups, which keeps location
// resolution testable: lat/lng come from the request and the country code comes
// from the text or from the supplied alpha-2.
func TestResolveLocationCountryResolution(t *testing.T) {
	svc := &Service{}
	ctx := context.Background()

	fromText := svc.resolveLocation(ctx, &locationInput{
		Name: "Kyiv, Ukraine", Lat: 50.45, Lng: 30.52, HasLat: true, HasLng: true,
	})
	if fromText == nil {
		t.Fatal("location not resolved")
	}
	if fromText.CountryCodeAlpha2 != "UA" {
		t.Fatalf("country from text = %q", fromText.CountryCodeAlpha2)
	}

	// A client-supplied country wins over the text, exactly like NestJS
	// `input.countryCodeAlpha2 ?? extractCountryCodeFromText(name)`.
	supplied := svc.resolveLocation(ctx, &locationInput{
		Name: "Kyiv, Ukraine", Country: "DE", Lat: 50.45, Lng: 30.52, HasLat: true, HasLng: true,
	})
	if supplied == nil || supplied.CountryCodeAlpha2 != "DE" {
		t.Fatalf("supplied country = %+v", supplied)
	}

	// An unresolvable supplied country is not replaced by a text guess.
	unresolved := svc.resolveLocation(ctx, &locationInput{
		Name: "Kyiv, Ukraine", Country: "Nowhere", Lat: 50.45, Lng: 30.52, HasLat: true, HasLng: true,
	})
	if unresolved == nil {
		t.Fatal("location not resolved")
	}
	if unresolved.CountryCodeAlpha2 != "" {
		t.Fatalf("unresolved country = %q", unresolved.CountryCodeAlpha2)
	}
}

type stubGeocoder struct {
	hit     *geocoding.Hit
	cached  *geocoding.Hit
	err     error
	queries []string
	country []string
}

func (s *stubGeocoder) Geocode(_ context.Context, query, alpha2 string) (*geocoding.Hit, error) {
	s.queries = append(s.queries, query)
	s.country = append(s.country, alpha2)
	return s.hit, s.err
}

func (s *stubGeocoder) CachedGeocode(_ context.Context, _, _ string) (*geocoding.Hit, error) {
	return s.cached, nil
}

func TestResolveLocationDelegatesToSharedGeocoder(t *testing.T) {
	ctx := context.Background()
	geocoder := &stubGeocoder{hit: &geocoding.Hit{
		Lat:               48.8566,
		Lng:               2.3522,
		CountryCodeAlpha2: "FR",
		Bounds:            &geocoding.Bounds{MinLat: 48.12, MaxLat: 48.9, MinLng: 2.05, MaxLng: 2.61},
	}}
	svc := &Service{geocoder: geocoder}

	// Explicit coordinates win, while the provider still supplies bounds and a
	// country for the same query. This mirrors the historical monitor contract:
	// having coordinates does not skip the lookup.
	explicit := svc.resolveLocation(ctx, &locationInput{
		Name: "Paris", Lat: 10.5, Lng: 20.25, HasLat: true, HasLng: true,
	})
	if explicit == nil || explicit.Lat != 10.5 || explicit.Lng != 20.25 {
		t.Fatalf("explicit coordinates = %+v", explicit)
	}
	if explicit.CountryCodeAlpha2 != "FR" {
		t.Fatalf("country = %q", explicit.CountryCodeAlpha2)
	}
	if explicit.Bounds == nil || explicit.Bounds.MinLat != 48.12 || explicit.Bounds.MaxLng != 2.61 {
		t.Fatalf("bounds = %+v", explicit.Bounds)
	}
	if len(geocoder.queries) != 1 || geocoder.queries[0] != "Paris" || geocoder.country[0] != "" {
		t.Fatalf("geocoder call = %v %v", geocoder.queries, geocoder.country)
	}

	// Without explicit coordinates the provider hit fills both values.
	filled := svc.resolveLocation(ctx, &locationInput{Name: "Paris"})
	if filled == nil || filled.Lat != 48.8566 || filled.Lng != 2.3522 {
		t.Fatalf("filled coordinates = %+v", filled)
	}
}

func TestResolveLocationReusesPreviewCacheEntry(t *testing.T) {
	ctx := context.Background()
	geocoder := &stubGeocoder{cached: &geocoding.Hit{
		Lat: 48.8566, Lng: 2.3522, CountryCodeAlpha2: "FR",
		Bounds: &geocoding.Bounds{MinLat: 48.12, MaxLat: 48.9, MinLng: 2.05, MaxLng: 2.61},
	}}
	svc := &Service{geocoder: geocoder}

	loc := svc.resolveLocation(ctx, &locationInput{Name: "Paris", Country: "FR"})
	if loc == nil || loc.Lat != 48.8566 || loc.Lng != 2.3522 || loc.CountryCodeAlpha2 != "FR" || loc.Bounds == nil {
		t.Fatalf("cached preview entry not reused: %+v", loc)
	}
	if len(geocoder.queries) != 0 {
		t.Fatalf("cache reuse still reached the provider: %v", geocoder.queries)
	}

	// A cached result for another country must not satisfy an explicit country
	// filter; the resolver has to ask the provider with that filter.
	mismatch := &stubGeocoder{
		cached: &geocoding.Hit{Lat: 1, Lng: 2, CountryCodeAlpha2: "US"},
		hit:    &geocoding.Hit{Lat: 52.5, Lng: 13.4, CountryCodeAlpha2: "DE"},
	}
	loc = (&Service{geocoder: mismatch}).resolveLocation(ctx, &locationInput{Name: "Springfield", Country: "DE"})
	if loc == nil || loc.CountryCodeAlpha2 != "DE" {
		t.Fatalf("country mismatch cache result used: %+v", loc)
	}
	if len(mismatch.queries) != 1 || mismatch.country[0] != "DE" {
		t.Fatalf("provider lookup country = %v %v", mismatch.queries, mismatch.country)
	}
}

func TestResolveLocationKeepsCoordinatesOnGeocoderFailure(t *testing.T) {
	ctx := context.Background()
	svc := &Service{geocoder: &stubGeocoder{err: errors.New("redis unavailable")}}

	loc := svc.resolveLocation(ctx, &locationInput{
		Name: "Kyiv", Country: "UA", Lat: 50.45, Lng: 30.52, HasLat: true, HasLng: true,
	})
	if loc == nil || loc.Lat != 50.45 || loc.Lng != 30.52 {
		t.Fatalf("recoverable failure dropped coordinates: %+v", loc)
	}
	if loc.CountryCodeAlpha2 != "UA" || loc.Bounds != nil {
		t.Fatalf("recoverable failure metadata = %+v", loc)
	}

	// A failed lookup without coordinates still cannot invent a location.
	if missing := svc.resolveLocation(ctx, &locationInput{Name: "Kyiv"}); missing != nil {
		t.Fatalf("missing coordinates resolved: %+v", missing)
	}
}

func TestCountryFromTextIgnoresLowercaseShortTokens(t *testing.T) {
	// "de" is a preposition here, not Germany.
	if code := countryFromText("Lago de Atitlan"); code != "" {
		t.Fatalf("Lago de Atitlan = %q", code)
	}
	if code := countryFromText("U.S.A."); code != "US" {
		t.Fatalf("U.S.A. = %q", code)
	}
	if code := countryFromText("Berlin, Germany"); code != "DE" {
		t.Fatalf("Berlin, Germany = %q", code)
	}
}
