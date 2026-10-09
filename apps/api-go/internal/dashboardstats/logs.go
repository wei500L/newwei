package dashboardstats

import (
	"bytes"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// recentLog 是 TaskLog 投影后的一条记录。只输出文档里实际存在的字段，
// null 保留为 null，缺失则省略——对齐 lean() 再 JSON.stringify。
type recentLog struct {
	createdAt    time.Time
	hasCreatedAt bool
	createdNull  bool

	jobID    string
	hasJobID bool
	jobNull  bool

	message    string
	hasMessage bool
	msgNull    bool

	stage    string
	hasStage bool
	stageNull bool

	status    string
	hasStatus bool
	statusNull bool
}

func recentLogFromDoc(doc bson.M) recentLog {
	var log recentLog
	log.createdAt, log.hasCreatedAt, log.createdNull = timeField(doc, "createdAt")
	log.jobID, log.hasJobID, log.jobNull = stringField(doc, "jobId")
	log.message, log.hasMessage, log.msgNull = stringField(doc, "message")
	log.stage, log.hasStage, log.stageNull = stringField(doc, "stage")
	log.status, log.hasStatus, log.statusNull = stringField(doc, "status")
	return log
}

func timeField(doc bson.M, key string) (time.Time, bool, bool) {
	value, ok := doc[key]
	if !ok {
		return time.Time{}, false, false
	}
	if value == nil {
		return time.Time{}, true, true
	}
	switch typed := value.(type) {
	case time.Time:
		return typed, true, false
	case bson.DateTime:
		return typed.Time(), true, false
	default:
		return time.Time{}, true, true
	}
}

func stringField(doc bson.M, key string) (string, bool, bool) {
	value, ok := doc[key]
	if !ok {
		return "", false, false
	}
	if value == nil {
		return "", true, true
	}
	text, ok := value.(string)
	if !ok {
		return "", true, true
	}
	return text, true, false
}

// formatJSTime 是 Date.toISOString()：UTC，始终三位毫秒。
func formatJSTime(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func (log recentLog) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	write := func(key string, raw []byte) {
		if !first {
			buf.WriteByte(',')
		}
		first = false
		buf.WriteString(strconv.Quote(key))
		buf.WriteByte(':')
		buf.Write(raw)
	}
	if log.hasCreatedAt {
		if log.createdNull {
			write("createdAt", []byte("null"))
		} else {
			write("createdAt", strconv.AppendQuote(nil, formatJSTime(log.createdAt)))
		}
	}
	writeString(&buf, &first, "jobId", log.hasJobID, log.jobNull, log.jobID)
	writeString(&buf, &first, "message", log.hasMessage, log.msgNull, log.message)
	writeString(&buf, &first, "stage", log.hasStage, log.stageNull, log.stage)
	writeString(&buf, &first, "status", log.hasStatus, log.statusNull, log.status)
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func writeString(buf *bytes.Buffer, first *bool, key string, has, isNull bool, value string) {
	if !has {
		return
	}
	if !*first {
		buf.WriteByte(',')
	}
	*first = false
	buf.WriteString(strconv.Quote(key))
	buf.WriteByte(':')
	if isNull {
		buf.WriteString("null")
		return
	}
	buf.WriteString(strconv.Quote(value))
}
