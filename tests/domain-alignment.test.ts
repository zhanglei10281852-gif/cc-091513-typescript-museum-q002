import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { COLLECTION_EVENTS, CUSTODY_PARTY_TYPES, PERMIT_STATES } from "../src/domain/types.js";

test("领域枚举与 reference/domain.json 保持一致", async () => {
  const url = new URL("../../reference/domain.json", import.meta.url);
  const reference = JSON.parse(await readFile(url, "utf8")) as Record<string, string[]>;
  assert.deepEqual([...PERMIT_STATES], reference["permit_states"]);
  assert.deepEqual([...COLLECTION_EVENTS], reference["collection_events"]);
  assert.deepEqual([...CUSTODY_PARTY_TYPES], reference["custody_types"]);
});
