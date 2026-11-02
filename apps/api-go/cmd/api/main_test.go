package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// healthcheck 子命令的退出码契约（Go-批2C 新增的正常启动入口分支）：
// 2xx → 0；非 2xx 或目标不可达 → 1。这里的 httptest 只模拟「本进程
// 探测目标」的响应行为，不涉及 legacy upstream。
func TestRunHealthcheckExitCodes(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()

	// PORT 复用 httptest 端口：从 URL 提取端口写入进程 env（测试结束后
	// 恢复，避免污染同包其他测试）。
	portOf := func(url string) string {
		return url[strings.LastIndex(url, ":")+1:]
	}
	original := os.Getenv("PORT")
	defer os.Setenv("PORT", original)

	os.Setenv("PORT", portOf(healthy.URL))
	if code := runHealthcheck(); code != 0 {
		t.Errorf("2xx: exit code = %d, want 0", code)
	}
	os.Setenv("PORT", portOf(unhealthy.URL))
	if code := runHealthcheck(); code != 1 {
		t.Errorf("5xx: exit code = %d, want 1", code)
	}
	os.Setenv("PORT", "1") // 不可达端口：连接失败 → 1
	if code := runHealthcheck(); code != 1 {
		t.Errorf("unreachable: exit code = %d, want 1", code)
	}
}
