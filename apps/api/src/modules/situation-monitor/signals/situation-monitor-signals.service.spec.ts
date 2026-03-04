import { SituationMonitorSignalsService } from './situation-monitor-signals.service';

describe('SituationMonitorSignalsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createService() {
    const env = { get: jest.fn() } as any;
    const cache = { get: jest.fn(), set: jest.fn() } as any;
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
