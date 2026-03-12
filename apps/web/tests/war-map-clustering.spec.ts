import { describe, expect, it } from 'vitest';

import {
  buildWarMapClusterCellKey,
  clusterWarMapPoints,
  computeWeightedClusterGeometry,
  DEFAULT_WAR_MAP_BBOX,
  resolveWarMapClusterCellSizeDegrees,
  sortWarMapEventClusterMembers,
  sortWarMapNewsClusterMembers,
  type WarMapClusterablePoint,
} from '../app/(app)/dashboard/charts/war-map/war-map-clustering';

interface TestEvent extends WarMapClusterablePoint {
  severity: 'low' | 'medium' | 'high';
  latestAt?: string;
  derivedScore?: number;
  name: string;
}

interface TestNews extends WarMapClusterablePoint {
  title: string;
  location: string;
  publishedAt?: string;
  ingestedAt?: string;
}

describe('war-map clustering', () => {
  it('matches the backend cluster cell size curve and clamps extremes', () => {
    expect(resolveWarMapClusterCellSizeDegrees(2)).toBeCloseTo(12, 5);
    expect(resolveWarMapClusterCellSizeDegrees(0)).toBeCloseTo(24, 5);
    expect(resolveWarMapClusterCellSizeDegrees(12)).toBeCloseTo(0.375, 5);
    expect(resolveWarMapClusterCellSizeDegrees(16)).toBeCloseTo(0.35, 5);
    expect(resolveWarMapClusterCellSizeDegrees(18)).toBeCloseTo(0.35, 5);
  });

  it('groups members into bbox-relative floor-based cells', () => {
    const bbox: [number, number, number, number] = [-20, -20, 20, 20];
    const cellSize = 10;

    expect(buildWarMapClusterCellKey(-5, -5, bbox, cellSize)).toBe('1:1');
    expect(buildWarMapClusterCellKey(4.9, 4.9, bbox, cellSize)).toBe('2:2');
    expect(buildWarMapClusterCellKey(19.99, 19.99, bbox, cellSize)).toBe('3:3');
  });

  it('keeps single members separate and preserves cluster members', () => {
    const points = [
      { id: 'a', lat: 11, lng: 11 },
      { id: 'b', lat: 11.2, lng: 11.4 },
      { id: 'c', lat: 39, lng: 39 },
    ] satisfies WarMapClusterablePoint[];

    const result = clusterWarMapPoints(points, {
      bbox: DEFAULT_WAR_MAP_BBOX,
      zoom: 2,
    });

    expect(result.singles).toEqual([{ id: 'c', lat: 39, lng: 39 }]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({
      cellKey: '15:8',
      count: 2,
      members: [
        { id: 'a', lat: 11, lng: 11 },
        { id: 'b', lat: 11.2, lng: 11.4 },
      ],
    });
  });

  it('sorts event members by severity, freshness, then score', () => {
    const members: TestEvent[] = [
      {
        id: 'low-new',
        lat: 0,
        lng: 0,
        severity: 'low',
        latestAt: '2026-03-10T09:00:00.000Z',
        derivedScore: 9,
        name: 'Low Fresh',
      },
      {
        id: 'high-old',
        lat: 0,
        lng: 0,
        severity: 'high',
        latestAt: '2026-03-09T09:00:00.000Z',
        derivedScore: 1,
        name: 'High Old',
      },
      {
        id: 'high-new',
        lat: 0,
        lng: 0,
        severity: 'high',
        latestAt: '2026-03-11T09:00:00.000Z',
        derivedScore: 4,
        name: 'High New',
      },
    ];

    expect(sortWarMapEventClusterMembers(members).map((member) => member.id)).toEqual([
      'high-new',
      'high-old',
      'low-new',
    ]);
  });

  it('sorts news members by published time with ingest fallback', () => {
    const members: TestNews[] = [
      {
        id: 'fallback-new',
        lat: 0,
        lng: 0,
        title: 'Fallback New',
        location: 'A',
        ingestedAt: '2026-03-11T10:00:00.000Z',
      },
      {
        id: 'published-mid',
        lat: 0,
        lng: 0,
        title: 'Published Mid',
        location: 'B',
        publishedAt: '2026-03-11T09:00:00.000Z',
      },
      {
        id: 'published-old',
        lat: 0,
        lng: 0,
        title: 'Published Old',
        location: 'C',
        publishedAt: '2026-03-10T09:00:00.000Z',
      },
    ];

    expect(sortWarMapNewsClusterMembers(members).map((member) => member.id)).toEqual([
      'fallback-new',
      'published-mid',
      'published-old',
    ]);
  });

  it('supports weighted cluster geometry for event-like points', () => {
    const members: TestEvent[] = [
      {
        id: 'low',
        lat: 10,
        lng: 10,
        severity: 'low',
        latestAt: '2026-03-10T09:00:00.000Z',
        derivedScore: 1,
        name: 'Low',
      },
      {
        id: 'high',
        lat: 20,
        lng: 20,
        severity: 'high',
        latestAt: '2026-03-11T09:00:00.000Z',
        derivedScore: 3,
        name: 'High',
      },
    ];

    expect(
      computeWeightedClusterGeometry(members, (member) => member.derivedScore ?? 1),
    ).toEqual({
      lat: 17.5,
      lng: 17.5,
    });
  });
});
