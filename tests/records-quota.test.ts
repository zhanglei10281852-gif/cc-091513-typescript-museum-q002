import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTOR,
  createActivePermit,
  PANDA,
  recordFixture,
  RHODODENDRON,
  startTestApp,
} from "./helpers.js";

test("采集接收占用配额，观察记录不占用", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);

    const collected = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    assert.equal(collected.body.record.status, "accepted");

    const observed = await client.api("POST", "/records", {
      body: recordFixture({ kind: "observed" }),
      ...COLLECTOR,
    });
    assert.equal(observed.body.record.status, "accepted");

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 1);
    assert.equal(panda.remaining, 2);
    assert.equal(panda.movements.length, 1);
    assert.equal(panda.movements[0].reason, "collection_accepted");
  } finally {
    await client.close();
  }
});

test("移动端补传按设备事件号幂等，并发重复也只入账一次", async () => {
  const client = await startTestApp();
  try {
    await createActivePermit(client);
    const payload = recordFixture({ deviceId: "dev-9", deviceEventNo: "evt-offline-42" });

    // 并发提交同一设备事件号
    const [first, second] = await Promise.all([
      client.api("POST", "/records", { body: payload, ...COLLECTOR }),
      client.api("POST", "/records", { body: payload, ...COLLECTOR }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    const replayed = first.status === 200 ? first : second;
    assert.equal(replayed.body.idempotentReplay, true);
    assert.equal(first.body.record.recordId, second.body.record.recordId);

    const records = await client.api("GET", "/records");
    assert.equal(records.body.records.length, 1);

    // 同一事件号但要素不一致 → 冲突
    const mismatched = await client.api("POST", "/records", {
      body: { ...payload, taxon: RHODODENDRON },
      ...COLLECTOR,
    });
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.error, "conflict");
  } finally {
    await client.close();
  }
});

test("多队伍并发占用配额不超采", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);

    // 大熊猫配额 3，两支考察队同时提交 10 份采集记录
    const submissions = Array.from({ length: 10 }, (_, i) =>
      client.api("POST", "/records", {
        body: recordFixture({
          deviceId: `dev-${i}`,
          deviceEventNo: `evt-race-${i}`,
          teamId: i % 2 === 0 ? "team-alpha" : "team-beta",
        }),
        ...COLLECTOR,
      }),
    );
    const results = await Promise.all(submissions);

    const accepted = results.filter((r) => r.body.record.status === "accepted");
    const quarantined = results.filter((r) => r.body.record.status === "quarantined");
    assert.equal(accepted.length, 3);
    assert.equal(quarantined.length, 7);
    for (const item of quarantined) {
      assert.ok(item.body.quarantineCase.issues.some((i: { code: string }) => i.code === "quota_exceeded"));
    }

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 3);
    assert.equal(panda.remaining, 0);
  } finally {
    await client.close();
  }
});

test("野外放归释放配额", async () => {
  const client = await startTestApp();
  try {
    const permitId = await createActivePermit(client);
    const submitted = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
    const recordId = submitted.body.record.recordId as string;

    const released = await client.api("POST", `/records/${recordId}/release`, {
      body: { reason: "个体健康状况不适合运输" },
      ...COLLECTOR,
    });
    assert.equal(released.status, 200);
    assert.equal(released.body.record.status, "released");

    const quota = await client.api("GET", `/permits/${permitId}/quota`);
    const panda = quota.body.species.find((s: { taxon: string }) => s.taxon === PANDA);
    assert.equal(panda.held, 0);
    assert.equal(panda.released, 1);
    assert.equal(panda.remaining, 3);
    assert.ok(panda.movements.some((m: { reason: string }) => m.reason === "specimen_released"));
  } finally {
    await client.close();
  }
});
