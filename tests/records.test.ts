import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../src/domain/errors.js";
import { collectBody, makeService, setupScenario } from "./helpers.js";

test("设备事件号幂等：重复补传返回同一记录且不重复占额", () => {
  const { service } = makeService();
  setupScenario(service);
  const body = collectBody({ deviceEventId: "evt-1" });
  const first = service.submitFieldRecord(body);
  const second = service.submitFieldRecord(body);
  assert.equal(second.idempotent, true);
  assert.equal(second.record.id, first.record.id);
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 1);
});

test("同一设备事件号但载荷不一致返回冲突", () => {
  const { service } = makeService();
  setupScenario(service);
  service.submitFieldRecord(collectBody({ deviceEventId: "evt-1" }));
  assert.throws(
    () =>
      service.submitFieldRecord(
        collectBody({ deviceEventId: "evt-1", quantity: 2 }),
      ),
    (e: unknown) =>
      e instanceof DomainError &&
      e.code === "device_event_conflict" &&
      Array.isArray((e.details as { mismatch: string[] }).mismatch),
  );
});

test("两份离线记录指向同一标本：进入重复复核，结论可选合并或排除", () => {
  const { service } = makeService();
  setupScenario(service);
  // 同团队、同物种、同数量、同地点、相隔 2 分钟，两个不同设备事件。
  const a = service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-a", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  const b = service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-b", occurredAt: "2026-08-01T09:02:00.000Z" }),
  );
  assert.equal(a.record.status, "accepted");
  assert.equal(b.record.status, "duplicate_review");

  const candidates = service.listDuplicateCandidates("pending");
  assert.equal(candidates.length, 1);
  const candidate = candidates[0]!;
  assert.deepEqual(candidate.recordIds, [a.record.id, b.record.id]);

  // 确认重复：合并到在先记录，只占一件额度，副记录证据仍可查。
  const result = service.resolveDuplicate(candidate.id, {
    conclusion: "duplicate",
    reviewerId: "r-1",
  });
  const merged = result.records.find((r) => r.id === b.record.id)!;
  assert.equal(merged.status, "merged");
  assert.equal(merged.mergedIntoRecordId, a.record.id);
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 1);

  const explained = service.explainRecord(b.record.id);
  assert.equal(explained.mergedInto?.id, a.record.id);
  // 副记录的现场照片作为来源证据保留。
  assert.equal(explained.record.photos.length, 1);
});

test("重复候选判定为不同标本：在后记录转为正常占用", () => {
  const { service } = makeService();
  setupScenario(service);
  service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-a", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  const b = service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-b", occurredAt: "2026-08-01T09:02:00.000Z" }),
  );
  const candidate = service.listDuplicateCandidates("pending")[0]!;
  service.resolveDuplicate(candidate.id, {
    conclusion: "distinct",
    reviewerId: "r-1",
    note: "花纹不同，是两只",
  });
  assert.equal(service.requireRecord(b.record.id).status, "accepted");
  const usage = service.explainPermit("P-NEW-2026").usages.find(
    (u) => u.speciesCode === "LEP01",
  )!;
  assert.equal(usage.occupied, 2);
});

test("时间或地点相差足够大的两份记录不构成重复候选", () => {
  const { service } = makeService();
  setupScenario(service);
  service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-a", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  const far = service.submitFieldRecord(
    collectBody({ deviceEventId: "dup-c", occurredAt: "2026-08-01T12:00:00.000Z" }),
  );
  assert.equal(far.record.status, "accepted");
  assert.equal(service.listDuplicateCandidates().length, 0);
});

test("完整责任链：现场→合作单位→承运→入馆批次", () => {
  const { service } = makeService();
  setupScenario(service);
  const r = service.submitFieldRecord(
    collectBody({ deviceEventId: "chain-1", occurredAt: "2026-08-01T09:00:00.000Z" }),
  );
  service.transferCustody(r.record.id, {
    at: "2026-08-01T12:00:00.000Z",
    toType: "partner_institution",
    toParty: "山地研究所",
    handlerId: "h-partner",
    note: "联合考察交接",
  });
  service.transferCustody(r.record.id, {
    at: "2026-08-02T08:00:00.000Z",
    toType: "carrier",
    toParty: "冷运专线",
    handlerId: "h-carrier",
  });
  const batch = service.accessionBatch({
    recordIds: [r.record.id],
    handlerId: "h-museum",
    at: "2026-08-03T10:00:00.000Z",
    note: "夏季考察首批",
  });

  const explained = service.explainRecord(r.record.id);
  assert.equal(explained.record.status, "accessioned");
  assert.deepEqual(
    explained.responsibilityChain.map((c) => c.toType),
    ["field_team", "partner_institution", "carrier", "museum"],
  );
  assert.deepEqual(
    explained.responsibilityChain.map((c) => c.handlerId),
    ["collector-1", "h-partner", "h-carrier", "h-museum"],
  );
  assert.ok(explained.accessionBatch);
  assert.equal(explained.accessionBatch.id, batch.id);
  assert.deepEqual(explained.accessionBatch.recordIds, [r.record.id]);
});

test("入馆批次中任一记录不合格则整批拒绝", () => {
  const { service } = makeService();
  setupScenario(service);
  const ok = service.submitFieldRecord(collectBody({ deviceEventId: "ok-1" }));
  const bad = service.submitFieldRecord(
    collectBody({ deviceEventId: "bad-1", speciesCode: "REP99" }),
  );
  assert.equal(bad.record.status, "quarantined");
  assert.throws(
    () =>
      service.accessionBatch({
        recordIds: [ok.record.id, bad.record.id],
        handlerId: "h-1",
      }),
    (e: unknown) => e instanceof DomainError && e.code === "record_not_accessionable",
  );
  // 合格记录未被部分入馆。
  assert.equal(service.requireRecord(ok.record.id).status, "accepted");
  assert.equal(service.db.accessions.length, 0);
});

test("敏感物种坐标：未授权者只见模糊坐标，授权研究者与非敏感物种见精确值", () => {
  const { service } = makeService();
  setupScenario(service);
  const sensitive = service.submitFieldRecord(
    collectBody({
      deviceEventId: "sens-1",
      speciesCode: "AMP02",
      lng: 101.123456,
      lat: 31.654321,
      occurredAt: "2026-08-01T09:00:00.000Z",
    }),
  );
  const normal = service.submitFieldRecord(
    collectBody({ deviceEventId: "norm-1", lng: 101.123456, lat: 31.654321 }),
  );

  const anonView = service.explainRecord(sensitive.record.id);
  assert.equal(anonView.record.coordinatePrecision, "redacted");
  assert.equal(anonView.record.lng, 101.1);
  assert.equal(anonView.record.lat, 31.7);
  assert.equal(anonView.record.photos[0]!.lng, 101.1);

  const otherView = service.explainRecord(sensitive.record.id, "r-other");
  assert.equal(otherView.record.coordinatePrecision, "redacted");

  const authView = service.explainRecord(sensitive.record.id, "r-auth");
  assert.equal(authView.record.coordinatePrecision, "exact");
  assert.equal(authView.record.lng, 101.123456);
  assert.equal(authView.record.photos[0]!.lng, 101.123456);

  // 非敏感物种对所有人精确。
  const normalView = service.explainRecord(normal.record.id);
  assert.equal(normalView.record.coordinatePrecision, "exact");
  assert.equal(normalView.record.lat, 31.654321);
});

test("按考察队查询返回额度用量、记录与复核结论", () => {
  const { service } = makeService();
  setupScenario(service);
  service.submitFieldRecord(collectBody({ deviceEventId: "e-1" }));
  service.submitFieldRecord(
    collectBody({ deviceEventId: "e-2", teamId: "team-b", occurredAt: "2026-08-01T09:05:00.000Z", lng: 101.2 }),
  );
  const view = service.explainExpedition("exp-1");
  assert.equal(view.records.length, 2);
  const lep = view.quotaUsages.find((u) => u.speciesCode === "LEP01")!;
  assert.equal(lep.occupied, 2);
  assert.equal(lep.limit, 3);
  assert.equal(view.quarantineCases.length, 0);
});
