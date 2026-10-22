package situationmonitors

import (
	"context"
	"testing"
)

// A Service without an HTTP client skips network geocoding, which keeps location
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
