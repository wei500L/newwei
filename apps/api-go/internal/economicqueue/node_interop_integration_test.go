//go:build integration

package economicqueue

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestEconomicQueueIntegrationNodeInterop cross-checks the Go producer/worker
// against the pinned bullmq@5.63.2 Node implementation. It only proves that both
// sides share the Redis hash/opts/data/event protocol; it does not call any real
// provider.
func TestEconomicQueueIntegrationNodeInterop(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("node is required in CI for the BullMQ interoperability fixture")
		}
		t.Skip("node is not installed")
	}

	t.Run("node producer to go worker", func(t *testing.T) {
		fixture := newQueueFixture(t)
		host, port := fixtureRedisHostPort(t, fixture)
		seen := make(chan string, 1)
		worker := fixture.worker(t, func(_ context.Context, job Job) error {
			var data JobData
			if err := json.Unmarshal(job.Data, &data); err != nil {
				return err
			}
			select {
			case seen <- data.DataItemID:
			default:
			}
			return nil
		}, WorkerOptions{Concurrency: 1, LockDuration: 5 * time.Second, PollInterval: 10 * time.Millisecond})
		runCtx, cancelRun := context.WithCancel(context.Background())
		go worker.Run(runCtx)

		output := runEconomicNodeFixture(t, "produce", map[string]string{
			"BULLMQ_REDIS_HOST": host,
			"BULLMQ_REDIS_PORT": port,
			"BULLMQ_QUEUE":      fixture.name,
			"FIXTURE_JOB_ID":    "node-job-1",
			"FIXTURE_DATA":      `{"dataItemId":"slug-node"}`,
		})
		if !strings.Contains(output, "node-job-1") {
			t.Fatalf("node producer output = %s", output)
		}
		select {
		case slug := <-seen:
			if slug != "slug-node" {
				t.Fatalf("worker saw slug %q, want slug-node", slug)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("Go worker never consumed the Node-produced job")
		}
		waitForJobGone(t, fixture, "node-job-1", 5*time.Second)
		cancelRun()
		closeWorker(t, worker)
	})

	t.Run("go producer to node worker", func(t *testing.T) {
		fixture := newQueueFixture(t)
		host, port := fixtureRedisHostPort(t, fixture)
		jobID, err := fixture.producer.AddManual(context.Background(), JobData{DataItemID: "slug-go"})
		if err != nil {
			t.Fatalf("add manual: %v", err)
		}
		output := runEconomicNodeFixture(t, "consume", map[string]string{
			"BULLMQ_REDIS_HOST":  host,
			"BULLMQ_REDIS_PORT":  port,
			"BULLMQ_QUEUE":       fixture.name,
			"FIXTURE_JOB_ID":     jobID,
			"FIXTURE_TIMEOUT_MS": "10000",
		})
		if !strings.Contains(output, `"ok":true`) {
			t.Fatalf("node consumer output = %s", output)
		}
		waitForJobGone(t, fixture, jobID, 5*time.Second)
	})
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
}

func runEconomicNodeFixture(t *testing.T, mode string, environment map[string]string) string {
	t.Helper()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	root := repoRoot(t)
	fixture, err := os.ReadFile(filepath.Join(root, "apps/api-go/testdata/economic_queue_fixture.mjs"))
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

func fixtureRedisHostPort(t *testing.T, fixture *queueFixture) (string, string) {
	t.Helper()
	addr := fixture.client.Options().Addr
	host, port, found := strings.Cut(addr, ":")
	if !found || host == "" || port == "" {
		t.Fatalf("unexpected redis addr %q", addr)
	}
	return host, port
}

func waitForJobGone(t *testing.T, fixture *queueFixture, jobID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if fixture.client.Exists(context.Background(), fixture.keys.job(jobID)).Val() == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s was not removed", jobID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func closeWorker(t *testing.T, worker *Worker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := worker.Close(ctx); err != nil {
		t.Fatalf("worker close: %v", err)
	}
}
