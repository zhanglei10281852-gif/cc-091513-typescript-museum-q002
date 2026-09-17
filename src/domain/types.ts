/**
 * 领域类型与枚举。
 * 许可状态、采集事件、交接类型的取值与 reference/domain.json 保持一致，
 * 由 tests/domain-alignment.test.ts 守护，防止两边漂移。
 */

import { AppError } from "../errors.js";

export const PERMIT_STATES = ["draft", "active", "suspended", "expired", "revoked"] as const;
export type PermitState = (typeof PERMIT_STATES)[number];

export const COLLECTION_EVENTS = ["observed", "collected", "released", "transferred", "received"] as const;
export type CollectionEventKind = (typeof COLLECTION_EVENTS)[number];

export const CUSTODY_PARTY_TYPES = ["field_team", "partner_institution", "carrier", "museum"] as const;
export type CustodyPartyType = (typeof CUSTODY_PARTY_TYPES)[number];

/**
 * 采集记录类型：observed 只观察不占用配额；collected 实际采集并占用配额。
 * released / transferred / received 体现为记录的后续动作（放归、交接、入馆），
 * 不作为独立的采集记录类型。
 */
export type RecordKind = "observed" | "collected";

/** 调用方角色：registrar 登记员 / curator 馆长 / collector 野外队或合作单位 / researcher 研究人员 / viewer 只读 */
export const ROLES = ["registrar", "curator", "collector", "researcher", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  /** 未认证（匿名只读）时为 null */
  actorId: string | null;
  role: Role;
}

// ---------------------------------------------------------------------------
// 地理
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lon: number;
  accuracyM?: number;
}

export type GeoBoundary =
  | { type: "bbox"; minLat: number; maxLat: number; minLon: number; maxLon: number }
  | { type: "polygon"; vertices: GeoPoint[] };

// ---------------------------------------------------------------------------
// 许可证
// ---------------------------------------------------------------------------

export interface SpeciesScopeEntry {
  taxon: string;
  /** 该物种在许可证下的数量配额 */
  quota: number;
  /** 敏感物种：精确坐标仅向馆方与获授权研究人员开放 */
  sensitive: boolean;
}

export interface PermitVersion {
  version: number;
  /** 印在许可证上的编号；修订换证后旧编号保留在索引中用于识别陈旧引用 */
  permitNumber: string;
  speciesScope: SpeciesScopeEntry[];
  boundary: GeoBoundary;
  validFrom: string;
  validTo: string;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface Permit {
  permitId: string;
  title: string;
  /** 获准在该许可证下采集的考察队 */
  teamIds: string[];
  state: PermitState;
  versions: PermitVersion[];
  currentVersion: number;
  createdAt: string;
  createdBy: string;
  suspendedAt: string | null;
  suspendReason: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  revokedBy: string | null;
}

export function currentPermitVersion(permit: Permit): PermitVersion {
  const version = permit.versions.find((v) => v.version === permit.currentVersion);
  if (!version) {
    throw new AppError(500, "internal", `许可证 ${permit.permitId} 缺少当前版本数据`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// 采集记录
// ---------------------------------------------------------------------------

export type RecordStatus =
  | "accepted" // 已接收（占用配额中）
  | "quarantined" // 隔离复核中
  | "released" // 野外放归（配额已释放）
  | "accessioned" // 已入馆（配额转实占）
  | "duplicate" // 被判定为重复记录（配额已释放）
  | "void"; // 复核驳回（作废）

export interface Photo {
  photoId: string;
  /** 照片内容摘要，作为来源证据的完整性锚点 */
  sha256: string;
  takenAt: string;
  caption: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface CustodyParty {
  type: CustodyPartyType;
  name: string;
}

export interface CustodyHandoff {
  handoffId: string;
  fromParty: CustodyParty;
  toParty: CustodyParty;
  handedAt: string;
  receivedAt: string | null;
  conditionNote: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface CollectionRecord {
  recordId: string;
  /** 设备事件号：移动端补传的幂等键 */
  deviceId: string;
  deviceEventNo: string;
  permitId: string | null;
  /** 记录校验时依据的许可证版本（证据固化，不随后续修订改变） */
  permitVersion: number | null;
  /** 提交方填写的许可证编号（可能是旧编号） */
  permitNumber: string;
  stalePermitReference: boolean;
  teamId: string;
  collectorId: string;
  kind: RecordKind;
  taxon: string;
  quantity: number;
  /** 野外标本编号；不同设备记录指向同一编号时产生重复候选 */
  fieldTag: string | null;
  /** 事件发生时间（现场） */
  occurredAt: string;
  /** 记录接收时间（入账），两者需区分 */
  receivedAt: string;
  location: GeoPoint;
  status: RecordStatus;
  photos: Photo[];
  custody: CustodyHandoff[];
  accessionBatchId: string | null;
  accessionedAt: string | null;
  duplicateGroupId: string | null;
  quarantineCaseIds: string[];
  releasedAt: string | null;
  releaseReason: string | null;
  submittedBy: string;
}

// ---------------------------------------------------------------------------
// 隔离复核
// ---------------------------------------------------------------------------

export type QuarantineReasonCode =
  | "unknown_permit"
  | "stale_permit_reference"
  | "team_not_authorized"
  | "permit_not_active"
  | "permit_suspended"
  | "permit_revoked"
  | "outside_validity_period"
  | "occurred_in_future"
  | "species_out_of_scope"
  | "outside_geo_boundary"
  | "quota_exceeded";

export interface QuarantineIssue {
  code: QuarantineReasonCode;
  message: string;
  details: Record<string, unknown> | null;
}

export interface QuarantineCase {
  caseId: string;
  recordId: string;
  permitId: string | null;
  issues: QuarantineIssue[];
  status: "open" | "accepted" | "rejected";
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

// ---------------------------------------------------------------------------
// 重复候选
// ---------------------------------------------------------------------------

export interface DuplicateResolution {
  outcome: "merged" | "kept_distinct";
  canonicalRecordId: string | null;
  rationale: string;
  resolvedBy: string;
  resolvedAt: string;
}

export interface DuplicateGroup {
  groupId: string;
  fieldTag: string;
  recordIds: string[];
  status: "open" | "resolved";
  resolution: DuplicateResolution | null;
  openedAt: string;
}

// ---------------------------------------------------------------------------
// 配额账（占用 / 转实 / 释放的流水）
// ---------------------------------------------------------------------------

export type QuotaMovementReason =
  | "collection_accepted" // 采集接收，占用
  | "quarantine_review" // 隔离期间预占，防止复核期间超采
  | "quarantine_accepted" // 复核通过，补占用
  | "quarantine_rejected" // 复核驳回，释放
  | "specimen_released" // 野外放归，释放
  | "duplicate_merged" // 重复合并，释放
  | "accessioned"; // 入馆，占用转实占

export interface QuotaMovement {
  movementId: string;
  permitId: string;
  taxon: string;
  recordId: string;
  teamId: string;
  kind: "hold" | "confirm" | "release";
  /** release 时指明释放的是占用中还是已实占的额度 */
  stage: "held" | "confirmed";
  quantity: number;
  reason: QuotaMovementReason;
  at: string;
  actorId: string;
}

// ---------------------------------------------------------------------------
// 入馆批次
// ---------------------------------------------------------------------------

export interface AccessionBatchItem {
  recordId: string;
  accessionedAt: string;
  accessionedBy: string;
}

export interface AccessionBatch {
  batchId: string;
  title: string;
  status: "open" | "closed";
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
  items: AccessionBatchItem[];
}

// ---------------------------------------------------------------------------
// 敏感坐标授权与审计
// ---------------------------------------------------------------------------

export interface SensitiveGrant {
  grantId: string;
  researcherId: string;
  /** null 表示对全部许可证生效 */
  permitId: string | null;
  grantedBy: string;
  grantedAt: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  permitId: string | null;
  teamId: string | null;
  summary: string;
}
