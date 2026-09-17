import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JsonFileStore } from "../src/ledger/state.js";
import { COLLECTOR, createActivePermit, recordFixture, startTestApp } from "./helpers.js";

test("账册快照持久化并可恢复后继续服务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "permit-ledger-"));
  const path = join(dir, "ledger.json");

  const client = await startTestApp({ store: new JsonFileStore(path) });
  const permitId = await createActivePermit(client);
  const submitted = await client.api("POST", "/records", { body: recordFixture(), ...COLLECTOR });
  assert.equal(submitted.body.record.status, "accepted");
  const recordId = submitted.body.record.recordId as string;
  await client.close();

  // 从快照恢复
  const loaded = await new JsonFileStore(path).load();
  assert.ok(loaded);
  assert.ok(loaded.permits[permitId]);
  assert.ok(loaded.records[recordId]);
  assert.equal(loaded.quotaMovements.length, 1);

  // 恢复后的实例数据完整可查，且幂等索引仍然有效
  const restored = await startTestApp({ store: new JsonFileStore(path), state: loaded });
  try {
    const record = await restored.api("GET", `/records/${recordId}`);
    assert.equal(record.status, 200);
    assert.equal(record.body.record.recordId, recordId);

    const quota = await restored.api("GET", `/permits/${permitId}/quota`);
    assert.equal(quota.body.species.length > 0, true);

    const replay = await restored.api("POST", "/records", {
      body: recordFixture({
        deviceId: submitted.body.record.deviceId,
        deviceEventNo: submitted.body.record.deviceEventNo,
      }),
      ...COLLECTOR,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.record.recordId, recordId);
  } finally {
    await restored.close();
  }
});
