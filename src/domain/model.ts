// 领域模型：许可证、采集记录、配额台账、交接与入馆。
// 枚举与 reference/domain.json 保持一致。

export const PERMIT_STATES = [
  "draft",
  "active",
  "suspended",
  "expired",
  "revoked",
] as const;
export type PermitState = (typeof PERMIT_STATES)[number];

export const COLLECTION_EVENT_TYPES = [
  "observed",
  "collected",
  "released",
  "transferred",
  "received",
] as const;
export type CollectionEventType = (typeof COLLECTION_EVENT_TYPES)[number];

/** 现场记录只可能是“采集到标本”或“观察到个体”，其余类型由交接/入馆动作产生。 */
export type FieldEventType = "observed" | "collected";

export const CUSTODY_TYPES = [
  "field_team",
  "partner_institution",
  "carrier",
  "museum",
] as const;
export type CustodyType = (typeof CUSTODY_TYPES)[number];

/** 地理边界：轴对齐包围盒或简单多边形（经纬度环，射线法判点）。 */
export type GeoBounds =
  | { type: "bbox"; bbox: [number, number, number, number] }
  | { type: "polygon"; coordinates: number[][][] };

export interface Taxon {
  code: string;
  name: string;
  /** 敏感物种：精确坐标仅向获授权研究人员展示。 */
  sensitive: boolean;
}

export interface Researcher {
  id: string;
  name: string;
  /** 可查看精确坐标的物种代码；"*" 表示全部敏感物种。 */
  sensitiveTaxa: string[];
}

export interface Expedition {
  id: string;
  name: string;
  /** 考察队下的多个作业团队，配额可被多团队并发占用。 */
  teamIds: string[];
  createdAt: string;
}

export interface PermitStateChange {
  state: PermitState;
  at: string;
  reason?: string | undefined;
}

export interface Permit {
  id: string;
  /** 当前许可证编号。 */
  permitNumber: string;
  /** 历史/合作方仍可能使用的旧编号，解析到同一许可证。 */
  aliases: string[];
  speciesCodes: string[];
  bounds: GeoBounds;
  validFrom: string;
  validUntil: string;
  /** 每个物种的采集配额（个体数）。 */
  quotaLimits: Record<string, number>;
  state: PermitState;
  history: PermitStateChange[];
  createdAt: string;
}

export interface FieldPhoto {
  id: string;
  sha256: string;
  takenAt: string;
  lng?: number | undefined;
  lat?: number | undefined;
  caption?: string | undefined;
}

export interface CustodyTransfer {
  seq: number;
  at: string;
  fromType: CustodyType | null;
  toType: CustodyType;
  fromParty: string | null;
  toParty: string;
  handlerId: string;
  note?: string | undefined;
}

export type RecordStatus =
  | "accepted" // 核验通过，占用配额
  | "quarantined" // 超出许可边界，隔离复核中
  | "duplicate_review" // 疑似与既有记录指向同一件标本
  | "merged" // 复核确认重复，并入主记录，证据保留
  | "rejected" // 隔离复核拒绝，证据保留
  | "released" // 标本在野外放归，配额释放
  | "accessioned"; // 已入馆

export interface QuotaEntry {
  id: string;
  at: string;
  permitId: string;
  speciesCode: string;
  /** 采集记录占用时填写；团队手工预占时为 null。 */
  recordId: string | null;
  /** 团队手工预占单号。 */
  reservationId?: string | undefined;
  teamId?: string | undefined;
  /** 数量，释放为负数。 */
  delta: number;
  /** hold：复核/预占期间的占用；committed：确认占用。 */
  phase: "hold" | "committed";
  reason: string;
  /** 释放条目指向被释放的占用/预占条目。 */
  releasesEntryId?: string | undefined;
}

export interface QuarantineCase {
  id: string;
  recordId: string;
  reasons: string[];
  openedAt: string;
  resolvedAt?: string | undefined;
  decision?: "admitted" | "rejected" | undefined;
  reviewerId?: string | undefined;
  note?: string | undefined;
}

export interface DuplicateCandidate {
  id: string;
  fingerprint: string;
  /** 在先记录与在后记录（提交顺序）。 */
  recordIds: [string, string];
  status: "pending" | "resolved";
  openedAt: string;
  decidedAt?: string | undefined;
  conclusion?: "distinct" | "duplicate" | undefined;
  primaryRecordId?: string | undefined;
  reviewerId?: string | undefined;
  note?: string | undefined;
}

export interface CollectionRecord {
  id: string;
  /** 移动端设备事件号，全库唯一，补传以此幂等。 */
  deviceEventId: string;
  expeditionId: string;
  teamId: string;
  /** 上传时实际填写的许可证编号（可能是旧编号），作为来源证据保留。 */
  permitNumberUsed: string;
  /** 解析到的当前许可证；无法解析时为 null。 */
  permitId: string | null;
  speciesCode: string;
  quantity: number;
  lng: number;
  lat: number;
  /** 事件实际发生时间（离线补传可能远早于接收时间）。 */
  occurredAt: string;
  /** 平台接收时间。 */
  receivedAt: string;
  collectorId: string;
  eventType: FieldEventType;
  photos: FieldPhoto[];
  custody: CustodyTransfer[];
  status: RecordStatus;
  quarantineCaseId: string | null;
  duplicateCandidateIds: string[];
  mergedIntoRecordId: string | null;
  accessionId: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface QuotaReservation {
  id: string;
  permitId: string;
  speciesCode: string;
  teamId: string;
  quantity: number;
  /** 已被采集记录抵扣的数量。 */
  consumedQuantity: number;
  createdAt: string;
  /** 手工释放（释放剩余额度）时刻；抵扣完不写此字段。 */
  releasedAt: string | null;
  note?: string | undefined;
}

export interface AccessionBatch {
  id: string;
  at: string;
  handlerId: string;
  recordIds: string[];
  note?: string | undefined;
  createdAt: string;
}

/** 纯数组持久化结构，Map 等派生索引不入库。 */
export interface Database {
  taxa: Taxon[];
  researchers: Researcher[];
  expeditions: Expedition[];
  permits: Permit[];
  records: CollectionRecord[];
  quotaEntries: QuotaEntry[];
  reservations: QuotaReservation[];
  quarantineCases: QuarantineCase[];
  duplicateCandidates: DuplicateCandidate[];
  accessions: AccessionBatch[];
}

export function createDatabase(): Database {
  return {
    taxa: [],
    researchers: [],
    expeditions: [],
    permits: [],
    records: [],
    quotaEntries: [],
    reservations: [],
    quarantineCases: [],
    duplicateCandidates: [],
    accessions: [],
  };
}
