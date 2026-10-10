package health

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

const (
	// ReadyPath 是认证版健康检查的精确路径。公开 live 探针不在这里。
	ReadyPath = "/api/healthz"
	// APIVersion 与 apps/api/package.json 的 version 一致。
	APIVersion     = "0.1.0"
	readyCacheTTL  = 5 * time.Second
)

// Deps 是认证版健康检查的真实依赖。探针只在请求到达时运行。
type Deps struct {
	DB         *sql.DB
	Redis      *redis.Client
	Mongo      *mongo.Database
	MongoURI   string
	CrawlBase  string
	CrawlKey   string
	CrawlTimeout time.Duration
	CrawlTTL   time.Duration
	ProxyURL   string
	RerankNeed bool
	DiskPath   string
}

// ReadyHandler 处理 GET /api/healthz。
type ReadyHandler struct {
	gate    Gate
	probes  *probeSet
	run     func(context.Context) []outcome
	now     func() time.Time
	version string

	mu     sync.Mutex
	cached *readyCache
}

type readyCache struct {
	at     time.Time
	status int
	body   []byte
}

// NewReadyHandler 装配鉴权和七项探针。
func NewReadyHandler(humans *authhttp.Authenticator, deps Deps) *ReadyHandler {
	probes := &probeSet{
		db:       deps.DB,
		redis:    deps.Redis,
		mongo:    deps.Mongo,
		mongoURI: deps.MongoURI,
		crawl: crawlConfig{
			baseURL:    strings.TrimRight(strings.TrimSpace(deps.CrawlBase), "/"),
			apiKey:     deps.CrawlKey,
			timeout:    deps.CrawlTimeout,
			healthTTL:  deps.CrawlTTL,
			proxyURL:   strings.TrimSpace(deps.ProxyURL),
			rerankNeed: deps.RerankNeed,
		},
		diskPath: deps.DiskPath,
	}
	return &ReadyHandler{
		gate: Gate{humans: humans, machines: mysqlMachines{db: deps.DB}, now: time.Now},
		probes: probes,
		run:    probes.all,
		now:    time.Now,
		version: APIVersion,
	}
}

// SetClock 固定缓存和时间戳。
func (h *ReadyHandler) SetClock(now func() time.Time) {
	if now != nil {
		h.now = now
		h.gate.now = now
	}
}

// SetProbes 让测试替换七项探针的结果。
func (h *ReadyHandler) SetProbes(run func(context.Context) []outcome) {
	h.run = run
}

// SetMachines 让测试替换机器令牌存储。
func (h *ReadyHandler) SetMachines(store machineStore) {
	h.gate.machines = store
}

func (h *ReadyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	if !h.gate.Open(w, r) {
		return
	}
	now := time.Now()
	if h.now != nil {
		now = h.now()
	}
	h.mu.Lock()
	if h.cached != nil && now.Sub(h.cached.at) < readyCacheTTL {
		status, body := h.cached.status, append([]byte(nil), h.cached.body...)
		h.mu.Unlock()
		writeReady(w, status, body)
		return
	}
	h.mu.Unlock()

	results := h.run(r.Context())
	status, body := assemble(results, h.version, now.UTC())
	h.mu.Lock()
	h.cached = &readyCache{at: now, status: status, body: body}
	h.mu.Unlock()
	writeReady(w, status, body)
}

func assemble(results []outcome, version string, now time.Time) (int, []byte) {
	order := []string{probeMySQL, probeRedis, probeMongo, probeCrawl, probeSSRF, probeLLM, probeDisk}
	byName := map[string]outcome{}
	for _, result := range results {
		byName[result.name] = result
	}
	var info, failed, details []outcome
	for _, name := range order {
		result, ok := byName[name]
		if !ok {
			result = down(name, "health probe failed")
		}
		if result.value == "" {
			if result.up {
				result = up(name)
			} else {
				result = down(name, "health probe failed")
			}
		}
		if result.up {
			info = append(info, result)
		} else {
			failed = append(failed, result)
		}
	}
	details = append(append([]outcome{}, info...), failed...)
	statusName := "ok"
	httpStatus := http.StatusOK
	if len(failed) > 0 {
		statusName = "error"
		httpStatus = http.StatusServiceUnavailable
	}
	body := []byte(`{"status":"` + statusName + `","info":` + objectOf(info) + `,"error":` + objectOf(failed) + `,"details":` + objectOf(details) + `,"version":"` + version + `","now":"` + now.Format("2006-01-02T15:04:05.000Z") + `"}`)
	return httpStatus, body
}

func objectOf(items []outcome) string {
	if len(items) == 0 {
		return "{}"
	}
	var buf strings.Builder
	buf.WriteByte('{')
	for i, item := range items {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteByte('"')
		buf.WriteString(item.name)
		buf.WriteString(`":`)
		buf.WriteString(item.value)
	}
	buf.WriteByte('}')
	return buf.String()
}

// Close 只关闭本端点自己建立的 Mongo 客户端。共享给业务路由的连接不在这里关。
func (h *ReadyHandler) Close(ctx context.Context) {
	if h == nil || h.probes == nil {
		return
	}
	h.probes.close(ctx)
}

func writeReady(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
