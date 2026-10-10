package health

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	probeMySQL    = "mysql"
	probeRedis    = "redis"
	probeMongo    = "mongo"
	probeCrawl    = "crawl4ai"
	probeSSRF     = "crawl4aiSsrfProxy"
	probeLLM      = "llmGateway"
	probeDisk     = "disk"
	ssrfProbeURL  = "https://example.com/"
	diskThreshold = 0.95
)

type outcome struct {
	name  string
	up    bool
	value string
}

type crawlConfig struct {
	baseURL    string
	apiKey     string
	timeout    time.Duration
	healthTTL  time.Duration
	proxyURL   string
	rerankNeed bool
}

type probeSet struct {
	db       *sql.DB
	redis    *redis.Client
	mongoURI    string
	mongo       *mongo.Database
	mongoClient *mongo.Client
	mongoMu     sync.Mutex
	crawl    crawlConfig
	getenv   func(string) string
	http     *http.Client
	diskPath string

	crawlMu       sync.Mutex
	crawlCached   *cachedProbe
	crawlFlight   chan struct{}
	crawlWait     []chan cachedProbe
	ssrfCached    *cachedProbe
	ssrfFlight    chan struct{}
	ssrfWait      []chan cachedProbe
}

type cachedProbe struct {
	ok         bool
	message    string
	durationMs int64
	expires    time.Time
}

func (p *probeSet) all(ctx context.Context) []outcome {
	names := []string{probeMySQL, probeRedis, probeMongo, probeCrawl, probeSSRF, probeLLM, probeDisk}
	out := make([]outcome, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			out[i] = p.one(ctx, name)
		}(i, name)
	}
	wg.Wait()
	return out
}

func (p *probeSet) one(ctx context.Context, name string) outcome {
	switch name {
	case probeMySQL:
		return p.mysql(ctx)
	case probeRedis:
		return p.redisProbe(ctx)
	case probeMongo:
		return p.mongoProbe(ctx)
	case probeCrawl:
		return p.crawlHealth(ctx)
	case probeSSRF:
		return p.ssrf(ctx)
	case probeLLM:
		return p.llm(ctx)
	case probeDisk:
		return p.disk()
	default:
		return down(name, "Unknown health probe")
	}
}

func (p *probeSet) mysql(ctx context.Context) outcome {
	if p.db == nil {
		return down(probeMySQL, "")
	}
	timeout := 1500 * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var one int
	err := p.db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
	if err != nil {
		if ctx.Err() != nil {
			return down(probeMySQL, fmt.Sprintf("timeout of %dms exceeded", timeout.Milliseconds()))
		}
		return down(probeMySQL, "")
	}
	return up(probeMySQL)
}

func (p *probeSet) redisProbe(ctx context.Context) outcome {
	if p.redis == nil {
		return down(probeRedis, "Redis ping failed")
	}
	timeoutMs := envInt(p.getenv, "HEALTH_REDIS_TIMEOUT_MS", 1500)
	writeEnabled := envBool(p.getenv, "HEALTH_REDIS_WRITE_CHECK_ENABLED", true)
	writeTTL := envInt(p.getenv, "HEALTH_REDIS_WRITE_TTL_MS", 5000)
	timeout := time.Duration(timeoutMs) * time.Millisecond

	started := time.Now()
	pingCtx, cancel := context.WithTimeout(ctx, timeout)
	pong, err := p.redis.Ping(pingCtx).Result()
	cancel()
	pingLatency := int(time.Since(started).Milliseconds())
	if err != nil {
		return down(probeRedis, scrub(err.Error()))
	}
	if pong != "PONG" {
		return redisStatus(false, map[string]any{"pingLatencyMs": pingLatency, "message": "Unexpected PING reply: " + pong})
	}

	mode := "standalone"
	var clusterState string
	var hasClusterState bool
	infoCtx, infoCancel := context.WithTimeout(ctx, timeout)
	info, infoErr := p.redis.ClusterInfo(infoCtx).Result()
	infoCancel()
	var slots []redis.ClusterSlot
	if writeEnabled {
		slotCtx, slotCancel := context.WithTimeout(ctx, timeout)
		slots, _ = p.redis.ClusterSlots(slotCtx).Result()
		slotCancel()
	}
	if infoErr == nil && strings.TrimSpace(info) != "" {
		mode = "cluster"
		clusterState = parseInfoValue(info, "cluster_state")
		if clusterState == "" {
			clusterState = "unknown"
		}
		hasClusterState = true
		if clusterState != "ok" {
			fields := map[string]any{"mode": mode, "clusterState": clusterState, "pingLatencyMs": pingLatency}
			return redisStatus(false, fields)
		}
	} else if len(slots) > 0 {
		mode = "cluster"
	}

	fields := map[string]any{"mode": mode, "pingLatencyMs": pingLatency}
	if hasClusterState {
		fields["clusterState"] = clusterState
	}
	if writeEnabled {
		writeStarted := time.Now()
		var probed int
		var writeErr error
		if mode == "cluster" && len(slots) > 0 {
			probed, writeErr = p.probeCluster(ctx, slots, timeout, writeTTL)
			fields["probedMasters"] = probed
		} else {
			writeErr = p.probeStandalone(ctx, timeout, writeTTL)
		}
		if writeErr != nil {
			fields["message"] = scrub(writeErr.Error())
			return redisStatus(false, fields)
		}
		fields["writeLatencyMs"] = int(time.Since(writeStarted).Milliseconds())
	}
	return redisStatus(true, fields)
}

func redisStatus(ok bool, fields map[string]any) outcome {
	order := []string{"mode", "clusterState", "pingLatencyMs", "writeLatencyMs", "probedMasters", "message"}
	body := orderedObject(ok, order, fields)
	return outcome{name: probeRedis, up: ok, value: body}
}

func (p *probeSet) probeStandalone(ctx context.Context, timeout time.Duration, ttlMs int) error {
	key := probeKey(os.Getpid(), time.Now().UnixNano(), randomHex(6), -1)
	return p.writeRead(ctx, key, timeout, ttlMs, "Redis write probe timeout", "Redis read probe timeout", "Redis write probe mismatch")
}

func (p *probeSet) probeCluster(ctx context.Context, slots []redis.ClusterSlot, timeout time.Duration, ttlMs int) (int, error) {
	masters := map[string]redis.ClusterSlot{}
	order := make([]string, 0)
	for _, slot := range slots {
		id := slotRangeID(slot)
		if _, ok := masters[id]; ok {
			continue
		}
		masters[id] = slot
		order = append(order, id)
	}
	probeID := fmt.Sprintf("%d:%d:%s", os.Getpid(), time.Now().UnixNano(), randomHex(6))
	errCh := make(chan error, len(order))
	for index, id := range order {
		slot := masters[id]
		go func(index int, slot redis.ClusterSlot) {
			tag, err := hashTagInRange(slot.Start, slot.End)
			if err != nil {
				errCh <- err
				return
			}
			key := fmt.Sprintf("health:redis:write:{%s}:%s:%d", tag, probeID, index)
			errCh <- p.writeRead(ctx, key, timeout, ttlMs, "Redis cluster write probe timeout", "Redis cluster read probe timeout", "Redis cluster write probe mismatch")
		}(index, slot)
	}
	for range order {
		if err := <-errCh; err != nil {
			return len(order), err
		}
	}
	return len(order), nil
}

func (p *probeSet) writeRead(ctx context.Context, key string, timeout time.Duration, ttlMs int, writeMsg, readMsg, mismatch string) error {
	writeCtx, cancel := context.WithTimeout(ctx, timeout)
	err := p.redis.Set(writeCtx, key, "1", time.Duration(ttlMs)*time.Millisecond).Err()
	cancel()
	if err != nil {
		return fmt.Errorf("%s", writeMsg)
	}
	readCtx, readCancel := context.WithTimeout(ctx, timeout)
	got, err := p.redis.Get(readCtx, key).Result()
	readCancel()
	if err != nil {
		return fmt.Errorf("%s", readMsg)
	}
	if got != "1" {
		return fmt.Errorf("%s", mismatch)
	}
	go func() {
		delCtx, delCancel := context.WithTimeout(context.Background(), timeout)
		defer delCancel()
		_ = p.redis.Del(delCtx, key).Err()
	}()
	return nil
}

func (p *probeSet) mongoProbe(ctx context.Context) outcome {
	database, err := p.mongoDB(ctx)
	if err != nil || database == nil {
		message := "MongoDB connection is not ready"
		if err != nil {
			message = scrub(err.Error())
			if message == "" {
				message = "MongoDB connection is not ready"
			}
		}
		return down(probeMongo, message)
	}
	timeout := time.Duration(envInt(p.getenv, "HEALTH_MONGO_TIMEOUT_MS", 1500)) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reply bson.M
	err = database.RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Decode(&reply)
	if err != nil {
		if ctx.Err() != nil {
			return down(probeMongo, "MongoDB ping timeout")
		}
		return down(probeMongo, scrub(err.Error()))
	}
	if ok, exists := reply["ok"]; exists {
		switch value := ok.(type) {
		case int32:
			if value != 1 {
				return down(probeMongo, "MongoDB ping returned non-ok response")
			}
		case int64:
			if value != 1 {
				return down(probeMongo, "MongoDB ping returned non-ok response")
			}
		case float64:
			if value != 1 {
				return down(probeMongo, "MongoDB ping returned non-ok response")
			}
		}
	}
	return up(probeMongo)
}

func (p *probeSet) mongoDB(ctx context.Context) (*mongo.Database, error) {
	if p.mongo != nil {
		return p.mongo, nil
	}
	if strings.TrimSpace(p.mongoURI) == "" {
		return nil, nil
	}
	p.mongoMu.Lock()
	defer p.mongoMu.Unlock()
	if p.mongo != nil {
		return p.mongo, nil
	}
	name, err := mongoDatabaseName(p.mongoURI)
	if err != nil {
		return nil, err
	}
	client, err := mongo.Connect(options.Client().ApplyURI(p.mongoURI).SetServerSelectionTimeout(1500 * time.Millisecond))
	if err != nil {
		return nil, fmt.Errorf("MongoDB connection is not ready")
	}
	p.mongoClient = client
	p.mongo = client.Database(name)
	return p.mongo, nil
}

func (p *probeSet) close(ctx context.Context) {
	if p == nil {
		return
	}
	p.mongoMu.Lock()
	client := p.mongoClient
	p.mongoClient = nil
	if client != nil {
		p.mongo = nil
	}
	p.mongoMu.Unlock()
	if client != nil {
		_ = client.Disconnect(ctx)
	}
}

func (p *probeSet) crawlHealth(ctx context.Context) outcome {
	probe := p.cachedCrawl(ctx, false)
	if probe.ok {
		return up(probeCrawl)
	}
	message := probe.message
	if message == "" {
		message = "crawl4ai health check failed"
	}
	return down(probeCrawl, message)
}

func (p *probeSet) ssrf(ctx context.Context) outcome {
	probe := p.cachedCrawl(ctx, true)
	fields := map[string]any{"durationMs": probe.durationMs}
	if probe.ok {
		return outcome{name: probeSSRF, up: true, value: orderedObject(true, []string{"durationMs"}, fields)}
	}
	message := probe.message
	if message == "" {
		message = "crawl4ai SSRF proxy probe failed"
	}
	fields["message"] = scrubProxy(message, p.crawl.proxyURL)
	return outcome{name: probeSSRF, up: false, value: orderedObject(false, []string{"durationMs", "message"}, fields)}
}

func (p *probeSet) cachedCrawl(ctx context.Context, ssrf bool) cachedProbe {
	p.crawlMu.Lock()
	cached := p.crawlCached
	waiters := &p.crawlWait
	flight := &p.crawlFlight
	if ssrf {
		cached = p.ssrfCached
		waiters = &p.ssrfWait
		flight = &p.ssrfFlight
	}
	if cached != nil && cached.expires.After(time.Now()) {
		value := *cached
		p.crawlMu.Unlock()
		return value
	}
	if *flight != nil {
		ch := make(chan cachedProbe, 1)
		*waiters = append(*waiters, ch)
		p.crawlMu.Unlock()
		select {
		case value := <-ch:
			return value
		case <-ctx.Done():
			return cachedProbe{ok: false, message: "crawl4ai health check failed"}
		}
	}
	*flight = make(chan struct{})
	p.crawlMu.Unlock()

	var value cachedProbe
	if ssrf {
		value = p.runSSRF(ctx)
	} else {
		value = p.runCrawl(ctx)
	}
	ttl := p.resolveCrawlTTL(ctx)
	value.expires = time.Now().Add(ttl)

	p.crawlMu.Lock()
	if ssrf {
		p.ssrfCached = &value
		for _, ch := range p.ssrfWait {
			ch <- value
		}
		p.ssrfWait = nil
		close(p.ssrfFlight)
		p.ssrfFlight = nil
	} else {
		p.crawlCached = &value
		for _, ch := range p.crawlWait {
			ch <- value
		}
		p.crawlWait = nil
		close(p.crawlFlight)
		p.crawlFlight = nil
	}
	p.crawlMu.Unlock()
	return value
}

func (p *probeSet) runCrawl(ctx context.Context) cachedProbe {
	if strings.TrimSpace(p.crawl.baseURL) == "" {
		return cachedProbe{ok: false, message: "crawl4ai health check failed"}
	}
	timeout := p.crawl.timeout
	if timeout <= 0 || timeout > 1500*time.Millisecond {
		timeout = 1500 * time.Millisecond
	}
	url := strings.TrimRight(p.crawl.baseURL, "/") + "/health"
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return cachedProbe{ok: false, message: "crawl4ai health check failed"}
	}
	if p.crawl.apiKey != "" {
		req.Header.Set("x-api-key", p.crawl.apiKey)
	}
	resp, err := p.client().Do(req)
	if err != nil {
		return cachedProbe{ok: false, message: "crawl4ai health check failed"}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cachedProbe{ok: false, message: "crawl4ai health check failed"}
	}
	return cachedProbe{ok: true}
}

func (p *probeSet) runSSRF(ctx context.Context) cachedProbe {
	proxy := strings.TrimSpace(p.crawl.proxyURL)
	if proxy == "" {
		return cachedProbe{ok: false, message: "crawl4ai SSRF proxy is not configured"}
	}
	if strings.TrimSpace(p.crawl.baseURL) == "" {
		return cachedProbe{ok: false, durationMs: 0, message: "crawl4ai SSRF proxy probe failed"}
	}
	started := time.Now()
	timeout := p.crawl.timeout
	if timeout <= 0 || timeout > 5*time.Second {
		timeout = 5 * time.Second
	}
	payload := map[string]any{
		"urls": []string{ssrfProbeURL},
		"browser_config": map[string]any{
			"type": "BrowserConfig",
			"params": map[string]any{
				"headless": true,
				"proxy_config": map[string]any{
					"server": proxy,
				},
			},
		},
		"crawler_config": map[string]any{
			"type": "CrawlerRunConfig",
			"params": map[string]any{
				"cache_mode":              "bypass",
				"only_text":               true,
				"word_count_threshold":    5,
				"exclude_external_links":  true,
				"remove_overlay_elements": true,
				"process_iframes":         true,
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return cachedProbe{ok: false, message: "crawl4ai SSRF proxy probe failed"}
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, strings.TrimRight(p.crawl.baseURL, "/")+"/crawl", strings.NewReader(string(raw)))
	if err != nil {
		return cachedProbe{ok: false, durationMs: time.Since(started).Milliseconds(), message: "crawl4ai SSRF proxy probe failed"}
	}
	req.Header.Set("Content-Type", "application/json")
	if p.crawl.apiKey != "" {
		req.Header.Set("x-api-key", p.crawl.apiKey)
	}
	resp, err := p.client().Do(req)
	duration := time.Since(started).Milliseconds()
	if err != nil {
		return cachedProbe{ok: false, durationMs: duration, message: "crawl4ai SSRF proxy probe failed"}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed crawlProbeBody
	_ = json.Unmarshal(body, &parsed)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && len(parsed.Results) > 0 && parsed.Results[0].Success {
		return cachedProbe{ok: true, durationMs: duration}
	}
	message := firstText(parsed)
	if message == "" {
		message = "crawl4ai SSRF proxy probe failed"
	}
	return cachedProbe{ok: false, durationMs: duration, message: scrubProxy(message, proxy)}
}

func (p *probeSet) resolveCrawlTTL(ctx context.Context) time.Duration {
	fallback := p.crawl.healthTTL
	if fallback <= 0 {
		fallback = 60 * time.Second
	}
	if p.db == nil {
		return maxDuration(time.Second, fallback)
	}
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	var raw []byte
	err := p.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", "crawl_client_settings").Scan(&raw)
	if err != nil {
		return maxDuration(time.Second, fallback)
	}
	var doc struct {
		HealthCheckTtlMs float64 `json:"healthCheckTtlMs"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.HealthCheckTtlMs <= 0 || math.IsNaN(doc.HealthCheckTtlMs) {
		return maxDuration(time.Second, fallback)
	}
	ttl := time.Duration(math.Round(doc.HealthCheckTtlMs)) * time.Millisecond
	if ttl < 5*time.Second {
		ttl = 5 * time.Second
	}
	if ttl > 900*time.Second {
		ttl = 900 * time.Second
	}
	if ttl < time.Second {
		ttl = time.Second
	}
	return ttl
}

func (p *probeSet) llm(ctx context.Context) outcome {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	settings, err := p.loadLLM(ctx)
	if err != nil {
		message := scrub(err.Error())
		if ctx.Err() != nil {
			message = "LLM gateway health check timed out after 2000ms"
		}
		return down(probeLLM, message)
	}
	completion := settings.completion()
	embedding := settings.embedding()
	rerank := settings.rerank()
	completionReady := strings.TrimSpace(completion) != ""
	embeddingReady := strings.TrimSpace(embedding) != ""
	rerankReady := strings.TrimSpace(rerank) != ""
	fields := map[string]any{
		"completionReady":          completionReady,
		"embeddingReady":           embeddingReady,
		"rerankReady":              rerankReady,
		"rerankRequired":           p.crawl.rerankNeed,
		"activeProfileId":          settings.activeID,
		"embeddingActiveProfileId": settings.embeddingActiveID,
		"rerankActiveProfileId":    settings.rerankActiveID,
	}
	order := []string{"completionReady", "embeddingReady", "rerankReady", "rerankRequired", "activeProfileId", "embeddingActiveProfileId", "rerankActiveProfileId", "message"}
	if !completionReady {
		fields["message"] = "LLM gateway completion model is not configured in MySQL profiles"
		return outcome{name: probeLLM, up: false, value: orderedObject(false, order, fields)}
	}
	if p.crawl.rerankNeed && !rerankReady {
		fields["message"] = "LLM gateway rerank model is required but not configured in MySQL profiles"
		return outcome{name: probeLLM, up: false, value: orderedObject(false, order, fields)}
	}
	return outcome{name: probeLLM, up: true, value: orderedObject(true, order, fields)}
}

func (p *probeSet) disk() outcome {
	path := p.diskPath
	if path == "" {
		wd, err := os.Getwd()
		if err != nil {
			return down(probeDisk, "Used disk storage exceeded the set threshold")
		}
		path = wd
	}
	size, free, err := diskSpace(path)
	if err != nil || size == 0 {
		return down(probeDisk, "Used disk storage exceeded the set threshold")
	}
	used := size - free
	if diskThreshold < float64(used)/float64(size) {
		return down(probeDisk, "Used disk storage exceeded the set threshold")
	}
	return up(probeDisk)
}

func (p *probeSet) client() *http.Client {
	if p.http != nil {
		return p.http
	}
	return http.DefaultClient
}

func up(name string) outcome {
	return outcome{name: name, up: true, value: `{"status":"up"}`}
}

func down(name, message string) outcome {
	if strings.TrimSpace(message) == "" {
		return outcome{name: name, up: false, value: `{"status":"down"}`}
	}
	body, err := json.Marshal(struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}{Status: "down", Message: message})
	if err != nil {
		return outcome{name: name, up: false, value: `{"status":"down"}`}
	}
	return outcome{name: name, up: false, value: string(body)}
}

func orderedObject(ok bool, order []string, fields map[string]any) string {
	var buf strings.Builder
	buf.WriteString(`{"status":"`)
	if ok {
		buf.WriteString("up")
	} else {
		buf.WriteString("down")
	}
	buf.WriteByte('"')
	for _, key := range order {
		value, exists := fields[key]
		if !exists || value == nil {
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		buf.WriteString(`,"`)
		buf.WriteString(key)
		buf.WriteString(`":`)
		buf.Write(encoded)
	}
	buf.WriteByte('}')
	return buf.String()
}

func diskSpace(path string) (size, free uint64, err error) {
	var stat syscall.Statfs_t
	if err = syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	unit := uint64(stat.Bsize)
	if unit == 0 {
		return 0, 0, nil
	}
	return stat.Blocks * unit, stat.Bavail * unit, nil
}

func envInt(getenv func(string) string, key string, fallback int) int {
	if getenv == nil {
		getenv = os.Getenv
	}
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envBool(getenv func(string) string, key string, fallback bool) bool {
	if getenv == nil {
		getenv = os.Getenv
	}
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func parseInfoValue(info, key string) string {
	for _, raw := range strings.Split(info, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		if ok && name == key {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func probeKey(pid int, now int64, random string, index int) string {
	if index < 0 {
		return fmt.Sprintf("health:redis:write:%d:%d:%s", pid, now, random)
	}
	return fmt.Sprintf("health:redis:write:%d:%d:%s:%d", pid, now, random, index)
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "0"
	}
	return fmt.Sprintf("%x", buf)
}

func slotRangeID(slot redis.ClusterSlot) string {
	if len(slot.Nodes) == 0 {
		return fmt.Sprintf("%d-%d", slot.Start, slot.End)
	}
	if slot.Nodes[0].ID != "" {
		return slot.Nodes[0].ID
	}
	return slot.Nodes[0].Addr
}

func hashTagInRange(start, end int) (string, error) {
	if start < 0 || end > 16383 || start > end {
		return "", fmt.Errorf("invalid cluster slot range")
	}
	var extra [4]byte
	_, _ = rand.Read(extra[:])
	nonce := binary.BigEndian.Uint32(extra[:])
	for attempt := 0; attempt < 5000; attempt++ {
		tag := fmt.Sprintf("h%s%x", strconv.FormatInt(int64(attempt), 36), nonce)
		slot := crc16([]byte(tag)) % 16384
		if int(slot) >= start && int(slot) <= end {
			return tag, nil
		}
	}
	return "", fmt.Errorf("unable to find hash tag within slot range")
}

func crc16(buf []byte) uint16 {
	var crc uint16
	for _, b := range buf {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func mongoDatabaseName(uri string) (string, error) {
	trimmed := strings.TrimSpace(uri)
	if !strings.HasPrefix(trimmed, "mongodb://") && !strings.HasPrefix(trimmed, "mongodb+srv://") {
		return "", fmt.Errorf("MongoDB connection is not ready")
	}
	slash := strings.LastIndex(trimmed, "/")
	if slash < 0 || slash+1 >= len(trimmed) {
		return "app", nil
	}
	name := trimmed[slash+1:]
	if cut := strings.IndexAny(name, "?"); cut >= 0 {
		name = name[:cut]
	}
	if name == "" {
		return "app", nil
	}
	return name, nil
}

type crawlProbeBody struct {
	Results []struct {
		Success       bool   `json:"success"`
		ErrorMessage  string `json:"error_message"`
		ErrorMessage2 string `json:"errorMessage"`
		Error         string `json:"error"`
	} `json:"results"`
	Error string `json:"error"`
}

func firstText(parsed crawlProbeBody) string {
	if len(parsed.Results) > 0 {
		item := parsed.Results[0]
		for _, value := range []string{item.ErrorMessage, item.ErrorMessage2, item.Error} {
			if strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return strings.TrimSpace(parsed.Error)
}

func scrub(message string) string {
	if strings.Contains(message, "://") || strings.Contains(message, "@") {
		return "health probe failed"
	}
	return message
}

func scrubProxy(message, proxy string) string {
	if proxy != "" {
		message = strings.ReplaceAll(message, proxy, "[redacted]")
	}
	return scrub(message)
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
