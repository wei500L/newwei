package geocoding

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
)

// Paths owned by the geocoding switch.
const (
	geocodePath       = "/api/geo/geocode"
	nominatimTestPath = "/api/system-settings/geo/nominatim/test"
)

// Handler serves the two POST routes. They share the client and differ only in
// permission and in whether the cache is read (D3: the administrator test uses
// Probe).
type Handler struct {
	auth   *platformgovernance.Authenticator
	client *Client
}

// NewHandler wires the authenticator and the shared client.
func NewHandler(auth *platformgovernance.Authenticator, client *Client) *Handler {
	return &Handler{auth: auth, client: client}
}

// ServeHTTP dispatches one taken-over request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.auth == nil || h.client == nil {
		settingshttp.WriteServiceError(w, r, settingshttp.ServiceUnavailable("Internal server error"))
		return
	}
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case geocodePath:
		h.serve(w, r, "items.read", false)
	case nominatimTestPath:
		h.serve(w, r, "settings.manage", true)
	default:
		http.NotFound(w, r)
	}
}

// geocodeResult is the GeocodeResult projection. Field names and the optional
// members match the NestJS contract.
type geocodeResult struct {
	Lat               float64 `json:"lat"`
	Lng               float64 `json:"lng"`
	DisplayName       string  `json:"displayName,omitempty"`
	Bounds            *Bounds `json:"bounds,omitempty"`
	Provider          string  `json:"provider"`
	Query             string  `json:"query"`
	CountryCodeAlpha2 string  `json:"countryCodeAlpha2,omitempty"`
}

type geocodeResponse struct {
	Result *geocodeResult `json:"result"`
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request, permission string, probe bool) {
	if h.auth.Authorize(w, r, permission) == nil {
		return
	}
	body, ok := settingshttp.ReadBodyOrFail(w, r)
	if !ok {
		return
	}
	query, countryCode, err := parseGeoDTO(body, probe)
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	var hit *Hit
	if probe {
		hit, err = h.client.Probe(r.Context(), query, countryCode)
	} else {
		hit, err = h.client.Geocode(r.Context(), query, countryCode)
	}
	if err != nil {
		settingshttp.WriteServiceError(w, r, err)
		return
	}
	settingshttp.WriteJSON(w, r, http.StatusCreated, geocodeResponse{Result: resultOf(hit)})
}

func resultOf(hit *Hit) *geocodeResult {
	if hit == nil {
		return nil
	}
	provider := hit.Provider
	if provider == "" {
		provider = "nominatim"
	}
	return &geocodeResult{
		Lat:               hit.Lat,
		Lng:               hit.Lng,
		DisplayName:       hit.DisplayName,
		Bounds:            hit.Bounds,
		Provider:          provider,
		Query:             hit.Query,
		CountryCodeAlpha2: hit.CountryCodeAlpha2,
	}
}

// rawGeoDTO is GeoGeocodeDto / GeoNominatimTestDto. Both keep query and the
// optional country code raw so the validator sees the original JSON type.
type rawGeoDTO struct {
	Query             json.RawMessage `json:"query"`
	CountryCodeAlpha2 json.RawMessage `json:"countryCodeAlpha2"`
}

func parseGeoDTO(body []byte, probe bool) (string, string, error) {
	var raw rawGeoDTO
	_ = json.Unmarshal(body, &raw)
	var problems settingshttp.ValidationErrors

	var query string
	isString := json.Unmarshal(raw.Query, &query) == nil
	// class-validator applies @MaxLength, @MinLength and @IsString bottom-up.
	if !probe && (!isString || len(query) > 200) {
		problems.Add("query must be shorter than or equal to 200 characters")
	}
	if !isString || len(query) < 1 {
		problems.Add("query must be longer than or equal to 1 characters")
	}
	if !isString {
		problems.Add("query must be a string")
	}

	countryCode := ""
	if len(raw.CountryCodeAlpha2) > 0 && string(raw.CountryCodeAlpha2) != "null" {
		var value string
		countryString := json.Unmarshal(raw.CountryCodeAlpha2, &value) == nil
		if probe {
			if !countryString || !matchesAlpha2(value) {
				problems.Add("countryCodeAlpha2 must match /^[A-Za-z]{2}$/ regular expression")
			}
		} else {
			if !countryString || len(value) != 2 {
				problems.Add("countryCodeAlpha2 must be longer than or equal to 2 and shorter than or equal to 2 characters")
			}
		}
		if !countryString {
			problems.Add("countryCodeAlpha2 must be a string")
		}
		countryCode = strings.ToUpper(strings.TrimSpace(value))
	}

	if err := problems.Err(); err != nil {
		return "", "", err
	}
	return strings.TrimSpace(query), countryCode, nil
}

func matchesAlpha2(value string) bool {
	if len(value) != 2 {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}
