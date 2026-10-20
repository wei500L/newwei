package newsbehavior

import (
	"context"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

// ScoringProfileView is the resolved behavior slice the NewsNow recommendation
// scores against: the clamped net dimensions plus the negative dimensions used
// by the feedback filter. It is decoded from the same cached wire profile
// getProfile serves, so the recommendation can never disagree with the profile
// endpoint.
type ScoringProfileView struct {
	Sources  personalnews.ScoreMap
	Topics   personalnews.ScoreMap
	Entities personalnews.ScoreMap
	Items    personalnews.ScoreMap
	Events   personalnews.ScoreMap
	Domains  personalnews.ScoreMap
	Negative NegativeView
}

// NegativeView is the negative half of the profile.
type NegativeView struct {
	Sources  personalnews.ScoreMap
	Topics   personalnews.ScoreMap
	Entities personalnews.ScoreMap
	Items    personalnews.ScoreMap
	Events   personalnews.ScoreMap
	Domains  personalnews.ScoreMap
}

// wireScoringProfile is the subset of the profile document this view needs.
type wireScoringProfile struct {
	Sources  map[string]float64 `json:"sources"`
	Topics   map[string]float64 `json:"topics"`
	Entities map[string]float64 `json:"entities"`
	Items    map[string]float64 `json:"items"`
	Events   map[string]float64 `json:"events"`
	Domains  map[string]float64 `json:"domains"`
	Negative struct {
		Sources  map[string]float64 `json:"sources"`
		Topics   map[string]float64 `json:"topics"`
		Entities map[string]float64 `json:"entities"`
		Items    map[string]float64 `json:"items"`
		Events   map[string]float64 `json:"events"`
		Domains  map[string]float64 `json:"domains"`
	} `json:"negative"`
	Net wireScoringNet `json:"net"`
}

// wireScoringNet is the unclamped net dimensions of the cached profile. The
// aggregate backfill reads it to seed the persistent signal rows.
type wireScoringNet struct {
	SourcesRaw  map[string]float64 `json:"sources"`
	TopicsRaw   map[string]float64 `json:"topics"`
	EntitiesRaw map[string]float64 `json:"entities"`
	ItemsRaw    map[string]float64 `json:"items"`
	EventsRaw   map[string]float64 `json:"events"`
	DomainsRaw  map[string]float64 `json:"domains"`
}

// GetScoringProfile returns the net dimensions and the negative dimensions of
// the user profile. The wire document comes from load, which reuses the Redis
// profile cache and recomputes exactly like getProfile.
func (s *Service) GetScoringProfile(ctx context.Context, orgID, userID string) (ScoringProfileView, error) {
	loaded, err := s.load(ctx, orgID, userID)
	if err != nil {
		return ScoringProfileView{}, err
	}
	var wire wireScoringProfile
	if err := json.Unmarshal(loaded.raw, &wire); err != nil {
		// The cached document was written by this service; an undecodable one is
		// a Redis value error, not a database error.
		return ScoringProfileView{}, redisErr(err)
	}
	return ScoringProfileView{
		Sources:  toScoreMap(wire.Sources),
		Topics:   toScoreMap(wire.Topics),
		Entities: toScoreMap(wire.Entities),
		Items:    toScoreMap(wire.Items),
		Events:   toScoreMap(wire.Events),
		Domains:  toScoreMap(wire.Domains),
		Negative: NegativeView{
			Sources:  toScoreMap(wire.Negative.Sources),
			Topics:   toScoreMap(wire.Negative.Topics),
			Entities: toScoreMap(wire.Negative.Entities),
			Items:    toScoreMap(wire.Negative.Items),
			Events:   toScoreMap(wire.Negative.Events),
			Domains:  toScoreMap(wire.Negative.Domains),
		},
	}, nil
}

// toScoreMap normalises a decoded dimension to a non-nil map.
func toScoreMap(values map[string]float64) personalnews.ScoreMap {
	out := make(personalnews.ScoreMap, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}
