package analysisruns

// This file is the analysis streaming adapter: UTF-16 flush thresholds,
// incremental running events, partial summaries and the domain StreamError.

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// StreamError keeps the text already delivered to subscribers so a failed run
// can persist its partial summary. The source wraps every stream failure in
// AnalysisStreamError and getPartialSummaryFromError only exposes a non-empty
// value.
type StreamError struct {
	Message        string
	PartialSummary string
	Cause          error
}

func (e *StreamError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *StreamError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func partialSummaryFromError(err error) (string, bool) {
	var streamErr *StreamError
	if !errors.As(err, &streamErr) || streamErr == nil {
		return "", false
	}
	if streamErr.PartialSummary == "" {
		return "", false
	}
	return streamErr.PartialSummary, true
}

// streamCollector owns the incremental running events of one analysis run.
//
// Flush contract: the buffer is compared with ANALYSIS_STREAM_FLUSH_CHARS using
// JavaScript string length (UTF-16 units, not UTF-8 bytes). A new chunk checks
// the elapsed time since the last flush; this is not a 250ms heartbeat. The
// anomaly statistical prefix is flushed before the model stream starts, the
// end of the stream flushes the remainder, and a failure flushes whatever was
// already received before wrapping the partial summary.
type streamCollector struct {
	streamer     publicportal.AnalysisStreamer
	events       *EventPublisher
	orgID        string
	analysisID   string
	analysisType Type
	createdAt    time.Time
	flushChars   int
	flushMs      int
	timeoutMs    int
	messages     []publicportal.AnalysisMessage
	observer     publicportal.AnalysisStreamObserver
}

func (c *streamCollector) run(ctx context.Context, initial string) (string, StreamRaw, error) {
	flushChars := c.flushChars
	if flushChars < 1 {
		flushChars = 80
	}
	flushMs := c.flushMs
	if flushMs < 0 {
		flushMs = 0
	}
	var summary strings.Builder
	var buffer strings.Builder
	bufferUnits := 0
	lastFlushAt := time.Now()
	lastModel := ""
	modelSet := false

	flush := func() {
		if buffer.Len() == 0 {
			return
		}
		chunk := buffer.String()
		buffer.Reset()
		bufferUnits = 0
		summary.WriteString(chunk)
		lastFlushAt = time.Now()
		published := chunk
		if err := c.events.Publish(
			ctx,
			c.orgID,
			c.analysisID,
			c.analysisType,
			StatusRunning,
			&published,
			nil,
			c.createdAt,
		); err != nil && ctx.Err() == nil {
			// The source bus swallows publish failures; the persisted result is
			// authoritative and the run must continue.
			log.Printf("analysisruns: publish running event: %v", err)
		}
	}

	if initial != "" {
		buffer.WriteString(initial)
		bufferUnits += utf16Len(initial)
		flush()
	}

	request := publicportal.AnalysisStreamRequest{
		OrgID:    c.orgID,
		Messages: c.messages,
		Timeout:  time.Duration(c.timeoutMs) * time.Millisecond,
		Observer: c.observer,
		OnChunk: func(chunk publicportal.AnalysisStreamChunk) error {
			if chunk.Model != "" {
				lastModel = chunk.Model
				modelSet = true
			}
			if chunk.Delta == "" {
				return nil
			}
			buffer.WriteString(chunk.Delta)
			bufferUnits += utf16Len(chunk.Delta)
			if bufferUnits >= flushChars || time.Since(lastFlushAt) >= time.Duration(flushMs)*time.Millisecond {
				flush()
			}
			return nil
		},
	}
	if _, err := c.streamer.StreamAnalysis(ctx, request); err != nil {
		flush()
		streamErr := &StreamError{
			Message:        err.Error(),
			PartialSummary: summary.String(),
			Cause:          err,
		}
		return "", StreamRaw{}, streamErr
	}
	flush()
	raw := StreamRaw{Stream: true}
	if modelSet {
		model := lastModel
		raw.Model = &model
	}
	return summary.String(), raw, nil
}
