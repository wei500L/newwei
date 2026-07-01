/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('@modular/utils', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  ensureTraceId: jest.fn((traceId?: string) => traceId ?? 'test-trace-id'),
  runWithTraceId: jest.fn(async (_traceId: string, fn: () => Promise<any>) => fn()),
}));

const workerInstances: { on: jest.Mock; close: jest.Mock<Promise<void>, []> }[] = [];

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => {
    const instance = {
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    workerInstances.push(instance);
    return instance;
  }),
  Queue: jest.fn(),
  QueueEvents: jest.fn(),
}));

jest.mock('./situation-monitor/signals/situation-monitor-telegram-scheduler', () => ({
  removeLegacyTelegramRepeatJobs: jest.fn().mockResolvedValue(undefined),
  removeQueuedTelegramPollJobs: jest.fn().mockResolvedValue(undefined),
  removeTelegramPollScheduler: jest.fn().mockResolvedValue(undefined),
  upsertTelegramPollScheduler: jest.fn().mockResolvedValue(undefined),
}));

import { AkshareQueueProcessor } from './akshare/akshare.processor';
import { AlertsProcessor } from './alerts/alerts.processor';
import { AnalysisProcessor } from './analysis/analysis.processor';
import { ArchivePreparationProcessor } from './archive/archive-preparation.processor';
import { AssistantProcessor } from './assistant/assistant.processor';
import { SituationMonitorSignalsProcessor } from './situation-monitor/signals/situation-monitor-signals.processor';

interface EventsMock {
  on: jest.Mock;
  off: jest.Mock;
}

interface ProcessorUnderTest {
  onModuleDestroy: () => Promise<unknown>;
}

interface TestCase {
  name: string;
  create: () => {
    events: EventsMock;
    processor: ProcessorUnderTest;
    start: () => Promise<unknown>;
  };
}

function createEvents(): EventsMock {
  return {
    on: jest.fn(),
    off: jest.fn(),
  };
}

function createQueue(overrides: Record<string, unknown> = {}) {
  return {
    opts: {
      connection: {
        host: '127.0.0.1',
        port: 6379,
      },
    },
    ...overrides,
  } as any;
}

const cases: TestCase[] = [
  {
    name: 'AnalysisProcessor',
    create: () => {
      const events = createEvents();
      const processor = new AnalysisProcessor(
        { analysisConfig: { queueConcurrency: 1 } } as any,
        { process: jest.fn() } as any,
        createQueue(),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onModuleInit(),
      };
    },
  },
  {
    name: 'AssistantProcessor',
    create: () => {
      const events = createEvents();
      const processor = new AssistantProcessor(
        { assistantConfig: { queueConcurrency: 1 } } as any,
        { process: jest.fn() } as any,
        createQueue(),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onModuleInit(),
      };
    },
  },
  {
    name: 'AkshareQueueProcessor',
    create: () => {
      const events = createEvents();
      const processor = new AkshareQueueProcessor(
        { akshareConfig: { queueConcurrency: 1 } } as any,
        {
          fetchAndPersist: jest.fn(),
          recordFetchFailure: jest.fn(),
        } as any,
        createQueue(),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onApplicationBootstrap(),
      };
    },
  },
  {
    name: 'AlertsProcessor',
    create: () => {
      const events = createEvents();
      const processor = new AlertsProcessor(
        { alertingConfig: { queueConcurrency: 1 } } as any,
        {
          scheduleScanJob: jest.fn().mockResolvedValue(undefined),
          ensureAllSchedules: jest.fn().mockResolvedValue(undefined),
          getNotificationBackoffDelay: jest.fn().mockReturnValue(0),
          enqueueActiveRuleChecks: jest.fn(),
          evaluateRule: jest.fn(),
          handleDeliveryJob: jest.fn(),
        } as any,
        createQueue(),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onModuleInit(),
      };
    },
  },
  {
    name: 'ArchivePreparationProcessor',
    create: () => {
      const events = createEvents();
      const processor = new ArchivePreparationProcessor(
        {} as any,
        {
          markProcessing: jest.fn(),
          markReady: jest.fn(),
          markFailed: jest.fn(),
        } as any,
        {} as any,
        createQueue(),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onModuleInit(),
      };
    },
  },
  {
    name: 'SituationMonitorSignalsProcessor',
    create: () => {
      const events = createEvents();
      const processor = new SituationMonitorSignalsProcessor(
        {
          get: jest.fn().mockReturnValue(undefined),
        } as any,
        {
          runJob: jest.fn(),
        } as any,
        {
          getTelegramRuntimeConfig: jest.fn().mockResolvedValue({
            enabled: false,
            pollIntervalMs: 60_000,
          }),
        } as any,
        createQueue({
          add: jest.fn().mockResolvedValue(undefined),
        }),
        events as any,
      );
      return {
        events,
        processor,
        start: () => processor.onModuleInit(),
      };
    },
  },
];

describe('processor queue event cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    workerInstances.length = 0;
  });

  it.each(cases)('$name unregisters the failed queue event listener on module destroy', async ({ create }) => {
    const { events, processor, start } = create();

    await start();

    const registeredHandler = events.on.mock.calls.find(([eventName]) => eventName === 'failed')?.[1];

    expect(registeredHandler).toEqual(expect.any(Function));

    const worker = workerInstances[workerInstances.length - 1];

    await processor.onModuleDestroy();

    expect(events.off).toHaveBeenCalledWith('failed', registeredHandler);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });
});
