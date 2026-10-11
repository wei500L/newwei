package analysiscollab

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"time"
	"unicode/utf16"
)

// Now 截断到毫秒，对齐 JavaScript Date 与 DATETIME(3)。
func Now() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// FormatISO 是 Date.toISOString() 的毫秒 UTC 形式。
func FormatISO(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// NewID 写入 Prisma cuid 列。MySQL 没有客户端默认值，必须显式插入。
func NewID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

// JSLen 是 JavaScript 字符串 length，对齐 class-validator MaxLength 与 service trim 后的长度。
func JSLen(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// Marshal 对齐 JSON.stringify：不转义 HTML，不追加换行。
func Marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
