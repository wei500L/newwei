package crawlworker

// Error values of the crawl worker. The limiter texts are copied verbatim from
// crawl.processor.ts because they surface in job failure logs during shutdown;
// the queue message errors mirror the three warn branches of
// parseWorkerConcurrencyMessage.

import "errors"

var (
	// errLimiterClosed is thrown by a new acquire after close().
	errLimiterClosed = errors.New("Global crawl concurrency limiter is closed")
	// errLimiterShuttingDown is the rejection pending waiters receive from
	// close().
	errLimiterShuttingDown = errors.New("Global crawl concurrency limiter is shutting down")

	// errInvalidJSONMessage is the "invalid JSON" broadcast rejection.
	errInvalidJSONMessage = errors.New("invalid JSON")
	// errNotObjectMessage is the "not an object" broadcast rejection.
	errNotObjectMessage = errors.New("not an object")
	// errUnsupportedPayloadMessage is the "unsupported payload" broadcast
	// rejection (wrong version, non-integer or out-of-range maxConcurrency).
	errUnsupportedPayloadMessage = errors.New("unsupported payload")

	// errJobPayloadMissing is persistMemoryPressureRequeueCount's "Crawl job
	// payload is missing" error.
	errJobPayloadMissing = errors.New("crawlworker: crawl job payload is missing; cannot persist retry state")
	// errJobPayloadNotObject reports job data that is not a JSON object.
	errJobPayloadNotObject = errors.New("crawlworker: crawl job payload is not a JSON object")
	// errNoSettingsReader reports a worker built without crawl settings.
	errNoSettingsReader = errors.New("crawlworker: crawl settings reader is not configured")
	// errNoTaskRunner reports a job that needs the execution runner but the
	// worker was built without one.
	errNoTaskRunner = errors.New("crawlworker: crawl execution runner is not configured")
	// errWorkerNotStarted reports an operation on a worker that never started.
	errWorkerNotStarted = errors.New("crawlworker: worker is not started")
	// errWorkerAlreadyStarted reports a second Start call.
	errWorkerAlreadyStarted = errors.New("crawlworker: worker already started")
	// errLockLost is the attempt cancel cause when the BullMQ job lock is no
	// longer owned by this attempt.
	errLockLost = errors.New("crawlworker: crawl job lock was lost")
)
