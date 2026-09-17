import type { IncomingMessage, ServerResponse } from "node:http";

import { DomainError } from "../domain/errors.js";
import type {
  LedgerService,
  SubmitFieldInput,
} from "../domain/service.js";
import {
  isObject,
  optionalString,
  requireEnum,
  requireIsoTime,
  requireNumber,
  requirePositiveInt,
  requireString,
  requireStringArray,
} from "../domain/validation.js";
import { CUSTODY_TYPES } from "../domain/model.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly service: LedgerService) {}

  add(method: string, path: string, handler: Handler): void {
    const paramNames: string[] = [];
    const source = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${source}$`),
      paramNames,
      handler,
    });
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = this.routes.find(
      (r) =>
        r.method === request.method && r.pattern.test(url.pathname),
    );
    if (!route) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const match = url.pathname.match(route.pattern);
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match![index + 1]!);
    });

    let body: unknown;
    if (request.method === "POST" || request.method === "PUT") {
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : "bad body";
        sendJson(response, 400, { error: "invalid_json", message });
        return;
      }
    }

    try {
      await route.handler(request, response, params, body);
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.statusCode, {
          error: error.code,
          message: error.message,
          details: error.details,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`unhandled error: ${message}\n`);
      sendJson(response, 500, { error: "internal_error" });
    }
  }

  // 路由注册与各端点处理。
  register(): void {
    const s = this.service;

    // ---------- 基础档案 ----------
    this.add("PUT", "/taxa/:code", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(res, 200,
        s.upsertTaxon({
          code: params.code!,
          name: requireString(b, "name"),
          sensitive: b.sensitive === true,
        }),
      );
    });

    this.add("PUT", "/researchers/:id", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(res, 200,
        s.upsertResearcher({
          id: params.id!,
          name: requireString(b, "name"),
          sensitiveTaxa: b.sensitiveTaxa
            ? requireStringArray(b, "sensitiveTaxa")
            : undefined,
        }),
      );
    });

    this.add("PUT", "/expeditions/:id", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(res, 200,
        s.upsertExpedition({
          id: params.id!,
          name: requireString(b, "name"),
          teamIds: b.teamIds ? requireStringArray(b, "teamIds") : undefined,
        }),
      );
    });

    // ---------- 许可证 ----------
    this.add("POST", "/permits", (_req, res, _params, body) => {
      const b = asObject(body);
      const quotaRaw = b.quotaLimits;
      if (!isObject(quotaRaw)) {
        throw new DomainError("invalid_field", "quotaLimits 必须是对象", 400);
      }
      const quotaLimits: Record<string, number> = {};
      for (const [key, value] of Object.entries(quotaRaw)) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new DomainError(
            "invalid_field",
            `物种 ${key} 配额必须是非负整数`,
            400,
          );
        }
        quotaLimits[key] = value;
      }
      sendJson(
        res,
        201,
        s.createPermit({
          permitNumber: requireString(b, "permitNumber"),
          aliases: b.aliases ? requireStringArray(b, "aliases") : undefined,
          speciesCodes: requireStringArray(b, "speciesCodes"),
          bounds: requireBounds(b),
          validFrom: requireIsoTime(b, "validFrom"),
          validUntil: requireIsoTime(b, "validUntil"),
          quotaLimits,
        }),
      );
    });

    this.add("POST", "/permits/:ref/aliases", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(res, 200, s.addPermitAlias(params.ref!, requireString(b, "alias")));
    });

    this.add("POST", "/permits/:ref/state", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        200,
        s.changePermitState(
          params.ref!,
          requireEnum(b, "state", ["draft", "active", "suspended", "expired", "revoked"]),
          optionalString(b, "reason"),
          b.at ? requireIsoTime(b, "at") : undefined,
        ),
      );
    });

    this.add("GET", "/permits/:ref", (req, res, params) => {
      sendJson(res, 200, s.explainPermit(params.ref!));
    });

    this.add("GET", "/permits/:ref/records", (req, res, params) => {
      const url = urlOf(req);
      sendJson(
        res,
        200,
        s.listRecords({
          permitRef: params.ref,
          status: optionalStatus(url),
          viewerResearcherId: url.searchParams.get("viewer") ?? undefined,
        }),
      );
    });

    // ---------- 现场记录 ----------
    this.add("POST", "/records", (_req, res, _params, body) => {
      const b = asObject(body);
      const photosRaw = b.photos;
      let photos: SubmitFieldInput["photos"] | undefined;
      if (photosRaw !== undefined) {
        if (!Array.isArray(photosRaw)) {
          throw new DomainError("invalid_field", "photos 必须是数组", 400);
        }
        photos = photosRaw.map((p) => {
          if (!isObject(p)) {
            throw new DomainError("invalid_field", "照片必须是对象", 400);
          }
          return {
            sha256: requireString(p, "sha256"),
            takenAt: requireIsoTime(p, "takenAt"),
            lng: p.lng === undefined ? undefined : requireNumber(p, "lng"),
            lat: p.lat === undefined ? undefined : requireNumber(p, "lat"),
            caption: optionalString(p, "caption"),
          };
        });
      }
      const result = s.submitFieldRecord({
        deviceEventId: requireString(b, "deviceEventId"),
        expeditionId: requireString(b, "expeditionId"),
        teamId: requireString(b, "teamId"),
        permitNumber: requireString(b, "permitNumber"),
        speciesCode: requireString(b, "speciesCode"),
        quantity: requirePositiveInt(b, "quantity"),
        lng: requireNumber(b, "lng"),
        lat: requireNumber(b, "lat"),
        occurredAt: requireIsoTime(b, "occurredAt"),
        collectorId: requireString(b, "collectorId"),
        eventType: requireEnum(b, "eventType", ["observed", "collected"]),
        photos,
      });
      // 幂等补传返回 200，新记录返回 201。
      sendJson(res, result.idempotent ? 200 : 201, result.record);
    });

    this.add("GET", "/records", (req, res) => {
      const url = urlOf(req);
      sendJson(
        res,
        200,
        s.listRecords({
          permitRef: url.searchParams.get("permit") ?? undefined,
          expeditionId: url.searchParams.get("expedition") ?? undefined,
          status: optionalStatus(url),
          viewerResearcherId: url.searchParams.get("viewer") ?? undefined,
        }),
      );
    });

    this.add("GET", "/records/:id", (req, res, params) => {
      const url = urlOf(req);
      sendJson(
        res,
        200,
        s.explainRecord(
          params.id!,
          url.searchParams.get("viewer") ?? undefined,
        ),
      );
    });

    this.add("POST", "/records/:id/release", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        200,
        s.releaseSpecimen(params.id!, {
          handlerId: requireString(b, "handlerId"),
          at: b.at ? requireIsoTime(b, "at") : undefined,
          note: optionalString(b, "note"),
        }),
      );
    });

    this.add("POST", "/records/:id/transfers", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        201,
        s.transferCustody(params.id!, {
          at: requireIsoTime(b, "at"),
          toType: requireEnum(b, "toType", CUSTODY_TYPES),
          toParty: requireString(b, "toParty"),
          handlerId: requireString(b, "handlerId"),
          note: optionalString(b, "note"),
        }),
      );
    });

    // ---------- 配额预占 ----------
    this.add("POST", "/reservations", (_req, res, _params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        201,
        s.reserveQuota({
          permitRef: requireString(b, "permitRef"),
          speciesCode: requireString(b, "speciesCode"),
          teamId: requireString(b, "teamId"),
          quantity: requirePositiveInt(b, "quantity"),
          note: optionalString(b, "note"),
        }),
      );
    });

    this.add("POST", "/reservations/:id/release", (_req, res, params) => {
      sendJson(res, 200, s.releaseReservation(params.id!));
    });

    // ---------- 复核 ----------
    this.add("GET", "/quarantine", (req, res) => {
      const url = urlOf(req);
      sendJson(
        res,
        200,
        s.listQuarantineCases(url.searchParams.get("open") === "true"),
      );
    });

    this.add("POST", "/quarantine/:id/resolve", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        200,
        s.resolveQuarantine(params.id!, {
          decision: requireEnum(b, "decision", ["admitted", "rejected"] as const),
          reviewerId: requireString(b, "reviewerId"),
          note: optionalString(b, "note"),
        }),
      );
    });

    this.add("GET", "/duplicates", (req, res) => {
      const url = urlOf(req);
      const status = url.searchParams.get("status");
      sendJson(
        res,
        200,
        s.listDuplicateCandidates(
          status === "pending" || status === "resolved" ? status : undefined,
        ),
      );
    });

    this.add("POST", "/duplicates/:id/resolve", (_req, res, params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        200,
        s.resolveDuplicate(params.id!, {
          conclusion: requireEnum(b, "conclusion", ["distinct", "duplicate"] as const),
          reviewerId: requireString(b, "reviewerId"),
          primaryRecordId: optionalString(b, "primaryRecordId"),
          note: optionalString(b, "note"),
        }),
      );
    });

    // ---------- 入馆 ----------
    this.add("POST", "/accessions", (_req, res, _params, body) => {
      const b = asObject(body);
      sendJson(
        res,
        201,
        s.accessionBatch({
          recordIds: requireStringArray(b, "recordIds"),
          handlerId: requireString(b, "handlerId"),
          at: b.at ? requireIsoTime(b, "at") : undefined,
          note: optionalString(b, "note"),
        }),
      );
    });

    this.add("GET", "/expeditions/:id", (_req, res, params) => {
      sendJson(res, 200, s.explainExpedition(params.id!));
    });
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) {
    throw new DomainError("invalid_json", "请求体必须是 JSON 对象", 400);
  }
  return body;
}

function requireBounds(b: Record<string, unknown>) {
  const raw = b.bounds;
  if (!isObject(raw) || typeof raw.type !== "string") {
    throw new DomainError("invalid_field", "bounds 非法", 400);
  }
  if (raw.type === "bbox") {
    if (!Array.isArray(raw.bbox) || raw.bbox.length !== 4 ||
        !raw.bbox.every((v) => typeof v === "number")) {
      throw new DomainError("invalid_field", "bounds.bbox 必须是 4 个数字", 400);
    }
    return { type: "bbox" as const, bbox: raw.bbox as [number, number, number, number] };
  }
  if (raw.type === "polygon") {
    if (
      !Array.isArray(raw.coordinates) ||
      raw.coordinates.some(
        (ring) =>
          !Array.isArray(ring) ||
          ring.some(
            (point) =>
              !Array.isArray(point) ||
              point.length < 2 ||
              typeof point[0] !== "number" ||
              typeof point[1] !== "number",
          ),
      )
    ) {
      throw new DomainError("invalid_field", "bounds.coordinates 非法", 400);
    }
    return {
      type: "polygon" as const,
      coordinates: raw.coordinates as number[][][],
    };
  }
  throw new DomainError("invalid_field", "bounds.type 非法", 400);
}

function optionalStatus(url: URL): Parameters<LedgerService["listRecords"]>[0]["status"] {
  const value = url.searchParams.get("status");
  const allowed = [
    "accepted",
    "quarantined",
    "duplicate_review",
    "merged",
    "rejected",
    "released",
    "accessioned",
  ] as const;
  if (!value) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new DomainError("invalid_field", "status 取值非法", 400);
  }
  return value as (typeof allowed)[number];
}

function urlOf(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("请求体超过 2MB 限制");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
