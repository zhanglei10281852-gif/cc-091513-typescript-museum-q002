import { createServer, type Server } from "node:http";

import { LedgerService } from "./domain/service.js";
import { Store } from "./store/store.js";
import { Router } from "./http/router.js";

export const serviceName = "野外标本采集许可账册";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export interface AppOptions {
  /** 数据文件；省略则使用内存存储（测试用）。 */
  dataFile?: string;
  now?: () => Date;
}

export function createApp(options: AppOptions = {}): Server {
  const store = new Store({ dataFile: options.dataFile, now: options.now });
  const service = new LedgerService(store);
  const router = new Router(service);
  router.register();

  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(healthPayload()));
      return;
    }
    void router.handle(request, response);
  });
}

/** 测试与脚本可直接获得服务实例（同一内存账册）。 */
export function createService(options: AppOptions = {}): {
  service: LedgerService;
  store: Store;
} {
  const store = new Store({ dataFile: options.dataFile, now: options.now });
  return { service: new LedgerService(store), store };
}
