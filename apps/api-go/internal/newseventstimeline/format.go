package newseventstimeline

import (
	"strconv"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// formatISOMillis is Date.prototype.toISOString: UTC, exactly three millisecond
// digits and a Z suffix. It is used for bucket keys, phase boundaries, the
// metadata updatedAt and the tick gate payload.
func formatISOMillis(value time.Time) string {
	return contract.FormatDateTime(value)
}

func formatInt(value int) string {
	return strconv.Itoa(value)
}

// toUTCDayStart mirrors toUtcDayStart: the UTC midnight of the value's UTC
// calendar day.
func toUTCDayStart(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}
