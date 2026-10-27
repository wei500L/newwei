// Command ais-relay runs the Go implementation of the AIS vessel relay.
//
// It is the drop-in replacement for apps/ais-relay: it reads the same environment
// variables, serves the same HTTP contract and reports the same health reason codes, so
// the API can be pointed at either process through REALTIME_SIGNALS_AIS_BASE_URL.
//
// The command has two modes: the default server mode, and the `healthcheck` subcommand
// used by the container health probe. The image is distroless (no shell, no curl, no
// node), so the only available probe is the binary itself — the same pattern as the
// api-go command.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/aisrelay"
)

// shutdownBudget bounds a graceful shutdown, matching the Node relay's 5s force exit.
const shutdownBudget = 5 * time.Second

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	if err := run(); err != nil {
		log.Fatalf("ais-relay: %v", err)
	}
}

// run starts the relay and blocks until the server stops or a signal arrives.
func run() error {
	cfg, err := aisrelay.LoadConfig(os.LookupEnv)
	if err != nil {
		return err
	}

	relay := aisrelay.New(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	relay.Start(ctx)

	server := &http.Server{
		Addr:              cfg.ListenAddress(),
		Handler:           relay.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("[ais-relay] listening on http://%s", cfg.ListenAddress())
		serverErr <- server.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		cancel()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case sig := <-stop:
		log.Printf("[ais-relay] %s received; shutting down", sig)
	}

	// Stop the upstream supervisor and the workers before draining HTTP: the relay
	// should not keep refreshing snapshots it is about to stop serving.
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownBudget)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("http shutdown: %w", err)
	}
	return nil
}

// runHealthcheck probes the local liveness endpoint and returns the process exit code.
//
// It resolves the port from the same configuration the server uses, so the probe follows
// PORT and its AIS_RELAY_PORT alias without a second definition of the default.
func runHealthcheck() int {
	cfg, err := aisrelay.LoadConfig(os.LookupEnv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ais-relay healthcheck: %v\n", err)
		return 1
	}

	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(cfg.ListenPort) + "/healthz/live")
	if err != nil {
		fmt.Fprintln(os.Stderr, "ais-relay healthcheck: request failed")
		return 1
	}
	defer func() {
		_ = response.Body.Close()
	}()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		fmt.Fprintf(os.Stderr, "ais-relay healthcheck: unexpected status %d\n", response.StatusCode)
		return 1
	}
	return 0
}
