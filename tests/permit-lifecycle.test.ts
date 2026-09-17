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

test("许可证生命周期：草稿 → 生效 → 修订换证 → 暂扣 → 恢复", async () => {
  const client = await startTestApp();
  try {
    // 配额放宽，避免隔离预占干扰生命周期断言
    const created = await client.api("POST", "/permits", {
      body: permitFixture({
        speciesScope: [
          { taxon: PANDA, quota: 10, sensitive: true },
          { taxon: RHODODENDRON, quota: 10, sensitive: false },
        ],
      }),
      ...REGISTRAR,
    });
    assert.equal(created.status, 201);
    const permitId = created.body.permit.permitId as string;
    assert.equal(created.body.permit.state, "draft");

    // 草稿状态下提交采集 → 隔离复核
    const draftRecord = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    assert.equal(draftRecord.status, 201);
    assert.equal(draftRecord.body.record.status, "quarantined");
    assert.ok(draftRecord.body.quarantineCase.issues.some((i: { code: string }) => i.code === "permit_not_active"));

    // 生效后可正常采集
    await client.api("POST", `/permits/${permitId}/activate`, { body: {}, ...REGISTRAR });
    const accepted = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    assert.equal(accepted.body.record.status, "accepted");

    // 修订换发新编号，旧编号保留为历史版本
    const amended = await client.api("POST", `/permits/${permitId}/amend`, {
      body: { permitNumber: "PER-2026-001-B", note: "换发新证" },
      ...REGISTRAR,
    });
    assert.equal(amended.status, 200);
    assert.equal(amended.body.permit.currentVersion, 2);
    assert.equal(amended.body.permit.versions.length, 2);

    // 合作单位沿用旧编号 → 识别为陈旧引用并隔离
    const stale = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-2026-001" }),
      ...COLLECTOR,
    });
    assert.equal(stale.body.record.status, "quarantined");
    assert.equal(stale.body.record.stalePermitReference, true);
    assert.ok(stale.body.quarantineCase.issues.some((i: { code: string }) => i.code === "stale_permit_reference"));

    // 暂扣期间采集被隔离，恢复后正常
    await client.api("POST", `/permits/${permitId}/suspend`, { body: { reason: "例行检查" }, ...REGISTRAR });
    const suspended = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-2026-001-B" }),
      ...COLLECTOR,
    });
    assert.ok(suspended.body.quarantineCase.issues.some((i: { code: string }) => i.code === "permit_suspended"));
    await client.api("POST", `/permits/${permitId}/resume`, { body: {}, ...REGISTRAR });
    const resumed = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-2026-001-B" }),
      ...COLLECTOR,
    });
    assert.equal(resumed.body.record.status, "accepted");
  } finally {
    await client.close();
  }
});

test("许可证输入校验与角色权限", async () => {
  const client = await startTestApp();
  try {
    // 未认证写操作 → 401
    const anonymous = await client.api("POST", "/permits", { body: permitFixture() });
    assert.equal(anonymous.status, 401);
    // 野外队角色不能管理许可证 → 403
    const forbidden = await client.api("POST", "/permits", { body: permitFixture(), ...COLLECTOR });
    assert.equal(forbidden.status, 403);
    // 非法有效期 → 400
    const invalid = await client.api("POST", "/permits", {
      body: permitFixture({ validFrom: "2026-12-31T00:00:00Z", validTo: "2026-01-01T00:00:00Z" }),
      ...REGISTRAR,
    });
    assert.equal(invalid.status, 400);
    // 重复许可证编号 → 409
    const first = await client.api("POST", "/permits", { body: permitFixture(), ...REGISTRAR });
    assert.equal(first.status, 201);
    const duplicate = await client.api("POST", "/permits", { body: permitFixture(), ...REGISTRAR });
    assert.equal(duplicate.status, 409);
  } finally {
    await client.close();
  }
});

test("多边形地理边界校验", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client, {
      boundary: {
        type: "polygon",
        vertices: [
          { lat: 30, lon: 103 },
          { lat: 30, lon: 104 },
          { lat: 31, lon: 104 },
          { lat: 31, lon: 103 },
        ],
      },
    });
    assert.ok(permitId);
    const inside = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 30.5, lon: 103.5 } }),
      ...COLLECTOR,
    });
    assert.equal(inside.body.record.status, "accepted");
    const outside = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 31.5, lon: 103.5 } }),
      ...COLLECTOR,
    });
    assert.ok(outside.body.quarantineCase.issues.some((i: { code: string }) => i.code === "outside_geo_boundary"));
  } finally {
    await client.close();
  }
});
