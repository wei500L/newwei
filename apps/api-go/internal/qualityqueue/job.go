package qualityqueue

import (
	"encoding/json"
	"strconv"
)

// Job is one job fetched from the queue. It carries exactly the fields the
// migrated handlers need; the remaining BullMQ fields stay in the Redis hash so
// a NestJS worker can keep processing the same job afterwards.
type Job struct {
	ID              string
	Name            string
	Data            json.RawMessage
	Options         JobOptions
	AttemptsMade    int64
	AttemptsStarted int64
	StalledCount    int64
	// DeferredFailure is the "job stalled more than allowable limit" marker
	// BullMQ writes as defa; a job carrying it must fail without running.
	DeferredFailure string
	// Token is the lock token taken by moveToActive.
	Token string
}

// JobOptions is the subset of the stored job options the worker acts on. The
// hash field "opts" is the JSON object cjson.encode wrote inside the script, so
// the tags mirror the NestJS job option names.
type JobOptions struct {
	Attempts         int64           `json:"attempts" msgpack:"attempts"`
	Backoff          *Backoff        `json:"backoff" msgpack:"backoff,omitempty"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
}

// keepJobs resolves the retention policy for one finished target the way
// BullMQ's Scripts.getKeepJobs does: the job option wins, and an unset option
// falls back to "keep forever" ({count:-1}).
func (o JobOptions) keepJobs(target string) KeepJobs {
	raw := o.RemoveOnComplete
	if target == "failed" {
		raw = o.RemoveOnFail
	}
	return parseKeepJobs(raw)
}

// parseKeepJobs accepts the three shapes BullMQ stores: a boolean, a number or
// an object with age/count.
func parseKeepJobs(raw json.RawMessage) KeepJobs {
	if len(raw) == 0 {
		count := int64(-1)
		return KeepJobs{Count: &count}
	}
	switch firstByte(raw) {
	case 't':
		return RemoveImmediately()
	case 'f':
		// false means "keep the job forever", which BullMQ models as
		// count:-1 (the same value as an unset option).
		count := int64(-1)
		return KeepJobs{Count: &count}
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		count := int64(number)
		return KeepJobs{Count: &count}
	}
	var shape struct {
		Age   *int64 `json:"age"`
		Count *int64 `json:"count"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		count := int64(-1)
		return KeepJobs{Count: &count}
	}
	// moveToFinished indexes keepJobs.count unconditionally, so a missing count
	// becomes BullMQ's "keep forever" sentinel instead of nil.
	if shape.Count == nil {
		count := int64(-1)
		shape.Count = &count
	}
	return KeepJobs{Age: shape.Age, Count: shape.Count}
}

// firstByte returns the first non-space byte of a JSON value.
func firstByte(raw json.RawMessage) byte {
	for _, char := range raw {
		switch char {
		case ' ', '\t', '\r', '\n':
			continue
		}
		return char
	}
	return 0
}

// jobFromFields builds a Job from the flat HGETALL reply moveToActive returns.
func jobFromFields(jobID string, fields map[string]string, token string) Job {
	job := Job{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		AttemptsMade:    parseInt64(fields["atm"]),
		AttemptsStarted: parseInt64(fields["ats"]),
		StalledCount:    parseInt64(fields["stc"]),
		DeferredFailure: fields["defa"],
	}
	data := fields["data"]
	if data == "" {
		data = "{}"
	}
	job.Data = json.RawMessage(data)
	if raw := fields["opts"]; raw != "" {
		var options JobOptions
		if err := json.Unmarshal([]byte(raw), &options); err == nil {
			job.Options = options
		}
	}
	return job
}

// parseInt64 reads a Redis integer field; a missing or malformed value is zero,
// which is also how BullMQ's parseInt(json.field || '0') behaves.
func parseInt64(raw string) int64 {
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// flattenPairs turns the flat [field, value, ...] HGETALL reply into a map.
func flattenPairs(reply []any) map[string]string {
	fields := make(map[string]string, len(reply)/2)
	for index := 0; index+1 < len(reply); index += 2 {
		key, ok := reply[index].(string)
		if !ok {
			continue
		}
		value, ok := reply[index+1].(string)
		if !ok {
			continue
		}
		fields[key] = value
	}
	return fields
}
