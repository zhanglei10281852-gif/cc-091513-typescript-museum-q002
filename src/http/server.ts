import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ROLES, type Principal, type Role } from "../domain/types.js";
import { AppError } from "../errors.js";
import type { PermitLedger } from "../ledger/ledger.js";
import { buildChainView, toPermitView, toRecordView } from "../ledger/views.js";
import { Router, type RouteContext } from "./router.js";
import {
  asObject,
  optString,
  reqBoundary,
  reqCustodyParty,
  reqEnum,
  reqGeoPoint,
  reqInt,
  reqIsoDate,
  reqSpeciesScope,
  reqString,
  reqStringArray,
} from "./validate.js";

const STAFF: Role[] = ["registrar", "curator"];
const CURATOR: Role[] = ["curator"];
const SUBMITTERS: Role[] = ["collector", "registrar", "curator"];

const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError(413, "payload_too_large", "请求体过大");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw AppError.validation("请求体不是合法 JSON");
  }
}

function principalFrom(request: IncomingMessage): Principal {
  const actorHeader = request.headers["x-actor-id"];
  const roleHeader = request.headers["x-actor-role"];
  const role = typeof roleHeader === "string" ? roleHeader : "viewer";
  if (!(ROLES as readonly string[]).includes(role)) {
    throw AppError.validation(`未知角色: ${role}`);
  }
  const actorId = typeof actorHeader === "string" && actorHeader.trim() !== "" ? actorHeader : null;
  return { actorId, role: role as Role };
}

/** 写接口已经过角色检查，actorId 必然存在 */
function actor(ctx: RouteContext): string {
  if (ctx.principal.actorId === null) throw AppError.unauthenticated();
  return ctx.principal.actorId;
}

export function buildServer(ledger: PermitLedger, healthPayload: unknown): Server {
  const router = new Router();

  router.add("GET", "/health", null, () => ({ status: 200, body: healthPayload }));

  // ------------------------------------------------------------------ 许可证
  router.add("POST", "/permits", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const permit = await ledger.createPermit(
      {
        title: reqString(obj, "title"),
        permitNumber: reqString(obj, "permitNumber"),
        teamIds: reqStringArray(obj, "teamIds"),
        speciesScope: reqSpeciesScope(obj, "speciesScope"),
        boundary: reqBoundary(obj, "boundary"),
        validFrom: reqIsoDate(obj, "validFrom"),
        validTo: reqIsoDate(obj, "validTo"),
        note: optString(obj, "note"),
      },
      actor(ctx),
    );
    return { status: 201, body: { permit: toPermitView(permit, ledger.now()) } };
  });

  router.add("GET", "/permits", null, () => ({
    status: 200,
    body: { permits: ledger.listPermits().map((p) => toPermitView(p, ledger.now())) },
  }));

  router.add("GET", "/permits/:permitId", null, (ctx) => ({
    status: 200,
    body: { permit: toPermitView(ledger.getPermit(ctx.params["permitId"] ?? ""), ledger.now()) },
  }));

  router.add("POST", "/permits/:permitId/activate", STAFF, async (ctx) => ({
    status: 200,
    body: { permit: toPermitView(await ledger.activatePermit(ctx.params["permitId"] ?? "", actor(ctx)), ledger.now()) },
  }));

  router.add("POST", "/permits/:permitId/suspend", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const permit = await ledger.suspendPermit(ctx.params["permitId"] ?? "", optString(obj, "reason") ?? null, actor(ctx));
    return { status: 200, body: { permit: toPermitView(permit, ledger.now()) } };
  });

  router.add("POST", "/permits/:permitId/resume", STAFF, async (ctx) => ({
    status: 200,
    body: { permit: toPermitView(await ledger.resumePermit(ctx.params["permitId"] ?? "", actor(ctx)), ledger.now()) },
  }));

  router.add("POST", "/permits/:permitId/amend", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const permit = await ledger.amendPermit(
      ctx.params["permitId"] ?? "",
      {
        permitNumber: optString(obj, "permitNumber"),
        speciesScope: obj["speciesScope"] === undefined ? undefined : reqSpeciesScope(obj, "speciesScope"),
        boundary: obj["boundary"] === undefined ? undefined : reqBoundary(obj, "boundary"),
        validFrom: obj["validFrom"] === undefined ? undefined : reqIsoDate(obj, "validFrom"),
        validTo: obj["validTo"] === undefined ? undefined : reqIsoDate(obj, "validTo"),
        note: optString(obj, "note"),
      },
      actor(ctx),
    );
    return { status: 200, body: { permit: toPermitView(permit, ledger.now()) } };
  });

  router.add("POST", "/permits/:permitId/revoke", CURATOR, async (ctx) => {
    const obj = asObject(ctx.body);
    const permit = await ledger.revokePermit(ctx.params["permitId"] ?? "", reqString(obj, "reason"), actor(ctx));
    return { status: 200, body: { permit: toPermitView(permit, ledger.now()) } };
  });

  router.add("GET", "/permits/:permitId/quota", null, (ctx) => ({
    status: 200,
    body: ledger.quotaReport(ctx.params["permitId"] ?? ""),
  }));

  router.add("GET", "/permits/:permitId/explain", null, (ctx) => {
    const explanation = ledger.permitExplanation(ctx.params["permitId"] ?? "");
    return {
      status: 200,
      body: {
        ...explanation,
        permit: toPermitView(explanation.permit, ledger.now()),
        records: explanation.records.map((r) => toRecordView(ledger.state, r, ctx.principal)),
      },
    };
  });

  // ------------------------------------------------------------------ 采集记录
  router.add("POST", "/records", SUBMITTERS, async (ctx) => {
    const obj = asObject(ctx.body);
    const result = await ledger.submitRecord(
      {
        deviceId: reqString(obj, "deviceId"),
        deviceEventNo: reqString(obj, "deviceEventNo"),
        permitNumber: reqString(obj, "permitNumber"),
        teamId: reqString(obj, "teamId"),
        collectorId: reqString(obj, "collectorId"),
        kind: reqEnum(obj, "kind", ["observed", "collected"] as const),
        taxon: reqString(obj, "taxon"),
        quantity: reqInt(obj, "quantity"),
        occurredAt: reqIsoDate(obj, "occurredAt"),
        location: reqGeoPoint(obj, "location"),
        fieldTag: optString(obj, "fieldTag"),
      },
      actor(ctx),
    );
    return {
      status: result.replay ? 200 : 201,
      body: {
        record: toRecordView(ledger.state, result.record, ctx.principal),
        quarantineCase: result.quarantineCase,
        duplicateGroup: result.duplicateGroup,
        idempotentReplay: result.replay,
      },
    };
  });

  router.add("GET", "/records", null, (ctx) => {
    const records = ledger.listRecords({
      permitId: ctx.query.get("permitId") ?? undefined,
      teamId: ctx.query.get("teamId") ?? undefined,
      status: ctx.query.get("status") ?? undefined,
      taxon: ctx.query.get("taxon") ?? undefined,
    });
    return { status: 200, body: { records: records.map((r) => toRecordView(ledger.state, r, ctx.principal)) } };
  });

  router.add("GET", "/records/:recordId", null, (ctx) => ({
    status: 200,
    body: { record: toRecordView(ledger.state, ledger.getRecord(ctx.params["recordId"] ?? ""), ctx.principal) },
  }));

  router.add("GET", "/records/:recordId/chain", null, (ctx) => ({
    status: 200,
    body: buildChainView(ledger.state, ledger.getRecord(ctx.params["recordId"] ?? ""), ctx.principal),
  }));

  router.add("POST", "/records/:recordId/photos", SUBMITTERS, async (ctx) => {
    const obj = asObject(ctx.body);
    const photo = await ledger.attachPhoto(
      ctx.params["recordId"] ?? "",
      { sha256: reqString(obj, "sha256"), takenAt: reqIsoDate(obj, "takenAt"), caption: optString(obj, "caption") },
      actor(ctx),
    );
    return { status: 201, body: { photo } };
  });

  router.add("POST", "/records/:recordId/custody", SUBMITTERS, async (ctx) => {
    const obj = asObject(ctx.body);
    const handoff = await ledger.recordCustody(
      ctx.params["recordId"] ?? "",
      {
        fromParty: reqCustodyParty(obj, "fromParty"),
        toParty: reqCustodyParty(obj, "toParty"),
        handedAt: reqIsoDate(obj, "handedAt"),
        receivedAt: obj["receivedAt"] === undefined ? undefined : reqIsoDate(obj, "receivedAt"),
        conditionNote: optString(obj, "conditionNote"),
      },
      actor(ctx),
    );
    return { status: 201, body: { handoff } };
  });

  router.add("POST", "/records/:recordId/release", SUBMITTERS, async (ctx) => {
    const obj = asObject(ctx.body);
    const record = await ledger.releaseRecord(
      ctx.params["recordId"] ?? "",
      {
        releasedAt: obj["releasedAt"] === undefined ? undefined : reqIsoDate(obj, "releasedAt"),
        reason: optString(obj, "reason"),
      },
      actor(ctx),
    );
    return { status: 200, body: { record: toRecordView(ledger.state, record, ctx.principal) } };
  });

  // ------------------------------------------------------------------ 隔离复核
  router.add("GET", "/quarantine", null, (ctx) => {
    const status = ctx.query.get("status") ?? "open";
    if (status !== "open" && status !== "resolved" && status !== "all") {
      throw AppError.validation("status 必须是 open / resolved / all 之一");
    }
    return { status: 200, body: { quarantineCases: ledger.listQuarantineCases(status) } };
  });

  router.add("POST", "/quarantine/:caseId/resolve", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const qc = await ledger.resolveQuarantine(
      ctx.params["caseId"] ?? "",
      { decision: reqEnum(obj, "decision", ["accept", "reject"] as const), rationale: reqString(obj, "rationale") },
      actor(ctx),
    );
    return { status: 200, body: { quarantineCase: qc } };
  });

  // ------------------------------------------------------------------ 重复候选
  router.add("GET", "/duplicates", null, (ctx) => {
    const status = ctx.query.get("status") ?? "open";
    if (status !== "open" && status !== "resolved" && status !== "all") {
      throw AppError.validation("status 必须是 open / resolved / all 之一");
    }
    return { status: 200, body: { duplicateGroups: ledger.listDuplicateGroups(status) } };
  });

  router.add("POST", "/duplicates/:groupId/resolve", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const outcome = reqEnum(obj, "outcome", ["merge", "distinct"] as const);
    const rationale = reqString(obj, "rationale");
    const group =
      outcome === "merge"
        ? await ledger.resolveDuplicate(
            ctx.params["groupId"] ?? "",
            { outcome: "merge", canonicalRecordId: reqString(obj, "canonicalRecordId"), rationale },
            actor(ctx),
          )
        : await ledger.resolveDuplicate(ctx.params["groupId"] ?? "", { outcome: "distinct", rationale }, actor(ctx));
    return { status: 200, body: { duplicateGroup: group } };
  });

  // ------------------------------------------------------------------ 入馆批次
  router.add("POST", "/accession-batches", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const batch = await ledger.createAccessionBatch({ title: reqString(obj, "title") }, actor(ctx));
    return { status: 201, body: { batch } };
  });

  router.add("GET", "/accession-batches/:batchId", null, (ctx) => ({
    status: 200,
    body: { batch: ledger.getAccessionBatch(ctx.params["batchId"] ?? "") },
  }));

  router.add("POST", "/accession-batches/:batchId/items", STAFF, async (ctx) => {
    const obj = asObject(ctx.body);
    const batch = await ledger.addAccessionItem(ctx.params["batchId"] ?? "", reqString(obj, "recordId"), actor(ctx));
    return { status: 200, body: { batch } };
  });

  router.add("POST", "/accession-batches/:batchId/close", STAFF, async (ctx) => ({
    status: 200,
    body: { batch: await ledger.closeAccessionBatch(ctx.params["batchId"] ?? "", actor(ctx)) },
  }));

  // ------------------------------------------------------------------ 考察队与授权
  router.add("GET", "/teams/:teamId/explain", null, (ctx) => ({
    status: 200,
    body: ledger.teamExplanation(ctx.params["teamId"] ?? ""),
  }));

  router.add("POST", "/sensitive-access-grants", CURATOR, async (ctx) => {
    const obj = asObject(ctx.body);
    const grant = await ledger.grantSensitiveAccess(
      { researcherId: reqString(obj, "researcherId"), permitId: optString(obj, "permitId") ?? null },
      actor(ctx),
    );
    return { status: 201, body: { grant } };
  });

  router.add("GET", "/sensitive-access-grants", STAFF, () => ({
    status: 200,
    body: { grants: ledger.state.sensitiveGrants },
  }));

  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const principal = principalFrom(request);
      const matched = router.match(method, url.pathname);
      if (!matched) {
        sendJson(response, 404, { error: "not_found", message: "接口不存在" });
        return;
      }
      const { route, params } = matched;
      if (route.roles !== null) {
        if (principal.actorId === null) throw AppError.unauthenticated();
        if (!route.roles.includes(principal.role)) throw AppError.forbidden();
      }
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? await readJsonBody(request) : undefined;
      const result = await route.handler({ params, query: url.searchParams, body, principal });
      sendJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(response, error.status, { error: error.code, message: error.message, details: error.details });
      } else {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        sendJson(response, 500, { error: "internal", message: "服务内部错误" });
      }
    }
  });
}
