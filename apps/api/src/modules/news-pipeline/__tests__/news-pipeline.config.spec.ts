import path from 'node:path';

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    watch: jest.fn(),
  };
});

let fsMock: jest.Mocked<typeof import('node:fs')>;

describe('NewsPipelineConfigService config watcher', () => {
  const absoluteConfigPath = path.join(process.cwd(), 'tmp.news-pipeline.yml');
  const configDir = path.dirname(absoluteConfigPath);
  const targetFile = path.basename(absoluteConfigPath);
  let watcherClose: jest.Mock;

  const envMock = {
    newsPipelineEnv: {
      cacheTtlSeconds: 60,
      maxInputChars: 10_000,
      configPath: absoluteConfigPath,
      crawlQueueConcurrency: 1,
      processQueueConcurrency: 1,
      crawlQueueRateLimit: 10,
      processQueueRateLimit: 10,
    },
    liteLlmConfig: {
      model: 'model',
      apiBase: 'http://example.com',
      apiKey: undefined,
      timeoutMs: 30_000,
      temperature: 0.2,
      topP: 1,
      maxOutputTokens: 256,
      maxRetries: 1,
      fallbackModels: [],
      requestsPerMinute: 60,
    },
    crawl4aiConfig: {
      baseUrl: 'http://crawl4ai',
      apiKey: undefined,
      timeoutMs: 30_000,
      maxConcurrency: 1,
      maxRetries: 1,
      healthCheckTtlMs: 60_000,
      retryBackoffMs: 1_000,
      media: {
        fetchTimeoutMs: 1_000,
        maxBytes: 1024,
        maxPerResult: 1,
      },
    },
  } as any;

  beforeEach(() => {
    jest.useFakeTimers();
    fsMock = jest.requireMock('node:fs') as jest.Mocked<typeof import('node:fs')>;
    jest.clearAllMocks();
    fsMock.existsSync.mockImplementation((candidate: any) => {
      return candidate === configDir || candidate === absoluteConfigPath;
    });
    fsMock.readFileSync.mockReturnValue('');
    watcherClose = jest.fn();
    fsMock.watch.mockReturnValue({
      close: watcherClose,
      on: jest.fn().mockReturnThis(),
    } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('watches config directory via fs.watch and reloads on changes', () => {
    let service: any;

    jest.isolateModules(() => {
      const mod = require('../news-pipeline.config') as typeof import('../news-pipeline.config');
      service = new mod.NewsPipelineConfigService(envMock);
    });

    expect(fsMock.watch).toHaveBeenCalledWith(
      configDir,
      { persistent: false },
      expect.any(Function),
    );

    const watchCallback = (fsMock.watch.mock.calls[0] as any[])[2];

    expect(fsMock.readFileSync).toHaveBeenCalledTimes(1);
    watchCallback('change', targetFile);
    jest.advanceTimersByTime(210);
    expect(fsMock.readFileSync).toHaveBeenCalledTimes(2);

    watchCallback('change', 'other.yml');
    jest.advanceTimersByTime(210);
    expect(fsMock.readFileSync).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    expect(watcherClose).toHaveBeenCalledTimes(1);
  });
});
