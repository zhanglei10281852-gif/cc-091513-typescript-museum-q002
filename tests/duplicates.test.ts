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

test("两份离线记录指向同一件标本：产生重复候选，合并后释放配额", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);

    // 两台设备离线记录同一野外编号，先后补传
    const first = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-1", deviceEventNo: "evt-a1", fieldTag: "FT-100" }),
      ...COLLECTOR,
    });
    assert.equal(first.body.duplicateGroup, null);
    const second = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-2", deviceEventNo: "evt-b2", fieldTag: "FT-100" }),
      ...COLLECTOR,
    });
    assert.equal(second.body.record.status, "accepted");
    const group = second.body.duplicateGroup;
    assert.ok(group);
    assert.equal(group.status, "open");
    assert.equal(group.recordIds.length, 2);

    // 两份记录各自预占配额
    let quota = await client.api("GET", `/permits/${permitId}/quota`);
    let panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 2);

    // 合并：保留第一份为正本，第二份判定为重复并释放配额
    const canonicalId = first.body.record.recordId as string;
    const duplicateId = second.body.record.recordId as string;
    const resolved = await client.api("POST", `/duplicates/${group.groupId}/resolve`, {
      body: { outcome: "merge", canonicalRecordId: canonicalId, rationale: "同一标本的重复离线记录" },
      ...REGISTRAR,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.duplicateGroup.status, "resolved");
    assert.equal(resolved.body.duplicateGroup.resolution.outcome, "merged");

    const duplicate = await client.api("GET", `/records/${duplicateId}`);
    assert.equal(duplicate.body.record.status, "duplicate");

    quota = await client.api("GET", `/permits/${permitId}/quota`);
    panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 1);
    assert.equal(panda.released, 1);
    assert.ok(panda.movements.some((m: { reason: string }) => m.reason === "duplicate_merged"));

    // 处理结论在责任链中可查
    const chain = await client.api("GET", `/records/${duplicateId}/chain`);
    assert.equal(chain.body.duplicateGroup.resolution.outcome, "merged");
    assert.equal(chain.body.duplicateGroup.resolution.canonicalRecordId, canonicalId);
  } finally {
    await client.close();
  }
});

test("重复候选确认为不同标本：双方保留", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-1", deviceEventNo: "evt-c1", fieldTag: "FT-200" }),
      ...COLLECTOR,
    });
    const second = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-2", deviceEventNo: "evt-c2", fieldTag: "FT-200" }),
      ...COLLECTOR,
    });
    const groupId = second.body.duplicateGroup.groupId as string;

    const resolved = await client.api("POST", `/duplicates/${groupId}/resolve`, {
      body: { outcome: "distinct", rationale: "野外编号误重用，实为两件标本" },
      ...REGISTRAR,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.duplicateGroup.resolution.outcome, "kept_distinct");

    const records = await client.api("GET", "/records?status=accepted");
    assert.equal(records.body.records.length, 2);
  } finally {
    await client.close();
  }
});

test("已入馆记录不能并入其他记录", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    const first = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-1", deviceEventNo: "evt-d1", fieldTag: "FT-300" }),
      ...COLLECTOR,
    });
    const firstId = first.body.record.recordId as string;
    await client.api("POST", `/records/${firstId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-alpha" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-06-20T09:00:00Z",
      },
      ...COLLECTOR,
    });
    const batch = await client.api("POST", "/accession-batches", { body: { title: "六月批次" }, ...REGISTRAR });
    await client.api("POST", `/accession-batches/${batch.body.batch.batchId}/items`, {
      body: { recordId: firstId },
      ...REGISTRAR,
    });

    const second = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-2", deviceEventNo: "evt-d2", fieldTag: "FT-300" }),
      ...COLLECTOR,
    });
    const groupId = second.body.duplicateGroup.groupId as string;
    const secondId = second.body.record.recordId as string;

    const merged = await client.api("POST", `/duplicates/${groupId}/resolve`, {
      body: { outcome: "merge", canonicalRecordId: secondId, rationale: "尝试并入未入馆记录" },
      ...REGISTRAR,
    });
    assert.equal(merged.status, 409);
  } finally {
    await client.close();
  }
});
