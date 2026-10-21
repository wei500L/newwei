//go:build integration

// B2 integration coverage: the Telegram poll handover against the real Redis 7.2
// service of the api-go-user-settings-integration CI job. Two worker instances
// share one Redis and one Telegram lease; the Telegram client is a fake, so no
// MTProto connection is opened and no upstream request is made.
package situationsignalsworker

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
)

// sitWorkerITWaitSubscriber waits until at least one process subscribes to the
// channel, which is the precondition of a delivered handover.
func sitWorkerITWaitSubscriber(t *testing.T, client *redis.Client, channel string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		counts, err := client.PubSubNumSub(context.Background(), channel).Result()
		if err != nil {
			t.Fatalf("pubsub numsub %q: %v", channel, err)
		}
		if counts[channel] > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no subscriber on %q within 5s", channel)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// sitWorkerITWaitDoneKeys waits until at least want completion keys exist. The
// handover is asynchronous (PUBLISH + LPUSH), so the caller must not read the state
// document before the owner recorded the completion.
func sitWorkerITWaitDoneKeys(t *testing.T, client *redis.Client, want int) []string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		keys := sitWorkerITDoneKeys(t, client)
		if len(keys) >= want {
			return keys
		}
		if time.Now().After(deadline) {
			t.Fatalf("completion keys = %v, want %d within 10s", keys, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// sitWorkerITDoneKeys returns the completion keys currently stored.
func sitWorkerITDoneKeys(t *testing.T, client *redis.Client) []string {
	t.Helper()
	keys, _, err := client.Scan(context.Background(), 0, telegramPollDonePrefix+"*", 100).Result()
	if err != nil {
		t.Fatalf("scan completion keys: %v", err)
	}
	return keys
}

// TestTelegramPollHandoverIntegration covers B2 end to end:
// a queue job that lands on a non-owner publishes a request that the lease owner
// serves, a refresh call on the non-owner waits for that owner, and a request no
// process is listening for is served by taking the lease over locally.
func TestTelegramPollHandoverIntegration(t *testing.T) {
	client := sitWorkerITRedis(t)
	sitWorkerITResetRedis(t, client)

	channels := loadTelegramChannels("full")
	if len(channels) == 0 {
		t.Fatal("embedded Telegram channel catalog has no channels")
	}
	handle := channels[0].Handle
	effective := defaultEffectiveSettings(t)

	newInstance := func(id string) (*Service, *sitWorkerITLeaseOwner, *fakePollClient) {
		pollClient := newFakePollClient()
		leaseOwner := &sitWorkerITLeaseOwner{redis: client, id: id, client: pollClient}
		service, err := New(Options{
			Redis:      client,
			Settings:   &fakeSettings{effective: effective},
			Telegram:   leaseOwner,
			Dispatcher: &fakePublisher{},
			Env:        testEnv(),
			Logger:     func(string, ...any) {},
		})
		if err != nil {
			t.Fatalf("build worker instance %s: %v", id, err)
		}
		t.Cleanup(service.Close)
		return service, leaseOwner, pollClient
	}

	ownerService, ownerLease, ownerPoll := newInstance("owner")
	callerService, callerLease, callerPoll := newInstance("caller")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The owner runs the subscriber loop (clear broadcast + poll handover) and
	// takes the lease with its first cycle.
	ownerCtx, ownerCancel := context.WithCancel(ctx)
	ownerDone := make(chan error, 1)
	go func() { ownerDone <- ownerService.Run(ownerCtx) }()
	sitWorkerITWaitSubscriber(t, client, telegramPollChannel)

	ownerPoll.setMessages(handle, telegramclient.Message{ID: 21, DateUnix: 1_700_000_021, Text: "owned"})
	if err := ownerService.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("owner job: %v", err)
	}
	if connects, _, _ := ownerLease.counts(); connects != 1 {
		t.Fatalf("owner connects = %d, want 1", connects)
	}

	// Queue job on the non-owner: it publishes the request and returns without
	// dialing anything, while the owner serves the cycle.
	ownerPoll.setMessages(handle,
		telegramclient.Message{ID: 21, DateUnix: 1_700_000_021, Text: "owned"},
		telegramclient.Message{ID: 22, DateUnix: 1_700_000_022, Text: "handed over"},
	)
	if err := callerService.HandleJob(ctx, SourceTelegram); err != nil {
		t.Fatalf("caller job: %v", err)
	}
	if resolve, fetch, _, _ := callerPoll.stats(); resolve != 0 || fetch != 0 {
		t.Fatalf("caller polled while it did not own the lease: %d/%d", resolve, fetch)
	}
	// The owner serves the request asynchronously, so wait for the completion
	// record before reading the state document it wrote.
	doneKeys := sitWorkerITWaitDoneKeys(t, client, 1)
	sitWorkerITAssertTelegramState(t, client, handle, 22, []string{handle + ":22", handle + ":21"})
	if connects, _, _ := ownerLease.counts(); connects != 2 {
		t.Fatalf("owner connects = %d, want the handed-over cycle to run on the owner", connects)
	}
	if len(doneKeys) != 1 {
		t.Fatalf("completion keys = %v, want one record for the queued request", doneKeys)
	}
	sitWorkerITAssertTTL(t, client, doneKeys[0], telegramPollDoneTTL, 5*time.Second)

	// Refresh call on the non-owner: it blocks until the owner recorded the
	// completion of the handed-over cycle.
	ownerPoll.setMessages(handle,
		telegramclient.Message{ID: 23, DateUnix: 1_700_000_023, Text: "refresh"},
		telegramclient.Message{ID: 22, DateUnix: 1_700_000_022, Text: "handed over"},
		telegramclient.Message{ID: 21, DateUnix: 1_700_000_021, Text: "owned"},
	)
	refreshCtx, refreshCancel := context.WithTimeout(ctx, 20*time.Second)
	defer refreshCancel()
	if err := callerService.PollTelegramWait(refreshCtx); err != nil {
		t.Fatalf("PollTelegramWait() error = %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 23, []string{handle + ":23", handle + ":22", handle + ":21"})
	if resolve, fetch, _, _ := callerPoll.stats(); resolve != 0 || fetch != 0 {
		t.Fatalf("caller polled the refresh cycle itself: %d/%d", resolve, fetch)
	}
	if keys := sitWorkerITDoneKeys(t, client); len(keys) != 1 {
		// The waiting caller consumed its own completion record with BLPOP, so only
		// the queued request's record is left.
		t.Fatalf("completion keys = %v, want only the queued request record", keys)
	}

	// No owner listening: stop the subscriber loop and release the lease, then a
	// refresh call takes the free lease on its first attempt and polls here, which
	// keeps a single-instance deployment working without any handover subscriber.
	// (The "zero subscribers, lease still held" branch is covered by the unit test
	// TestTelegramPollWithoutSubscriberTakesTheLeaseOver because the lease release
	// window cannot be forced from the outside.)
	ownerCancel()
	select {
	case err := <-ownerDone:
		if err != nil {
			t.Fatalf("owner Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owner subscriber loop did not stop")
	}
	sitWorkerITAssertNoSubscriber(t, client, telegramPollChannel)
	ownerLease.release(t)
	callerPoll.setMessages(handle,
		telegramclient.Message{ID: 24, DateUnix: 1_700_000_024, Text: "local"},
		telegramclient.Message{ID: 23, DateUnix: 1_700_000_023, Text: "refresh"},
		telegramclient.Message{ID: 22, DateUnix: 1_700_000_022, Text: "handed over"},
		telegramclient.Message{ID: 21, DateUnix: 1_700_000_021, Text: "owned"},
	)
	if err := callerService.PollTelegramWait(ctx); err != nil {
		t.Fatalf("PollTelegramWait() without an owner error = %v", err)
	}
	sitWorkerITAssertTelegramState(t, client, handle, 24, []string{
		handle + ":24", handle + ":23", handle + ":22", handle + ":21",
	})
	if resolve, fetch, _, _ := callerPoll.stats(); resolve == 0 || fetch == 0 {
		t.Fatalf("the takeover cycle did not poll locally: %d/%d", resolve, fetch)
	}
	if connects, _, _ := callerLease.counts(); connects != 1 {
		t.Fatalf("caller connects = %d, want the takeover cycle to own the lease", connects)
	}
}

// sitWorkerITAssertNoSubscriber waits until nobody subscribes to the channel.
func sitWorkerITAssertNoSubscriber(t *testing.T, client *redis.Client, channel string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		counts, err := client.PubSubNumSub(context.Background(), channel).Result()
		if err != nil {
			t.Fatalf("pubsub numsub %q: %v", channel, err)
		}
		if counts[channel] == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("subscriber on %q still present", channel)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
