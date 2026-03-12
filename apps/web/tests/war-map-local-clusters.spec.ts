import { describe, expect, it } from 'vitest';

import {
  buildWarMapClusterCellKey,
  clusterWarMapPoints,
  computeWeightedClusterGeometry,
  resolveWarMapClusterCellSizeDegrees,
  sortWarMapEventClusterMembers,
  sortWarMapNewsClusterMembers,
  type WarMapClusterablePoint,
} from '../app/(app)/dashboard/charts/war-map/war-map-clustering';

interface TestPoint extends WarMapClusterablePoint {
  weight?: number;
}

describe('war-map local clusters', () => {
  it('matches the backend cell size progression', () => {
    expect(resolveWarMapClusterCellSizeDegrees()).toBe(12);
    expect(resolveWarMapClusterCellSizeDegrees(6)).toBe(3);
    expect(resolveWarMapClusterCellSizeDegrees(16)).toBe(0.35);
  });

  it('groups only points inside the current bbox', () => {
    const bbox: [number, number, number, number] = [0, 0, 10, 10];
    const points: TestPoint[] = [
      { id: 'inside-a', lat: 1, lng: 1 },
      { id: 'inside-b', lat: 2, lng: 2 },
      { id: 'outside', lat: 22, lng: 22 },
    ];

    const result = clusterWarMapPoints(points, { bbox, zoom: 2 });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.members.map((member) => member.id)).toEqual([
      'inside-a',
      'inside-b',
    ]);
    expect(result.singles).toHaveLength(0);
  });

  it('keeps singleton points and computes weighted cluster centers', () => {
    const bbox: [number, number, number, number] = [0, 0, 30, 30];
    const points: TestPoint[] = [
      { id: 'cluster-a', lat: 2, lng: 2, weight: 1 },
      { id: 'cluster-b', lat: 4, lng: 4, weight: 9 },
      { id: 'single', lat: 20, lng: 20, weight: 1 },
    ];

    const result = clusterWarMapPoints(points, {
      bbox,
      zoom: 2,
      getClusterGeometry: (members) =>
        computeWeightedClusterGeometry(members, (point) => point.weight ?? 1),
    });

    expect(result.singles.map((point) => point.id)).toEqual(['single']);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.count).toBe(2);
    expect(result.clusters[0]?.lat).toBeCloseTo(3.8);
    expect(result.clusters[0]?.lng).toBeCloseTo(3.8);
  });

  it('uses the same floor-based cell keys as the backend grid', () => {
    const bbox: [number, number, number, number] = [0, 0, 10, 10];
    const cellSize = 2;

    expect(buildWarMapClusterCellKey(1.99, 1.99, bbox, cellSize)).toBe('0:0');
    expect(buildWarMapClusterCellKey(2, 2, bbox, cellSize)).toBe('1:1');
  });
});

describe('war-map local cluster sorting', () => {
  it('sorts event members by severity, then latest time, then name', () => {
    const result = sortWarMapEventClusterMembers([
      { id: 'fr', lat: 0, lng: 0, name: 'France', severity: 'medium', latestAt: '2026-03-11T10:00:00.000Z' },
      { id: 'ca', lat: 0, lng: 0, name: 'Canada', severity: 'high', latestAt: '2026-03-10T10:00:00.000Z' },
      { id: 'br', lat: 0, lng: 0, name: 'Brazil', severity: 'high', latestAt: '2026-03-12T10:00:00.000Z' },
    ]);

    expect(result.map((entry) => entry.name)).toEqual(['Brazil', 'Canada', 'France']);
  });

  it('sorts news members by published time and falls back to ingested time', () => {
    const result = sortWarMapNewsClusterMembers([
      { id: 'a', lat: 0, lng: 0, title: 'Older published', publishedAt: '2026-03-11T10:00:00.000Z' },
      { id: 'b', lat: 0, lng: 0, title: 'Newest ingested', ingestedAt: '2026-03-12T11:00:00.000Z' },
      { id: 'c', lat: 0, lng: 0, title: 'Newest published', publishedAt: '2026-03-12T12:00:00.000Z' },
    ]);

    expect(result.map((entry) => entry.title)).toEqual([
      'Newest published',
      'Newest ingested',
      'Older published',
    ]);
  });
});
