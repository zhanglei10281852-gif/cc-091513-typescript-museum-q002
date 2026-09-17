import {
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { createDatabase, type Database } from "../domain/model.js";

export interface StoreOptions {
  /** 数据文件路径；不设置则纯内存（测试用）。 */
  dataFile?: string | undefined;
  /** 可注入的时钟（测试用）。 */
  now?: (() => Date) | undefined;
}

/**
 * 进程内账册存储。
 *
 * 所有变更业务逻辑均同步执行：Node 单线程事件循环内，两次 await 之间不会被
 * 其他请求打断，因此多团队并发提交时的“检查余额→写入占用”是原子序列，
 * 不需要额外锁即可防止超采。变更后排队串行落盘。
 */
export class Store {
  readonly db: Database;
  readonly now: () => Date;
  private readonly dataFile: string | undefined;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: StoreOptions = {}) {
    this.dataFile = options.dataFile;
    this.now = options.now ?? (() => new Date());
    this.db = options.dataFile ? loadOrInit(options.dataFile) : createDatabase();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  genId(): string {
    return randomUUID();
  }

  /** 将一次同步变更排队落盘；同进程内写入顺序与提交顺序一致。 */
  persist(): void {
    if (!this.dataFile) return;
    const file = this.dataFile;
    const snapshot = structuredClone(this.db);
    this.saveChain = this.saveChain.then(
      () => writeJsonAtomic(file, snapshot),
      (error) => {
        process.stderr.write(`persist failed: ${String(error)}\n`);
        return writeJsonAtomic(file, snapshot);
      },
    );
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }
}

function loadOrInit(file: string): Database {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<Database>;
    return { ...createDatabase(), ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createDatabase();
    throw error;
  }
}

function writeJsonAtomic(file: string, data: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      renameSync(tmp, file);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}
