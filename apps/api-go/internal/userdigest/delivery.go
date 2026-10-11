package userdigest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultDeliveryTime     = "09:00"
	defaultDeliveryTimezone = "UTC"
	deliveryStatusIdle      = "idle"
)

// timePattern 对齐 UpdateUserDigestDeliveryDto 的 @Matches(/^\d{2}:\d{2}$/)，没有捕获组。
var timePattern = regexp.MustCompile(`^\d{2}:\d{2}$`)

// timeClockPattern 对齐 service 里的 TIME_PATTERN，用来取出小时和分钟。
var timeClockPattern = regexp.MustCompile(`^(\d{2}):(\d{2})$`)

// DeliverySettings 是 UserDigestDeliverySettingsV1。邮箱只来自用户行，不来自请求体。
type DeliverySettings struct {
	Version       int     `json:"version"`
	Enabled       bool    `json:"enabled"`
	Time          string  `json:"time"`
	Timezone      string  `json:"timezone"`
	TargetEmail   string  `json:"targetEmail"`
	EmailVerified bool    `json:"emailVerified"`
	NextRunAt     *string `json:"nextRunAt"`
	LastSentAt    *string `json:"lastSentAt"`
	LastStatus    string  `json:"lastStatus"`
	LastStatusAt  *string `json:"lastStatusAt"`
	LastError     *string `json:"lastError"`
}

type deliveryUser struct {
	email         string
	emailVerified bool
}

type deliverySchedule struct {
	enabled      bool
	timezone     string
	sendHour     int
	sendMinute   int
	nextRunAt    sql.NullTime
	lastSentAt   sql.NullTime
	lastStatus   string
	lastStatusAt sql.NullTime
	lastError    sql.NullString
	found        bool
}

func (s *Service) GetDelivery(ctx context.Context, orgID, userID string) (DeliverySettings, error) {
	user, err := s.deliveryUser(ctx, orgID, userID)
	if err != nil {
		return DeliverySettings{}, err
	}
	schedule, err := s.deliverySchedule(ctx, orgID, userID)
	if err != nil {
		return DeliverySettings{}, err
	}
	return schedule.settings(user), nil
}

func (s *Service) UpdateDelivery(ctx context.Context, orgID, userID string, input deliveryInput) (DeliverySettings, error) {
	user, err := s.deliveryUser(ctx, orgID, userID)
	if err != nil {
		return DeliverySettings{}, err
	}
	normalized, err := normalizeScheduleInput(input)
	if err != nil {
		return DeliverySettings{}, err
	}
	if normalized.enabled && !user.emailVerified {
		return DeliverySettings{}, badRequest("Verified email is required before enabling digest delivery")
	}
	var next *time.Time
	if normalized.enabled {
		at, err := computeNextRunAt(normalized.timezone, normalized.sendHour, normalized.sendMinute, s.clock())
		if err != nil {
			return DeliverySettings{}, badRequest("timezone must be a valid IANA timezone")
		}
		next = &at
	}
	if err := s.upsertDelivery(ctx, orgID, userID, normalized, next); err != nil {
		return DeliverySettings{}, err
	}
	schedule, err := s.deliverySchedule(ctx, orgID, userID)
	if err != nil {
		return DeliverySettings{}, err
	}
	return schedule.settings(user), nil
}

type scheduleInput struct {
	enabled    bool
	timezone   string
	sendHour   int
	sendMinute int
}

func normalizeScheduleInput(input deliveryInput) (scheduleInput, error) {
	timezone := strings.TrimSpace(input.timezone)
	if !validTimezone(timezone) {
		return scheduleInput{}, badRequest("timezone must be a valid IANA timezone")
	}
	match := timeClockPattern.FindStringSubmatch(strings.TrimSpace(input.time))
	if match == nil {
		return scheduleInput{}, badRequest("time must use HH:mm format")
	}
	hour, hourErr := strconv.Atoi(match[1])
	minute, minuteErr := strconv.Atoi(match[2])
	if hourErr != nil || minuteErr != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return scheduleInput{}, badRequest("time must be a valid 24-hour clock value")
	}
	return scheduleInput{enabled: input.enabled, timezone: timezone, sendHour: hour, sendMinute: minute}, nil
}

// validTimezone 用 time.LoadLocation（依赖本包 import 的 time/tzdata）。
// Nest 用 Intl.DateTimeFormat({ timeZone })。ICU 会接受部分大小写变体
// （例如 america/new_york），Go 的名字区分大小写。非法名字两边都拒绝。
func validTimezone(name string) bool {
	if name == "" || name == "Local" {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

// computeNextRunAt 返回严格晚于 reference 的下一次发送时刻。
//
// Nest（user-digest-delivery.service.ts）用的是 dayjs，不是 luxon / Temporal：
//
//	dayjs(reference).tz(zone).hour(h).minute(m).second(0).millisecond(0)
//	若 !isAfter(reference) 则 add(1, "day")，最后 utc().toDate()。
//
// 在 UTC 服务器上，dayjs timezone 插件把「该时区的墙钟」写进 $d（按 UTC 标记），
// 并把 $offset 冻在 reference 那一瞬间，设置 hour/minute 时不再按目标墙钟重算偏移。
// 因此发送时刻和 reference 落在夏令时切换两侧时，Nest 的 UTC 瞬间会比真实墙钟
// 差 1 小时。Go 的 time.Date(y, m, d, h, min, 0, 0, loc) 会使用目标墙钟自己的
// 偏移。这里保持 dayjs 的冻结偏移，不改成 Go 的墙钟重算。
//
// add(1, "day") 在 UTC 服务器上是对 $d 做 setDate(+1)，也就是加一个 UTC 日历日
// （24 小时），偏移仍是 reference 的偏移。不是时区内 AddDate 那种跨 DST 仍保持
// 同一墙钟（23 或 25 小时）的算法。这里同样加一个 UTC 日历日。
//
// dayjs 1.11 的 .utc().toDate() 返回原始 $d。那会丢掉 $offset，把任意时区的
// HH:mm 存成 HH:mm UTC。同函数里的 isAfter 用的是 valueOf()，那个值应用了 $offset。
// 若原样返回 $d，日程就不再使用用户时区。这里返回应用偏移后的瞬间（valueOf），
// 也就是「该时区下一次 HH:mm，且严格晚于 reference」，不是从现在起平加 24 小时，
// 也不是 HH:mm UTC。这是相对 Nest .utc().toDate() 的有意差异。
func computeNextRunAt(timezone string, hour, minute int, reference time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	reference = reference.UTC().Truncate(time.Millisecond)
	local := reference.In(loc)
	_, offset := local.Zone()
	year, month, day := local.Date()
	wall := time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
	adjusted := applyFrozenOffset(wall, offset)
	if !adjusted.After(reference) {
		wall = wall.AddDate(0, 0, 1)
		adjusted = applyFrozenOffset(wall, offset)
	}
	return adjusted.UTC(), nil
}

func applyFrozenOffset(wall time.Time, offsetSeconds int) time.Time {
	return wall.Add(-time.Duration(offsetSeconds) * time.Second)
}

func (s *Service) deliveryUser(ctx context.Context, orgID, userID string) (deliveryUser, error) {
	if err := s.requireDB(); err != nil {
		return deliveryUser{}, err
	}
	var user deliveryUser
	var verified sql.NullTime
	var userActive, membershipActive bool
	err := s.db.QueryRowContext(ctx, "SELECT u.email, u.emailVerified, u.isActive, m.isActive "+
		"FROM Membership m INNER JOIN `User` u ON u.id = m.userId "+
		"WHERE m.userId = ? AND m.orgId = ?", userID, orgID).Scan(&user.email, &verified, &userActive, &membershipActive)
	if errors.Is(err, sql.ErrNoRows) {
		return deliveryUser{}, notFound("Digest delivery user not found")
	}
	if err != nil {
		return deliveryUser{}, fmt.Errorf("%w: digest delivery user: %v", errMySQL, err)
	}
	if !membershipActive || !userActive {
		return deliveryUser{}, badRequest("Digest delivery is unavailable for inactive users")
	}
	user.emailVerified = verified.Valid
	return user, nil
}

func (s *Service) deliverySchedule(ctx context.Context, orgID, userID string) (deliverySchedule, error) {
	if err := s.requireDB(); err != nil {
		return deliverySchedule{}, err
	}
	var schedule deliverySchedule
	err := s.db.QueryRowContext(ctx, `SELECT enabled, timezone, sendHour, sendMinute, nextRunAt, lastSentAt, lastStatus, lastStatusAt, lastError
FROM UserDigestDeliverySchedule WHERE orgId = ? AND userId = ?`, orgID, userID).Scan(
		&schedule.enabled, &schedule.timezone, &schedule.sendHour, &schedule.sendMinute,
		&schedule.nextRunAt, &schedule.lastSentAt, &schedule.lastStatus, &schedule.lastStatusAt, &schedule.lastError)
	if errors.Is(err, sql.ErrNoRows) {
		return deliverySchedule{}, nil
	}
	if err != nil {
		return deliverySchedule{}, fmt.Errorf("%w: digest delivery schedule: %v", errMySQL, err)
	}
	schedule.found = true
	return schedule, nil
}

func (s *Service) upsertDelivery(ctx context.Context, orgID, userID string, input scheduleInput, next *time.Time) error {
	if err := s.requireDB(); err != nil {
		return err
	}
	id, err := newRowID()
	if err != nil {
		return fmt.Errorf("%w: delivery id: %v", errMySQL, err)
	}
	var nextValue any
	if next != nil {
		nextValue = next.UTC().Truncate(time.Millisecond)
	}
	updatedAt := time.Now().UTC().Truncate(time.Millisecond)
	// id、updatedAt 没有列默认值。createdAt / lastStatus 有默认值。
	// 关闭投递时 nextRunAt 写 NULL，并只清 lastError；lastStatus / lastSentAt 不动。
	// 打开投递时不改 lastError。
	const query = "INSERT INTO UserDigestDeliverySchedule " +
		"(id, orgId, userId, enabled, timezone, sendHour, sendMinute, nextRunAt, updatedAt) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row " +
		"ON DUPLICATE KEY UPDATE enabled = new_row.enabled, timezone = new_row.timezone, " +
		"sendHour = new_row.sendHour, sendMinute = new_row.sendMinute, nextRunAt = new_row.nextRunAt, " +
		"lastError = IF(new_row.enabled = 0, NULL, lastError), updatedAt = new_row.updatedAt"
	if _, err := s.db.ExecContext(ctx, query, id, orgID, userID, input.enabled, input.timezone, input.sendHour, input.sendMinute, nextValue, updatedAt); err != nil {
		return fmt.Errorf("%w: upsert digest delivery: %v", errMySQL, err)
	}
	return nil
}

func (s deliverySchedule) settings(user deliveryUser) DeliverySettings {
	enabled := false
	timezone := defaultDeliveryTimezone
	clock := defaultDeliveryTime
	status := deliveryStatusIdle
	var next, sent, statusAt sql.NullTime
	var lastError sql.NullString
	if s.found {
		enabled = s.enabled
		timezone = s.timezone
		clock = fmt.Sprintf("%02d:%02d", s.sendHour, s.sendMinute)
		status = s.lastStatus
		next = s.nextRunAt
		sent = s.lastSentAt
		statusAt = s.lastStatusAt
		lastError = s.lastError
	}
	if status == "" {
		status = deliveryStatusIdle
	}
	return DeliverySettings{
		Version:       1,
		Enabled:       enabled,
		Time:          clock,
		Timezone:      timezone,
		TargetEmail:   user.email,
		EmailVerified: user.emailVerified,
		NextRunAt:     nullTimeISO(next),
		LastSentAt:    nullTimeISO(sent),
		LastStatus:    status,
		LastStatusAt:  nullTimeISO(statusAt),
		LastError:     nullString(lastError),
	}
}

func nullTimeISO(value sql.NullTime) *string {
	if !value.Valid {
		return nil
	}
	text := isoTime(value.Time)
	return &text
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}
