import { randomUUID } from "node:crypto";

import { validateBoundary, pointInBoundary } from "../domain/geo.js";
import {
  currentPermitVersion,
  type AccessionBatch,
  type AuditEntry,
  type CollectionRecord,
  type CustodyHandoff,
  type CustodyParty,
  type DuplicateGroup,
  type GeoBoundary,
  type GeoPoint,
  type Permit,
  type PermitState,
  type PermitVersion,
  type Photo,
  type QuarantineCase,
  type QuarantineIssue,
  type QuotaMovement,
  type QuotaMovementReason,
  type RecordKind,
  type SensitiveGrant,
  type SpeciesScopeEntry,
} from "../domain/types.js";
import { AppError } from "../errors.js";
import { emptyState, MemoryStore, type LedgerState, type StateStore } from "./state.js";

// ---------------------------------------------------------------------------
// 输入与结果类型
// ---------------------------------------------------------------------------

export interface CreatePermitInput {
  title: string;
  permitNumber: string;
  teamIds: string[];
  speciesScope: SpeciesScopeEntry[];
  boundary: GeoBoundary;
  validFrom: string;
  validTo: string;
  note?: string | undefined;
}

export interface AmendPermitInput {
  permitNumber?: string | undefined;
  speciesScope?: SpeciesScopeEntry[] | undefined;
  boundary?: GeoBoundary | undefined;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  note?: string | undefined;
}

export interface SubmitRecordInput {
  deviceId: string;
  deviceEventNo: string;
  permitNumber: string;
  teamId: string;
  collectorId: string;
  kind: RecordKind;
  taxon: string;
  quantity: number;
  occurredAt: string;
  location: GeoPoint;
  fieldTag?: string | undefined;
}

export interface SubmitResult {
  record: CollectionRecord;
  quarantineCase: QuarantineCase | null;
  duplicateGroup: DuplicateGroup | null;
  /** true 表示设备事件号命中既有记录，本次为幂等回放，未产生新账 */
  replay: boolean;
}

export interface PhotoInput {
  sha256: string;
  takenAt: string;
  caption?: string | undefined;
}

export interface CustodyInput {
  fromParty: CustodyParty;
  toParty: CustodyParty;
  handedAt: string;
  receivedAt?: string | undefined;
  conditionNote?: string | undefined;
}

export interface ReleaseInput {
  releasedAt?: string | undefined;
  reason?: string | undefined;
}

export interface ResolveQuarantineInput {
  decision: "accept" | "reject";
  rationale: string;
}

export type ResolveDuplicateInput =
  | { outcome: "merge"; canonicalRecordId: string; rationale: string }
  | { outcome: "distinct"; rationale: string };

export interface QuotaSpeciesReport {
  taxon: string;
  inScope: boolean;
  sensitive: boolean;
  /** null 表示该物种已不在当前版本范围内（历史流水仍保留） */
  limit: number | null;
  held: number;
  confirmed: number;
  released: number;
  remaining: number | null;
  movements: QuotaMovement[];
}

export interface QuotaReport {
  permitId: string;
  generatedAt: string;
  species: QuotaSpeciesReport[];
}

export interface PermitExplanation {
  permit: Permit;
  effectiveState: PermitState;
  quota: QuotaReport;
  records: CollectionRecord[];
  quarantineCases: QuarantineCase[];
  duplicateGroups: DuplicateGroup[];
  audit: AuditEntry[];
}

export interface TeamExplanation {
  teamId: string;
  records: CollectionRecord[];
  quotaMovements: QuotaMovement[];
  quotaByPermit: {
    permitId: string;
    taxon: string;
    held: number;
    confirmed: number;
    released: number;
  }[];
  openQuarantineCases: QuarantineCase[];
  openDuplicateGroups: DuplicateGroup[];
}

export interface LedgerOptions {
  state?: LedgerState | undefined;
  store?: StateStore | undefined;
  now?: (() => Date) | undefined;
}

type QuotaStage = "none" | "held" | "confirmed" | "released";

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function validatePermitRules(
  speciesScope: SpeciesScopeEntry[],
  boundary: GeoBoundary,
  validFrom: string,
  validTo: string,
): void {
  if (speciesScope.length === 0) {
    throw AppError.validation("许可证物种范围不能为空");
  }
  const seen = new Set<string>();
  for (const entry of speciesScope) {
    if (seen.has(entry.taxon)) {
      throw AppError.validation(`物种范围内存在重复条目: ${entry.taxon}`);
    }
    seen.add(entry.taxon);
    if (!Number.isInteger(entry.quota) || entry.quota < 0) {
      throw AppError.validation(`物种 ${entry.taxon} 的配额必须是非负整数`);
    }
  }
  validateBoundary(boundary);
  const from = Date.parse(validFrom);
  const to = Date.parse(validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw AppError.validation("许可证有效期不是合法时间");
  }
  if (from >= to) {
    throw AppError.validation("许可证有效期起点必须早于终点");
  }
}

/**
 * 许可账册核心。
 *
 * 并发模型：所有变更先在内存状态上同步完成（Node 单线程，检查与落账之间
 * 没有 await，构成天然临界区），随后再异步持久化快照。因此多队伍同时提交
 * 采集记录时，配额检查与占用是原子的，不会超采。
 */
export class PermitLedger {
  /** 只读访问；外部不得直接修改 */
  readonly state: LedgerState;
  private readonly store: StateStore;
  private readonly nowFn: () => Date;

  constructor(options: LedgerOptions = {}) {
    this.state = options.state ?? emptyState();
    this.store = options.store ?? new MemoryStore();
    this.nowFn = options.now ?? (() => new Date());
  }

  now(): Date {
    return this.nowFn();
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  private async persist(): Promise<void> {
    await this.store.save(this.state);
  }

  private audit(
    action: string,
    entityType: string,
    entityId: string,
    actorId: string,
    summary: string,
    refs: { permitId?: string | null; teamId?: string | null } = {},
  ): void {
    this.state.auditLog.push({
      seq: this.state.auditLog.length + 1,
      at: this.nowIso(),
      actorId,
      action,
      entityType,
      entityId,
      permitId: refs.permitId ?? null,
      teamId: refs.teamId ?? null,
      summary,
    });
  }

  // -------------------------------------------------------------------------
  // 查询辅助
  // -------------------------------------------------------------------------

  getPermit(permitId: string): Permit {
    const permit = this.state.permits[permitId];
    if (!permit) throw AppError.notFound("许可证", permitId);
    return permit;
  }

  getRecord(recordId: string): CollectionRecord {
    const record = this.state.records[recordId];
    if (!record) throw AppError.notFound("采集记录", recordId);
    return record;
  }

  getQuarantineCase(caseId: string): QuarantineCase {
    const qc = this.state.quarantineCases[caseId];
    if (!qc) throw AppError.notFound("隔离单", caseId);
    return qc;
  }

  getDuplicateGroup(groupId: string): DuplicateGroup {
    const group = this.state.duplicateGroups[groupId];
    if (!group) throw AppError.notFound("重复候选组", groupId);
    return group;
  }

  getAccessionBatch(batchId: string): AccessionBatch {
    const batch = this.state.accessionBatches[batchId];
    if (!batch) throw AppError.notFound("入馆批次", batchId);
    return batch;
  }

  listPermits(): Permit[] {
    return Object.values(this.state.permits);
  }

  listRecords(filter: {
    permitId?: string | undefined;
    teamId?: string | undefined;
    status?: string | undefined;
    taxon?: string | undefined;
  }): CollectionRecord[] {
    return Object.values(this.state.records).filter(
      (record) =>
        (filter.permitId === undefined || record.permitId === filter.permitId) &&
        (filter.teamId === undefined || record.teamId === filter.teamId) &&
        (filter.status === undefined || record.status === filter.status) &&
        (filter.taxon === undefined || record.taxon === filter.taxon),
    );
  }

  listQuarantineCases(status: "open" | "resolved" | "all"): QuarantineCase[] {
    return Object.values(this.state.quarantineCases).filter((qc) => {
      if (status === "all") return true;
      if (status === "open") return qc.status === "open";
      return qc.status !== "open";
    });
  }

  listDuplicateGroups(status: "open" | "resolved" | "all"): DuplicateGroup[] {
    return Object.values(this.state.duplicateGroups).filter((group) => {
      if (status === "all") return true;
      return group.status === status;
    });
  }

  movementsForRecord(recordId: string): QuotaMovement[] {
    return this.state.quotaMovements.filter((m) => m.recordId === recordId);
  }

  /** 某记录当前的配额阶段：none → held → confirmed，或已 released */
  private recordQuotaStage(recordId: string): QuotaStage {
    let stage: QuotaStage = "none";
    for (const movement of this.state.quotaMovements) {
      if (movement.recordId !== recordId) continue;
      if (movement.kind === "hold") stage = "held";
      else if (movement.kind === "confirm") stage = "confirmed";
      else stage = "released";
    }
    return stage;
  }

  /** 折叠配额流水，得到某许可证某物种的占用 / 实占 / 累计释放 */
  private quotaUsage(permitId: string, taxon: string): {
    held: number;
    confirmed: number;
    released: number;
  } {
    let held = 0;
    let confirmed = 0;
    let released = 0;
    for (const m of this.state.quotaMovements) {
      if (m.permitId !== permitId || m.taxon !== taxon) continue;
      if (m.kind === "hold") {
        held += m.quantity;
      } else if (m.kind === "confirm") {
        held -= m.quantity;
        confirmed += m.quantity;
      } else {
        released += m.quantity;
        if (m.stage === "held") held -= m.quantity;
        else confirmed -= m.quantity;
      }
    }
    return { held, confirmed, released };
  }

  private appendMovement(input: {
    permitId: string;
    taxon: string;
    recordId: string;
    teamId: string;
    kind: QuotaMovement["kind"];
    stage: QuotaMovement["stage"];
    quantity: number;
    reason: QuotaMovementReason;
    actorId: string;
  }): QuotaMovement {
    const movement: QuotaMovement = {
      movementId: newId("mov"),
      permitId: input.permitId,
      taxon: input.taxon,
      recordId: input.recordId,
      teamId: input.teamId,
      kind: input.kind,
      stage: input.stage,
      quantity: input.quantity,
      reason: input.reason,
      at: this.nowIso(),
      actorId: input.actorId,
    };
    this.state.quotaMovements.push(movement);
    return movement;
  }

  // -------------------------------------------------------------------------
  // 许可证生命周期
  // -------------------------------------------------------------------------

  async createPermit(input: CreatePermitInput, actorId: string): Promise<Permit> {
    validatePermitRules(input.speciesScope, input.boundary, input.validFrom, input.validTo);
    if (input.teamIds.length === 0) {
      throw AppError.validation("许可证至少关联一个考察队");
    }
    if (this.state.permitNumberIndex[input.permitNumber] !== undefined) {
      throw AppError.conflict(`许可证编号已存在: ${input.permitNumber}`);
    }
    const now = this.nowIso();
    const permit: Permit = {
      permitId: newId("per"),
      title: input.title,
      teamIds: [...new Set(input.teamIds)],
      state: "draft",
      versions: [
        {
          version: 1,
          permitNumber: input.permitNumber,
          speciesScope: input.speciesScope,
          boundary: input.boundary,
          validFrom: input.validFrom,
          validTo: input.validTo,
          note: input.note ?? null,
          recordedAt: now,
          recordedBy: actorId,
        },
      ],
      currentVersion: 1,
      createdAt: now,
      createdBy: actorId,
      suspendedAt: null,
      suspendReason: null,
      revokedAt: null,
      revokeReason: null,
      revokedBy: null,
    };
    this.state.permits[permit.permitId] = permit;
    this.state.permitNumberIndex[input.permitNumber] = { permitId: permit.permitId, version: 1 };
    this.audit("permit_created", "permit", permit.permitId, actorId, `创建许可证 ${input.permitNumber}（${input.title}）`, {
      permitId: permit.permitId,
    });
    await this.persist();
    return permit;
  }

  async activatePermit(permitId: string, actorId: string): Promise<Permit> {
    const permit = this.getPermit(permitId);
    if (permit.state !== "draft") {
      throw AppError.invalidState(`仅草稿状态的许可证可生效（当前 ${permit.state}）`);
    }
    permit.state = "active";
    this.audit("permit_activated", "permit", permitId, actorId, "许可证生效", { permitId });
    await this.persist();
    return permit;
  }

  async suspendPermit(permitId: string, reason: string | null, actorId: string): Promise<Permit> {
    const permit = this.getPermit(permitId);
    if (permit.state !== "active") {
      throw AppError.invalidState(`仅生效中的许可证可暂扣（当前 ${permit.state}）`);
    }
    permit.state = "suspended";
    permit.suspendedAt = this.nowIso();
    permit.suspendReason = reason;
    this.audit("permit_suspended", "permit", permitId, actorId, `许可证暂扣${reason ? `：${reason}` : ""}`, { permitId });
    await this.persist();
    return permit;
  }

  async resumePermit(permitId: string, actorId: string): Promise<Permit> {
    const permit = this.getPermit(permitId);
    if (permit.state !== "suspended") {
      throw AppError.invalidState(`仅暂扣中的许可证可恢复（当前 ${permit.state}）`);
    }
    permit.state = "active";
    permit.suspendedAt = null;
    permit.suspendReason = null;
    this.audit("permit_resumed", "permit", permitId, actorId, "许可证恢复生效", { permitId });
    await this.persist();
    return permit;
  }

  /**
   * 修订许可证：产生新版本。旧版本（含旧编号）保留在案，
   * 引用旧编号的采集记录会被识别为陈旧引用并进入隔离复核。
   */
  async amendPermit(permitId: string, input: AmendPermitInput, actorId: string): Promise<Permit> {
    const permit = this.getPermit(permitId);
    if (permit.state === "revoked") {
      throw AppError.invalidState("已撤回的许可证不能修订");
    }
    const base = currentPermitVersion(permit);
    const next: PermitVersion = {
      version: permit.currentVersion + 1,
      permitNumber: input.permitNumber ?? base.permitNumber,
      speciesScope: input.speciesScope ?? base.speciesScope,
      boundary: input.boundary ?? base.boundary,
      validFrom: input.validFrom ?? base.validFrom,
      validTo: input.validTo ?? base.validTo,
      note: input.note ?? null,
      recordedAt: this.nowIso(),
      recordedBy: actorId,
    };
    validatePermitRules(next.speciesScope, next.boundary, next.validFrom, next.validTo);
    if (next.permitNumber !== base.permitNumber && this.state.permitNumberIndex[next.permitNumber] !== undefined) {
      throw AppError.conflict(`许可证编号已被占用: ${next.permitNumber}`);
    }
    permit.versions.push(next);
    permit.currentVersion = next.version;
    this.state.permitNumberIndex[next.permitNumber] = { permitId, version: next.version };
    this.audit("permit_amended", "permit", permitId, actorId, `修订许可证至第 ${next.version} 版（编号 ${next.permitNumber}）`, {
      permitId,
    });
    await this.persist();
    return permit;
  }

  /**
   * 撤回许可证：只阻止撤回时点之后的采集，已形成的采集记录、照片、
   * 交接与入馆数据全部保留，作为来源证据不可抹除。
   */
  async revokePermit(permitId: string, reason: string, actorId: string): Promise<Permit> {
    const permit = this.getPermit(permitId);
    if (permit.state === "revoked") {
      throw AppError.invalidState("许可证已处于撤回状态");
    }
    permit.state = "revoked";
    permit.revokedAt = this.nowIso();
    permit.revokeReason = reason;
    permit.revokedBy = actorId;
    this.audit("permit_revoked", "permit", permitId, actorId, `撤回许可证：${reason}（历史来源证据保留）`, { permitId });
    await this.persist();
    return permit;
  }

  // -------------------------------------------------------------------------
  // 采集记录
  // -------------------------------------------------------------------------

  /** 针对许可证当前版本校验采集要素（物种、边界、有效期、队伍、许可证状态） */
  private validateCollectionFields(
    permit: Permit,
    fields: { teamId: string; taxon: string; occurredAt: Date; location: GeoPoint },
  ): { issues: QuarantineIssue[]; scopeEntry: SpeciesScopeEntry | null } {
    const issues: QuarantineIssue[] = [];
    const version = currentPermitVersion(permit);

    if (!permit.teamIds.includes(fields.teamId)) {
      issues.push({
        code: "team_not_authorized",
        message: `考察队 ${fields.teamId} 不在许可证授权队伍范围内`,
        details: { teamId: fields.teamId, authorizedTeams: permit.teamIds },
      });
    }
    if (permit.state === "draft") {
      issues.push({ code: "permit_not_active", message: "许可证尚未生效（草稿）", details: null });
    } else if (permit.state === "suspended") {
      issues.push({
        code: "permit_suspended",
        message: `许可证已暂扣${permit.suspendReason ? `：${permit.suspendReason}` : ""}`,
        details: { suspendedAt: permit.suspendedAt },
      });
    } else if (permit.state === "revoked") {
      const revokedAt = permit.revokedAt ?? "";
      if (fields.occurredAt.getTime() >= Date.parse(revokedAt)) {
        issues.push({
          code: "permit_revoked",
          message: `采集时间晚于许可证撤回时间（${revokedAt}），撤回后不得继续采集`,
          details: { revokedAt },
        });
      }
    }
    const from = Date.parse(version.validFrom);
    const to = Date.parse(version.validTo);
    if (fields.occurredAt.getTime() < from || fields.occurredAt.getTime() > to) {
      issues.push({
        code: "outside_validity_period",
        message: `采集时间不在许可证有效期 ${version.validFrom} ~ ${version.validTo} 内`,
        details: { validFrom: version.validFrom, validTo: version.validTo },
      });
    }
    const scopeEntry = version.speciesScope.find((e) => e.taxon === fields.taxon) ?? null;
    if (!scopeEntry) {
      issues.push({
        code: "species_out_of_scope",
        message: `物种 ${fields.taxon} 不在许可证物种范围内`,
        details: { taxon: fields.taxon },
      });
    }
    if (!pointInBoundary(fields.location, version.boundary)) {
      issues.push({
        code: "outside_geo_boundary",
        message: "采集坐标超出许可证地理边界",
        details: { location: fields.location },
      });
    }
    return { issues, scopeEntry };
  }

  async submitRecord(input: SubmitRecordInput, actorId: string): Promise<SubmitResult> {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw AppError.validation("采集数量必须是正整数");
    }
    if (input.fieldTag !== undefined && input.quantity !== 1) {
      throw AppError.validation("野外编号仅适用于单件标本记录（quantity 必须为 1）");
    }
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw AppError.validation(`occurredAt 不是合法时间: ${input.occurredAt}`);
    }

    // 幂等：同一设备事件号直接返回既有记录；若要素不一致则提示冲突，防止设备重用事件号
    const idemKey = `${input.deviceId}#${input.deviceEventNo}`;
    const existingId = this.state.deviceEventIndex[idemKey];
    if (existingId !== undefined) {
      const existing = this.getRecord(existingId);
      const mismatch =
        existing.permitNumber !== input.permitNumber ||
        existing.taxon !== input.taxon ||
        existing.quantity !== input.quantity ||
        existing.occurredAt !== occurredAt.toISOString();
      if (mismatch) {
        throw AppError.conflict(
          `设备事件号 ${input.deviceId}#${input.deviceEventNo} 已入账，但本次提交的要素不一致`,
          { recordId: existing.recordId },
        );
      }
      return {
        record: existing,
        quarantineCase: this.latestOpenCase(existing),
        duplicateGroup: existing.duplicateGroupId
          ? this.state.duplicateGroups[existing.duplicateGroupId] ?? null
          : null,
        replay: true,
      };
    }

    const issues: QuarantineIssue[] = [];

    // 解析许可证编号：编号可能属于历史版本（合作单位沿用了旧编号）
    const numberRef = this.state.permitNumberIndex[input.permitNumber];
    const permit = numberRef !== undefined ? this.state.permits[numberRef.permitId] ?? null : null;
    let stalePermitReference = false;
    let scopeEntry: SpeciesScopeEntry | null = null;
    if (permit === null || numberRef === undefined) {
      issues.push({
        code: "unknown_permit",
        message: `许可证编号无法识别: ${input.permitNumber}`,
        details: null,
      });
    } else {
      if (numberRef.version !== permit.currentVersion) {
        stalePermitReference = true;
        issues.push({
          code: "stale_permit_reference",
          message: `编号 ${input.permitNumber} 属于许可证第 ${numberRef.version} 版，当前有效版本为第 ${permit.currentVersion} 版`,
          details: { submittedVersion: numberRef.version, currentVersion: permit.currentVersion },
        });
      }
      const checked = this.validateCollectionFields(permit, {
        teamId: input.teamId,
        taxon: input.taxon,
        occurredAt,
        location: input.location,
      });
      issues.push(...checked.issues);
      scopeEntry = checked.scopeEntry;
    }
    if (occurredAt.getTime() > this.nowFn().getTime()) {
      issues.push({
        code: "occurred_in_future",
        message: "采集时间晚于接收时间，请检查设备时钟",
        details: { occurredAt: occurredAt.toISOString() },
      });
    }

    // 配额检查（仅实际采集占用配额；observed 不占用）
    let quotaExceeded = false;
    if (permit && input.kind === "collected" && scopeEntry) {
      const usage = this.quotaUsage(permit.permitId, input.taxon);
      const remaining = scopeEntry.quota - usage.held - usage.confirmed;
      if (remaining < input.quantity) {
        quotaExceeded = true;
        issues.push({
          code: "quota_exceeded",
          message: `物种 ${input.taxon} 剩余配额 ${remaining}，不足以覆盖采集数量 ${input.quantity}`,
          details: { taxon: input.taxon, remaining, requested: input.quantity },
        });
      }
    }

    const now = this.nowIso();
    const record: CollectionRecord = {
      recordId: newId("rec"),
      deviceId: input.deviceId,
      deviceEventNo: input.deviceEventNo,
      permitId: permit?.permitId ?? null,
      permitVersion: permit ? permit.currentVersion : null,
      permitNumber: input.permitNumber,
      stalePermitReference,
      teamId: input.teamId,
      collectorId: input.collectorId,
      kind: input.kind,
      taxon: input.taxon,
      quantity: input.quantity,
      fieldTag: input.fieldTag ?? null,
      occurredAt: occurredAt.toISOString(),
      receivedAt: now,
      location: input.location,
      status: issues.length > 0 ? "quarantined" : "accepted",
      photos: [],
      custody: [],
      accessionBatchId: null,
      accessionedAt: null,
      duplicateGroupId: null,
      quarantineCaseIds: [],
      releasedAt: null,
      releaseReason: null,
      submittedBy: actorId,
    };
    this.state.records[record.recordId] = record;
    this.state.deviceEventIndex[idemKey] = record.recordId;

    // 配额占用：校验通过直接占用；进入隔离但配额检查通过时同样预占，避免复核期间被其他队伍超采
    if (permit && input.kind === "collected" && scopeEntry && !quotaExceeded) {
      this.appendMovement({
        permitId: permit.permitId,
        taxon: input.taxon,
        recordId: record.recordId,
        teamId: input.teamId,
        kind: "hold",
        stage: "held",
        quantity: input.quantity,
        reason: issues.length > 0 ? "quarantine_review" : "collection_accepted",
        actorId,
      });
    }

    let quarantineCase: QuarantineCase | null = null;
    if (issues.length > 0) {
      quarantineCase = {
        caseId: newId("qc"),
        recordId: record.recordId,
        permitId: permit?.permitId ?? null,
        issues,
        status: "open",
        openedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      };
      this.state.quarantineCases[quarantineCase.caseId] = quarantineCase;
      record.quarantineCaseIds.push(quarantineCase.caseId);
    }

    const duplicateGroup = this.flagDuplicatesIfNeeded(record);

    this.audit(
      issues.length > 0 ? "record_quarantined" : "record_submitted",
      "record",
      record.recordId,
      actorId,
      issues.length > 0
        ? `接收采集记录（${issues.length} 项疑点，进入隔离复核）`
        : `接收采集记录 ${input.taxon} ×${input.quantity}`,
      { permitId: record.permitId, teamId: record.teamId },
    );
    await this.persist();
    return { record, quarantineCase, duplicateGroup, replay: false };
  }

  private latestOpenCase(record: CollectionRecord): QuarantineCase | null {
    for (const caseId of record.quarantineCaseIds) {
      const qc = this.state.quarantineCases[caseId];
      if (qc && qc.status === "open") return qc;
    }
    return null;
  }

  /** 同一野外编号出现在多条未作废记录上时，建立 / 扩充重复候选组 */
  private flagDuplicatesIfNeeded(record: CollectionRecord): DuplicateGroup | null {
    if (record.fieldTag === null) return null;
    const candidates = Object.values(this.state.records).filter(
      (other) =>
        other.recordId !== record.recordId &&
        other.fieldTag === record.fieldTag &&
        other.status !== "void" &&
        other.status !== "duplicate",
    );
    if (candidates.length === 0) return null;

    let group: DuplicateGroup | null = null;
    for (const other of candidates) {
      if (other.duplicateGroupId) {
        const existing = this.state.duplicateGroups[other.duplicateGroupId];
        if (existing && existing.status === "open") {
          group = existing;
          break;
        }
      }
    }
    if (!group) {
      group = {
        groupId: newId("dup"),
        fieldTag: record.fieldTag,
        recordIds: [],
        status: "open",
        resolution: null,
        openedAt: this.nowIso(),
      };
      this.state.duplicateGroups[group.groupId] = group;
    }
    for (const other of candidates) {
      if (!group.recordIds.includes(other.recordId)) {
        group.recordIds.push(other.recordId);
        other.duplicateGroupId = group.groupId;
      }
    }
    if (!group.recordIds.includes(record.recordId)) {
      group.recordIds.push(record.recordId);
    }
    record.duplicateGroupId = group.groupId;
    this.audit(
      "duplicate_flagged",
      "duplicate_group",
      group.groupId,
      "system",
      `野外编号 ${record.fieldTag} 出现 ${group.recordIds.length} 条候选记录`,
      { permitId: record.permitId, teamId: record.teamId },
    );
    return group;
  }

  async attachPhoto(recordId: string, input: PhotoInput, actorId: string): Promise<Photo> {
    const record = this.getRecord(recordId);
    if (record.status === "void") {
      throw AppError.invalidState("记录已作废，不能追加照片");
    }
    const photo: Photo = {
      photoId: newId("pho"),
      sha256: input.sha256,
      takenAt: input.takenAt,
      caption: input.caption ?? null,
      uploadedBy: actorId,
      uploadedAt: this.nowIso(),
    };
    record.photos.push(photo);
    this.audit("photo_attached", "record", recordId, actorId, `追加现场照片（SHA-256 ${input.sha256.slice(0, 12)}…）`, {
      permitId: record.permitId,
      teamId: record.teamId,
    });
    await this.persist();
    return photo;
  }

  /** 登记经手交接：链条必须连续，首环节从野外队或合作机构开始 */
  async recordCustody(recordId: string, input: CustodyInput, actorId: string): Promise<CustodyHandoff> {
    const record = this.getRecord(recordId);
    if (record.status === "void" || record.status === "duplicate") {
      throw AppError.invalidState(`记录状态为 ${record.status}，不能登记交接`);
    }
    const handedAt = new Date(input.handedAt);
    if (Number.isNaN(handedAt.getTime())) {
      throw AppError.validation(`handedAt 不是合法时间: ${input.handedAt}`);
    }
    const last = record.custody[record.custody.length - 1];
    if (!last) {
      if (input.fromParty.type !== "field_team" && input.fromParty.type !== "partner_institution") {
        throw AppError.validation("首次交接必须从野外队或合作机构开始");
      }
    } else {
      if (input.fromParty.type !== last.toParty.type || input.fromParty.name !== last.toParty.name) {
        throw AppError.validation(
          `交接链条断裂：上一环节接收方为 ${last.toParty.type}/${last.toParty.name}，本次交出方为 ${input.fromParty.type}/${input.fromParty.name}`,
        );
      }
      if (handedAt.getTime() < Date.parse(last.handedAt)) {
        throw AppError.validation("交接时间早于上一环节，请核对时间顺序");
      }
    }
    const handoff: CustodyHandoff = {
      handoffId: newId("hand"),
      fromParty: input.fromParty,
      toParty: input.toParty,
      handedAt: handedAt.toISOString(),
      receivedAt: input.receivedAt ?? null,
      conditionNote: input.conditionNote ?? null,
      recordedBy: actorId,
      recordedAt: this.nowIso(),
    };
    record.custody.push(handoff);
    this.audit(
      "custody_recorded",
      "record",
      recordId,
      actorId,
      `交接 ${input.fromParty.name} → ${input.toParty.name}`,
      { permitId: record.permitId, teamId: record.teamId },
    );
    await this.persist();
    return handoff;
  }

  /** 野外放归：释放该记录占用的配额 */
  async releaseRecord(recordId: string, input: ReleaseInput, actorId: string): Promise<CollectionRecord> {
    const record = this.getRecord(recordId);
    if (record.status !== "accepted") {
      throw AppError.invalidState(`当前状态 ${record.status} 不能登记野外放归（仅已接收记录可放归）`);
    }
    record.status = "released";
    record.releasedAt = input.releasedAt ?? this.nowIso();
    record.releaseReason = input.reason ?? null;
    if (record.kind === "collected" && record.permitId && this.recordQuotaStage(recordId) === "held") {
      this.appendMovement({
        permitId: record.permitId,
        taxon: record.taxon,
        recordId,
        teamId: record.teamId,
        kind: "release",
        stage: "held",
        quantity: record.quantity,
        reason: "specimen_released",
        actorId,
      });
    }
    this.audit("record_released", "record", recordId, actorId, "野外放归，配额释放", {
      permitId: record.permitId,
      teamId: record.teamId,
    });
    await this.persist();
    return record;
  }

  // -------------------------------------------------------------------------
  // 隔离复核与重复处理
  // -------------------------------------------------------------------------

  async resolveQuarantine(caseId: string, input: ResolveQuarantineInput, actorId: string): Promise<QuarantineCase> {
    const qc = this.getQuarantineCase(caseId);
    if (qc.status !== "open") {
      throw AppError.invalidState(`隔离单 ${caseId} 已处理（${qc.status}）`);
    }
    const record = this.getRecord(qc.recordId);
    const now = this.nowIso();

    if (input.decision === "reject") {
      record.status = "void";
      if (record.permitId && this.recordQuotaStage(record.recordId) === "held") {
        this.appendMovement({
          permitId: record.permitId,
          taxon: record.taxon,
          recordId: record.recordId,
          teamId: record.teamId,
          kind: "release",
          stage: "held",
          quantity: record.quantity,
          reason: "quarantine_rejected",
          actorId,
        });
      }
      qc.status = "rejected";
    } else {
      // 复核通过：按许可证当前版本重新校验（期间许可证可能已修订）
      if (!record.permitId) {
        throw AppError.conflict("许可证编号仍无法解析，不能通过复核；请驳回或先补登许可证");
      }
      const permit = this.getPermit(record.permitId);
      const { issues } = this.validateCollectionFields(permit, {
        teamId: record.teamId,
        taxon: record.taxon,
        occurredAt: new Date(record.occurredAt),
        location: record.location,
      });
      if (issues.length > 0) {
        throw AppError.conflict("记录仍不满足许可要求，不能通过复核", { issues });
      }
      record.status = "accepted";
      if (record.kind === "collected" && this.recordQuotaStage(record.recordId) === "none") {
        const version = currentPermitVersion(permit);
        const entry = version.speciesScope.find((e) => e.taxon === record.taxon);
        const usage = this.quotaUsage(permit.permitId, record.taxon);
        const remaining = (entry?.quota ?? 0) - usage.held - usage.confirmed;
        if (remaining < record.quantity) {
          throw AppError.conflict(`物种 ${record.taxon} 剩余配额 ${remaining} 不足，不能通过复核`, {
            remaining,
            requested: record.quantity,
          });
        }
        this.appendMovement({
          permitId: permit.permitId,
          taxon: record.taxon,
          recordId: record.recordId,
          teamId: record.teamId,
          kind: "hold",
          stage: "held",
          quantity: record.quantity,
          reason: "quarantine_accepted",
          actorId,
        });
      }
      qc.status = "accepted";
    }
    qc.resolvedAt = now;
    qc.resolvedBy = actorId;
    qc.resolutionNote = input.rationale;
    this.audit(
      "quarantine_resolved",
      "quarantine_case",
      caseId,
      actorId,
      `隔离复核${qc.status === "accepted" ? "通过" : "驳回"}：${input.rationale}`,
      { permitId: record.permitId, teamId: record.teamId },
    );
    await this.persist();
    return qc;
  }

  async resolveDuplicate(groupId: string, input: ResolveDuplicateInput, actorId: string): Promise<DuplicateGroup> {
    const group = this.getDuplicateGroup(groupId);
    if (group.status !== "open") {
      throw AppError.invalidState(`重复候选组 ${groupId} 已处理`);
    }
    const now = this.nowIso();
    if (input.outcome === "merge") {
      if (!group.recordIds.includes(input.canonicalRecordId)) {
        throw AppError.validation(`canonicalRecordId ${input.canonicalRecordId} 不在候选组内`);
      }
      for (const recordId of group.recordIds) {
        if (recordId === input.canonicalRecordId) continue;
        const record = this.getRecord(recordId);
        if (record.status === "accessioned") {
          throw AppError.conflict(`记录 ${recordId} 已入馆，不能并入其他记录；请先更正入馆批次`);
        }
        if (record.permitId && this.recordQuotaStage(recordId) === "held") {
          this.appendMovement({
            permitId: record.permitId,
            taxon: record.taxon,
            recordId,
            teamId: record.teamId,
            kind: "release",
            stage: "held",
            quantity: record.quantity,
            reason: "duplicate_merged",
            actorId,
          });
        }
        record.status = "duplicate";
      }
      group.resolution = {
        outcome: "merged",
        canonicalRecordId: input.canonicalRecordId,
        rationale: input.rationale,
        resolvedBy: actorId,
        resolvedAt: now,
      };
    } else {
      group.resolution = {
        outcome: "kept_distinct",
        canonicalRecordId: null,
        rationale: input.rationale,
        resolvedBy: actorId,
        resolvedAt: now,
      };
    }
    group.status = "resolved";
    this.audit(
      "duplicate_resolved",
      "duplicate_group",
      groupId,
      actorId,
      input.outcome === "merge" ? `重复候选合并，正本 ${input.canonicalRecordId}` : "重复候选确认为不同标本",
      {},
    );
    await this.persist();
    return group;
  }

  // -------------------------------------------------------------------------
  // 入馆批次
  // -------------------------------------------------------------------------

  async createAccessionBatch(input: { title: string }, actorId: string): Promise<AccessionBatch> {
    const batch: AccessionBatch = {
      batchId: newId("batch"),
      title: input.title,
      status: "open",
      createdBy: actorId,
      createdAt: this.nowIso(),
      closedAt: null,
      items: [],
    };
    this.state.accessionBatches[batch.batchId] = batch;
    this.audit("batch_created", "accession_batch", batch.batchId, actorId, `创建入馆批次「${input.title}」`);
    await this.persist();
    return batch;
  }

  /** 入馆：要求记录已接收且交接链末端已到馆；入馆后配额由占用转实占 */
  async addAccessionItem(batchId: string, recordId: string, actorId: string): Promise<AccessionBatch> {
    const batch = this.getAccessionBatch(batchId);
    if (batch.status !== "open") {
      throw AppError.invalidState(`入馆批次 ${batchId} 已关闭`);
    }
    const record = this.getRecord(recordId);
    if (record.status !== "accepted") {
      throw AppError.conflict(`仅已接收记录可入馆（当前状态 ${record.status}）`);
    }
    if (record.accessionBatchId) {
      throw AppError.conflict(`记录已进入入馆批次 ${record.accessionBatchId}`);
    }
    const last = record.custody[record.custody.length - 1];
    if (!last || last.toParty.type !== "museum") {
      throw AppError.conflict("标本尚未完成到馆交接，不能入馆");
    }
    const at = this.nowIso();
    batch.items.push({ recordId, accessionedAt: at, accessionedBy: actorId });
    record.accessionBatchId = batchId;
    record.accessionedAt = at;
    record.status = "accessioned";
    if (record.kind === "collected" && record.permitId && this.recordQuotaStage(recordId) === "held") {
      this.appendMovement({
        permitId: record.permitId,
        taxon: record.taxon,
        recordId,
        teamId: record.teamId,
        kind: "confirm",
        stage: "confirmed",
        quantity: record.quantity,
        reason: "accessioned",
        actorId,
      });
    }
    this.audit("batch_item_added", "accession_batch", batchId, actorId, `记录 ${recordId} 入馆`, {
      permitId: record.permitId,
      teamId: record.teamId,
    });
    await this.persist();
    return batch;
  }

  async closeAccessionBatch(batchId: string, actorId: string): Promise<AccessionBatch> {
    const batch = this.getAccessionBatch(batchId);
    if (batch.status !== "open") {
      throw AppError.invalidState(`入馆批次 ${batchId} 已关闭`);
    }
    batch.status = "closed";
    batch.closedAt = this.nowIso();
    this.audit("batch_closed", "accession_batch", batchId, actorId, `入馆批次关闭（${batch.items.length} 件）`);
    await this.persist();
    return batch;
  }

  // -------------------------------------------------------------------------
  // 敏感坐标授权
  // -------------------------------------------------------------------------

  async grantSensitiveAccess(
    input: { researcherId: string; permitId: string | null },
    actorId: string,
  ): Promise<SensitiveGrant> {
    if (input.permitId !== null) {
      this.getPermit(input.permitId);
    }
    const existing = this.state.sensitiveGrants.find(
      (g) => g.researcherId === input.researcherId && g.permitId === input.permitId,
    );
    if (existing) return existing;
    const grant: SensitiveGrant = {
      grantId: newId("sag"),
      researcherId: input.researcherId,
      permitId: input.permitId,
      grantedBy: actorId,
      grantedAt: this.nowIso(),
    };
    this.state.sensitiveGrants.push(grant);
    this.audit(
      "sensitive_access_granted",
      "sensitive_grant",
      grant.grantId,
      actorId,
      `授权研究人员 ${input.researcherId} 查看敏感坐标（范围：${input.permitId ?? "全部许可证"}）`,
      { permitId: input.permitId },
    );
    await this.persist();
    return grant;
  }

  // -------------------------------------------------------------------------
  // 解释性查询
  // -------------------------------------------------------------------------

  /** 配额账：逐物种给出限额、占用、实占、累计释放、剩余，以及全部流水 */
  quotaReport(permitId: string): QuotaReport {
    const permit = this.getPermit(permitId);
    const version = currentPermitVersion(permit);
    const taxa = new Set<string>([
      ...version.speciesScope.map((e) => e.taxon),
      ...this.state.quotaMovements.filter((m) => m.permitId === permitId).map((m) => m.taxon),
    ]);
    const species = [...taxa].sort().map((taxon) => {
      const entry = version.speciesScope.find((e) => e.taxon === taxon) ?? null;
      const usage = this.quotaUsage(permitId, taxon);
      return {
        taxon,
        inScope: entry !== null,
        sensitive: entry?.sensitive ?? false,
        limit: entry?.quota ?? null,
        held: usage.held,
        confirmed: usage.confirmed,
        released: usage.released,
        remaining: entry === null ? null : entry.quota - usage.held - usage.confirmed,
        movements: this.state.quotaMovements.filter((m) => m.permitId === permitId && m.taxon === taxon),
      };
    });
    return { permitId, generatedAt: this.nowIso(), species };
  }

  /** 按许可证解释：版本沿革、配额账、关联记录、隔离单、重复候选与审计轨迹 */
  permitExplanation(permitId: string): PermitExplanation {
    const permit = this.getPermit(permitId);
    const records = this.listRecords({ permitId });
    const recordIds = new Set(records.map((r) => r.recordId));
    return {
      permit,
      effectiveState: this.effectiveState(permit),
      quota: this.quotaReport(permitId),
      records,
      quarantineCases: Object.values(this.state.quarantineCases).filter((qc) => recordIds.has(qc.recordId)),
      duplicateGroups: Object.values(this.state.duplicateGroups).filter((group) =>
        group.recordIds.some((id) => recordIds.has(id)),
      ),
      audit: this.state.auditLog.filter((entry) => entry.permitId === permitId),
    };
  }

  /** 按考察队解释：记录、配额流水、未决隔离与重复候选 */
  teamExplanation(teamId: string): TeamExplanation {
    const records = this.listRecords({ teamId });
    const recordIds = new Set(records.map((r) => r.recordId));
    const movements = this.state.quotaMovements.filter((m) => m.teamId === teamId);
    const aggregate = new Map<string, { permitId: string; taxon: string; held: number; confirmed: number; released: number }>();
    for (const m of movements) {
      const key = `${m.permitId}#${m.taxon}`;
      let bucket = aggregate.get(key);
      if (!bucket) {
        bucket = { permitId: m.permitId, taxon: m.taxon, held: 0, confirmed: 0, released: 0 };
        aggregate.set(key, bucket);
      }
      if (m.kind === "hold") bucket.held += m.quantity;
      else if (m.kind === "confirm") {
        bucket.held -= m.quantity;
        bucket.confirmed += m.quantity;
      } else {
        bucket.released += m.quantity;
        if (m.stage === "held") bucket.held -= m.quantity;
        else bucket.confirmed -= m.quantity;
      }
    }
    return {
      teamId,
      records,
      quotaMovements: movements,
      quotaByPermit: [...aggregate.values()],
      openQuarantineCases: Object.values(this.state.quarantineCases).filter(
        (qc) => qc.status === "open" && recordIds.has(qc.recordId),
      ),
      openDuplicateGroups: Object.values(this.state.duplicateGroups).filter(
        (group) => group.status === "open" && group.recordIds.some((id) => recordIds.has(id)),
      ),
    };
  }

  private effectiveState(permit: Permit): PermitState {
    if (permit.state === "active") {
      const version = currentPermitVersion(permit);
      if (this.nowFn().getTime() > Date.parse(version.validTo)) return "expired";
    }
    return permit.state;
  }
}
