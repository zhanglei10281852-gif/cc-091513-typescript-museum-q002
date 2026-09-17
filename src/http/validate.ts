import type { CustodyParty, GeoBoundary, GeoPoint, SpeciesScopeEntry } from "../domain/types.js";
import { CUSTODY_PARTY_TYPES } from "../domain/types.js";
import { AppError } from "../errors.js";

/** HTTP 请求体 → 领域输入的校验与转换，全部失败都以 400 回应 */

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw AppError.validation("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

export function reqString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.validation(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

export function optString(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw AppError.validation(`字段 ${field} 必须是非空字符串`);
  }
  return value;
}

export function reqInt(obj: Record<string, unknown>, field: string, min = 1): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw AppError.validation(`字段 ${field} 必须是不小于 ${min} 的整数`);
  }
  return value;
}

export function reqEnum<T extends string>(obj: Record<string, unknown>, field: string, values: readonly T[]): T {
  const value = obj[field];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw AppError.validation(`字段 ${field} 必须是 ${values.join(" / ")} 之一`);
  }
  return value as T;
}

export function reqStringArray(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw AppError.validation(`字段 ${field} 必须是非空字符串数组`);
  }
  return value as string[];
}

export function reqIsoDate(obj: Record<string, unknown>, field: string): string {
  const value = reqString(obj, field);
  if (Number.isNaN(Date.parse(value))) {
    throw AppError.validation(`字段 ${field} 不是合法时间: ${value}`);
  }
  return value;
}

function reqNumber(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw AppError.validation(`字段 ${field} 必须是数字`);
  }
  return value;
}

export function reqGeoPoint(obj: Record<string, unknown>, field: string): GeoPoint {
  const raw = obj[field];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.validation(`字段 ${field} 必须是坐标对象`);
  }
  const point = raw as Record<string, unknown>;
  const lat = reqNumber(point, "lat");
  const lon = reqNumber(point, "lon");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw AppError.validation(`字段 ${field} 的经纬度超出范围`);
  }
  const result: GeoPoint = { lat, lon };
  const accuracy = point["accuracyM"];
  if (accuracy !== undefined) {
    if (typeof accuracy !== "number" || !(accuracy >= 0)) {
      throw AppError.validation(`字段 ${field}.accuracyM 必须是非负数字`);
    }
    result.accuracyM = accuracy;
  }
  return result;
}

export function reqBoundary(obj: Record<string, unknown>, field: string): GeoBoundary {
  const raw = obj[field];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.validation(`字段 ${field} 必须是边界对象`);
  }
  const boundary = raw as Record<string, unknown>;
  if (boundary["type"] === "bbox") {
    return {
      type: "bbox",
      minLat: reqNumber(boundary, "minLat"),
      maxLat: reqNumber(boundary, "maxLat"),
      minLon: reqNumber(boundary, "minLon"),
      maxLon: reqNumber(boundary, "maxLon"),
    };
  }
  if (boundary["type"] === "polygon") {
    const vertices = boundary["vertices"];
    if (!Array.isArray(vertices)) {
      throw AppError.validation(`字段 ${field}.vertices 必须是坐标数组`);
    }
    return {
      type: "polygon",
      vertices: vertices.map((v) => reqGeoPoint({ v }, "v")),
    };
  }
  throw AppError.validation(`字段 ${field}.type 必须是 bbox 或 polygon`);
}

export function reqSpeciesScope(obj: Record<string, unknown>, field: string): SpeciesScopeEntry[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw AppError.validation(`字段 ${field} 必须是非空数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw AppError.validation(`字段 ${field}[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    const quota = entry["quota"];
    if (typeof quota !== "number" || !Number.isInteger(quota) || quota < 0) {
      throw AppError.validation(`字段 ${field}[${index}].quota 必须是非负整数`);
    }
    const sensitive = entry["sensitive"];
    if (sensitive !== undefined && typeof sensitive !== "boolean") {
      throw AppError.validation(`字段 ${field}[${index}].sensitive 必须是布尔值`);
    }
    return { taxon: reqString(entry, "taxon"), quota, sensitive: sensitive === true };
  });
}

export function reqCustodyParty(obj: Record<string, unknown>, field: string): CustodyParty {
  const raw = obj[field];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw AppError.validation(`字段 ${field} 必须是交接方对象`);
  }
  const party = raw as Record<string, unknown>;
  return {
    type: reqEnum(party, "type", CUSTODY_PARTY_TYPES),
    name: reqString(party, "name"),
  };
}
