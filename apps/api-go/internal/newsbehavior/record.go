package newsbehavior

import (
	"context"
	"fmt"
	"log"
	"time"
)

// record 写入当天的 v2 hash，并在有信号时累加 MySQL 聚合、标脏相似度快照。
//
// duplicate 为 true 时对应 Nest `if (!acquired) return;`。控制器返回
// undefined，ExpressAdapter.reply 对 null/undefined 调用 res.send()，
// POST 默认 201，正文为空。这里不要补 {"recorded":true}。
func (s *Service) record(ctx context.Context, orgID, userID string, in recordInput) (bool, error) {
	if orgID == "" || userID == "" {
		return false, fmt.Errorf("%w: missing identity", errDB)
	}
	now := time.Now().UTC()
	today := formatDayKey(now)
	itemID := normalizeID(in.itemID)
	eventID := normalizeID(in.eventID)
	domain := normalizeURLDomain(in.url)
	source := normalizeSourceSignal(in.source, domain)
	topics := normalizeTerms(in.topics)
	entities := normalizeTerms(in.entities)

	if isMilestone(in.eventType) && (itemID != "" || eventID != "") {
		id := itemID
		if id == "" {
			id = eventID
		}
		acquired, err := s.setIfAbsentAt(ctx,
			milestoneKey(orgID, userID, in.eventType, today, id),
			time.Duration(milestoneTTLSeconds)*time.Second)
		if err != nil {
			// Fail-open：Redis 抖动不能丢掉这一次阅读里程碑。
			log.Printf("user-news-behavior: milestone dedupe check failed; recording event: orgId=%s userId=%s type=%s err=%v",
				orgID, userID, in.eventType, err)
		} else if !acquired {
			return true, nil
		}
	}

	positive := positiveWeights[in.eventType]
	negative := negativeWeights[in.eventType]
	dailyKey := dayBucketKey(orgID, userID, today)
	var incs []hashIncr
	var deltas []signalDelta

	if positive > 0 {
		incs = append(incs, hashIncr{field: behaviorFieldKey("p", "actions", in.eventType), by: 1})
		if source != "" {
			deltas = append(deltas, signalDelta{signalType: signalSource, signalKey: source, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "sources", source), by: positive})
		}
		if itemID != "" {
			deltas = append(deltas, signalDelta{signalType: signalItem, signalKey: itemID, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "items", itemID), by: positive})
		}
		if eventID != "" {
			deltas = append(deltas, signalDelta{signalType: signalEvent, signalKey: eventID, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "events", eventID), by: positive})
		}
		if domain != "" {
			deltas = append(deltas, signalDelta{signalType: signalDomain, signalKey: domain, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "domains", domain), by: positive})
		}
		for _, term := range topics {
			deltas = append(deltas, signalDelta{signalType: signalTopic, signalKey: term, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "topics", term), by: positive})
		}
		for _, term := range entities {
			deltas = append(deltas, signalDelta{signalType: signalEntity, signalKey: term, delta: float64(positive)})
			incs = append(incs, hashIncr{field: behaviorFieldKey("p", "entities", term), by: positive})
		}
	}

	if negative > 0 {
		incs = append(incs, hashIncr{field: behaviorFieldKey("n", "actions", in.eventType), by: 1})
		if in.eventType == "not_interested" {
			switch {
			case itemID != "":
				deltas = append(deltas, signalDelta{signalType: signalItem, signalKey: itemID, delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "items", itemID), by: negative})
			case eventID != "":
				deltas = append(deltas, signalDelta{signalType: signalEvent, signalKey: eventID, delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "events", eventID), by: negative})
			case source != "":
				deltas = append(deltas, signalDelta{signalType: signalSource, signalKey: source, delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "sources", source), by: negative})
			case len(topics) > 0:
				deltas = append(deltas, signalDelta{signalType: signalTopic, signalKey: topics[0], delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "topics", topics[0]), by: negative})
			case len(entities) > 0:
				deltas = append(deltas, signalDelta{signalType: signalEntity, signalKey: entities[0], delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "entities", entities[0]), by: negative})
			}
		}
		if in.eventType == "unsubscribe" {
			if len(topics) > 0 {
				deltas = append(deltas, signalDelta{signalType: signalTopic, signalKey: topics[0], delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "topics", topics[0]), by: negative})
			}
			if len(entities) > 0 {
				deltas = append(deltas, signalDelta{signalType: signalEntity, signalKey: entities[0], delta: -float64(negative)})
				incs = append(incs, hashIncr{field: behaviorFieldKey("n", "entities", entities[0]), by: negative})
			}
		}
	}

	if err := s.hincrBy(ctx, dailyKey, incs); err != nil {
		return false, err
	}
	if err := s.expireAndDel(ctx, dailyKey, time.Duration(retentionV2Seconds)*time.Second, profileCacheKey(orgID, userID)); err != nil {
		return false, err
	}
	if err := s.persistAggregateDeltas(ctx, orgID, userID, deltas); err != nil {
		return false, err
	}
	return false, nil
}
