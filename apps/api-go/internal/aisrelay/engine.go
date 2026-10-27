package aisrelay

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// connState mirrors the three WebSocket readyState values the health rules
// distinguish: no socket, a socket still handshaking, and an open socket.
type connState int

const (
	// connIdle means there is no upstream socket (Node: upstreamSocket === null).
	connIdle connState = iota
	// connConnecting means a handshake is in flight (Node: readyState CONNECTING).
	connConnecting
	// connOpen means the subscription stream is live (Node: readyState OPEN).
	connOpen
)

// engine owns all relay state behind a single mutex.
//
// The Node relay is single threaded, so its aggregates are read and written without
// synchronisation. In Go the upstream reader, the drain loop, the snapshot ticker and
// every HTTP handler run concurrently, so all state below is guarded by mu and the
// HTTP paths take the same lock. Snapshot reads therefore never observe a partially
// applied batch, which is the property the Node event loop provided implicitly.
type engine struct {
	cfg Config
	// now is injectable so tests can drive aggregation, eviction and health
	// thresholds with a deterministic clock instead of sleeping.
	now func() time.Time

	mu    sync.Mutex
	state connState

	// Aggregates. Every ordered container reproduces JS Map/Set iteration order,
	// because the snapshots sort stably and evict oldest-first on top of it.
	vessels          *orderedMap[*vesselState]
	vesselHistory    *orderedMap[[]int64]
	vesselGridKeys   *orderedMap[string]
	densityGrid      *orderedMap[*densityCell]
	candidateReports *orderedMap[*candidateReport]

	// Counters reported in `status` and `diagnostics`.
	messageCount             int
	droppedMessages          int
	positionReportsSeen      int
	positionReportsProcessed int
	ignoredPositionReports   int
	parseErrors              int

	// Snapshot cache. The serialised payloads are cached because the HTTP handler
	// serves those bytes directly and because the absence/presence of
	// candidateReports is a query-parameter choice on the same state.
	snapshotSequence                  int
	lastSnapshot                      *Snapshot
	lastSnapshotAt                    int64
	lastSnapshotJSONWithoutCandidates []byte
	lastSnapshotJSONWithCandidates    []byte

	// Install-recovery bookkeeping mirrored from the Node relay.
	lastParseErrorAt         int64
	lastParseErrorMessage    *string
	lastUpstreamConnectedAt  int64
	lastUpstreamMessageAt    int64
	lastUpstreamErrorAt      int64
	lastUpstreamErrorMessage *string

	// Health state machine.
	relayHealthState      HealthState
	relayStatusReasonCode *ReasonCode
	relayStatusReason     *string
	lastRelayIssueAt      int64
	lastRelayHealthyAt    int64

	// queue is the backpressure buffer between the upstream reader and the drain
	// loop. A full buffer means the relay is behind: the message is counted as
	// dropped instead of blocking the reader, matching the Node hard cap.
	queue chan []byte
}

// newEngine builds an empty relay state.
func newEngine(cfg Config, now func() time.Time) *engine {
	if now == nil {
		now = time.Now
	}
	return &engine{
		cfg:                cfg,
		now:                now,
		state:              connIdle,
		vessels:            newOrderedMap[*vesselState](),
		vesselHistory:      newOrderedMap[[]int64](),
		vesselGridKeys:     newOrderedMap[string](),
		densityGrid:        newOrderedMap[*densityCell](),
		candidateReports:   newOrderedMap[*candidateReport](),
		relayHealthState:   HealthStateOK,
		lastRelayHealthyAt: now().UnixMilli(),
		queue:              make(chan []byte, cfg.UpstreamQueueHardCap),
	}
}

// nowMillis is the current time in epoch milliseconds, the unit the Node relay uses
// throughout its aggregates.
func (e *engine) nowMillis() int64 {
	return e.now().UnixMilli()
}

// submitUpstreamMessage hands one raw upstream payload to the drain loop.
//
// The non-blocking send reproduces the Node hard cap: a message that arrives while
// the buffer is full is counted as dropped and discarded, so the websocket reader
// keeps up with the socket instead of applying backpressure to the upstream.
func (e *engine) submitUpstreamMessage(raw []byte) {
	select {
	case e.queue <- raw:
	default:
		e.mu.Lock()
		e.droppedMessages++
		e.mu.Unlock()
	}
}

// clearQueue discards buffered payloads. The Node relay calls this whenever a
// connection is replaced or closed; like Node, the discarded messages are not added
// to droppedMessages, so the counter only measures backpressure overflow.
func (e *engine) clearQueue() {
	for {
		select {
		case <-e.queue:
		default:
			return
		}
	}
}

// runDrainLoop consumes the backpressure queue until ctx is cancelled.
//
// Payloads are processed in batches under a single lock acquisition: taking the lock
// per message would let every HTTP read interleave with the aggregation, and the
// batch bound plus time budget keep one burst from monopolising the state.
func (e *engine) runDrainLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case first := <-e.queue:
			e.processBatch(first)
		}
	}
}

// processBatch aggregates one batch of upstream payloads.
func (e *engine) processBatch(first []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()

	startedAt := e.now()
	budget := e.cfg.UpstreamDrainBudget
	e.processRawMessageLocked(first)
	processed := 1

	for processed < e.cfg.UpstreamDrainBatch {
		if e.now().Sub(startedAt) >= budget {
			return
		}
		select {
		case raw := <-e.queue:
			e.processRawMessageLocked(raw)
			processed++
		default:
			return
		}
	}
}

// processRawMessageLocked parses one upstream payload and folds it into the
// aggregates. It reproduces processRawUpstreamMessage: every payload counts as a
// message, only PositionReport payloads become vessel state, and a payload that is
// not valid JSON increments parseErrors.
func (e *engine) processRawMessageLocked(raw []byte) {
	now := e.nowMillis()
	e.lastUpstreamMessageAt = now
	e.messageCount++

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		// JSON.parse throws only for malformed JSON. Valid JSON that is not an
		// object (a bare string, number or array) parses fine in JS and simply has
		// no MessageType, so it must not be counted as a parse error.
		if !json.Valid(raw) {
			e.parseErrors++
			e.lastParseErrorAt = now
			message := err.Error()
			e.lastParseErrorMessage = &message
		}
		return
	}

	messageType, ok := decodeJSONString(payload["MessageType"])
	if !ok || messageType != "PositionReport" {
		return
	}
	e.positionReportsSeen++
	e.processPositionReportLocked(payload)
}

// decodeObjectMember decodes a nested JSON object member. A missing, null, non-object
// or array member yields nil, which is what the Node `typeof === "object" &&
// !Array.isArray` guards reject.
//
// The member is decoded into a raw-member map at this protocol boundary so that
// field lookup stays case sensitive: encoding/json's struct decoding falls back to a
// case-insensitive match, which would accept "mmsi" for "MMSI" where the Node relay
// reads undefined and drops the report.
func decodeObjectMember(raw json.RawMessage) map[string]json.RawMessage {
	if !isJSONObject(raw) {
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil
	}
	return object
}

// processPositionReportLocked folds one PositionReport into the vessel index, the
// density grid, the sighting history and the candidate report set.
func (e *engine) processPositionReportLocked(payload map[string]json.RawMessage) {
	meta := decodeObjectMember(payload["MetaData"])
	message := decodeObjectMember(payload["Message"])
	var position map[string]json.RawMessage
	if message != nil {
		position = decodeObjectMember(message["PositionReport"])
	}
	if meta == nil || position == nil {
		e.ignoredPositionReports++
		return
	}

	mmsiRaw := meta["MMSI"]
	if isAbsentRaw(mmsiRaw) {
		mmsiRaw = meta["MMSI_String"]
	}
	mmsi := normalizeMmsiRaw(mmsiRaw)

	// `getNumber(position.Latitude) ?? getNumber(meta.latitude)`: the fallback only
	// applies when the position field is absent, so a reported 0 is kept.
	lat := getNumberRaw(position["Latitude"])
	if lat == nil {
		lat = getNumberRaw(meta["latitude"])
	}
	lon := getNumberRaw(position["Longitude"])
	if lon == nil {
		lon = getNumberRaw(meta["longitude"])
	}
	if mmsi == nil || *mmsi == "" || lat == nil || lon == nil {
		e.ignoredPositionReports++
		return
	}

	now := e.nowMillis()
	key := gridKeyOf(*lat, *lon)
	if previousKey, ok := e.vesselGridKeys.Get(*mmsi); ok && previousKey != key {
		e.removeVesselFromDensityCellLocked(*mmsi)
	}

	e.vessels.Set(*mmsi, &vesselState{
		mmsi:      *mmsi,
		name:      normalizeStringRaw(meta["ShipName"]),
		lat:       *lat,
		lon:       *lon,
		timestamp: now,
		shipType:  getNumberRaw(meta["ShipType"]),
		heading:   getNumberRaw(position["TrueHeading"]),
		speed:     getNumberRaw(position["Sog"]),
		course:    getNumberRaw(position["Cog"]),
	})

	history, _ := e.vesselHistory.Get(*mmsi)
	history = append(history, now)
	if len(history) > vesselHistoryDepth {
		history = history[len(history)-vesselHistoryDepth:]
	}
	e.vesselHistory.Set(*mmsi, history)

	cell := e.getOrCreateDensityCellLocked(key, *lat, *lon, now)
	cell.vesselIDs.Add(*mmsi)
	cell.lastUpdate = now
	e.vesselGridKeys.Set(*mmsi, key)

	if isLikelyMilitaryCandidate(meta) {
		e.candidateReports.Set(*mmsi, &candidateReport{
			mmsi:      *mmsi,
			name:      normalizeStringRaw(meta["ShipName"]),
			lat:       *lat,
			lon:       *lon,
			shipType:  getNumberRaw(meta["ShipType"]),
			heading:   getNumberRaw(position["TrueHeading"]),
			speed:     getNumberRaw(position["Sog"]),
			course:    getNumberRaw(position["Cog"]),
			timestamp: now,
		})
	}

	e.positionReportsProcessed++
}
