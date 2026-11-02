//go:build integration

package telegramsched

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set - integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

func clearQueue(t *testing.T, client *redis.Client) {
	t.Helper()
	ctx := context.Background()
	pattern := "bull:situationMonitorSignals:*"
	var cursor uint64
	for {
		keys, next, err := client.Scan(ctx, cursor, pattern, 500).Result()
		if err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(keys) > 0 {
			if err := client.Del(ctx, keys...).Err(); err != nil {
				t.Fatalf("del: %v", err)
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
}

func fixedClock() func() time.Time {
	value := time.UnixMilli(1_700_000_000_000)
	return func() time.Time { return value }
}

func TestTelegramSchedulerRedisIntegration(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	clearQueue(t, client)
	ctx := context.Background()
	scheduler := New(client)
	scheduler.now = fixedClock()
	now := scheduler.now().UnixMilli()

	if err := scheduler.Sync(ctx, true, 60_000); err != nil {
		t.Fatal(err)
	}
	score, err := client.ZScore(ctx, scheduler.keys.repeat, PollSchedulerID).Result()
	if err != nil {
		t.Fatal(err)
	}
	if int64(score) != now {
		t.Fatalf("repeat score = %f, want %d", score, now)
	}
	hash, err := client.HGetAll(ctx, scheduler.keys.repeat+":"+PollSchedulerID).Result()
	if err != nil {
		t.Fatal(err)
	}
	if hash["name"] != PollJobName || hash["every"] != "60000" {
		t.Fatalf("scheduler hash = %v", hash)
	}
	if hash["data"] != `{"type":"poll","source":"telegram"}` {
		t.Fatalf("scheduler data = %s", hash["data"])
	}
	if !strings.Contains(hash["opts"], `"removeOnComplete":true`) {
		t.Fatalf("scheduler opts = %s", hash["opts"])
	}

	// The first `every` iteration has delay 0, so addJobFromScheduler pushes it
	// to the wait list instead of the delayed zset (BullMQ behaviour).
	scheduledID := "repeat:" + PollSchedulerID + ":" + itoa64(now)
	waiting, err := client.LRange(ctx, scheduler.keys.wait, 0, -1).Result()
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(waiting, scheduledID) {
		t.Fatalf("scheduled iteration %s missing from wait: %v", scheduledID, waiting)
	}
	scheduledOpts, err := client.HGet(ctx, scheduler.keys.prefix+scheduledID, "opts").Result()
	if err != nil {
		t.Fatal(err)
	}
	var opts map[string]any
	if err := json.Unmarshal([]byte(scheduledOpts), &opts); err != nil {
		t.Fatal(err)
	}
	if opts["repeatJobKey"] != PollSchedulerID {
		t.Fatalf("scheduled opts = %v", opts)
	}

	bootstrapName, bootstrapData := findJobByName(t, client, scheduler, PollJobName+":bootstrap")
	if bootstrapName == "" {
		t.Fatal("bootstrap job missing")
	}
	if bootstrapData != `{"type":"poll","source":"telegram"}` {
		t.Fatalf("bootstrap data = %s", bootstrapData)
	}

	// A second upsert with a different interval replaces the stored every.
	if err := scheduler.Sync(ctx, true, 30_000); err != nil {
		t.Fatal(err)
	}
	if got, _ := client.HGet(ctx, scheduler.keys.repeat+":"+PollSchedulerID, "every").Result(); got != "30000" {
		t.Fatalf("every after update = %q", got)
	}
}

func TestTelegramSchedulerRemovalIntegration(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	clearQueue(t, client)
	ctx := context.Background()
	scheduler := New(client)
	scheduler.now = fixedClock()

	if err := scheduler.Sync(ctx, true, 60_000); err != nil {
		t.Fatal(err)
	}
	// Simulate pending Telegram poll jobs in all four collections plus an OREF
	// job and a locked Telegram job that must be skipped.
	seedJob(t, client, scheduler, "telegram-poll:waiting", "telegram-poll", false)
	seedJob(t, client, scheduler, "telegram-poll:paused", "telegram-poll", true)
	seedJob(t, client, scheduler, "telegram-poll:prioritized", "telegram-poll", false)
	seedDelayedJob(t, client, scheduler, "telegram-poll:delayed", "telegram-poll")
	seedJob(t, client, scheduler, "oref-poll:waiting", "oref-poll", false)
	seedJob(t, client, scheduler, "telegram-poll:locked", "telegram-poll", false)
	if err := client.Set(ctx, scheduler.keys.prefix+"telegram-poll:locked:lock", "token", time.Minute).Err(); err != nil {
		t.Fatal(err)
	}

	// A legacy hashed repeat entry whose name is telegram-poll is removed first.
	legacyKey := "telegram-poll:job1:::60000"
	if err := client.ZAdd(ctx, scheduler.keys.repeat, redis.Z{Score: float64(nowOf(scheduler) + 1), Member: legacyKey}).Err(); err != nil {
		t.Fatal(err)
	}
	if err := client.HSet(ctx, scheduler.keys.repeat+":"+legacyKey, "name", PollJobName).Err(); err != nil {
		t.Fatal(err)
	}

	if err := scheduler.Sync(ctx, false, 0); err != nil {
		t.Fatal(err)
	}
	if exists, _ := client.Exists(ctx, scheduler.keys.repeat+":"+PollSchedulerID).Result(); exists != 0 {
		t.Fatal("scheduler hash still exists")
	}
	if _, err := client.ZScore(ctx, scheduler.keys.repeat, PollSchedulerID).Result(); err != redis.Nil {
		t.Fatalf("scheduler zset member still exists: %v", err)
	}
	if _, err := client.ZScore(ctx, scheduler.keys.repeat, legacyKey).Result(); err != redis.Nil {
		t.Fatalf("legacy repeat still exists: %v", err)
	}
	for _, id := range []string{"telegram-poll:waiting", "telegram-poll:paused", "telegram-poll:prioritized", "telegram-poll:delayed"} {
		if exists, _ := client.Exists(ctx, scheduler.keys.prefix+id).Result(); exists != 0 {
			t.Fatalf("%s was not removed", id)
		}
	}
	if exists, _ := client.Exists(ctx, scheduler.keys.prefix+"oref-poll:waiting").Result(); exists != 1 {
		t.Fatal("oref job must survive")
	}
	if exists, _ := client.Exists(ctx, scheduler.keys.prefix+"telegram-poll:locked").Result(); exists != 1 {
		t.Fatal("locked job must survive")
	}
	// The BullMQ legacy branch (removeRepeatable-3 ARGV[2] = the legacy key)
	// removes the zset member and returns before the new branch deletes the
	// hash, so the legacy repeat hash is an allowed orphan; the zset member
	// assertion above is the functional check.
	for _, key := range []string{
		scheduler.keys.repeat + ":" + PollSchedulerID,
		scheduler.keys.prefix + "telegram-poll:waiting",
		scheduler.keys.prefix + "telegram-poll:paused",
		scheduler.keys.prefix + "telegram-poll:prioritized",
		scheduler.keys.prefix + "telegram-poll:delayed",
	} {
		if exists, _ := client.Exists(ctx, key).Result(); exists != 0 {
			t.Fatalf("%s still exists", key)
		}
	}
}

func TestTelegramSchedulerNodeInterop(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	clearQueue(t, client)
	ctx := context.Background()
	scheduler := New(client)
	scheduler.now = fixedClock()

	if err := scheduler.Sync(ctx, true, 45_000); err != nil {
		t.Fatal(err)
	}
	raw := runNodeFixture(t, "inspect", nil)
	var inspected struct {
		Schedulers []struct {
			Key      string          `json:"key"`
			Name     string          `json:"name"`
			Every    int64           `json:"every"`
			Template json.RawMessage `json:"template"`
		} `json:"schedulers"`
		Jobs []struct {
			Name string `json:"name"`
			Data struct {
				Type   string `json:"type"`
				Source string `json:"source"`
			} `json:"data"`
		} `json:"jobs"`
	}
	if err := json.Unmarshal([]byte(raw), &inspected); err != nil {
		t.Fatalf("node inspect: %v\n%s", err, raw)
	}
	found := false
	for _, entry := range inspected.Schedulers {
		if entry.Key == PollSchedulerID {
			found = true
			if entry.Name != PollJobName || entry.Every != 45_000 {
				t.Fatalf("node scheduler = %+v", entry)
			}
			if !strings.Contains(string(entry.Template), `"source":"telegram"`) {
				t.Fatalf("node template = %s", entry.Template)
			}
		}
	}
	if !found {
		t.Fatalf("node did not read the scheduler: %s", raw)
	}

	// Node replaces the scheduler interval; Go must observe and then remove it.
	if out := runNodeFixture(t, "upsert", map[string]string{"FIXTURE_EVERY": "30000"}); !strings.Contains(out, "ok") {
		t.Fatalf("node upsert = %s", out)
	}
	if got, _ := client.HGet(ctx, scheduler.keys.repeat+":"+PollSchedulerID, "every").Result(); got != "30000" {
		t.Fatalf("every after node upsert = %q", got)
	}
	if err := scheduler.Sync(ctx, false, 0); err != nil {
		t.Fatal(err)
	}
	if exists, _ := client.Exists(ctx, scheduler.keys.repeat+":"+PollSchedulerID).Result(); exists != 0 {
		t.Fatal("Go did not remove the Node scheduler")
	}
}

func nowOf(scheduler *Scheduler) int64 { return scheduler.now().UnixMilli() }

func itoa64(value int64) string { return strconv.FormatInt(value, 10) }

func findJobByName(t *testing.T, client *redis.Client, scheduler *Scheduler, name string) (string, string) {
	t.Helper()
	ids, err := client.LRange(context.Background(), scheduler.keys.wait, 0, -1).Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		jobName, err := client.HGet(context.Background(), scheduler.keys.prefix+id, "name").Result()
		if err != nil {
			continue
		}
		if jobName == name {
			data, _ := client.HGet(context.Background(), scheduler.keys.prefix+id, "data").Result()
			return jobName, data
		}
	}
	return "", ""
}

func seedJob(t *testing.T, client *redis.Client, scheduler *Scheduler, id, name string, paused bool) {
	t.Helper()
	ctx := context.Background()
	jobKey := scheduler.keys.prefix + id
	if err := client.HSet(ctx, jobKey, "name", name, "data", "{}", "opts", "{}", "timestamp", nowOf(scheduler)).Err(); err != nil {
		t.Fatal(err)
	}
	if paused {
		if err := client.LPush(ctx, scheduler.keys.paused, id).Err(); err != nil {
			t.Fatal(err)
		}
		return
	}
	if strings.Contains(id, "prioritized") {
		if err := client.ZAdd(ctx, scheduler.keys.prioritized, redis.Z{Score: 1, Member: id}).Err(); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := client.LPush(ctx, scheduler.keys.wait, id).Err(); err != nil {
		t.Fatal(err)
	}
}

func seedDelayedJob(t *testing.T, client *redis.Client, scheduler *Scheduler, id, name string) {
	t.Helper()
	ctx := context.Background()
	if err := client.HSet(ctx, scheduler.keys.prefix+id, "name", name, "data", "{}", "opts", "{}").Err(); err != nil {
		t.Fatal(err)
	}
	if err := client.ZAdd(ctx, scheduler.keys.delayed, redis.Z{Score: float64(nowOf(scheduler) + 1000), Member: id}).Err(); err != nil {
		t.Fatal(err)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../../.."))
}

func runNodeFixture(t *testing.T, mode string, environment map[string]string) string {
	t.Helper()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("node is required in CI for the BullMQ interoperability fixture")
		}
		t.Skip("node is not installed")
	}
	root := repoRoot(t)
	fixture, err := os.ReadFile(filepath.Join(root, "apps/api-go/testdata/situation_scheduler_fixture.mjs"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	command := exec.Command(nodePath, "--input-type=module")
	command.Dir = filepath.Join(root, "infra/scripts")
	command.Stdin = bytes.NewReader(fixture)
	env := append(os.Environ(), "FIXTURE_MODE="+mode)
	for key, value := range environment {
		env = append(env, key+"="+value)
	}
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("node fixture %s: %v\n%s", mode, err, output)
	}
	return strings.TrimSpace(string(output))
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
