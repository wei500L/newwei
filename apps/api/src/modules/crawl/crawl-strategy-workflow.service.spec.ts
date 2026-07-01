import { CrawlStrategyWorkflowService } from './crawl-strategy-workflow.service';

describe('CrawlStrategyWorkflowService.compareVersions', () => {
  it('returns structural diffs and binding impact summary', async () => {
    const prisma = {
      crawlStrategyWorkflowVersion: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) => {
            if (where.id === 'left-v') {
              return {
                id: 'left-v',
                workflowId: 'wf-1',
                orgId: 'org-1',
                version: 1,
                name: 'Version 1',
                description: null,
                definition: {
                  version: 1,
                  metadata: {},
                  settings: {
                    executionMode: 'layered',
                    maxDepth: 3,
                    maxPages: 60,
                    timeoutMs: 15000,
                    concurrency: 2,
                    robotsPolicy: 'respect',
                    domainScope: 'registrable_domain',
                  },
                  nodes: [
                    {
                      id: 'seed',
                      type: 'seed-discovery',
                      label: 'Seed',
                      position: { x: 80, y: 100 },
                      config: { mode: 'sitemap' },
                    },
                  ],
                  edges: [],
                },
                createdById: 'user-1',
                createdAt: new Date('2026-03-21T09:00:00.000Z'),
              };
            }
            return {
              id: 'right-v',
              workflowId: 'wf-1',
              orgId: 'org-1',
              version: 2,
              name: 'Version 2',
              description: null,
              definition: {
                version: 1,
                metadata: {},
                settings: {
                  executionMode: 'hybrid',
                  maxDepth: 4,
                  maxPages: 60,
                  timeoutMs: 15000,
                  concurrency: 2,
                  robotsPolicy: 'respect',
                  domainScope: 'registrable_domain',
                },
                nodes: [
                  {
                    id: 'seed',
                    type: 'seed-discovery',
                    label: 'Seed Discovery',
                    position: { x: 80, y: 100 },
                    config: { mode: 'rss' },
                  },
                  {
                    id: 'filter',
                    type: 'url-filter',
                    label: 'Filter',
                    position: { x: 320, y: 100 },
                    config: { excludePatterns: ['/tag/'] },
                  },
                ],
                edges: [
                  {
                    id: 'edge-1',
                    source: 'seed',
                    target: 'filter',
                  },
                ],
              },
              createdById: 'user-1',
              createdAt: new Date('2026-03-21T10:00:00.000Z'),
            };
          }),
      },
      crawlStrategyWorkflow: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'wf-1',
            name: 'Workflow A',
            publishedVersionId: 'right-v',
          },
        ]),
      },
      crawlSiteProfile: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'profile-1',
            name: 'Profile A',
            matchHost: 'news.example.com',
            workflowId: 'wf-1',
            workflowVersionId: 'left-v',
            workflowBindingMode: 'pinned',
            updatedAt: new Date('2026-03-21T10:10:00.000Z'),
          },
          {
            id: 'profile-2',
            name: 'Profile B',
            matchHost: 'world.example.com',
            workflowId: 'wf-1',
            workflowVersionId: null,
            workflowBindingMode: 'published',
            updatedAt: new Date('2026-03-21T10:12:00.000Z'),
          },
        ]),
      },
      newsSource: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'source-1',
            name: 'Source A',
            url: 'https://example.com/news',
            workflowId: 'wf-1',
            workflowVersionId: 'right-v',
            workflowBindingMode: 'pinned',
            updatedAt: new Date('2026-03-21T10:20:00.000Z'),
          },
        ]),
      },
    } as any;

    const service = new CrawlStrategyWorkflowService(prisma, {} as any);

    const result = await service.compareVersions('org-1', {
      leftVersionId: 'left-v',
      rightVersionId: 'right-v',
    });

    expect(result.summary.changedSettingsCount).toBe(2);
    expect(result.summary.addedNodeCount).toBe(1);
    expect(result.summary.changedNodeCount).toBe(1);
    expect(result.summary.addedEdgeCount).toBe(1);
    expect(result.definitionDiff.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'executionMode' }),
        expect.objectContaining({ key: 'maxDepth' }),
      ]),
    );
    expect(result.definitionDiff.nodes.added).toEqual([
      expect.objectContaining({ id: 'filter', type: 'url-filter' }),
    ]);
    expect(result.definitionDiff.nodes.changed).toEqual([
      expect.objectContaining({
        id: 'seed',
        changedFields: expect.arrayContaining(['label', 'config']),
      }),
    ]);
    expect(result.bindingImpact.profiles.total).toBe(2);
    expect(result.bindingImpact.profiles.followingPublishedCount).toBe(1);
    expect(result.bindingImpact.profiles.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'profile-1', appliesTo: 'left_version' }),
        expect.objectContaining({ id: 'profile-2', appliesTo: 'published_right' }),
      ]),
    );
    expect(result.bindingImpact.newsSources.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'source-1', appliesTo: 'right_version' }),
      ]),
    );
  });
});

describe('CrawlStrategyWorkflowService workflow proxy policy', () => {
  it('rejects creating a workflow draft with discovery crawlOptions proxy overrides', async () => {
    const prisma = {
      crawlStrategyWorkflow: {
        create: jest.fn(),
      },
    } as any;

    const service = new CrawlStrategyWorkflowService(prisma, {} as any);

    await expect(
      service.createWorkflow('org-1', 'user-1', {
        name: 'Bad Workflow',
        draftDefinition: {
          version: 1,
          metadata: {},
          settings: {
            executionMode: 'hybrid',
            maxDepth: 3,
            maxPages: 60,
            timeoutMs: 15000,
            concurrency: 2,
            robotsPolicy: 'respect',
            domainScope: 'registrable_domain',
          },
          nodes: [
            {
              id: 'list-1',
              type: 'list-discovery',
              label: 'List Discovery',
              position: { x: 0, y: 0 },
              config: {
                crawlOptions: {
                  proxyUrl: 'http://proxy.example.com:8080',
                },
              },
            },
          ],
          edges: [],
        },
      }),
    ).rejects.toThrow('Unsupported crawl config');
    expect(prisma.crawlStrategyWorkflow.create).not.toHaveBeenCalled();
  });

  it('rejects publishing an existing draft with discovery crawlOptions proxy overrides', async () => {
    const prisma = {
      crawlStrategyWorkflow: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wf-1',
          orgId: 'org-1',
          name: 'Bad Workflow',
          description: null,
          draftDefinition: {
            version: 1,
            metadata: {},
            settings: {
              executionMode: 'hybrid',
              maxDepth: 3,
              maxPages: 60,
              timeoutMs: 15000,
              concurrency: 2,
              robotsPolicy: 'respect',
              domainScope: 'registrable_domain',
            },
            nodes: [
              {
                id: 'deep-1',
                type: 'deep-discovery',
                label: 'Deep Discovery',
                position: { x: 0, y: 0 },
                config: {
                  crawlOptions: {
                    proxyConfig: {
                      server: 'http://proxy.example.com:8080',
                    },
                  },
                },
              },
            ],
            edges: [],
          },
          publishedVersion: null,
          versions: [],
        }),
      },
      $transaction: jest.fn(),
    } as any;

    const service = new CrawlStrategyWorkflowService(prisma, {} as any);

    await expect(
      service.publishWorkflow('org-1', 'user-1', 'wf-1'),
    ).rejects.toThrow('Unsupported crawl config');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
