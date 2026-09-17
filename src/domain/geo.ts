import type { GeoBounds } from "./model.js";

/** 经度差，处理 ±180° 经线环绕。 */
function deltaLng(lng1: number, lng2: number): number {
  let d = lng1 - lng2;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointWithinBounds(
  lng: number,
  lat: number,
  bounds: GeoBounds,
): boolean {
  if (bounds.type === "bbox") {
    const [minLng, minLat, maxLng, maxLat] = bounds.bbox;
    if (lat < minLat || lat > maxLat) return false;
    // 支持跨 180° 经线的包围盒（minLng > maxLng）。
    const d = deltaLng(lng, minLng);
    const width = ((maxLng - minLng + 360) % 360) || 360;
    return d >= 0 && d <= width;
  }
  const [outer, ...holes] = bounds.coordinates;
  if (!outer || !pointInRing(lng, lat, outer)) return false;
  return !holes.some((hole) => pointInRing(lng, lat, hole));
}

export function isValidLngLat(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}
