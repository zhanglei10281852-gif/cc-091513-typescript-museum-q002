import type { Server } from "node:http";

import { buildServer } from "./http/server.js";
import { PermitLedger } from "./ledger/ledger.js";
import type { LedgerState, StateStore } from "./ledger/state.js";

export const serviceName = "野外标本采集许可账册";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

export interface AppOptions {
  state?: LedgerState | undefined;
  store?: StateStore | undefined;
  now?: (() => Date) | undefined;
}

export function createApp(options: AppOptions = {}): Server {
  const ledger = new PermitLedger({ state: options.state, store: options.store, now: options.now });
  return buildServer(ledger, healthPayload());
}
