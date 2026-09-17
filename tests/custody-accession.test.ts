import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTOR,
  createActivePermit,
  PANDA,
  recordFixture,
  REGISTRAR,
  startTestApp,
} from "./helpers.js";

test("交接链必须连续，入馆要求到馆交接，入馆后配额转实占", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);
    const submitted = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    const recordId = submitted.body.record.recordId as string;

    // 首次交接必须从野外队或合作机构开始
    const badFirst = await client.api("POST", `/records/${recordId}/custody`, {
      body: {
        fromParty: { type: "carrier", name: "山地物流" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-06-16T09:00:00Z",
      },
      ...COLLECTOR,
    });
    assert.equal(badFirst.status, 400);

    // 野外队 → 承运人 → 馆方
    const first = await client.api("POST", `/records/${recordId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-alpha" },
        toParty: { type: "carrier", name: "山地物流" },
        handedAt: "2026-06-16T09:00:00Z",
        conditionNote: "冷藏运输",
      },
      ...COLLECTOR,
    });
    assert.equal(first.status, 201);

    // 链条断裂：交出方与上一环节接收方不一致
    const broken = await client.api("POST", `/records/${recordId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-beta" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-06-18T09:00:00Z",
      },
      ...COLLECTOR,
    });
    assert.equal(broken.status, 400);

    const second = await client.api("POST", `/records/${recordId}/custody`, {
      body: {
        fromParty: { type: "carrier", name: "山地物流" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-06-18T09:00:00Z",
        receivedAt: "2026-06-18T15:00:00Z",
      },
      ...COLLECTOR,
    });
    assert.equal(second.status, 201);

    // 入馆：配额由占用转实占
    const batch = await client.api("POST", "/accession-batches", { body: { title: "六月批次" }, ...REGISTRAR });
    const batchId = batch.body.batch.batchId as string;
    const added = await client.api("POST", `/accession-batches/${batchId}/items`, {
      body: { recordId },
      ...REGISTRAR,
    });
    assert.equal(added.status, 200);

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 0);
    assert.equal(panda.confirmed, 1);
    assert.equal(panda.remaining, 2);
    assert.ok(panda.movements.some((m: { reason: string }) => m.reason === "accessioned"));

    // 责任链时间线：现场 → 交接 → 到馆 → 入馆
    const chain = await client.api("GET", `/records/${recordId}/chain`);
    assert.equal(chain.body.record.status, "accessioned");
    const kinds = chain.body.timeline.map((t: { kind: string }) => t.kind);
    assert.deepEqual(kinds[0], "field_event");
    assert.equal(kinds[kinds.length - 1], "accession");
    assert.ok(kinds.includes("custody_received"));

    // 批次关闭后不能再加件
    await client.api("POST", `/accession-batches/${batchId}/close`, { body: {}, ...REGISTRAR });
    const another = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    const lateAdd = await client.api("POST", `/accession-batches/${batchId}/items`, {
      body: { recordId: another.body.record.recordId },
      ...REGISTRAR,
    });
    assert.equal(lateAdd.status, 409);
  } finally {
    await client.close();
  }
});

test("未完成到馆交接的标本不能入馆", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    const submitted = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    const recordId = submitted.body.record.recordId as string;
    await client.api("POST", `/records/${recordId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-alpha" },
        toParty: { type: "carrier", name: "山地物流" },
        handedAt: "2026-06-16T09:00:00Z",
      },
      ...COLLECTOR,
    });
    const batch = await client.api("POST", "/accession-batches", { body: { title: "六月批次" }, ...REGISTRAR });
    const added = await client.api("POST", `/accession-batches/${batch.body.batch.batchId}/items`, {
      body: { recordId },
      ...REGISTRAR,
    });
    assert.equal(added.status, 409);
    assert.match(added.body.message, /交接/);
  } finally {
    await client.close();
  }
});

test("隔离中的记录不能入馆", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    const quarantined = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 35.5, lon: 103.5 } }),
      ...COLLECTOR,
    });
    const batch = await client.api("POST", "/accession-batches", { body: { title: "六月批次" }, ...REGISTRAR });
    const added = await client.api("POST", `/accession-batches/${batch.body.batch.batchId}/items`, {
      body: { recordId: quarantined.body.record.recordId },
      ...REGISTRAR,
    });
    assert.equal(added.status, 409);
  } finally {
    await client.close();
  }
});
