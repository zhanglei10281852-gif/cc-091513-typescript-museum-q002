import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AccessionBatch,
  AuditEntry,
  CollectionRecord,
  DuplicateGroup,
  Permit,
  QuarantineCase,
  QuotaMovement,
  SensitiveGrant,
} from "../domain/types.js";

/** 账册全量状态：plain object 以便 JSON 快照持久化。 */
export interface LedgerState {
  schemaVersion: 1;
  permits: Record<string, Permit>;
  /** 许可证编号（含历史版本编号）→ 许可证与版本 */
  permitNumberIndex: Record<string, { permitId: string; version: number }>;
  records: Record<string, CollectionRecord>;
  /** 设备事件号幂等索引：`deviceId#deviceEventNo` → recordId */
  deviceEventIndex: Record<string, string>;
  quarantineCases: Record<string, QuarantineCase>;
  duplicateGroups: Record<string, DuplicateGroup>;
  accessionBatches: Record<string, AccessionBatch>;
  quotaMovements: QuotaMovement[];
  sensitiveGrants: SensitiveGrant[];
  auditLog: AuditEntry[];
}

export function emptyState(): LedgerState {
  return {
    schemaVersion: 1,
    permits: {},
    permitNumberIndex: {},
    records: {},
    deviceEventIndex: {},
    quarantineCases: {},
    duplicateGroups: {},
    accessionBatches: {},
    quotaMovements: [],
    sensitiveGrants: [],
    auditLog: [],
  };
}

/** 持久化接口：每次成功变更后保存全量快照。 */
export interface StateStore {
  save(state: LedgerState): Promise<void>;
}

export class MemoryStore implements StateStore {
  save(): Promise<void> {
    return Promise.resolve();
  }
}

/** JSON 文件快照存储：tmp + rename 原子写入，写操作串行排队。 */
export class JsonFileStore implements StateStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<LedgerState | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as LedgerState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  save(state: LedgerState): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, this.path);
    });
    return this.queue;
  }
}
