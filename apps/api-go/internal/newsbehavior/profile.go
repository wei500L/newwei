package newsbehavior

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

type wireDims struct {
	Actions  scoreRecord `json:"actions"`
	Sources  scoreRecord `json:"sources"`
	Topics   scoreRecord `json:"topics"`
	Entities scoreRecord `json:"entities"`
	Items    scoreRecord `json:"items"`
	Events   scoreRecord `json:"events"`
	Domains  scoreRecord `json:"domains"`
}

type wireBand struct {
	Key      string   `json:"key"`
	Weight   float64  `json:"weight"`
	Positive wireDims `json:"positive"`
	Negative wireDims `json:"negative"`
	Net      wireDims `json:"net"`
}

type wireDecay struct {
	Strategy     string `json:"strategy"`
	HalfLifeDays int    `json:"halfLifeDays"`
	WindowDays   int    `json:"windowDays"`
}

type wireMeta struct {
	LegacyFallbackUsed bool      `json:"legacyFallbackUsed"`
	DecayPolicy        wireDecay `json:"decayPolicy"`
}

type wireProfile struct {
	Actions  scoreRecord `json:"actions"`
	Sources  scoreRecord `json:"sources"`
	Topics   scoreRecord `json:"topics"`
	Entities scoreRecord `json:"entities"`
	Items    scoreRecord `json:"items"`
	Events   scoreRecord `json:"events"`
	Domains  scoreRecord `json:"domains"`
	Positive wireDims    `json:"positive"`
	Negative wireDims    `json:"negative"`
	Net      wireDims    `json:"net"`
	Bands    []wireBand  `json:"bands"`
	Meta     wireMeta    `json:"meta"`
}

type loadedProfile struct {
	raw      []byte
	personal personalnews.PersonalizationProfile
}

func (s *Service) profileJSON(ctx context.Context, orgID, userID string) ([]byte, error) {
	loaded, err := s.load(ctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	return loaded.raw, nil
}

// ProfileJSON returns the exact UserNewsBehaviorProfile document getProfile
// serves (the Redis-cached wire shape). It is the read the user-data export
// embeds verbatim, so the export and GET /api/user-news-behavior/profile can
// never disagree.
func (s *Service) ProfileJSON(ctx context.Context, orgID, userID string) ([]byte, error) {
	return s.profileJSON(ctx, orgID, userID)
}

// GetPersonalizationProfile 返回 Nest getPersonalizationProfile 的四段：
// positive、negative、net，以及完整 meta。空分数表是空对象。
func (s *Service) GetPersonalizationProfile(ctx context.Context, orgID, userID string) (personalnews.PersonalizationProfile, error) {
	loaded, err := s.load(ctx, orgID, userID)
	if err != nil {
		return personalnews.PersonalizationProfile{}, err
	}
	return loaded.personal, nil
}

func (s *Service) load(ctx context.Context, orgID, userID string) (loadedProfile, error) {
	if orgID == "" || userID == "" {
		return loadedProfile{}, fmt.Errorf("%w: missing identity", errDB)
	}
	cacheKey := profileCacheKey(orgID, userID)
	cached, found, err := s.cacheGet(ctx, cacheKey)
	if err != nil {
		return loadedProfile{}, err
	}
	if found {
		hit, parseErr := cacheValueHit(cached)
		if parseErr != nil {
			// cache.get 对非空字符串执行 JSON.parse，解析失败会抛出。
			return loadedProfile{}, redisErr(parseErr)
		}
		if hit {
			return loadedProfile{raw: cached, personal: personalizationFromJSON(cached)}, nil
		}
	}

	now := time.Now().UTC()
	dayKeys := recentDayKeys(orgID, userID, now)
	days, err := s.hgetallMany(ctx, dayKeys)
	if err != nil {
		return loadedProfile{}, err
	}
	positive, negative, bands, actionTotal := foldDays(days)
	legacyUsed := false
	if actionTotal <= legacyFallbackActionThreshold {
		legacy, err := s.hgetallMany(ctx, legacyHashKeys(orgID, userID))
		if err != nil {
			return loadedProfile{}, err
		}
		legacyUsed = applyLegacy(positive, legacy)
	}
	net := subtractDims(positive, negative)
	top := clampDims(net)
	wireBands := make([]wireBand, len(bands))
	for i, band := range bands {
		wireBands[i] = wireBand{
			Key:      band.key,
			Weight:   band.weight,
			Positive: band.positive.wire(),
			Negative: band.negative.wire(),
			Net:      subtractDims(band.positive, band.negative).wire(),
		}
	}
	wire := wireProfile{
		Actions:  top.actions.record(),
		Sources:  top.sources.record(),
		Topics:   top.topics.record(),
		Entities: top.entities.record(),
		Items:    top.items.record(),
		Events:   top.events.record(),
		Domains:  top.domains.record(),
		Positive: positive.wire(),
		Negative: negative.wire(),
		Net:      net.wire(),
		Bands:    wireBands,
		Meta: wireMeta{
			LegacyFallbackUsed: legacyUsed,
			DecayPolicy: wireDecay{
				Strategy:     "exponential_half_life",
				HalfLifeDays: decayHalfLifeDays,
				WindowDays:   windowDays,
			},
		},
	}
	raw, err := marshalJS(wire)
	if err != nil {
		return loadedProfile{}, fmt.Errorf("newsbehavior: marshal profile: %w", err)
	}
	if err := s.cacheSet(ctx, cacheKey, raw, time.Duration(profileCacheTTLSeconds)*time.Second); err != nil {
		return loadedProfile{}, err
	}
	return loadedProfile{
		raw: raw,
		personal: personalnews.PersonalizationProfile{
			Positive: positive.export(),
			Negative: negative.export(),
			Net:      net.export(),
			Meta:     metaMap(legacyUsed),
		},
	}, nil
}

func metaMap(legacyUsed bool) map[string]any {
	return map[string]any{
		"legacyFallbackUsed": legacyUsed,
		"decayPolicy": map[string]any{
			"strategy":     "exponential_half_life",
			"halfLifeDays": float64(decayHalfLifeDays),
			"windowDays":   float64(windowDays),
		},
	}
}

// clear 先删 Redis（旧 hash、窗口内日桶、画像缓存），再在一个事务里
// 删本用户聚合和快照，并把同组织其他用户的快照标脏。
// 里程碑去重键和 sim-dirty 节流键不在 clearProfile 的删除列表里。
func (s *Service) clear(ctx context.Context, orgID, userID string) error {
	if orgID == "" || userID == "" {
		return fmt.Errorf("%w: missing identity", errDB)
	}
	keys := legacyHashKeys(orgID, userID)
	keys = append(keys, recentDayKeys(orgID, userID, time.Now().UTC())...)
	keys = append(keys, profileCacheKey(orgID, userID))
	if err := s.cacheDel(ctx, keys); err != nil {
		return err
	}
	return s.clearStoredProfile(ctx, orgID, userID)
}

func cacheValueHit(raw []byte) (bool, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var value any
	if err := dec.Decode(&value); err != nil {
		return false, err
	}
	if err := dec.Decode(&value); !errors.Is(err, io.EOF) {
		if err == nil {
			return false, errors.New("trailing json")
		}
		return false, err
	}
	return jsTruthy(value), nil
}

func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0 && !math.IsNaN(typed)
	default:
		return true
	}
}

func personalizationFromJSON(raw []byte) personalnews.PersonalizationProfile {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return personalnews.PersonalizationProfile{
			Positive: emptyDims(),
			Negative: emptyDims(),
			Net:      emptyDims(),
		}
	}
	return personalnews.PersonalizationProfile{
		Positive: decodeDims(top["positive"]),
		Negative: decodeDims(top["negative"]),
		Net:      decodeDims(top["net"]),
		Meta:     decodeMeta(top["meta"]),
	}
}

func emptyDims() personalnews.ScoreDimensions {
	return personalnews.ScoreDimensions{
		Actions:  personalnews.ScoreMap{},
		Sources:  personalnews.ScoreMap{},
		Topics:   personalnews.ScoreMap{},
		Entities: personalnews.ScoreMap{},
		Items:    personalnews.ScoreMap{},
		Events:   personalnews.ScoreMap{},
		Domains:  personalnews.ScoreMap{},
	}
}

func fillDims(dims *personalnews.ScoreDimensions) {
	if dims.Actions == nil {
		dims.Actions = personalnews.ScoreMap{}
	}
	if dims.Sources == nil {
		dims.Sources = personalnews.ScoreMap{}
	}
	if dims.Topics == nil {
		dims.Topics = personalnews.ScoreMap{}
	}
	if dims.Entities == nil {
		dims.Entities = personalnews.ScoreMap{}
	}
	if dims.Items == nil {
		dims.Items = personalnews.ScoreMap{}
	}
	if dims.Events == nil {
		dims.Events = personalnews.ScoreMap{}
	}
	if dims.Domains == nil {
		dims.Domains = personalnews.ScoreMap{}
	}
}

func decodeDims(raw json.RawMessage) personalnews.ScoreDimensions {
	dims := emptyDims()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return dims
	}
	var parsed personalnews.ScoreDimensions
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return dims
	}
	fillDims(&parsed)
	return parsed
}

func decodeMeta(raw json.RawMessage) map[string]any {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var meta map[string]any
	if err := json.Unmarshal(trimmed, &meta); err != nil {
		return nil
	}
	return meta
}
