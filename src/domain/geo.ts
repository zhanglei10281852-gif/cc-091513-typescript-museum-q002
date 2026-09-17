import { AppError } from "../errors.js";
import type { GeoBoundary, GeoPoint } from "./types.js";

export function validateGeoPoint(point: GeoPoint): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw AppError.validation(`纬度超出范围: ${String(point.lat)}`);
  }
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw AppError.validation(`经度超出范围: ${String(point.lon)}`);
  }
}

export function validateBoundary(boundary: GeoBoundary): void {
  if (boundary.type === "bbox") {
    if (!(boundary.minLat < boundary.maxLat) || !(boundary.minLon < boundary.maxLon)) {
      throw AppError.validation("地理边界框的最小值必须小于最大值");
    }
    validateGeoPoint({ lat: boundary.minLat, lon: boundary.minLon });
    validateGeoPoint({ lat: boundary.maxLat, lon: boundary.maxLon });
    return;
  }
  if (boundary.type === "polygon") {
    if (boundary.vertices.length < 3) {
      throw AppError.validation("多边形边界至少需要 3 个顶点");
    }
    for (const vertex of boundary.vertices) {
      validateGeoPoint(vertex);
    }
    return;
  }
  throw AppError.validation("未知的地理边界类型");
}

/** 判断采集点是否落在许可证地理边界内（经纬度平面近似，适用于山区小范围）。 */
export function pointInBoundary(point: GeoPoint, boundary: GeoBoundary): boolean {
  if (boundary.type === "bbox") {
    return (
      point.lat >= boundary.minLat &&
      point.lat <= boundary.maxLat &&
      point.lon >= boundary.minLon &&
      point.lon <= boundary.maxLon
    );
  }
  // 射线法
  const vertices = boundary.vertices;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const vi = vertices[i];
    const vj = vertices[j];
    if (!vi || !vj) continue;
    const crosses =
      vi.lat > point.lat !== vj.lat > point.lat &&
      point.lon < ((vj.lon - vi.lon) * (point.lat - vi.lat)) / (vj.lat - vi.lat) + vi.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}
