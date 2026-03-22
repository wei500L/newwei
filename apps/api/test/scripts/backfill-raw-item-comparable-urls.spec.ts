import { buildComparableUrlVariants } from '@modular/mongo';
import { Types } from 'mongoose';

import {
  backfillRawItemComparableUrls,
  parseCliArgsFromArgs,
} from '../../scripts/backfill-raw-item-comparable-urls';

describe('backfill-raw-item-comparable-urls script helpers', () => {
  it('parses CLI flags for dry-run, batch size, max docs, and resume id', () => {
    const parsed = parseCliArgsFromArgs([
      '--dry-run',
      '--batch-size=1200',
      '--max-docs=200',
      '--resume-after-id=507f1f77bcf86cd799439011',
    ]);

    expect(parsed).toEqual({
      dryRun: true,
      batchSize: 1200,
      maxDocs: 200,
      resumeAfterId: '507f1f77bcf86cd799439011',
    });
  });

  it('syncs indexes and backfills the hashed comparable full URL field', async () => {
    const firstId = new Types.ObjectId('507f1f77bcf86cd799439011');
    const secondId = new Types.ObjectId('507f1f77bcf86cd799439012');
    const docs = [
      {
        _id: firstId,
        payload: { url: 'https://Example.com/story?id=123#top' },
      },
      {
        _id: secondId,
        payload: { url: 'not-a-url' },
      },
    ];
    const cursor = (async function* () {
      for (const doc of docs) {
        yield doc;
      }
    })();
    const syncIndexes = jest.fn().mockResolvedValue([]);
    const bulkWrite = jest.fn().mockResolvedValue(undefined);
    const find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          cursor: jest.fn().mockReturnValue(cursor),
        }),
      }),
    });

    const result = await backfillRawItemComparableUrls(
      {
        syncIndexes,
        bulkWrite,
        find,
      } as any,
      {
        dryRun: false,
        batchSize: 10,
      },
    );

    const comparable = buildComparableUrlVariants('https://Example.com/story?id=123#top');

    expect(syncIndexes).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(
      {
        $or: [
          { urlComparableFull: { $exists: false } },
          { urlComparableFullHash: { $exists: false } },
          { urlComparableBase: { $exists: false } },
        ],
      },
      {
        _id: 1,
        'payload.url': 1,
        urlComparableFull: 1,
        urlComparableFullHash: 1,
        urlComparableBase: 1,
      },
    );
    expect(bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: { _id: firstId },
            update: {
              $set: {
                urlComparableFull: comparable?.full ?? null,
                urlComparableFullHash: comparable?.fullHash ?? null,
                urlComparableBase: comparable?.base ?? null,
              },
            },
          },
        },
        {
          updateOne: {
            filter: { _id: secondId },
            update: {
              $set: {
                urlComparableFull: null,
                urlComparableFullHash: null,
                urlComparableBase: null,
              },
            },
          },
        },
      ],
      { ordered: false },
    );
    expect(result).toEqual({
      scanned: 2,
      updated: 2,
      invalidUrls: 1,
      lastId: secondId.toString(),
    });
  });

  it('does not mutate indexes or documents during dry-run', async () => {
    const syncIndexes = jest.fn();
    const bulkWrite = jest.fn();
    const cursor = (async function* () {
      yield {
        _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
        payload: { url: 'https://example.com/story' },
      };
    })();
    const find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          cursor: jest.fn().mockReturnValue(cursor),
        }),
      }),
    });

    await backfillRawItemComparableUrls(
      {
        syncIndexes,
        bulkWrite,
        find,
      } as any,
      {
        dryRun: true,
        batchSize: 10,
      },
    );

    expect(syncIndexes).not.toHaveBeenCalled();
    expect(bulkWrite).not.toHaveBeenCalled();
  });
});
