import type { Database, QuotaEntry } from "../domain/model.js";
import { conflict } from "../domain/errors.js";

export interface QuotaUsage {
  permitId: string;
  speciesCode: string;
  limit: number | null;
  committed: number;
  hold: number;
  /** committed + hold，即当前占用总额。 */
  occupied: number;
  available: number | null;
}

export function sumEntries(entries: QuotaEntry[]): {
  committed: number;
  hold: number;
} {
  let committed = 0;
  let hold = 0;
  for (const entry of entries) {
    if (entry.phase === "committed") committed += entry.delta;
    else hold += entry.delta;
  }
  return { committed, hold };
}

/** 单个物种维度的用量；limit 为 null 表示许可证未列配额（不允许占用）。 */
export function getUsage(
  db: Database,
  permitId: string,
  speciesCode: string,
): QuotaUsage {
  const permit = db.permits.find((p) => p.id === permitId);
  const limit = permit?.quotaLimits[speciesCode] ?? null;
  const entries = db.quotaEntries.filter(
    (e) => e.permitId === permitId && e.speciesCode === speciesCode,
  );
  const { committed, hold } = sumEntries(entries);
  const occupied = committed + hold;
  return {
    permitId,
    speciesCode,
    limit,
    committed,
    hold,
    occupied,
    available: limit === null ? null : limit - occupied,
  };
}

/** 许可证全部配额维度（含发生过占用但当前许可证未列出的历史维度）。 */
export function getUsageForPermit(
  db: Database,
  permitId: string,
): QuotaUsage[] {
  const keys = new Set<string>();
  for (const entry of db.quotaEntries) {
    if (entry.permitId === permitId) keys.add(entry.speciesCode);
  }
  const permit = db.permits.find((p) => p.id === permitId);
  if (permit) for (const code of Object.keys(permit.quotaLimits)) keys.add(code);
  return [...keys].sort().map((speciesCode) => getUsage(db, permitId, speciesCode));
}

/** 考察队相关记录占用过的全部配额维度。 */
export function getUsageForExpedition(
  db: Database,
  expeditionId: string,
): QuotaUsage[] {
  const permitIds = new Set<string>();
  for (const record of db.records) {
    if (record.expeditionId === expeditionId && record.permitId) {
      permitIds.add(record.permitId);
    }
  }
  return [...permitIds]
    .sort()
    .flatMap((permitId) => getUsageForPermit(db, permitId));
}

/**
 * 申请占用配额。余额不足直接抛 409——多团队并发提交时，后到者失败而不是超采。
 * 必须在同步事务段内调用。entry.id 由调用方（Store）生成。
 */
export function assertAndReserve(db: Database, entry: QuotaEntry): QuotaEntry {
  assertCapacity(db, entry.permitId, entry.speciesCode, entry.delta);
  db.quotaEntries.push(entry);
  return entry;
}

/** 只检查容量，不写入；用于在任何变更落库前完成预检。 */
export function assertCapacity(
  db: Database,
  permitId: string,
  speciesCode: string,
  amount: number,
): void {
  if (amount <= 0) return;
  const permit = db.permits.find((p) => p.id === permitId);
  const limit = permit?.quotaLimits[speciesCode] ?? null;
  if (limit === null) {
    throw conflict(
      "quota_species_not_listed",
      `许可证未覆盖物种 ${speciesCode} 的配额`,
    );
  }
  const usage = getUsage(db, permitId, speciesCode);
  if (usage.occupied + amount > limit) {
    throw conflict(
      "quota_exceeded",
      `物种 ${speciesCode} 配额不足：剩余 ${limit - usage.occupied}，申请 ${amount}`,
      { limit, occupied: usage.occupied, requested: amount },
    );
  }
}

/** 追加一条与既有占用对冲的释放条目（负数），可部分释放。 */
export function releaseEntry(
  db: Database,
  entry: Omit<QuotaEntry, "id" | "delta" | "phase"> & { id: string },
  target: QuotaEntry,
  amount: number = target.delta,
): QuotaEntry {
  if (!Number.isInteger(amount) || amount <= 0 || amount > target.delta) {
    throw new Error("释放数量必须是 1..原占用数量 的整数");
  }
  const full: QuotaEntry = {
    ...entry,
    delta: -amount,
    phase: target.phase,
    releasesEntryId: target.id,
  };
  db.quotaEntries.push(full);
  return full;
}

/** 按记录归集配额条目（含释放对冲）。 */
export function entriesForRecord(
  db: Database,
  recordId: string,
): QuotaEntry[] {
  return db.quotaEntries.filter((e) => e.recordId === recordId);
}
