export const BBOX_QUERY_MIN_ZOOM = 2.8;

export type WarMapBbox = [number, number, number, number];

function formatBbox(bbox: WarMapBbox): string {
  return bbox.map((part) => part.toFixed(5)).join(',');
}

export function buildWarMapQueryBbox(
  bbox: WarMapBbox | undefined,
  zoom: number,
): string | undefined {
  if (zoom < BBOX_QUERY_MIN_ZOOM || !bbox) {
    return undefined;
  }
  return formatBbox(bbox);
}
