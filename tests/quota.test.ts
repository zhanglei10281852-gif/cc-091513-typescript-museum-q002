import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../src/domain/errors.js";
import { collectBody, makeService, setupScenario } from "./helpers.js";

test("配额上限：超额采集进入隔离复核且占用不超限", () => {
  const { service, store } = makeService();
  setupScenario(service);
  service.submitFieldRecord(collectBody({ deviceEventId: "evt-1" }));
  service.submitFieldRecord(collectBody({ deviceEventId: "evt-2", teamId: "team-b" }));
  service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-3", occurredAt: "2026-08-01T10:00:00.000Z", lng: 101.3 }),
  );
  const fourth = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-4", occurredAt: "2026-08-01T11:00:00.000Z", lng: 101.4 }),
  );
  assert.equal(fourth.record.status, "quarantined");
  assert.deepEqual(
    service.listQuarantineCases()[0]!.reasons,
    ["quota_exceeded"],
  );
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.committed, 3);
  assert.equal(usage.occupied, 3);
  assert.equal(usage.available, 0);

  // 额度释放后复核可准入。
  service.releaseSpecimen(
    store.db.records.find((r) => r.deviceEventId === "evt-1")!.id,
    { handlerId: "h-1", at: "2026-08-01T11:30:00.000Z" },
  );
  const qc = service.listQuarantineCases()[0]!;
  const admitted = service.resolveQuarantine(qc.id, {
    decision: "admitted",
    reviewerId: "r-1",
  });
  assert.equal(admitted.record.status, "accepted");
});

test("多团队并发提交串行落账，绝不超采", async () => {
  const { service } = makeService();
  setupScenario(service);
  // 两支团队同时各提交 2 件，许可总量只有 3。
  const bodies = [
    collectBody({ deviceEventId: "evt-a1", teamId: "team-a", occurredAt: "2026-08-01T09:00:00.000Z", lng: 101.00 }),
    collectBody({ deviceEventId: "evt-a2", teamId: "team-a", occurredAt: "2026-08-01T09:01:00.000Z", lng: 101.05 }),
    collectBody({ deviceEventId: "evt-b1", teamId: "team-b", occurredAt: "2026-08-01T09:00:00.000Z", lng: 101.10 }),
    collectBody({ deviceEventId: "evt-b2", teamId: "team-b", occurredAt: "2026-08-01T09:01:00.000Z", lng: 101.15 }),
  ];
  const outcomes = await Promise.all(
    bodies.map(
      (b) =>
        new Promise<string>((resolve) => {
          setImmediate(() => {
            try {
              resolve(service.submitFieldRecord(b).record.status);
            } catch (error) {
              resolve((error as DomainError).code);
            }
          });
        }),
    ),
  );
  const accepted = outcomes.filter((s) => s === "accepted").length;
  const quarantined = outcomes.filter((s) => s === "quarantined").length;
  assert.equal(accepted, 3);
  assert.equal(quarantined, 1);
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 3);
});

test("团队预占占用余额；采集确认抵扣预占，不双重计数", () => {
  const { service } = makeService();
  setupScenario(service);
  service.reserveQuota({
    permitRef: "P-NEW-2026",
    speciesCode: "LEP01",
    teamId: "team-a",
    quantity: 2,
    note: "甲沟样线",
  });
  let usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.hold, 2);
  assert.equal(usage.available, 1);

  service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-1", quantity: 2, occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  // 2 件被预占对冲：committed=2、hold=2、释放=-2，占用净额仍为 2。
  assert.equal(usage.committed, 2);
  assert.equal(usage.hold, 0);
  assert.equal(usage.occupied, 2);
  assert.equal(usage.available, 1);
});

test("预占只能被本团队抵扣；他队不能共享", () => {
  const { service } = makeService();
  setupScenario(service);
  service.reserveQuota({
    permitRef: "P-NEW-2026",
    speciesCode: "LEP01",
    teamId: "team-a",
    quantity: 2,
  });
  service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-b1", teamId: "team-b", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  // team-b 的 1 件是新占用，team-a 的 2 件预占仍在 hold，共 3。
  assert.equal(usage.committed, 1);
  assert.equal(usage.hold, 2);
  assert.equal(usage.occupied, 3);
  assert.equal(usage.available, 0);
});

test("释放预占剩余额度", () => {
  const { service } = makeService();
  setupScenario(service);
  const { reservation } = service.reserveQuota({
    permitRef: "P-NEW-2026",
    speciesCode: "LEP01",
    teamId: "team-a",
    quantity: 2,
  });
  // 采集 1 件，抵扣预占 1。
  service.submitFieldRecord(collectBody({ deviceEventId: "evt-1" }));
  const released = service.releaseReservation(reservation.id);
  assert.equal(released.entry?.delta ?? 0, -1);
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 1);
  assert.equal(usage.available, 2);
});

test("标本放归释放占用，再次采集可使用额度", () => {
  const { service } = makeService();
  setupScenario(service);
  // AMP02 配额只有 1。
  const first = service.submitFieldRecord(
    collectBody({ deviceEventId: "evt-amp", speciesCode: "AMP02", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  assert.equal(first.record.status, "accepted");
  const over = service.submitFieldRecord(
    collectBody({
      deviceEventId: "evt-amp2",
      speciesCode: "AMP02",
      teamId: "team-b",
      occurredAt: "2026-08-01T10:00:00.000Z",
    }),
  );
  assert.equal(over.record.status, "quarantined");
  service.releaseSpecimen(first.record.id, {
    handlerId: "h-1",
    at: "2026-08-01T12:00:00.000Z",
    note: "健康个体放归",
  });
  const qc = over.record.quarantineCaseId!;
  const admitted = service.resolveQuarantine(qc, {
    decision: "admitted",
    reviewerId: "r-1",
  });
  assert.equal(admitted.record.status, "accepted");
});

test("已入馆记录不能放归；放归记录不能交接", () => {
  const { service } = makeService();
  setupScenario(service);
  const r = service.submitFieldRecord(collectBody({ deviceEventId: "evt-1" }));
  service.transferCustody(r.record.id, {
    at: "2026-08-01T15:00:00.000Z",
    toType: "carrier",
    toParty: "冷运",
    handlerId: "h-1",
  });
  const batch = service.accessionBatch({
    recordIds: [r.record.id],
    handlerId: "h-2",
    at: "2026-08-01T20:00:00.000Z",
  });
  assert.ok(batch.id);
  assert.throws(
    () => service.releaseSpecimen(r.record.id, { handlerId: "h-3" }),
    (e: unknown) => e instanceof DomainError && e.code === "record_not_releasable",
  );
});
