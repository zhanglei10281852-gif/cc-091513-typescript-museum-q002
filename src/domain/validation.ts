import { invalidInput } from "./errors.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput("invalid_field", `字段 ${field} 必须是非空字符串`, {
      field,
    });
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalidInput("invalid_field", `字段 ${field} 必须是字符串`, { field });
  }
  return value;
}

export function requirePositiveInt(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw invalidInput("invalid_field", `字段 ${field} 必须是正整数`, {
      field,
    });
  }
  return value;
}

export function requireNumber(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput("invalid_field", `字段 ${field} 必须是数字`, { field });
  }
  return value;
}

export function requireIsoTime(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requireString(body, field);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw invalidInput("invalid_field", `字段 ${field} 必须是 ISO 8601 时间`, {
      field,
    });
  }
  return new Date(ms).toISOString();
}

export function optionalIsoTime(
  body: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw invalidInput("invalid_field", `字段 ${field} 必须是 ISO 8601 时间`, {
      field,
    });
  }
  return new Date(Date.parse(value)).toISOString();
}

export function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(body, field);
  if (!allowed.includes(value as T)) {
    throw invalidInput("invalid_field", `字段 ${field} 取值非法`, {
      field,
      allowed,
    });
  }
  return value as T;
}

export function requireStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw invalidInput("invalid_field", `字段 ${field} 必须是字符串数组`, {
      field,
    });
  }
  return value as string[];
}
