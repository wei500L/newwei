import { SituationMonitorSignalsService } from './situation-monitor-signals.service';

describe('SituationMonitorSignalsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createService() {
    const env = { get: jest.fn() } as any;
    const cache = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    } as any;
    const dispatcher = { publish: jest.fn() } as any;
    const alerts = { enqueueRuleCheck: jest.fn() } as any;
    const settings = {
      getTelegramRuntimeConfig: jest.fn().mockResolvedValue({
        enabled: true,
        apiId: '123456',
        apiHash: 'hash',
        session: 'session',
        channelSet: 'full',
        maxFeedItems: 200,
        maxTextChars: 800,
        channelTimeoutMs: 15_000,
        pollCycleTimeoutMs: 30_000,
        startupDelayMs: 60_000,
        rateLimitMs: 800,
        pollIntervalMs: 60_000,
      }),
    } as any;
    const prisma = {
      org: { findMany: jest.fn() },
      alertRule: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    } as any;

    const service = new SituationMonitorSignalsService(
      env,
      cache,
      dispatcher,
      alerts,
      settings,
      prisma,
    );

    return { service };
  }

  it('returns global telegram feed metadata', async () => {
    const { service } = createService();
    jest.spyOn(service as any, 'restoreCachedTelegramState').mockResolvedValue(undefined);

    (service as any).telegramState.channelSet = 'full';
    (service as any).telegramState.lastPollAt = Date.now();
    (service as any).telegramState.items = [
      {
        id: 'demo:1',
        source: 'telegram',
        channel: 'demo',
        channelTitle: 'Demo',
        url: 'https://t.me/demo/1',
        ts: new Date().toISOString(),
        text: 'hello',
        topic: 'breaking',
        tags: [],
        earlySignal: true,
      },
    ];

    const result = await service.getTelegramFeed();

    expect(result.scope).toBe('global');
    expect(result.channelSet).toBe('full');
    expect(result.count).toBe(1);
  });

  it('drops cached telegram items when the runtime channel set changes before serving feed', async () => {
    const { service } = createService();

    jest.spyOn(service as any, 'restoreCachedTelegramState').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'getTelegramRuntimeConfig').mockResolvedValue({
      enabled: true,
      apiId: '123456',
      apiHash: 'hash',
      session: 'session',
      channelSet: 'tech',
      maxFeedItems: 200,
      maxTextChars: 800,
      channelTimeoutMs: 15_000,
      pollCycleTimeoutMs: 30_000,
      startupDelayMs: 60_000,
      rateLimitMs: 800,
      pollIntervalMs: 60_000,
    });

    (service as any).telegramState.channelSet = 'full';
    (service as any).telegramState.channels = [{ handle: 'legacy' }];
    (service as any).telegramState.cursorByHandle = { legacy: 42 };
    (service as any).telegramState.lastPollAt = Date.now();
    (service as any).telegramState.items = [
      {
        id: 'legacy:1',
        source: 'telegram',
        channel: 'legacy',
        channelTitle: 'Legacy',
        url: 'https://t.me/legacy/1',
        ts: new Date().toISOString(),
        text: 'stale item',
        topic: 'breaking',
        tags: [],
        earlySignal: true,
      },
    ];

    const result = await service.getTelegramFeed();

    expect(result.channelSet).toBe('tech');
    expect(result.count).toBe(0);
    expect((service as any).telegramState.items).toEqual([]);
    expect((service as any).telegramState.cursorByHandle).toEqual({});
  });

  it('drops previous channel-set items during polling when the new set has no fresh posts', async () => {
    const { service } = createService();

    jest.spyOn(service as any, 'getTelegramRuntimeConfig').mockResolvedValue({
      enabled: true,
      apiId: '123456',
      apiHash: 'hash',
      session: 'session',
      channelSet: 'tech',
      maxFeedItems: 200,
      maxTextChars: 800,
      channelTimeoutMs: 15_000,
      pollCycleTimeoutMs: 30_000,
      startupDelayMs: 0,
      rateLimitMs: 0,
      pollIntervalMs: 60_000,
    });
    jest.spyOn(service as any, 'initTelegramClientIfNeeded').mockResolvedValue(true);
    jest.spyOn(service as any, 'loadTelegramChannels').mockReturnValue([
      { handle: 'new-feed', topic: 'intel', enabled: true, maxMessages: 10 },
    ]);
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);

    (service as any).telegramState.channelSet = 'full';
    (service as any).telegramState.channels = [{ handle: 'legacy' }];
    (service as any).telegramState.cursorByHandle = { legacy: 42 };
    (service as any).telegramState.items = [
      {
        id: 'legacy:1',
        source: 'telegram',
        channel: 'legacy',
        channelTitle: 'Legacy',
        url: 'https://t.me/legacy/1',
        ts: new Date().toISOString(),
        text: 'stale item',
        topic: 'breaking',
        tags: [],
        earlySignal: true,
      },
    ];
    (service as any).telegramState.client = {
      getEntity: jest.fn().mockResolvedValue({}),
      getMessages: jest.fn().mockResolvedValue([]),
    };

    await (service as any).pollTelegramOnce();

    expect((service as any).telegramState.channelSet).toBe('tech');
    expect((service as any).telegramState.items).toEqual([]);
    expect((service as any).telegramState.cursorByHandle).toEqual({});
  });

  it('restores telegram cursor state from cache', async () => {
    const { service } = createService();
    (service as any).cache.get.mockResolvedValue({
      channelSet: 'full',
      cursorByHandle: { alpha: 10, beta: 20 },
      items: [],
      lastPollAt: Date.now(),
      lastError: null,
    });

    await (service as any).restoreCachedTelegramState();

    expect((service as any).telegramState.channelSet).toBe('full');
    expect((service as any).telegramState.cursorByHandle).toEqual({ alpha: 10, beta: 20 });
  });

  it('computes Telegram startup delay from service start in guarded polling', async () => {
    const { service } = createService();

    (service as any).serviceStartedAt = Date.now() - 120_000;
    (service as any).telegramState.lastPollAt = 0;

    jest.spyOn(service as any, 'getTelegramRuntimeConfig').mockResolvedValue({
      enabled: true,
      apiId: '123456',
      apiHash: 'hash',
      session: 'session',
      channelSet: 'full',
      maxFeedItems: 200,
      maxTextChars: 800,
      channelTimeoutMs: 15_000,
      pollCycleTimeoutMs: 30_000,
      startupDelayMs: 60_000,
      rateLimitMs: 800,
      pollIntervalMs: 60_000,
    });
    const initTelegramClientSpy = jest
      .spyOn(service as any, 'initTelegramClientIfNeeded')
      .mockResolvedValue(false);

    await (service as any).guardedTelegramPoll();

    expect(initTelegramClientSpy).toHaveBeenCalledTimes(1);
  });

  it('allows first Telegram poll once startup delay has elapsed', async () => {
    const { service } = createService();

    (service as any).serviceStartedAt = Date.now() - 120_000;
    (service as any).telegramState.lastPollAt = 0;

    jest.spyOn(service as any, 'getTelegramRuntimeConfig').mockResolvedValue({
      enabled: true,
      apiId: '123456',
      apiHash: 'hash',
      session: 'session',
      channelSet: 'full',
      maxFeedItems: 200,
      maxTextChars: 800,
      channelTimeoutMs: 15_000,
      pollCycleTimeoutMs: 30_000,
      startupDelayMs: 60_000,
      rateLimitMs: 800,
      pollIntervalMs: 60_000,
    });
    const initTelegramClientSpy = jest
      .spyOn(service as any, 'initTelegramClientIfNeeded')
      .mockResolvedValue(false);

    await (service as any).pollTelegramOnce();

    expect(initTelegramClientSpy).toHaveBeenCalledTimes(1);
  });

  it('retries OREF bootstrap on next poll after a transient bootstrap failure', async () => {
    const { service } = createService();

    jest.spyOn(service as any, 'isOrefEnabled').mockReturnValue(true);
    jest.spyOn(service as any, 'isOrefConfigured').mockReturnValue(true);
    const bootstrapSpy = jest
      .spyOn(service as any, 'bootstrapOrefHistoryWithRetry')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    jest.spyOn(service as any, 'orefCurlFetch').mockResolvedValue('[]');
    jest
      .spyOn(service as any, 'recomputeOrefHistoryCounts')
      .mockImplementation(() => undefined);
    jest.spyOn(service as any, 'persistOrefAlerts').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'persistOrefHistory').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'persistOrefMetrics').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'triggerOrefAlertChecks')
      .mockResolvedValue(undefined);

    await (service as any).pollOrefOnce();
    expect((service as any).orefBootstrapped).toBe(false);

    await (service as any).pollOrefOnce();

    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
    expect((service as any).orefBootstrapped).toBe(true);
  });

  it('triggers OREF alert checks even when upstream payload is unchanged', async () => {
    const { service } = createService();

    (service as any).orefBootstrapped = true;
    (service as any).orefState.lastAlertsJson = '[]';

    jest.spyOn(service as any, 'isOrefEnabled').mockReturnValue(true);
    jest.spyOn(service as any, 'isOrefConfigured').mockReturnValue(true);
    jest.spyOn(service as any, 'orefCurlFetch').mockResolvedValue('[]');
    jest
      .spyOn(service as any, 'recomputeOrefHistoryCounts')
      .mockImplementation(() => undefined);
    jest.spyOn(service as any, 'persistOrefAlerts').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'persistOrefHistory').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'persistOrefMetrics').mockResolvedValue(undefined);
    const triggerChecksSpy = jest
      .spyOn(service as any, 'triggerOrefAlertChecks')
      .mockResolvedValue(undefined);

    await (service as any).pollOrefOnce();

    expect(triggerChecksSpy).toHaveBeenCalledTimes(1);
  });
});
