package situationmonitors

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
)

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
	country := contentsubscriptions.NormalizeCountryAlpha2(input.Country)
	if country == "" {
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

func (s *Service) geocode(ctx context.Context, name, country string) *geoHit {
	if s == nil || s.httpClient == nil || strings.TrimSpace(name) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	query := url.Values{}
	query.Set("format", "jsonv2")
	query.Set("limit", "1")
	query.Set("addressdetails", "1")
	query.Set("q", name)
	if country != "" {
		query.Set("countrycodes", strings.ToLower(country))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://nominatim.openstreetmap.org/search?"+query.Encode(), nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "modular-api")
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil
	}
	var rows []struct {
		Lat         string   `json:"lat"`
		Lon         string   `json:"lon"`
		Boundingbox []string `json:"boundingbox"`
		Address     struct {
			CountryCode string `json:"country_code"`
		} `json:"address"`
	}
	if err := json.Unmarshal(body, &rows); err != nil || len(rows) == 0 {
		return nil
	}
	lat, latErr := strconv.ParseFloat(rows[0].Lat, 64)
	lng, lngErr := strconv.ParseFloat(rows[0].Lon, 64)
	if latErr != nil || lngErr != nil || !finite(lat) || !finite(lng) {
		return nil
	}
	hit := &geoHit{Lat: lat, Lng: lng}
	if code := contentsubscriptions.NormalizeCountryAlpha2(rows[0].Address.CountryCode); code != "" {
		hit.Country = code
	}
	if len(rows[0].Boundingbox) == 4 {
		minLat, err1 := strconv.ParseFloat(rows[0].Boundingbox[0], 64)
		maxLat, err2 := strconv.ParseFloat(rows[0].Boundingbox[1], 64)
		minLng, err3 := strconv.ParseFloat(rows[0].Boundingbox[2], 64)
		maxLng, err4 := strconv.ParseFloat(rows[0].Boundingbox[3], 64)
		if err1 == nil && err2 == nil && err3 == nil && err4 == nil && finite(minLat) && finite(maxLat) && finite(minLng) && finite(maxLng) {
			hit.Bounds = &bounds{MinLat: minLat, MaxLat: maxLat, MinLng: minLng, MaxLng: maxLng}
		}
	}
	return hit
}
