import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../src/domain/errors.js";
import { collectBody, makeService, setupScenario } from "./helpers.js";

test("旧许可证编号通过别名解析到当前许可证", () => {
  const { service } = makeService();
  setupScenario(service);
  const result = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-old", permitNumber: "P-OLD-2025" }),
  );
  assert.equal(result.idempotent, false);
  assert.equal(result.record.status, "accepted");
  const permit = service.explainPermit("P-OLD-2025");
  assert.equal(permit.permit.permitNumber, "P-NEW-2026");
});

test("物种超出范围或坐标越界进入隔离复核并记录原因", () => {
  const { service } = makeService();
  setupScenario(service);

  const outOfScope = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-species", speciesCode: "REP99" }),
  );
  assert.equal(outOfScope.record.status, "quarantined");
  const qc1 = service.listQuarantineCases()[0]!;
  assert.deepEqual(qc1.reasons, ["species_out_of_scope"]);

  const outOfBounds = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-geo", lng: 90.0, lat: 20.0 }),
  );
  assert.equal(outOfBounds.record.status, "quarantined");
  const qc2 = service.listQuarantineCases()[1]!;
  assert.deepEqual(qc2.reasons, ["location_out_of_bounds"]);
});

test("无法解析的许可证号进入隔离复核；补登旧编号别名后可准入", () => {
  const { service } = makeService();
  setupScenario(service);
  const result = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-unknown", permitNumber: "P-PARTNER-X" }),
  );
  assert.equal(result.record.status, "quarantined");

  const qc = service.listQuarantineCases()[0]!;
  assert.throws(
    () => service.resolveQuarantine(qc.id, { decision: "admitted", reviewerId: "r-1" }),
    (e: unknown) => e instanceof DomainError && e.code === "permit_unresolved",
  );

  service.addPermitAlias("P-NEW-2026", "P-PARTNER-X");
  const resolved = service.resolveQuarantine(qc.id, {
    decision: "admitted",
    reviewerId: "r-1",
  });
  assert.equal(resolved.record.status, "accepted");
  // 上传时实际使用的编号作为来源证据保留。
  assert.equal(resolved.record.permitNumberUsed, "P-PARTNER-X");
});

test("撤回许可证只阻止后续采集，不抹去撤回前已形成的记录与占用", () => {
  const { service, clock } = makeService();
  setupScenario(service);

  const before = service.submitFieldRecord(collectBody({ deviceEventId: "evt-before" }));
  assert.equal(before.record.status, "accepted");

  service.changePermitState("P-NEW-2026", "revoked", "野外违规", "2026-08-02T00:00:00.000Z");
  clock.set("2026-08-02T12:00:00.000Z");

  // 撤回之后发生的事件：隔离复核。
  const after = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-after", occurredAt: "2026-08-02T09:00:00.000Z" }),
  );
  assert.equal(after.record.status, "quarantined");
  assert.ok(after.record.permitId, "记录仍关联许可证，证据保留");
  assert.deepEqual(
    service.listQuarantineCases()[0]!.reasons,
    ["permit_revoked_at_event"],
  );

  // 撤回之前的记录仍可交接、入馆，占用仍在账。
  service.transferCustody(before.record.id, {
    at: "2026-08-01T18:00:00.000Z",
    toType: "carrier",
    toParty: "顺丰冷运",
    handlerId: "h-1",
  });
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.committed, 1);
  assert.equal(usage.limit, 3);
});

test("暂停期间不能预占或采集，恢复后正常", () => {
  const { service, clock } = makeService();
  setupScenario(service);
  service.changePermitState("P-NEW-2026", "suspended", undefined, "2026-08-03T00:00:00.000Z");
  clock.set("2026-08-03T12:00:00.000Z");
  assert.throws(
    () =>
      service.reserveQuota({
        permitRef: "P-NEW-2026",
        speciesCode: "LEP01",
        teamId: "team-a",
        quantity: 1,
      }),
    (e: unknown) => e instanceof DomainError && e.code === "permit_suspended",
  );
  service.changePermitState("P-NEW-2026", "active", "整改完成", "2026-08-05T00:00:00.000Z");
  clock.set("2026-08-05T12:00:00.000Z");
  const r = service.reserveQuota({
    permitRef: "P-NEW-2026",
    speciesCode: "LEP01",
    teamId: "team-a",
    quantity: 1,
  });
  assert.equal(r.reservation.quantity, 1);
});

test("越过有效期自动到期；撤回是终态不可恢复", () => {
  const { service } = makeService();
  setupScenario(service);
  const permit = service.requirePermit("P-NEW-2026");
  assert.equal(service.permitStateAt(permit, "2026-10-02T00:00:00.000Z"), "expired");
  assert.equal(service.permitStateAt(permit, "2026-06-01T00:00:00.000Z"), "draft");
  service.changePermitState("P-NEW-2026", "revoked", undefined, "2026-08-02T00:00:00.000Z");
  assert.throws(
    () => service.changePermitState("P-NEW-2026", "active", undefined, "2026-08-03T00:00:00.000Z"),
    (e: unknown) => e instanceof DomainError && e.code === "permit_transition_illegal",
  );
});

test("观察记录不占用配额", () => {
  const { service } = makeService();
  setupScenario(service);
  const result = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-obs", eventType: "observed" }),
  );
  assert.equal(result.record.status, "accepted");
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 0);
});
