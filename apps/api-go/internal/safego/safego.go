// Package safego isolates panics in the goroutines started by the gateway's
// background code.
//
// The gateway is a single process: the HTTP server, the BullMQ workers and the
// ticker schedulers all share it. net/http recovers a panic only on the
// goroutine that serves a request. A panic in a goroutine the application starts
// itself therefore unwinds to the top of that goroutine with no recover, and the
// whole process exits, taking every other responsibility down with it.
//
// Go runs one fire-and-forget unit on a new goroutine and lets a panic end only
// that goroutine; Call runs one per-round or per-job unit on the caller's
// goroutine and turns a panic into an ordinary error, so the surrounding loop or
// the worker's existing failure path can continue exactly as it would for a
// returned error.
//
// name must be a bounded static string such as "itempipeline.worker.process".
// Do not build it from job ids or org ids: that would make the panic counter
// unbounded. Put the dynamic context in the unit's own logs instead.
package safego

import (
	"fmt"
	"log"
	"runtime/debug"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// Go runs fn on a new goroutine and recovers a panic so it cannot terminate the
// process. The goroutine ends after logging; it is never restarted.
func Go(name string, fn func()) {
	go func() {
		defer func() {
			if value := recover(); value != nil {
				recordPanic(name, value)
			}
		}()
		fn()
	}()
}

// Call runs fn on the current goroutine. A panic is recovered and returned as an
// error tagged with name, after logging the stack, so a per-round loop body or a
// per-job handler can treat it as an ordinary failure. The error is returned
// through the named result so a deferred recover cannot clobber a normal return.
func Call(name string, fn func() error) (err error) {
	defer func() {
		if value := recover(); value != nil {
			recordPanic(name, value)
			err = fmt.Errorf("%s: panic: %v", name, value)
		}
	}()
	return fn()
}

// recordPanic logs the recovered value together with the full stack and counts
// the panic under its bounded name.
func recordPanic(name string, value any) {
	log.Printf("safego: %s panicked: %v\n%s", name, value, debug.Stack())
	metrics.RecordGoroutinePanic(name)
}
