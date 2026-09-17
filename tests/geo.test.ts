import assert from "node:assert/strict";
import { test } from "node:test";

import { pointWithinBounds, isValidLngLat } from "../src/domain/geo.js";
import type { GeoBounds } from "../src/domain/model.js";

test("包围盒内外判定", () => {
  const bounds: GeoBounds = { type: "bbox", bbox: [100, 30, 102, 32] };
  assert.equal(pointWithinBounds(101, 31, bounds), true);
  assert.equal(pointWithinBounds(100, 30, bounds), true);
  assert.equal(pointWithinBounds(99.9, 31, bounds), false);
  assert.equal(pointWithinBounds(101, 32.1, bounds), false);
});

test("跨 180 度经线的包围盒", () => {
  const bounds: GeoBounds = { type: "bbox", bbox: [170, -10, -170, 10] };
  assert.equal(pointWithinBounds(175, 0, bounds), true);
  assert.equal(pointWithinBounds(-175, 0, bounds), true);
  assert.equal(pointWithinBounds(180, 0, bounds), true);
  assert.equal(pointWithinBounds(0, 0, bounds), false);
});

test("多边形外环节点在内部、孔洞内为外部", () => {
  const polygon: GeoBounds = {
    type: "polygon",
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  };
  assert.equal(pointWithinBounds(2, 2, polygon), true);
  assert.equal(pointWithinBounds(5, 5, polygon), false);
  assert.equal(pointWithinBounds(11, 5, polygon), false);
});

test("经纬度合法性", () => {
  assert.equal(isValidLngLat(180, 90), true);
  assert.equal(isValidLngLat(181, 0), false);
  assert.equal(isValidLngLat(0, -91), false);
  assert.equal(isValidLngLat(Number.NaN, 0), false);
});
