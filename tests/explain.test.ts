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

test("按许可证查询：配额占用与释放、记录、隔离与审计轨迹可解释", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);

    // team-alpha 接收 1 件；team-beta 接收 1 件后放归；另有 1 件越界隔离
    await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-1", deviceEventNo: "evt-e1", teamId: "team-alpha" }),
      ...COLLECTOR,
    });
    const toRelease = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-2", deviceEventNo: "evt-e2", teamId: "team-beta" }),
      ...COLLECTOR,
    });
    await client.api("POST", `/records/${toRelease.body.record.recordId}/release`, { body: {}, ...COLLECTOR });
    await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-3", deviceEventNo: "evt-e3", location: { lat: 35.5, lon: 103.5 } }),
      ...COLLECTOR,
    });

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    // 占用 2（接收 1 + 隔离预占 1），释放 1（放归），剩余 1
    assert.equal(panda.limit, 3);
    assert.equal(panda.held, 2);
    assert.equal(panda.released, 1);
    assert.equal(panda.remaining, 1);
    assert.equal(panda.movements.length, 4);

    const explain = await client.api("GET", `/permits/${permitId}/explain`);
    assert.equal(explain.body.permit.effectiveState, "active");
    assert.equal(explain.body.records.length, 3);
    assert.equal(explain.body.quarantineCases.length, 1);
    assert.ok(explain.body.audit.length >= 3);
    assert.equal(explain.body.quota.species.find((s: { taxon: string }) => s.taxon === PANDA).remaining, 1);
  } finally {
    await client.close();
  }
});

test("按考察队查询：各队占用与释放分明", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-1", deviceEventNo: "evt-f1", teamId: "team-alpha" }),
      ...COLLECTOR,
    });
    const betaRecord = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-2", deviceEventNo: "evt-f2", teamId: "team-beta" }),
      ...COLLECTOR,
    });
    await client.api("POST", `/records/${betaRecord.body.record.recordId}/release`, { body: {}, ...COLLECTOR });
    await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-3", deviceEventNo: "evt-f3", teamId: "team-beta", location: { lat: 35.5, lon: 103.5 } }),
      ...COLLECTOR,
    });

    const alpha = await client.api("GET", "/teams/team-alpha/explain");
    assert.equal(alpha.body.records.length, 1);
    const alphaQuota = alpha.body.quotaByPermit.find((q: { taxon: string }) => q.taxon === PANDA);
    assert.equal(alphaQuota.held, 1);
    assert.equal(alphaQuota.released, 0);
    assert.equal(alpha.body.openQuarantineCases.length, 0);

    const beta = await client.api("GET", "/teams/team-beta/explain");
    assert.equal(beta.body.records.length, 2);
    const betaQuota = beta.body.quotaByPermit.find((q: { taxon: string }) => q.taxon === PANDA);
    assert.equal(betaQuota.held, 1); // 隔离预占
    assert.equal(betaQuota.released, 1); // 放归
    assert.equal(beta.body.openQuarantineCases.length, 1);

    // 未授权队伍不在许可证范围内
    const outsider = await client.api("POST", "/records", {
      body: recordFixture({ deviceId: "dev-4", deviceEventNo: "evt-f4", teamId: "team-gamma" }),
      ...COLLECTOR,
    });
    assert.ok(outsider.body.quarantineCase.issues.some((i: { code: string }) => i.code === "team_not_authorized"));
  } finally {
    await client.close();
  }
});
