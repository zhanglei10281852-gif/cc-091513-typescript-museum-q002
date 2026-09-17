import {
  currentPermitVersion,
  type CollectionRecord,
  type CustodyHandoff,
  type DuplicateGroup,
  type GeoPoint,
  type Permit,
  type PermitState,
  type Photo,
  type Principal,
  type QuarantineCase,
  type QuotaMovement,
  type Role,
} from "../domain/types.js";
import type { LedgerState } from "./state.js";

/** 馆方人员：登记员与馆长始终可见精确坐标 */
const STAFF_ROLES: Role[] = ["registrar", "curator"];

export function effectivePermitState(permit: Permit, now: Date): PermitState {
  if (permit.state === "active" && now.getTime() > Date.parse(currentPermitVersion(permit).validTo)) {
    return "expired";
  }
  return permit.state;
}

/** 记录是否属于敏感物种；许可证或物种无法确认时按敏感处理（宁可隐藏） */
export function isSensitiveRecord(state: LedgerState, record: CollectionRecord): boolean {
  if (!record.permitId) return true;
  const permit = state.permits[record.permitId];
  if (!permit) return true;
  const version =
    permit.versions.find((v) => v.version === record.permitVersion) ??
    permit.versions.find((v) => v.version === permit.currentVersion);
  const entry = version?.speciesScope.find((e) => e.taxon === record.taxon);
  return entry?.sensitive ?? true;
}

export function canViewPreciseLocation(state: LedgerState, record: CollectionRecord, principal: Principal): boolean {
  if (STAFF_ROLES.includes(principal.role)) return true;
  if (principal.role !== "researcher" || principal.actorId === null) return false;
  return state.sensitiveGrants.some(
    (g) => g.researcherId === principal.actorId && (g.permitId === null || g.permitId === record.permitId),
  );
}

export type LocationView =
  | (GeoPoint & { redacted: false })
  | { lat: number; lon: number; precision: "coarse"; redacted: true };

export type RecordView = Omit<CollectionRecord, "location"> & {
  location: LocationView;
  sensitive: boolean;
  coordinatesRedacted: boolean;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 采集记录视图：敏感物种的精确坐标仅向馆方与获授权研究人员开放，其余角色得到粗化坐标 */
export function toRecordView(state: LedgerState, record: CollectionRecord, principal: Principal): RecordView {
  const sensitive = isSensitiveRecord(state, record);
  const precise = !sensitive || canViewPreciseLocation(state, record, principal);
  const location: LocationView = precise
    ? { ...record.location, redacted: false }
    : {
        lat: round1(record.location.lat),
        lon: round1(record.location.lon),
        precision: "coarse",
        redacted: true,
      };
  return { ...record, location, sensitive, coordinatesRedacted: !precise };
}

export type PermitView = Permit & { effectiveState: PermitState };

export function toPermitView(permit: Permit, now: Date): PermitView {
  return { ...permit, effectiveState: effectivePermitState(permit, now) };
}

export interface TimelineEntry {
  at: string;
  kind: string;
  summary: string;
}

export interface ChainView {
  record: RecordView;
  photos: Photo[];
  custody: CustodyHandoff[];
  accession: { batchId: string; batchTitle: string; accessionedAt: string } | null;
  quotaMovements: QuotaMovement[];
  quarantineCases: QuarantineCase[];
  duplicateGroup: DuplicateGroup | null;
  /** 从现场到入馆的完整责任链，按事件发生时间排序 */
  timeline: TimelineEntry[];
}

/** 一件标本的完整责任链：现场采集 → 照片 → 交接 → 入馆，含配额、隔离与重复处理结论 */
export function buildChainView(state: LedgerState, record: CollectionRecord, principal: Principal): ChainView {
  const batch = record.accessionBatchId ? state.accessionBatches[record.accessionBatchId] ?? null : null;
  const duplicateGroup = record.duplicateGroupId ? state.duplicateGroups[record.duplicateGroupId] ?? null : null;
  const quarantineCases = record.quarantineCaseIds
    .map((id) => state.quarantineCases[id])
    .filter((qc): qc is QuarantineCase => qc !== undefined);
  const quotaMovements = state.quotaMovements.filter((m) => m.recordId === record.recordId);

  const timeline: TimelineEntry[] = [];
  timeline.push({
    at: record.occurredAt,
    kind: "field_event",
    summary: `现场${record.kind === "collected" ? "采集" : "观察"} ${record.taxon} ×${record.quantity}（${record.teamId}/${record.collectorId}）`,
  });
  timeline.push({
    at: record.receivedAt,
    kind: "ingest",
    summary: `记录接收入账（设备 ${record.deviceId} 事件号 ${record.deviceEventNo}）`,
  });
  for (const photo of record.photos) {
    timeline.push({ at: photo.takenAt, kind: "photo", summary: `现场照片（SHA-256 ${photo.sha256.slice(0, 12)}…）` });
  }
  for (const handoff of record.custody) {
    timeline.push({
      at: handoff.handedAt,
      kind: "custody",
      summary: `交接 ${handoff.fromParty.name}（${handoff.fromParty.type}）→ ${handoff.toParty.name}（${handoff.toParty.type}）`,
    });
    if (handoff.receivedAt) {
      timeline.push({ at: handoff.receivedAt, kind: "custody_received", summary: `${handoff.toParty.name} 确认接收` });
    }
  }
  for (const qc of quarantineCases) {
    timeline.push({ at: qc.openedAt, kind: "quarantine", summary: `进入隔离复核（${qc.issues.map((i) => i.code).join(", ")}）` });
    if (qc.resolvedAt) {
      timeline.push({
        at: qc.resolvedAt,
        kind: "quarantine_resolved",
        summary: `隔离复核${qc.status === "accepted" ? "通过" : "驳回"}：${qc.resolutionNote ?? ""}`,
      });
    }
  }
  if (duplicateGroup?.resolution) {
    timeline.push({
      at: duplicateGroup.resolution.resolvedAt,
      kind: "duplicate_resolved",
      summary:
        duplicateGroup.resolution.outcome === "merged"
          ? `重复候选合并，正本 ${duplicateGroup.resolution.canonicalRecordId ?? ""}`
          : "重复候选确认为不同标本",
    });
  }
  if (record.releasedAt) {
    timeline.push({ at: record.releasedAt, kind: "released", summary: "野外放归" });
  }
  if (record.accessionedAt && batch) {
    timeline.push({ at: record.accessionedAt, kind: "accession", summary: `入馆批次「${batch.title}」（${batch.batchId}）` });
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    record: toRecordView(state, record, principal),
    photos: record.photos,
    custody: record.custody,
    accession: batch && record.accessionedAt
      ? { batchId: batch.batchId, batchTitle: batch.title, accessionedAt: record.accessionedAt }
      : null,
    quotaMovements,
    quarantineCases,
    duplicateGroup,
    timeline,
  };
}
