import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Server } from "node:http";

import { createApp } from "../src/app.js";

async function startServer(app: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      app.close((error) => (error ? reject(error) : resolve())),
    );
  return { base, close };
}

async function setup(base: string) {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await put("/taxa/LEP01", { name: "山地凤蝶", sensitive: false });
  await put("/taxa/AMP02", { name: "隐纹小鲵", sensitive: true });
  await put("/researchers/r-auth", { name: "授权", sensitiveTaxa: ["AMP02"] });
  await put("/expeditions/exp-1", {
    name: "联合考察",
    teamIds: ["team-a", "team-b"],
  });
  const permitRes = await post("/permits", {
    permitNumber: "P-NEW",
    aliases: ["P-OLD"],
    speciesCodes: ["LEP01", "AMP02"],
    bounds: { type: "bbox", bbox: [100, 30, 102, 32] },
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-10-01T00:00:00.000Z",
    quotaLimits: { LEP01: 2, AMP02: 1 },
  });
  assert.equal(permitRes.status, 201);
  return { post, put };
}

const collectPayload = (overrides: Record<string, unknown> = {}) => ({
  deviceEventId: "dev-1",
  expeditionId: "exp-1",
  teamId: "team-a",
  permitNumber: "P-OLD",
  speciesCode: "LEP01",
  quantity: 1,
  lng: 101,
  lat: 31,
  occurredAt: "2026-08-01T09:00:00.000Z",
  collectorId: "c-1",
  eventType: "collected",
  ...overrides,
});

test("HTTP 全链路：旧编号提交→幂等补传→敏感遮蔽→交接→入馆→解释查询", async () => {
  const app = createApp();
  const { base, close } = await startServer(app);
  try {
    const { post } = await setup(base);

    // 首次 201，旧编号别名解析。
    const r1 = await post("/records", collectPayload());
    assert.equal(r1.status, 201);
    const record1 = (await r1.json()) as { id: string };

    // 同设备事件号补传 → 200 幂等。
    const r2 = await post("/records", collectPayload());
    assert.equal(r2.status, 200);

    // 载荷冲突 → 409。
    const r3 = await post("/records", collectPayload({ quantity: 2 }));
    assert.equal(r3.status, 409);
    assert.equal((await r3.json()).error, "device_event_conflict");

    // 敏感物种精确坐标未授权遮蔽。
    await post(
      "/records",
      collectPayload({
        deviceEventId: "dev-2",
        speciesCode: "AMP02",
        lng: 101.123456,
        lat: 31.654321,
        occurredAt: "2026-08-01T09:30:00.000Z",
      }),
    );
    const hidden = await (await fetch(`${base}/records`)).json() as unknown[];
    const sensitive = (hidden as Array<{ speciesCode: string; lat: number }>).find(
      (r) => r.speciesCode === "AMP02",
    )!;
    assert.equal(sensitive.lat, 31.7);

    const visibleRes = await fetch(`${base}/records?viewer=r-auth`);
    const visible = (await visibleRes.json()) as Array<{
      speciesCode: string;
      lat: number;
    }>;
    assert.equal(visible.find((r) => r.speciesCode === "AMP02")!.lat, 31.654321);

    // 交接 + 入馆。
    const t = await post(`/records/${record1.id}/transfers`, {
      at: "2026-08-01T18:00:00.000Z",
      toType: "carrier",
      toParty: "冷运",
      handlerId: "h-1",
    });
    assert.equal(t.status, 201);
    const a = await post("/accessions", {
      recordIds: [record1.id],
      handlerId: "h-2",
      at: "2026-08-02T10:00:00.000Z",
    });
    assert.equal(a.status, 201);

    // 解释视图包含完整责任链与配额。
    const explainedRes = await fetch(`${base}/records/${record1.id}`);
    const explained = (await explainedRes.json()) as {
      responsibilityChain: Array<{ toType: string }>;
      quotaEntries: unknown[];
      accessionBatch: { id: string };
    };
    assert.deepEqual(
      explained.responsibilityChain.map((c) => c.toType),
      ["field_team", "carrier", "museum"],
    );
    assert.equal(explained.quotaEntries.length, 1);
    assert.ok(explained.accessionBatch.id);

    // 许可证视角用旧编号也可查询。
    const permitViewRes = await fetch(`${base}/permits/P-OLD`);
    assert.equal(permitViewRes.status, 200);
    const permitView = (await permitViewRes.json()) as {
      usages: Array<{ speciesCode: string; occupied: number }>;
    };
    assert.equal(permitView.usages.find((u) => u.speciesCode === "LEP01")!.occupied, 1);
  } finally {
    await close();
  }
});

test("HTTP 越界记录隔离、复核拒绝后证据保留", async () => {
  const app = createApp();
  const { base, close } = await startServer(app);
  try {
    const { post } = await setup(base);
    const res = await post(
      "/records",
      collectPayload({ deviceEventId: "dev-x", lng: 90, lat: 20 }),
    );
    assert.equal(res.status, 201);
    const record = (await res.json()) as {
      id: string;
      status: string;
      quarantineCaseId: string;
      photos: unknown[];
    };
    assert.equal(record.status, "quarantined");
    assert.ok(record.quarantineCaseId);
    assert.equal(record.photos.length, 0); // 该 payload 未覆盖 photos（默认逻辑仅测试辅助有）

    const list = await (await fetch(`${base}/quarantine?open=true`)).json() as Array<{
      id: string;
    }>;
    assert.equal(list.length, 1);
    const reject = await post(`/quarantine/${list[0]!.id}/resolve`, {
      decision: "rejected",
      reviewerId: "rev-1",
      note: "越界采集",
    });
    assert.equal(reject.status, 200);

    // 被拒记录仍可解释查询，证据未抹去。
    const explainedRes = await fetch(`${base}/records/${record.id}`);
    assert.equal(explainedRes.status, 200);
    const explained = (await explainedRes.json()) as {
      record: { status: string };
      quarantineCase: { decision: string };
    };
    assert.equal(explained.record.status, "rejected");
    assert.equal(explained.quarantineCase.decision, "rejected");
  } finally {
    await close();
  }
});

test("文件持久化：重启进程后账册与设备事件幂等仍然成立", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-"));
  const dataFile = join(dir, "ledger.json");

  const app1 = createApp({ dataFile });
  const s1 = await startServer(app1);
  try {
    await setup(s1.base);
    const res = await fetch(`${s1.base}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    assert.equal(res.status, 201);
  } finally {
    await s1.close();
  }
  // 文件已写入。
  const raw = JSON.parse(await readFile(dataFile, "utf8")) as {
    records: unknown[];
    permits: unknown[];
  };
  assert.equal(raw.records.length, 1);
  assert.equal(raw.permits.length, 1);

  const app2 = createApp({ dataFile });
  const s2 = await startServer(app2);
  try {
    const res = await fetch(`${s2.base}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    // 重启后同设备事件号仍识别为幂等补传。
    assert.equal(res.status, 200);
    const records = (await (await fetch(`${s2.base}/records`)).json()) as unknown[];
    assert.equal(records.length, 1);
  } finally {
    await s2.close();
  }
});

test("未知路由与非法 JSON 返回规范错误", async () => {
  const app = createApp();
  const { base, close } = await startServer(app);
  try {
    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
    const bad = await fetch(`${base}/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_json");
  } finally {
    await close();
  }
});
