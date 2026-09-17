import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTOR,
  createActivePermit,
  PANDA,
  permitFixture,
  recordFixture,
  REGISTRAR,
  RHODODENDRON,
  startTestApp,
} from "./helpers.js";

test("越界、超物种范围、超有效期、未知许可证均进入隔离复核", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);

    const outOfSpecies = await client.api("POST", "/records", {
      body: recordFixture({ taxon: "Panthera uncia" }),
      ...COLLECTOR,
    });
    assert.ok(outOfSpecies.body.quarantineCase.issues.some((i: { code: string }) => i.code === "species_out_of_scope"));

    const outOfBoundary = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 35.5, lon: 103.5 } }),
      ...COLLECTOR,
    });
    assert.ok(outOfBoundary.body.quarantineCase.issues.some((i: { code: string }) => i.code === "outside_geo_boundary"));

    const outOfValidity = await client.api("POST", "/records", {
      body: recordFixture({ occurredAt: "2025-06-15T08:00:00Z" }),
      ...COLLECTOR,
    });
    assert.ok(
      outOfValidity.body.quarantineCase.issues.some((i: { code: string }) => i.code === "outside_validity_period"),
    );

    const unknownPermit = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-UNKNOWN-9" }),
      ...COLLECTOR,
    });
    assert.ok(unknownPermit.body.quarantineCase.issues.some((i: { code: string }) => i.code === "unknown_permit"));

    const openCases = await client.api("GET", "/quarantine?status=open");
    assert.equal(openCases.body.quarantineCases.length, 4);
  } finally {
    await client.close();
  }
});

test("隔离期间预占配额，驳回后释放", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client, {
      speciesScope: [{ taxon: PANDA, quota: 1, sensitive: false }],
    });

    // 越界采集进入隔离，但配额检查通过 → 预占额度，防止复核期间被超采
    const quarantined = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 35.5, lon: 103.5 } }),
      ...COLLECTOR,
    });
    assert.equal(quarantined.body.record.status, "quarantined");

    let quota = await client.api("GET", `/permits/${permitId}/quota`);
    let panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 1);
    assert.equal(panda.remaining, 0);
    assert.equal(panda.movements[0].reason, "quarantine_review");

    // 驳回 → 记录作废，额度释放
    const caseId = quarantined.body.quarantineCase.caseId as string;
    const rejected = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "reject", rationale: "采集点确在许可边界之外" },
      ...REGISTRAR,
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.quarantineCase.status, "rejected");

    quota = await client.api("GET", `/permits/${permitId}/quota`);
    panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 0);
    assert.equal(panda.released, 1);
    assert.equal(panda.remaining, 1);
    assert.ok(panda.movements.some((m: { reason: string }) => m.reason === "quarantine_rejected"));
  } finally {
    await client.close();
  }
});

test("许可证修订后，超范围记录可通过复核", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client, {
      speciesScope: [{ taxon: PANDA, quota: 2, sensitive: false }],
    });

    const submitted = await client.api("POST", "/records", {
      body: recordFixture({ taxon: RHODODENDRON }),
      ...COLLECTOR,
    });
    assert.equal(submitted.body.record.status, "quarantined");
    const caseId = submitted.body.quarantineCase.caseId as string;

    // 修订许可证，把该物种纳入范围
    await client.api("POST", `/permits/${permitId}/amend`, {
      body: {
        speciesScope: [
          { taxon: PANDA, quota: 2, sensitive: false },
          { taxon: RHODODENDRON, quota: 5, sensitive: false },
        ],
      },
      ...REGISTRAR,
    });

    const resolved = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "accept", rationale: "许可证已修订，物种纳入范围" },
      ...REGISTRAR,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.quarantineCase.status, "accepted");

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const rhodo = quota.body.species.find((s: { taxon: string }) => s.taxon === RHODODENDRON);
    assert.equal(rhodo.held, 1);
    assert.ok(rhodo.movements.some((m: { reason: string }) => m.reason === "quarantine_accepted"));
  } finally {
    await client.close();
  }
});

test("复核通过时配额仍不足则保持冲突", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client, {
      speciesScope: [{ taxon: PANDA, quota: 1, sensitive: false }],
    });

    const first = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    assert.equal(first.body.record.status, "accepted");

    // 第二份记录因配额不足进入隔离（未预占）
    const second = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    assert.equal(second.body.record.status, "quarantined");
    assert.ok(second.body.quarantineCase.issues.some((i: { code: string }) => i.code === "quota_exceeded"));

    // 配额没有变化，复核通过失败
    const caseId = second.body.quarantineCase.caseId as string;
    const resolved = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "accept", rationale: "尝试放行" },
      ...REGISTRAR,
    });
    assert.equal(resolved.status, 409);

    // 修订提高配额后可通过
    await client.api("POST", `/permits/${permitId}/amend`, {
      body: { speciesScope: [{ taxon: PANDA, quota: 2, sensitive: false }] },
      ...REGISTRAR,
    });
    const retry = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "accept", rationale: "配额已提高" },
      ...REGISTRAR,
    });
    assert.equal(retry.status, 200);
  } finally {
    await client.close();
  }
});

test("未知许可证的记录不能通过复核，只能驳回", async () => {
  const client = await startTestApp();
  try {
    const submitted = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-GHOST-1" }),
      ...COLLECTOR,
    });
    const caseId = submitted.body.quarantineCase.caseId as string;
    const accept = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "accept", rationale: "尝试通过" },
      ...REGISTRAR,
    });
    assert.equal(accept.status, 409);
    const reject = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "reject", rationale: "许可证编号不存在" },
      ...REGISTRAR,
    });
    assert.equal(reject.status, 200);
    const record = await client.api("GET", `/records/${submitted.body.record.recordId}`);
    assert.equal(record.body.record.status, "void");
  } finally {
    await client.close();
  }
});

test("旧许可证编号经复核确认后按当前版本入账", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);
    await client.api("POST", `/permits/${permitId}/amend`, {
      body: { permitNumber: "PER-2026-001-B" },
      ...REGISTRAR,
    });

    // 合作单位沿用旧编号上传
    const stale = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-2026-001" }),
      ...COLLECTOR,
    });
    assert.equal(stale.body.record.status, "quarantined");
    const caseId = stale.body.quarantineCase.caseId as string;

    const resolved = await client.api("POST", `/quarantine/${caseId}/resolve`, {
      body: { decision: "accept", rationale: "确认旧编号对应现许可证，按当前版本入账" },
      ...REGISTRAR,
    });
    assert.equal(resolved.status, 200);

    const record = await client.api("GET", `/records/${stale.body.record.recordId}`);
    assert.equal(record.body.record.status, "accepted");
    assert.equal(record.body.record.permitVersion, 2);
    assert.equal(record.body.record.stalePermitReference, true);
  } finally {
    await client.close();
  }
});
