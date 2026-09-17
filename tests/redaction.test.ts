import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTOR,
  createActivePermit,
  CURATOR,
  recordFixture,
  REGISTRAR,
  RESEARCHER,
  RHODODENDRON,
  startTestApp,
} from "./helpers.js";

test("敏感物种精确坐标仅向馆方与获授权研究人员开放", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);
    const submitted = await client.api("POST", "/records", {
      body: recordFixture({ location: { lat: 30.5234, lon: 103.4567 } }),
      ...COLLECTOR,
    });
    const recordId = submitted.body.record.recordId as string;

    // 匿名访客：坐标粗化
    const anonymous = await client.api("GET", `/records/${recordId}`);
    assert.equal(anonymous.body.record.coordinatesRedacted, true);
    assert.equal(anonymous.body.record.sensitive, true);
    assert.equal(anonymous.body.record.location.lat, 30.5);
    assert.equal(anonymous.body.record.location.redacted, true);

    // 未获授权的研究人员：同样粗化
    const researcher = await client.api("GET", `/records/${recordId}`, RESEARCHER);
    assert.equal(researcher.body.record.coordinatesRedacted, true);

    // 馆方登记员：精确坐标
    const registrar = await client.api("GET", `/records/${recordId}`, REGISTRAR);
    assert.equal(registrar.body.record.coordinatesRedacted, false);
    assert.equal(registrar.body.record.location.lat, 30.5234);

    // 授权后的研究人员可见精确坐标（登记员无权授权，需馆长）
    const forbidden = await client.api("POST", "/sensitive-access-grants", {
      body: { researcherId: "res-1", permitId },
      ...REGISTRAR,
    });
    assert.equal(forbidden.status, 403);
    const granted = await client.api("POST", "/sensitive-access-grants", {
      body: { researcherId: "res-1", permitId },
      ...CURATOR,
    });
    assert.equal(granted.status, 201);
    const authorized = await client.api("GET", `/records/${recordId}`, RESEARCHER);
    assert.equal(authorized.body.record.coordinatesRedacted, false);
    assert.equal(authorized.body.record.location.lat, 30.5234);

    // 授权范围按许可证隔离：其他许可证的敏感记录仍不可见
    const otherPermit = await client.api("POST", "/permits", {
      body: {
        title: "另一许可证",
        permitNumber: "PER-2026-002",
        teamIds: ["team-alpha"],
        speciesScope: [{ taxon: RHODODENDRON, quota: 5, sensitive: true }],
        boundary: { type: "bbox", minLat: 30, maxLat: 31, minLon: 103, maxLon: 104 },
        validFrom: "2026-01-01T00:00:00Z",
        validTo: "2026-12-31T23:59:59Z",
      },
      ...REGISTRAR,
    });
    const otherPermitId = otherPermit.body.permit.permitId as string;
    await client.api("POST", `/permits/${otherPermitId}/activate`, { body: {}, ...REGISTRAR });
    const otherRecord = await client.api("POST", "/records", {
      body: recordFixture({ permitNumber: "PER-2026-002", taxon: RHODODENDRON }),
      ...COLLECTOR,
    });
    const otherView = await client.api("GET", `/records/${otherRecord.body.record.recordId}`, RESEARCHER);
    assert.equal(otherView.body.record.coordinatesRedacted, true);

    // 责任链接口同样应用脱敏
    const chain = await client.api("GET", `/records/${recordId}/chain`);
    assert.equal(chain.body.record.coordinatesRedacted, true);
  } finally {
    await client.close();
  }
});

test("非敏感物种坐标对所有角色公开", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    const submitted = await client.api("POST", "/records", {
      body: recordFixture({ taxon: RHODODENDRON, location: { lat: 30.5234, lon: 103.4567 } }),
      ...COLLECTOR,
    });
    const view = await client.api("GET", `/records/${submitted.body.record.recordId}`);
    assert.equal(view.body.record.sensitive, false);
    assert.equal(view.body.record.coordinatesRedacted, false);
    assert.equal(view.body.record.location.lat, 30.5234);
  } finally {
    await client.close();
  }
});
