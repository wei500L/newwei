import { ArchiveClassifier } from '../archive.classifier';
import { ArchiveRegion, ArchiveVertical } from '../archive.types';

describe('ArchiveClassifier', () => {
  const classifier = new ArchiveClassifier();

  it('classifies East Sea storyline in APAC', () => {
    const result = classifier.classify({
      title: 'Japan releases defense white paper on regional tensions',
      summary: 'Tokyo and Seoul discussed East China Sea posture.',
      topics: ['security', 'east china sea'],
      entities: [{ name: 'Japan' }, { name: 'South Korea' }],
      location: 'Japan',
    });

    expect(result.region).toBe(ArchiveRegion.APAC);
    expect(result.vertical).toBe(ArchiveVertical.EAST_SEA);
    expect(result.countryLabel).toBe('Japan');

    const ruleSignals = classifier.classifyRuleSignals({
      title: 'Japan releases defense white paper on regional tensions',
      summary: 'Tokyo and Seoul discussed East China Sea posture.',
      topics: ['security', 'east china sea'],
      entities: [{ name: 'Japan' }, { name: 'South Korea' }],
      location: 'Japan',
    });

    expect(ruleSignals.ruleScores[ArchiveVertical.EAST_SEA]).toBeGreaterThan(0);
    expect(ruleSignals.region).toBe(ArchiveRegion.APAC);
    expect(ruleSignals.countryMatchedVerticals).toContain(ArchiveVertical.EAST_SEA);
    expect(
      ruleSignals.verticalSignals[ArchiveVertical.EAST_SEA].matchedStrongKeywords,
    ).toContain('east china sea');
  });

  it('classifies South Sea storyline using keywords', () => {
    const result = classifier.classify({
      title: 'Patrols increase near Scarborough Shoal',
      summary: 'New coast guard activity observed in the South China Sea.',
      topics: ['maritime', 'south china sea'],
      entities: [{ name: 'Philippines' }],
      location: 'Philippines',
    });

    expect(result.region).toBe(ArchiveRegion.APAC);
    expect(result.vertical).toBe(ArchiveVertical.SOUTH_SEA);
  });

  it('falls back to OTHER region and foreign affairs vertical', () => {
    const result = classifier.classify({
      title: 'Broad diplomatic developments discussed',
      summary: 'Several countries announced new sanctions and responses.',
      topics: ['diplomacy'],
      entities: [],
      location: null,
    });

    expect(result.region).toBe(ArchiveRegion.OTHER);
    expect(result.vertical).toBe(ArchiveVertical.FOREIGN_AFFAIRS);

    const ruleSignals = classifier.classifyRuleSignals({
      title: 'Broad diplomatic developments discussed',
      summary: 'Several countries announced new sanctions and responses.',
      topics: ['diplomacy'],
      entities: [],
      location: null,
    });

    expect(ruleSignals.ruleScores[ArchiveVertical.FOREIGN_AFFAIRS]).toBeGreaterThan(0);
    expect(
      ruleSignals.verticalSignals[ArchiveVertical.FOREIGN_AFFAIRS].matchedStrongKeywords,
    ).toContain('diplomacy');
  });

  it('keeps domestic policy content out of foreign affairs when both word groups appear', () => {
    const ruleSignals = classifier.classifyRuleSignals({
      title: 'Cabinet unveils fiscal stimulus after foreign ministry briefing',
      summary:
        'The package focuses on local government financing, infrastructure, energy security, and industrial policy implementation.',
      topics: ['domestic policy', 'industrial policy', 'energy security'],
      entities: [{ name: 'China' }],
      location: 'China',
      source: 'policy desk',
    });

    expect(ruleSignals.ruleVertical).toBe(ArchiveVertical.DOMESTIC_AFFAIRS);
    expect(
      ruleSignals.verticalSignals[ArchiveVertical.DOMESTIC_AFFAIRS].matchedStrongKeywords,
    ).toContain('industrial policy');
    expect(ruleSignals.suppressedKeywords).toContain('industrial policy');
  });

  it('classifies west-front border security separately from maritime theaters', () => {
    const ruleSignals = classifier.classifyRuleSignals({
      title: 'Ceasefire frays after Kashmir border clash',
      summary:
        'Indian and Pakistani forces raised frontier security readiness after fresh militant infiltration alerts.',
      topics: ['kashmir', 'border clash', 'counterterrorism'],
      entities: [{ name: 'India' }, { name: 'Pakistan' }],
      location: 'Pakistan',
    });

    expect(ruleSignals.region).toBe(ArchiveRegion.APAC);
    expect(ruleSignals.ruleVertical).toBe(ArchiveVertical.WEST_FRONT);
    expect(ruleSignals.countryMatchedVerticals).toContain(ArchiveVertical.WEST_FRONT);
    expect(
      ruleSignals.verticalSignals[ArchiveVertical.WEST_FRONT].matchedStrongKeywords,
    ).toContain('kashmir');
  });

  it('returns locale-neutral empty country label when no country signal exists', () => {
    const result = classifier.classify({
      title: null,
      summary: null,
      topics: [],
      entities: [],
      location: null,
    });

    expect(result.countryCode).toBeNull();
    expect(result.countryLabel).toBe('');
  });

  it('keeps zero rule scores when no vertical signal exists while classify stays compatible', () => {
    const ruleSignals = classifier.classifyRuleSignals({
      title: null,
      summary: null,
      topics: [],
      entities: [],
      location: null,
    });

    expect(ruleSignals.ruleScores[ArchiveVertical.EAST_SEA]).toBe(0);
    expect(ruleSignals.ruleScores[ArchiveVertical.SOUTH_SEA]).toBe(0);
    expect(ruleSignals.ruleScores[ArchiveVertical.WEST_FRONT]).toBe(0);
    expect(ruleSignals.ruleScores[ArchiveVertical.FOREIGN_AFFAIRS]).toBe(0);
    expect(ruleSignals.ruleScores[ArchiveVertical.DOMESTIC_AFFAIRS]).toBe(0);

    const classification = classifier.classify({
      title: null,
      summary: null,
      topics: [],
      entities: [],
      location: null,
    });

    expect(classification.vertical).toBe(ArchiveVertical.FOREIGN_AFFAIRS);
  });
});
