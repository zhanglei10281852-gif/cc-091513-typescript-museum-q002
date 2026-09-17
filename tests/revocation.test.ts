import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTOR,
  createActivePermit,
  CURATOR,
  recordFixture,
  REGISTRAR,
  startTestApp,
} from "./helpers.js";

test("许可证撤回只阻止后续采集，已形成的来源证据完整保留", async () => {
  let now = new Date("2026-09-17T10:00:00Z");
  const client = await startTestApp({ now: () => now });
  try {
    const permitId = await createActivePermit(client);

    // 撤回前：采集 → 照片 → 交接 → 入馆，完整链路
    const before = await client.api("POST", "/records", {
      body: recordFixture({ occurredAt: "2026-09-10T08:00:00Z" }),
      ...COLLECTOR,
    });
    assert.equal(before.body.record.status, "accepted");
    const beforeId = before.body.record.recordId as string;
    await client.api("POST", `/records/${beforeId}/photos`, {
      body: { sha256: "a".repeat(64), takenAt: "2026-09-10T08:05:00Z" },
      ...COLLECTOR,
    });
    await client.api("POST", `/records/${beforeId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-alpha" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-09-12T09:00:00Z",
      },
      ...COLLECTOR,
    });
    const batch = await client.api("POST", "/accession-batches", { body: { title: "九月批次" }, ...REGISTRAR });
    const batchId = batch.body.batch.batchId as string;
    const accessioned = await client.api("POST", `/accession-batches/${batchId}/items`, {
      body: { recordId: beforeId },
      ...REGISTRAR,
    });
    assert.equal(accessioned.status, 200);

    // 馆长撤回许可证（登记员无权撤回）
    const forbidden = await client.api("POST", `/permits/${permitId}/revoke`, {
      body: { reason: "主管部门要求" },
      ...REGISTRAR,
    });
    assert.equal(forbidden.status, 403);
    const revoked = await client.api("POST", `/permits/${permitId}/revoke`, {
      body: { reason: "主管部门要求" },
      ...CURATOR,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.permit.state, "revoked");

    // 撤回时点之前的采集仍然有效（事件发生顺序与接收顺序区分）
    const preRevocation = await client.api("POST", "/records", {
      body: recordFixture({ occurredAt: "2026-09-16T08:00:00Z" }),
      ...COLLECTOR,
    });
    assert.equal(preRevocation.body.record.status, "accepted");

    // 撤回时点之后的采集被阻止
    now = new Date("2026-09-20T10:00:00Z");
    const postRevocation = await client.api("POST", "/records", {
      body: recordFixture({ occurredAt: "2026-09-18T08:00:00Z" }),
      ...COLLECTOR,
    });
    assert.equal(postRevocation.body.record.status, "quarantined");
    assert.ok(postRevocation.body.quarantineCase.issues.some((i: { code: string }) => i.code === "permit_revoked"));

    // 已形成的来源证据完整可查：照片、交接、入馆、时间线
    const chain = await client.api("GET", `/records/${beforeId}/chain`);
    assert.equal(chain.status, 200);
    assert.equal(chain.body.photos.length, 1);
    assert.equal(chain.body.custody.length, 1);
    assert.equal(chain.body.accession.batchId, batchId);
    assert.equal(chain.body.record.status, "accessioned");
    const kinds = chain.body.timeline.map((t: { kind: string }) => t.kind);
    assert.ok(kinds.includes("field_event"));
    assert.ok(kinds.includes("photo"));
    assert.ok(kinds.includes("custody"));
    assert.ok(kinds.includes("accession"));

    // 撤回前的在途标本仍可完成入馆（撤回只阻止后续采集，不阻断善后）
    const preId = preRevocation.body.record.recordId as string;
    await client.api("POST", `/records/${preId}/custody`, {
      body: {
        fromParty: { type: "field_team", name: "team-alpha" },
        toParty: { type: "museum", name: "自然博物馆" },
        handedAt: "2026-09-19T09:00:00Z",
      },
      ...COLLECTOR,
    });
    const lateAccession = await client.api("POST", `/accession-batches/${batchId}/items`, {
      body: { recordId: preId },
      ...REGISTRAR,
    });
    assert.equal(lateAccession.status, 200);
  } finally {
    await client.close();
  }
});

test("已撤回的许可证不能修订", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);
    await client.api("POST", `/permits/${permitId}/revoke`, { body: { reason: "违规采集" }, ...CURATOR });
    const amended = await client.api("POST", `/permits/${permitId}/amend`, {
      body: { note: "尝试修订" },
      ...REGISTRAR,
    });
    assert.equal(amended.status, 409);
  } finally {
    await client.close();
  }
});
