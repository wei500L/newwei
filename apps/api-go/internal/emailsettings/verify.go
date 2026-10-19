package emailsettings

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
)

// verifyCache reproduces EmailService.verifyCached:
//
//   - inside the TTL the previous outcome is returned without touching SMTP;
//   - only one verify runs at a time, and concurrent callers share that result;
//   - lastVerifyAtMs / lastVerifyError are process-local, so the reported status
//     is "this process's most recent verify", exactly like NestJS.
type verifyCache struct {
	mu       sync.Mutex
	now      func() time.Time
	verify   func(context.Context) error
	lastAt   time.Time
	lastErr  string
	hasRun   bool
	inFlight *verifyCall
}

// verifyCall is one shared in-flight attempt.
type verifyCall struct {
	done chan struct{}
	err  error
}

func newVerifyCache(now func() time.Time, verify func(context.Context) error) *verifyCache {
	if now == nil {
		now = time.Now
	}
	return &verifyCache{now: now, verify: verify}
}

// verifyCached runs the verify policy. ttl <= 0 always starts a new attempt
// (unless one is already running, which is shared).
func (c *verifyCache) verifyCached(ctx context.Context, ttl time.Duration) error {
	c.mu.Lock()
	if c.hasRun && c.now().Sub(c.lastAt) < ttl {
		err := c.lastErr
		c.mu.Unlock()
		if err != "" {
			return errors.New(err)
		}
		return nil
	}
	if c.inFlight != nil {
		call := c.inFlight
		c.mu.Unlock()
		<-call.done
		return call.err
	}
	call := &verifyCall{done: make(chan struct{})}
	c.inFlight = call
	c.mu.Unlock()

	err := c.verify(ctx)

	c.mu.Lock()
	call.err = err
	c.lastAt = c.now()
	c.hasRun = true
	if err != nil {
		c.lastErr = err.Error()
	} else {
		c.lastErr = ""
	}
	c.inFlight = nil
	close(call.done)
	c.mu.Unlock()
	return err
}

// status renders the current verify state.
func (c *verifyCache) status() verifyStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.hasRun {
		return verifyStatus{}
	}
	ok := c.lastErr == ""
	checkedAt := settingshttp.NestTimestamp(c.lastAt)
	var message *string
	if c.lastErr != "" {
		trimmed := strings.TrimSpace(c.lastErr)
		message = &trimmed
	}
	return verifyStatus{OK: &ok, CheckedAt: &checkedAt, Error: message}
}
