package situationsignalsworker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// B2: the Telegram poll is bound to the process that owns the single-instance
// MTProto lease. A queue job (or a refresh request) that lands on any other
// instance used to be skipped, so with N instances the effective poll rate
// dropped to about 1/N and a refresh reported success without refreshing. The
// poll is therefore handed over: the request is published on
// telegramPollChannel, the lease owner runs the cycle under its existing
// in-progress protection and records the completion in a short-lived result key.
const (
	// telegramPollChannel is the cross-instance Telegram poll request channel.
	// Its payload is telegramPollRequest.
	telegramPollChannel = "situation-monitor:signals:telegram-poll:v1"
	// telegramPollDonePrefix prefixes the per-request completion key. The value
	// is a one-element list written with LPUSH so a waiting caller can block on
	// BLPOP instead of polling.
	telegramPollDonePrefix = "situation-monitor:signals:telegram-poll-done:"
	// telegramPollDoneTTL bounds how long a completion record survives when the
	// waiting caller went away.
	telegramPollDoneTTL = 120 * time.Second
	// telegramPollWaitMarginMS is added to the configured poll cycle timeout when
	// a caller waits for a handed-over cycle, so a full slow cycle still finishes
	// before the waiter gives up.
	telegramPollWaitMarginMS = 30_000
	// telegramPollVersion is the only accepted request/completion version.
	telegramPollVersion = 1

	// telegramPollRequestIDBytes is the request id entropy (128 bits).
	telegramPollRequestIDBytes = 16
)

var (
	// errTelegramPollNoOwner is reported when the poll request reached no
	// subscriber and the lease could not be acquired either: another process owns
	// the lease but is not listening for handovers.
	errTelegramPollNoOwner = errors.New("telegram poll is owned by an instance that does not accept handovers")
	// errTelegramPollHandoverTimeout is reported when the lease owner accepted the
	// request but did not record a completion in time.
	errTelegramPollHandoverTimeout = errors.New("telegram poll handover timed out")
)

// telegramPollMode selects how a Telegram cycle reacts when another instance
// owns the single-instance lease.
type telegramPollMode int

const (
	// telegramPollAsync hands the cycle over and returns immediately; this is the
	// queue-job path, where the job itself must not block on another process.
	telegramPollAsync telegramPollMode = iota
	// telegramPollWait hands the cycle over and waits for the owner to finish it;
	// this is the refresh path, whose caller reports the outcome.
	telegramPollWait
	// telegramPollServe is the path that receives a handover request. It never
	// forwards the request again: every instance subscribes to the channel, so a
	// forwarded request would fan out without end. A process that does not own the
	// lease simply leaves the request to the owner.
	telegramPollServe
)

// telegramCycleOutcome reports how one Telegram cycle ended.
type telegramCycleOutcome int

const (
	// telegramCycleSkipped means no cycle ran in this process because the work
	// belongs to another instance (it owns the lease) or no handover transport is
	// configured.
	telegramCycleSkipped telegramCycleOutcome = iota
	// telegramCycleRefused means this instance could have run the cycle but
	// deliberately did not: a runtime guard (disabled, unconfigured, startup delay,
	// invalidated session) or a lease/state error. The request path records this as
	// a failed completion so a waiting caller learns the reason instead of waiting
	// for the timeout.
	telegramCycleRefused
	// telegramCyclePolled means this process ran the cycle (possibly after taking
	// the lease over during the handover).
	telegramCyclePolled
	// telegramCycleHandedOver means another instance was asked to run the cycle.
	telegramCycleHandedOver
)

// telegramPollRequest is the handover request document
// ({"version":1,"requestId":"…"}).
type telegramPollRequest struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
}

// telegramPollDone is the handover completion document. Error carries the
// lastError the owner recorded for the cycle, so a waiting caller can log why a
// handed-over cycle failed even though the shared state document is the source
// of truth for the refresh response.
type telegramPollDone struct {
	Version int    `json:"version"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
}

// pollHandover is the cross-instance transport of the Telegram poll handover.
// It is an interface so the worker tests can use an in-memory implementation and
// never need a live Redis.
type pollHandover interface {
	// Publish sends one poll request and reports how many subscribers received
	// it. Zero means no instance is listening for handovers.
	Publish(ctx context.Context, requestID string) (int64, error)
	// Wait blocks until the owner recorded the completion of requestID. received
	// is false when the timeout expired first.
	Wait(ctx context.Context, requestID string, timeout time.Duration) (done telegramPollDone, received bool, err error)
	// Complete records the completion of requestID for a waiting caller.
	Complete(ctx context.Context, requestID string, done telegramPollDone) error
}

// redisPollHandover is the production pollHandover over the shared client.
//
// Wait uses BLPOP, which blocks one pooled connection for the duration of the
// wait. Handovers are rare (only when the lease owner is another process) and the
// wait is bounded by the poll cycle timeout plus the margin, so a dedicated
// blocking connection is not needed.
type redisPollHandover struct {
	client *redis.Client
}

// newRedisPollHandover binds the handover transport to the shared Redis client.
func newRedisPollHandover(client *redis.Client) pollHandover {
	return redisPollHandover{client: client}
}

// Publish sends one poll request document.
func (h redisPollHandover) Publish(ctx context.Context, requestID string) (int64, error) {
	if h.client == nil {
		return 0, errors.New("situationsignalsworker: redis client is not configured")
	}
	payload, err := json.Marshal(telegramPollRequest{Version: telegramPollVersion, RequestID: requestID})
	if err != nil {
		return 0, err
	}
	return h.client.Publish(ctx, telegramPollChannel, payload).Result()
}

// Wait blocks on the completion list key until the owner pushes a record or the
// timeout expires.
func (h redisPollHandover) Wait(ctx context.Context, requestID string, timeout time.Duration) (telegramPollDone, bool, error) {
	if h.client == nil {
		return telegramPollDone{}, false, errors.New("situationsignalsworker: redis client is not configured")
	}
	values, err := h.client.BLPop(ctx, timeout, telegramPollDoneKey(requestID)).Result()
	if errors.Is(err, redis.Nil) {
		return telegramPollDone{}, false, nil
	}
	if err != nil {
		return telegramPollDone{}, false, err
	}
	if len(values) < 2 {
		return telegramPollDone{}, false, errors.New("situationsignalsworker: incomplete telegram poll completion record")
	}
	var done telegramPollDone
	if err := json.Unmarshal([]byte(values[1]), &done); err != nil {
		return telegramPollDone{}, false, err
	}
	return done, true, nil
}

// Complete pushes the completion record with the short handover TTL.
func (h redisPollHandover) Complete(ctx context.Context, requestID string, done telegramPollDone) error {
	if h.client == nil {
		return errors.New("situationsignalsworker: redis client is not configured")
	}
	if done.Version == 0 {
		done.Version = telegramPollVersion
	}
	payload, err := json.Marshal(done)
	if err != nil {
		return err
	}
	key := telegramPollDoneKey(requestID)
	pipe := h.client.Pipeline()
	pipe.LPush(ctx, key, payload)
	pipe.Expire(ctx, key, telegramPollDoneTTL)
	_, err = pipe.Exec(ctx)
	return err
}

// telegramPollDoneKey is the completion key of one request.
func telegramPollDoneKey(requestID string) string {
	return telegramPollDonePrefix + requestID
}

// newTelegramPollRequestID returns a random 128-bit request id (hex).
func newTelegramPollRequestID() string {
	buffer := make([]byte, telegramPollRequestIDBytes)
	if _, err := rand.Read(buffer); err != nil {
		// A random-source failure must not drop the poll: fall back to the clock,
		// which is unique enough for a request id scoped to one handover.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

// PollTelegramWait runs one Telegram poll cycle for the refresh route (B2): when
// this process owns the lease it polls directly, otherwise it hands the cycle
// over and blocks until the owner recorded the completion. It is the entry point
// situationsignals.RefreshService uses, so the refresh reports a real outcome
// instead of claiming a refresh that never ran.
func (s *Service) PollTelegramWait(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing.Load() {
		return nil
	}
	_, err := s.pollTelegram(ctx, telegramPollWait)
	return err
}

// PollOref runs one OREF poll cycle for the refresh route. The OREF poll needs no
// handover: it takes its own per-cycle Redis lease and any instance may run it.
func (s *Service) PollOref(ctx context.Context) error {
	s.orefMu.Lock()
	defer s.orefMu.Unlock()
	if s.closing.Load() {
		return nil
	}
	s.runOrefCycle(ctx)
	return nil
}

// handleTelegramPollRequest serves one request received on telegramPollChannel.
// It runs the cycle under the process in-progress protection and records the
// completion only when this process actually polled, so a waiting caller never
// blocks for the whole timeout and a process that merely received the broadcast
// never unblocks it.
//
// The completion document is informational: the completion key is the handover
// signal, while the cached state document is the source of truth the refresh
// reads. If the lease moved between receiving the request and running the cycle,
// this process leaves the request to the new owner instead of forwarding it again.
func (s *Service) handleTelegramPollRequest(ctx context.Context, payload string) {
	var request telegramPollRequest
	if err := json.Unmarshal([]byte(payload), &request); err != nil {
		return
	}
	if request.Version != telegramPollVersion || strings.TrimSpace(request.RequestID) == "" {
		return
	}
	s.logf("situationsignalsworker: received telegram poll request %s", request.RequestID)

	s.mu.Lock()
	outcome := telegramCycleSkipped
	var pollErr error
	if !s.closing.Load() {
		outcome, pollErr = s.pollTelegram(ctx, telegramPollServe)
	}
	lastError := s.telegramState.LastError
	s.mu.Unlock()

	switch outcome {
	case telegramCyclePolled, telegramCycleRefused:
	default:
		// The lease belongs to another instance (or no transport is configured):
		// leave the request to the owner instead of answering it.
		return
	}
	if pollErr != nil {
		s.logf("situationsignalsworker: telegram poll request %s failed here: %v", request.RequestID, pollErr)
	}

	done := telegramPollDone{Version: telegramPollVersion, OK: outcome == telegramCyclePolled}
	switch {
	case pollErr != nil:
		done.Error = pollErr.Error()
	default:
		done.Error = lastError
	}
	if s.pollBus == nil {
		return
	}
	if err := s.pollBus.Complete(ctx, request.RequestID, done); err != nil {
		s.logf("situationsignalsworker: record telegram poll completion failed: %v", err)
		return
	}
	s.logf("situationsignalsworker: telegram poll request %s finished ok=%t", request.RequestID, done.OK)
}

// handoverTelegramPoll publishes a poll request for a cycle this process may not
// run because another instance owns the lease (B2) and reports how the cycle
// ended.
//
// mode telegramPollAsync returns after publishing (queue job). mode
// telegramPollWait waits for the owner's completion (refresh route); the caller
// holds the Telegram lock for the duration of the wait, which delays but never
// drops a queued Telegram job (the queue worker renews its job lock meanwhile).
//
// A PUBLISH that reports zero subscribers means no process is listening for
// handovers: the lease owner is still starting or its subscription is gone. The
// cycle then tries the lease once more and polls locally when it wins, which
// keeps a single-instance deployment working without a subscriber.
func (s *Service) handoverTelegramPoll(ctx context.Context, runtime TelegramRuntimeConfig, options telegramclient.Options, fingerprint string, mode telegramPollMode) (telegramCycleOutcome, error) {
	if s.pollBus == nil {
		s.logf("situationsignalsworker: telegram poll handover is not configured; skipped the cycle")
		return telegramCycleSkipped, nil
	}
	requestID := newTelegramPollRequestID()
	subscribers, err := s.pollBus.Publish(ctx, requestID)
	if err != nil {
		s.logf("situationsignalsworker: publish telegram poll request failed: %v", err)
		return telegramCycleSkipped, fmt.Errorf("publish telegram poll request: %w", err)
	}
	if subscribers == 0 {
		s.logf("situationsignalsworker: no subscriber accepted telegram poll request %s; retrying the lease", requestID)
		owned, leaseErr := s.telegram.WithLease(ctx, options, fingerprint, func(callCtx context.Context, client telegramclient.PollClient) error {
			s.pollTelegramWithClient(callCtx, runtime, client)
			return nil
		})
		if leaseErr != nil {
			s.telegramState.LastError = fmt.Sprintf("telegram poll failed: %v", leaseErr)
			s.logf("situationsignalsworker: telegram poll failed: %v", leaseErr)
			return telegramCycleSkipped, nil
		}
		if !owned {
			return telegramCycleSkipped, errTelegramPollNoOwner
		}
		s.completeTelegramOwnedCycle(ctx)
		return telegramCyclePolled, nil
	}
	if mode == telegramPollAsync {
		s.logf("situationsignalsworker: handed telegram poll request %s to the lease owner", requestID)
		return telegramCycleHandedOver, nil
	}

	timeout := time.Duration(runtime.PollCycleTimeoutMS+telegramPollWaitMarginMS) * time.Millisecond
	done, received, err := s.pollBus.Wait(ctx, requestID, timeout)
	if err != nil {
		s.logf("situationsignalsworker: wait for telegram poll request %s failed: %v", requestID, err)
		return telegramCycleHandedOver, fmt.Errorf("wait for telegram poll handover: %w", err)
	}
	if !received {
		s.logf("situationsignalsworker: telegram poll request %s timed out after %s", requestID, timeout)
		return telegramCycleHandedOver, errTelegramPollHandoverTimeout
	}
	if !done.OK && done.Error != "" {
		s.logf("situationsignalsworker: handed-over telegram poll request %s reported: %s", requestID, done.Error)
	}
	return telegramCycleHandedOver, nil
}
