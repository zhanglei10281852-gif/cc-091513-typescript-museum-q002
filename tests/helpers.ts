import { LedgerService, type SubmitFieldInput } from "../src/domain/service.js";
import { Store } from "../src/store/store.js";

export interface Clock {
  now: () => Date;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}

export function fakeClock(start = "2026-08-02T00:00:00.000Z"): Clock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
}

export function makeService(clock?: Clock) {
  const c = clock ?? fakeClock();
  const store = new Store({ now: c.now });
  return { service: new LedgerService(store), store, clock: c };
}

export const PHOTO = "a".repeat(64);
export const PHOTO2 = "b".repeat(64);

/** 标准山地区县场景：两支团队、一个含旧编号的许可证、普通与敏感物种。 */
export function setupScenario(service: LedgerService) {
  service.upsertTaxon({ code: "LEP01", name: "山地凤蝶", sensitive: false });
  service.upsertTaxon({ code: "AMP02", name: "隐纹小鲵", sensitive: true });
  // 已登记但不在任何许可证范围内的物种。
  service.upsertTaxon({ code: "REP99", name: "外来爬行类", sensitive: false });
  service.upsertResearcher({
    id: "r-auth",
    name: "获授权研究员",
    sensitiveTaxa: ["AMP02"],
  });
  service.upsertResearcher({
    id: "r-other",
    name: "普通馆员",
    sensitiveTaxa: [],
  });
  service.upsertExpedition({
    id: "exp-1",
    name: "2026 夏季联合考察",
    teamIds: ["team-a", "team-b"],
  });
  const permit = service.createPermit({
    permitNumber: "P-NEW-2026",
    aliases: ["P-OLD-2025"],
    speciesCodes: ["LEP01", "AMP02"],
    bounds: { type: "bbox", bbox: [100.0, 30.0, 102.0, 32.0] },
    validFrom: "2026-07-01T00:00:00.000Z",
    validUntil: "2026-10-01T00:00:00.000Z",
    quotaLimits: { LEP01: 3, AMP02: 1 },
  });
  return permit;
}

export function collectBody(
  overrides: Partial<SubmitFieldInput> = {},
): SubmitFieldInput {
  const base: SubmitFieldInput = {
    deviceEventId: "dev-evt-1",
    expeditionId: "exp-1",
    teamId: "team-a",
    permitNumber: "P-NEW-2026",
    speciesCode: "LEP01",
    quantity: 1,
    lng: 101.0,
    lat: 31.0,
    occurredAt: "2026-08-01T09:00:00.000Z",
    collectorId: "collector-1",
    eventType: "collected",
    photos: [
      {
        sha256: PHOTO,
        takenAt: "2026-08-01T08:59:00.000Z",
        lng: 101.0,
        lat: 31.0,
      },
    ],
    ...overrides,
  };
  // 未显式给照片时，照片坐标跟随主体坐标，便于敏感坐标遮蔽断言。
  if (overrides.photos === undefined) {
    base.photos = [
      {
        sha256: PHOTO,
        takenAt: "2026-08-01T08:59:00.000Z",
        lng: base.lng,
        lat: base.lat,
      },
    ];
  }
  return base;
}
