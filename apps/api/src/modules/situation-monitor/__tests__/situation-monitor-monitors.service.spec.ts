import { SituationMonitorMonitorsService } from '../situation-monitor-monitors.service';

const makeCandidate = (overrides: Partial<Record<string, unknown>> = {}) => ({
  itemKey: 'candidate-1',
  itemType: 'headline',
  title: 'NVIDIA expands AI chip output',
  summary: 'Semiconductor supply chain update',
  link: 'https://example.com/article',
  source: 'Example News',
  timestamp: Date.parse('2026-03-06T00:00:00.000Z'),
  topics: [] as string[],
  entities: [] as string[],
  extraTexts: [] as string[],
  ...overrides,
});

const makeMonitor = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'monitor-1',
  kind: 'manual',
  name: 'AI Watch',
  enabled: true,
  rawKeywords: [] as string[],
  approvedTopics: [] as string[],
  approvedEntities: [] as string[],
  approvedLexicalTerms: [] as string[],
  rejectedSuggestions: {
    topics: [],
    entities: [],
    lexicalTerms: [],
  },
  queryEmbeddingModel: 'embedding-model',
  queryEmbeddingVector: [1, 0],
  createdAt: '2026-03-05T00:00:00.000Z',
  updatedAt: '2026-03-06T00:00:00.000Z',
  ...overrides,
});

describe('SituationMonitorMonitorsService', () => {
  it('maps embedding rows by index when candidate embedding responses are out of order', async () => {
    const liteLlm = {
      embedding: jest.fn().mockResolvedValue({
        model: 'embedding-model',
        data: [
          { index: 1, embedding: [0, 7] },
          { index: 0, embedding: [5, 0] },
        ],
      }),
    };
    const service = new SituationMonitorMonitorsService(
      {} as any,
      liteLlm as any,
      {} as any,
      {} as any,
    );

    const results = await (service as any).embedCandidateBatch(
      'org-1',
      [makeMonitor()],
      [
        makeCandidate({
          itemKey: 'candidate-a',
          title: 'AI rollout',
        }),
        makeCandidate({
          itemKey: 'candidate-b',
          title: 'Chip supply chain',
        }),
      ],
    );

    expect(results.get('candidate-a')).toEqual([1, 0]);
    expect(results.get('candidate-b')).toEqual([0, 1]);
  });

  it('keeps semantic scores attached to the original candidate indexes after shortlist sorting', async () => {
    const service = new SituationMonitorMonitorsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'loadMonitorRows').mockResolvedValue([{ id: 'row-1' }]);
    jest.spyOn(service as any, 'normalizeMonitorRow').mockReturnValue(makeMonitor());
    jest.spyOn(service as any, 'embedCandidateBatch').mockResolvedValue(
      new Map([
        ['candidate-a', [0.8, 0.6]],
        ['candidate-b', [1, 0]],
        ['candidate-c', [0.5, 0.5]],
      ]),
    );
    jest.spyOn(service as any, 'tryRerankCandidates').mockResolvedValue(new Map());

    const results = await (service as any).matchCandidates('org-1', 'user-1', [
      makeCandidate({
        itemKey: 'candidate-a',
        title: 'Candidate A',
        timestamp: Date.parse('2026-03-05T00:00:00.000Z'),
      }),
      makeCandidate({
        itemKey: 'candidate-b',
        title: 'Candidate B',
        timestamp: Date.parse('2026-03-06T00:00:00.000Z'),
      }),
      makeCandidate({
        itemKey: 'candidate-c',
        title: 'Candidate C',
        timestamp: Date.parse('2026-03-04T00:00:00.000Z'),
      }),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      itemKey: 'candidate-b',
      monitorId: 'monitor-1',
      score: 0.15,
    });
    expect(results[0]?.reasons).toEqual([
      {
        code: 'semantic',
        label: 'Semantic recall',
        score: 1,
      },
    ]);
  });
});
