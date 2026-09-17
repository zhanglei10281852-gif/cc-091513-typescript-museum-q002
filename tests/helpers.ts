import assert from "node:assert/strict";

import { createApp, type AppOptions } from "../src/app.js";

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface TestClient {
  baseUrl: string;
  close(): Promise<void>;
  api(
    method: string,
    path: string,
    options?: { body?: unknown; actorId?: string; role?: string },
  ): Promise<ApiResponse>;
}

export async function startTestApp(options: AppOptions = {}): Promise<TestClient> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    async api(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (opts.actorId) headers["x-actor-id"] = opts.actorId;
      if (opts.role) headers["x-actor-role"] = opts.role;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}

export const REGISTRAR = { actorId: "reg-1", role: "registrar" };
export const CURATOR = { actorId: "cur-1", role: "curator" };
export const COLLECTOR = { actorId: "col-1", role: "collector" };
export const RESEARCHER = { actorId: "res-1", role: "researcher" };

export const PANDA = "Ailuropoda melanoleuca";
export const RHODODENDRON = "Rhododendron rubiginosum";

export function permitFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "横断山区联合考察采集许可",
    permitNumber: "PER-2026-001",
    teamIds: ["team-alpha", "team-beta"],
    speciesScope: [
      { taxon: PANDA, quota: 3, sensitive: true },
      { taxon: RHODODENDRON, quota: 10, sensitive: false },
    ],
    boundary: { type: "bbox", minLat: 30, maxLat: 31, minLon: 103, maxLon: 104 },
    validFrom: "2026-01-01T00:00:00Z",
    validTo: "2026-12-31T23:59:59Z",
    ...overrides,
  };
}

let eventCounter = 0;

export function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  eventCounter += 1;
  return {
    deviceId: "dev-1",
    deviceEventNo: `evt-${eventCounter}`,
    permitNumber: "PER-2026-001",
    teamId: "team-alpha",
    collectorId: "collector-7",
    kind: "collected",
    taxon: PANDA,
    quantity: 1,
    occurredAt: "2026-06-15T08:00:00Z",
    location: { lat: 30.5234, lon: 103.4567 },
    ...overrides,
  };
}

/** 创建并生效一个许可证，返回 permitId */
export async function createActivePermit(
  client: TestClient,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await client.api("POST", "/permits", { body: permitFixture(overrides), ...REGISTRAR });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const permitId = created.body.permit.permitId as string;
  const activated = await client.api("POST", `/permits/${permitId}/activate`, { body: {}, ...REGISTRAR });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  return permitId;
}
