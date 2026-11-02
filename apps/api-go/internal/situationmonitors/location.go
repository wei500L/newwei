package situationmonitors

import (
	"context"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
)

// LocationGeocoder is the narrow geocoding surface resolveLocation depends on.
// Production uses *geocoding.Client, which owns the shared Redis positive and
// negative cache, the global Nominatim rate limiter and the SQL-backed identity
// settings; monitor code must not create a second cache or HTTP fallback.
type LocationGeocoder interface {
	Geocode(ctx context.Context, query, alpha2 string) (*geocoding.Hit, error)
}

// cachedLocationGeocoder is the optional cache-only read the production
// *geocoding.Client also implements. Keeping it separate keeps the required
// monitor dependency at one method while still letting the save path reuse the
// preview entry that was keyed without the country field the editor echoes back.
type cachedLocationGeocoder interface {
	CachedGeocode(ctx context.Context, query, alpha2 string) (*geocoding.Hit, error)
}

type geoHit struct {
	Lat     float64
	Lng     float64
	Country string
	Bounds  *bounds
}

func (s *Service) resolveLocation(ctx context.Context, input *locationInput) *locationDTO {
	if input == nil {
		return nil
	}
	name := normalizeName(input.Name)
	if name == "" {
		return nil
	}
	// NestJS uses `input.countryCodeAlpha2 ?? extractCountryCodeFromText(name)`:
	// a client-supplied country wins even when it does not resolve, so the name is
	// only parsed when the field is absent.
	country := ""
	if input.Country != "" {
		country = contentsubscriptions.NormalizeCountryAlpha2(input.Country)
	} else {
		country = countryFromText(name)
	}
	geocoded := s.geocode(ctx, name, country)
	lat, latOK := input.Lat, input.HasLat
	lng, lngOK := input.Lng, input.HasLng
	if !latOK && geocoded != nil {
		lat, latOK = geocoded.Lat, true
	}
	if !lngOK && geocoded != nil {
		lng, lngOK = geocoded.Lng, true
	}
	if !latOK || !lngOK || !finite(lat) || !finite(lng) {
		return nil
	}
	loc := &locationDTO{Name: name, Lat: lat, Lng: lng}
	if geocoded != nil && geocoded.Bounds != nil {
		loc.Bounds = geocoded.Bounds
	}
	if geocoded != nil && geocoded.Country != "" {
		loc.CountryCodeAlpha2 = geocoded.Country
	} else {
		loc.CountryCodeAlpha2 = country
	}
	return loc
}

func countryFromText(name string) string {
	if code := contentsubscriptions.NormalizeCountryAlpha2(name); code != "" {
		return code
	}
	sanitized := strings.NewReplacer("U.S.A.", "USA", "U.S.A", "USA", "U.S.", "USA", "U.K.", "UK", "U.K", "UK").Replace(name)
	for _, token := range strings.FieldsFunc(sanitized, func(r rune) bool {
		switch r {
		case ' ', ',', ';', ':', '.', '(', ')', '/', '-':
			return true
		default:
			return false
		}
	}) {
		// NestJS extractCountryCodeFromText ignores short tokens that are not
		// uppercase, so a lowercase preposition ("de", "in") is never read as a
		// country code.
		if utf16Len(token) <= 3 && token != strings.ToUpper(token) {
			continue
		}
		if code := contentsubscriptions.NormalizeCountryAlpha2(token); code != "" {
			return code
		}
	}
	return ""
}

func legacyLocation(value any) *locationDTO {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	name := normalizeName(asString(record["name"]))
	lat, latOK := asFinite(record["lat"])
	lng, lngOK := asFinite(record["lng"])
	if name == "" || !latOK || !lngOK {
		return nil
	}
	loc := &locationDTO{Name: name, Lat: lat, Lng: lng}
	if country := countryFromText(name); country != "" {
		loc.CountryCodeAlpha2 = country
	}
	return loc
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

// geocode delegates to the shared geocoding client. The monitor service keeps
// the historical recoverable-failure behaviour: a cache or upstream failure
// yields no provider metadata but never discards coordinates the caller
// supplied. Only a definitive cache/upstream miss becomes a negative entry,
// which is owned by geocoding.Client.
func (s *Service) geocode(ctx context.Context, name, country string) *geoHit {
	if s == nil || s.geocoder == nil || strings.TrimSpace(name) == "" {
		return nil
	}
	if country != "" {
		// Preview requests do not carry a country, so their shared cache entry
		// uses the "any" key. The editor echoes the resolved alpha-2 on save;
		// accept the cached entry only when it agrees with that country.
		if cache, ok := s.geocoder.(cachedLocationGeocoder); ok {
			if cached, err := cache.CachedGeocode(ctx, name, ""); err == nil && cached != nil {
				if converted := providerHit(cached); converted != nil && converted.Country == country {
					return converted
				}
			}
		}
	}
	hit, err := s.geocoder.Geocode(ctx, name, country)
	if hit == nil {
		return nil
	}
	// A cache write failure wraps a successful provider result. Keep the
	// provider metadata rather than discarding it for a recoverable cache error.
	_ = err
	return providerHit(hit)
}

// providerHit projects the shared geocoding result onto the monitor DTO shape.
// Coordinates and country/bounds are copied only from a usable provider hit.
func providerHit(hit *geocoding.Hit) *geoHit {
	if hit == nil || !finite(hit.Lat) || !finite(hit.Lng) {
		return nil
	}
	out := &geoHit{Lat: hit.Lat, Lng: hit.Lng}
	if code := contentsubscriptions.NormalizeCountryAlpha2(hit.CountryCodeAlpha2); code != "" {
		out.Country = code
	}
	if hit.Bounds != nil && finite(hit.Bounds.MinLat) && finite(hit.Bounds.MaxLat) && finite(hit.Bounds.MinLng) && finite(hit.Bounds.MaxLng) {
		out.Bounds = &bounds{
			MinLat: hit.Bounds.MinLat,
			MaxLat: hit.Bounds.MaxLat,
			MinLng: hit.Bounds.MinLng,
			MaxLng: hit.Bounds.MaxLng,
		}
	}
	return out
}
