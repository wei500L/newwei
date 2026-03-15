import { describe, expect, it } from 'vitest';

import {
  VERTICAL_SECTIONS,
  resolveArchiveClassificationI18nKeys,
  resolveArchiveClassificationSignals,
  resolveArchiveItemPreview,
  resolveArchiveRelevancePercent,
  resolveArchiveSearchFeedbackVisualState,
  resolveArchiveVerticalTone,
  resolveArchiveWeightStars,
} from '../app/(app)/events-archive/events-archive-display';

describe('events archive display helpers', () => {
  it('provides tone config for every configured vertical', () => {
    const verticals = Array.from(
      new Set(VERTICAL_SECTIONS.flatMap((section) => section.verticals)),
    );

    expect(verticals).toHaveLength(5);
    for (const vertical of verticals) {
      expect(resolveArchiveVerticalTone(vertical)).toMatchObject({
        accentDotClassName: expect.any(String),
        accentGlowClassName: expect.any(String),
        actionClassName: expect.any(String),
        titlePillClassName: expect.any(String),
      });
    }
  });

  it('falls back to safe country and summary labels', () => {
    expect(
      resolveArchiveItemPreview(
        {
          countryLabel: '  ',
          summary: null,
          title: '  Archive headline  ',
        },
        {
          countryLabel: '未知',
          summary: '未命名事件',
        },
      ),
    ).toEqual({
      country: '未知',
      summary: 'Archive headline',
    });

    expect(
      resolveArchiveItemPreview(
        {
          countryLabel: 'Australia',
          summary: '  ',
          title: null,
        },
        {
          countryLabel: '未知',
          summary: '未命名事件',
        },
      ),
    ).toEqual({
      country: 'Australia',
      summary: '未命名事件',
    });
  });

  it('clamps weight stars to the supported range', () => {
    expect(resolveArchiveWeightStars(0)).toBe('★');
    expect(resolveArchiveWeightStars(3)).toBe('★★★');
    expect(resolveArchiveWeightStars(9)).toBe('★★★★★');
  });

  it('rounds relevance percentages and ignores invalid values', () => {
    expect(resolveArchiveRelevancePercent(0.876)).toBe(88);
    expect(resolveArchiveRelevancePercent(null)).toBeNull();
    expect(resolveArchiveRelevancePercent(Number.NaN)).toBeNull();
  });

  it('maps feedback tones to the intended visual states', () => {
    expect(resolveArchiveSearchFeedbackVisualState('pending')).toBe(
      'debouncing',
    );
    expect(resolveArchiveSearchFeedbackVisualState('info')).toBe('minChars');
    expect(resolveArchiveSearchFeedbackVisualState('ready')).toBe('ready');
  });

  it('deduplicates and caps classification rule signals for the detail drawer', () => {
    expect(
      resolveArchiveClassificationSignals(
        [' Rule ', 'Rule', 'Embedding', '', 'Rerank'],
        2,
      ),
    ).toEqual(['Rule', 'Embedding']);
  });

  it('deduplicates and caps classification i18n keys', () => {
    expect(
      resolveArchiveClassificationI18nKeys(
        [
          'pages.eventsArchive.detail.classificationStaleReason.embeddingModelChanged',
          'pages.eventsArchive.detail.classificationStaleReason.embeddingModelChanged',
          'pages.eventsArchive.detail.classificationStaleReason.rerankModelChanged',
        ],
        2,
      ),
    ).toEqual([
      'pages.eventsArchive.detail.classificationStaleReason.embeddingModelChanged',
      'pages.eventsArchive.detail.classificationStaleReason.rerankModelChanged',
    ]);
  });
});
