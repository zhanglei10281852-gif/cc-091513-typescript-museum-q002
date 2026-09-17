import type {
  AccessionBatch,
  CollectionRecord,
  CustodyTransfer,
  Database,
  DuplicateCandidate,
  Expedition,
  FieldEventType,
  FieldPhoto,
  GeoBounds,
  Permit,
  PermitState,
  QuarantineCase,
  QuotaEntry,
  QuotaReservation,
  Researcher,
  Taxon,
} from "./model.js";
import { CUSTODY_TYPES, PERMIT_STATES } from "./model.js";
import {
  conflict,
  invalidInput,
  notFound,
} from "./errors.js";
import { isValidLngLat, pointWithinBounds } from "./geo.js";
import {
  assertAndReserve,
  entriesForRecord,
  getUsage,
  getUsageForExpedition,
  getUsageForPermit,
  releaseEntry,
} from "./quota.js";
import type { Store } from "../store/store.js";

const DUP_WINDOW_MS = 5 * 60 * 1000;

interface ConsumptionItem {
  hold: QuotaEntry;
  reservation: QuotaReservation;
  amount: number;
}

interface ConsumptionPlan {
  items: ConsumptionItem[];
  /** 可被预占抵扣的总量。 */
  consumed: number;
}

export interface SubmitFieldInput {
  deviceEventId: string;
  expeditionId: string;
  teamId: string;
  permitNumber: string;
  speciesCode: string;
  quantity: number;
  lng: number;
  lat: number;
  occurredAt: string;
  collectorId: string;
  eventType: FieldEventType;
  photos?: Array<{
    sha256: string;
    takenAt: string;
    lng?: number | undefined;
    lat?: number | undefined;
    caption?: string | undefined;
  }> | undefined;
}

export class LedgerService {
  constructor(private readonly store: Store) {
    this.db = store.db;
  }

  /** 底层账册（查询/测试直接读取；变更应走服务方法以保证台账一致）。 */
  readonly db: Database;

  // ---------- 基础档案 ----------

  upsertTaxon(input: {
    code: string;
    name: string;
    sensitive?: boolean | undefined;
  }): Taxon {
    let taxon = this.db.taxa.find((t) => t.code === input.code);
    if (!taxon) {
      taxon = { code: input.code, name: input.name, sensitive: false };
      this.db.taxa.push(taxon);
    } else {
      taxon.name = input.name;
    }
    if (input.sensitive !== undefined) taxon.sensitive = input.sensitive;
    this.store.persist();
    return taxon;
  }

  upsertResearcher(input: {
    id: string;
    name: string;
    sensitiveTaxa?: string[] | undefined;
  }): Researcher {
    let researcher = this.db.researchers.find((r) => r.id === input.id);
    if (!researcher) {
      researcher = { id: input.id, name: input.name, sensitiveTaxa: [] };
      this.db.researchers.push(researcher);
    } else {
      researcher.name = input.name;
    }
    if (input.sensitiveTaxa) researcher.sensitiveTaxa = input.sensitiveTaxa;
    this.store.persist();
    return researcher;
  }

  upsertExpedition(input: {
    id: string;
    name: string;
    teamIds?: string[] | undefined;
  }): Expedition {
    let expedition = this.db.expeditions.find((e) => e.id === input.id);
    if (!expedition) {
      expedition = {
        id: input.id,
        name: input.name,
        teamIds: input.teamIds ?? [],
        createdAt: this.store.nowIso(),
      };
      this.db.expeditions.push(expedition);
    } else {
      expedition.name = input.name;
      if (input.teamIds) expedition.teamIds = input.teamIds;
    }
    this.store.persist();
    return expedition;
  }

  // ---------- 许可证 ----------

  createPermit(input: {
    permitNumber: string;
    aliases?: string[] | undefined;
    speciesCodes: string[];
    bounds: GeoBounds;
    validFrom: string;
    validUntil: string;
    quotaLimits: Record<string, number>;
    initialState?: PermitState | undefined;
  }): Permit {
    this.validateBounds(input.bounds);
    const validFrom = new Date(Date.parse(input.validFrom));
    const validUntil = new Date(Date.parse(input.validUntil));
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime())) {
      throw invalidInput("invalid_field", "许可证有效期必须是 ISO 8601 时间");
    }
    if (validUntil <= validFrom) {
      throw invalidInput("invalid_field", "validUntil 必须晚于 validFrom");
    }
    for (const [code, limit] of Object.entries(input.quotaLimits)) {
      if (!input.speciesCodes.includes(code)) {
        throw invalidInput(
          "quota_species_not_listed",
          `配额物种 ${code} 不在物种范围内`,
        );
      }
      if (!Number.isInteger(limit) || limit < 0) {
        throw invalidInput("invalid_field", `物种 ${code} 配额必须是非负整数`);
      }
    }
    if (this.findPermitByNumber(input.permitNumber)) {
      throw conflict("permit_number_exists", `许可证编号 ${input.permitNumber} 已存在`);
    }
    const aliases = input.aliases ?? [];
    for (const alias of aliases) {
      if (this.findPermitByNumber(alias)) {
        throw conflict("permit_alias_exists", `旧编号 ${alias} 已被占用`);
      }
    }
    const now = this.store.nowIso();
    const initialState = input.initialState ?? "active";
    const permit: Permit = {
      id: this.store.genId(),
      permitNumber: input.permitNumber,
      aliases,
      speciesCodes: [...input.speciesCodes],
      bounds: input.bounds,
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
      quotaLimits: { ...input.quotaLimits },
      state: initialState,
      // 生效时刻即激活；更严格的流程可先建 draft 再激活。
      history:
        initialState === "active"
          ? [{ state: "active", at: validFrom.toISOString() }]
          : [{ state: initialState, at: now }],
      createdAt: now,
    };
    this.db.permits.push(permit);
    this.store.persist();
    return permit;
  }

  addPermitAlias(ref: string, alias: string): Permit {
    const permit = this.requirePermit(ref);
    if (permit.permitNumber === alias || permit.aliases.includes(alias)) {
      throw conflict("permit_alias_exists", `编号 ${alias} 已指向该许可证`);
    }
    if (this.findPermitByNumber(alias)) {
      throw conflict("permit_alias_exists", `编号 ${alias} 已被其他许可证占用`);
    }
    permit.aliases.push(alias);
    this.store.persist();
    return permit;
  }

  /**
   * 变更许可证状态。撤回/暂停只登记一个时间点：该时间点之后的采集被阻止，
   * 之前形成的记录、配额占用和证据链不受影响。
   */
  changePermitState(
    ref: string,
    target: PermitState,
    reason?: string,
    at?: string,
  ): Permit {
    const permit = this.requirePermit(ref);
    if (!PERMIT_STATES.includes(target)) {
      throw invalidInput("invalid_field", "许可证状态非法", { target });
    }
    const atIso = at
      ? new Date(Date.parse(at)).toISOString()
      : this.store.nowIso();
    if (Number.isNaN(Date.parse(atIso))) {
      throw invalidInput("invalid_field", "状态变更时间非法");
    }
    const last = permit.history[permit.history.length - 1];
    if (last && atIso < last.at) {
      throw conflict(
        "permit_state_order",
        "状态变更时间不能早于上一次变更",
      );
    }
    const current = this.permitStateAt(permit, this.store.nowIso());
    if (target === current) {
      throw conflict("permit_state_same", `许可证已处于 ${target} 状态`);
    }
    assertTransitionAllowed(current, target);
    permit.history.push({ state: target, at: atIso, reason });
    permit.state = this.permitStateAt(permit, this.store.nowIso());
    this.store.persist();
    return permit;
  }

  /**
   * 许可证在某时刻的有效状态：以状态变更历史为准，越过有效期自动视为 expired；
   * 历史中显式的 revoked/suspended 优先，不被有效期覆盖。
   */
  permitStateAt(permit: Permit, at: string): PermitState {
    let state: PermitState = "draft";
    for (const change of permit.history) {
      if (change.at <= at) state = change.state;
    }
    if (
      (state === "active" || state === "suspended") &&
      at > permit.validUntil
    ) {
      return "expired";
    }
    if (state === "draft" && at < permit.validFrom) return "draft";
    return state;
  }

  findPermitByNumber(number: string): Permit | undefined {
    return this.db.permits.find(
      (p) => p.permitNumber === number || p.aliases.includes(number),
    );
  }

  /**
   * 以事件发生时刻核验许可边界：物种范围、地理边界、有效期与许可状态。
   * 撤回（revoked）只对其生效时刻之后的事件构成违例。
   */
  boundaryViolations(
    record: { speciesCode: string; lng: number; lat: number; occurredAt: string },
    permit: Permit,
  ): string[] {
    const reasons: string[] = [];
    if (!permit.speciesCodes.includes(record.speciesCode)) {
      reasons.push("species_out_of_scope");
    }
    if (!pointWithinBounds(record.lng, record.lat, permit.bounds)) {
      reasons.push("location_out_of_bounds");
    }
    const stateAtEvent = this.permitStateAt(permit, record.occurredAt);
    if (stateAtEvent !== "active") {
      reasons.push(`permit_${stateAtEvent}_at_event`);
    }
    return reasons;
  }

  requirePermit(ref: string): Permit {
    const permit =
      this.db.permits.find((p) => p.id === ref) ?? this.findPermitByNumber(ref);
    if (!permit) throw notFound("permit_not_found", `许可证 ${ref} 不存在`);
    return permit;
  }

  // ---------- 现场记录提交（幂等） ----------

  submitFieldRecord(input: SubmitFieldInput): {
    record: CollectionRecord;
    idempotent: boolean;
  } {
    // 设备事件号幂等：补传同一事件直接返回既有记录，绝不重复占用配额。
    const existing = this.db.records.find(
      (r) => r.deviceEventId === input.deviceEventId,
    );
    if (existing) {
      const mismatch = idempotencyMismatch(existing, input);
      if (mismatch) {
        throw conflict(
          "device_event_conflict",
          `设备事件号 ${input.deviceEventId} 已存在但载荷不一致`,
          { mismatch },
        );
      }
      return { record: existing, idempotent: true };
    }

    // ---- 输入校验（任何写入之前完成） ----
    const occurredAt = new Date(Date.parse(input.occurredAt));
    if (Number.isNaN(occurredAt.getTime())) {
      throw invalidInput("invalid_field", "occurredAt 必须是 ISO 8601 时间");
    }
    if (occurredAt.getTime() > this.store.now().getTime() + 60_000) {
      throw invalidInput("event_in_future", "采集事件时间不能晚于当前时间");
    }
    const occurredAtIso = occurredAt.toISOString();

    const expedition = this.db.expeditions.find(
      (e) => e.id === input.expeditionId,
    );
    if (!expedition) throw notFound("expedition_not_found", "考察队不存在");
    if (!expedition.teamIds.includes(input.teamId)) {
      throw invalidInput(
        "team_not_in_expedition",
        `团队 ${input.teamId} 不属于考察队 ${input.expeditionId}`,
      );
    }
    const taxon = this.db.taxa.find((t) => t.code === input.speciesCode);
    if (!taxon) throw notFound("taxon_not_found", `物种 ${input.speciesCode} 未登记`);
    if (!isValidLngLat(input.lng, input.lat)) {
      throw invalidInput("invalid_coordinates", "经纬度非法");
    }
    if (input.eventType !== "observed" && input.eventType !== "collected") {
      throw invalidInput("invalid_field", "现场事件只能是 observed 或 collected");
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw invalidInput("invalid_field", "quantity 必须是正整数");
    }
    const photos = this.parsePhotos(input.photos ?? []);

    // ---- 边界核验（以事件发生时刻为准） ----
    // 无法解析许可证号（合作方旧编号未登记）等问题全部进入隔离复核，而不是丢弃记录。
    const permit = this.findPermitByNumber(input.permitNumber);
    const reasons = permit
      ? this.boundaryViolations(
          {
            speciesCode: input.speciesCode,
            lng: input.lng,
            lat: input.lat,
            occurredAt: occurredAtIso,
          },
          permit,
        )
      : ["permit_number_unresolved"];

    // ---- 配额预检 ----
    // 采集记录先测算可抵扣的本团队预占，净增量必须落在剩余额度内；
    // 超出数量边界（含许可证根本未给该物种列配额）同样进入隔离复核，
    // 不写入任何占用，因此并发下也不会超采。
    let consumptionPlan: ConsumptionPlan | null = null;
    if (permit && reasons.length === 0 && input.eventType === "collected") {
      consumptionPlan = this.planConsumption(
        input.teamId,
        permit,
        input.speciesCode,
        input.quantity,
      );
      const usage = getUsage(this.db, permit.id, input.speciesCode);
      if (usage.limit === null) {
        reasons.push("quota_not_defined");
      } else {
        const net = input.quantity - consumptionPlan.consumed;
        if (net > (usage.available ?? 0)) {
          reasons.push("quota_exceeded");
        }
      }
    }

    const receivedAt = this.store.nowIso();
    const recordId = this.store.genId();
    const custody: CustodyTransfer[] =
      input.eventType === "collected"
        ? [
            {
              seq: 0,
              at: occurredAtIso,
              fromType: null,
              toType: "field_team",
              fromParty: null,
              toParty: input.teamId,
              handlerId: input.collectorId,
              note: "现场采集",
            },
          ]
        : [];

    const record: CollectionRecord = {
      id: recordId,
      deviceEventId: input.deviceEventId,
      expeditionId: input.expeditionId,
      teamId: input.teamId,
      permitNumberUsed: input.permitNumber,
      permitId: permit ? permit.id : null,
      status: "accepted",
      quarantineCaseId: null,
      duplicateCandidateIds: [],
      mergedIntoRecordId: null,
      accessionId: null,
      releasedAt: null,
      speciesCode: input.speciesCode,
      quantity: input.quantity,
      lng: input.lng,
      lat: input.lat,
      occurredAt: occurredAtIso,
      receivedAt,
      collectorId: input.collectorId,
      eventType: input.eventType,
      photos,
      custody,
      createdAt: receivedAt,
    };
    this.db.records.push(record);

    if (reasons.length > 0) {
      record.status = "quarantined";
      const qc: QuarantineCase = {
        id: this.store.genId(),
        recordId,
        reasons,
        openedAt: receivedAt,
      };
      this.db.quarantineCases.push(qc);
      record.quarantineCaseId = qc.id;
      this.store.persist();
      return { record, idempotent: false };
    }

    // 通过边界核验后再查重，避免隔离记录互相遮蔽。
    const duplicateOf = this.findDuplicate(record);
    if (duplicateOf) {
      record.status = "duplicate_review";
      const candidate: DuplicateCandidate = {
        id: this.store.genId(),
        fingerprint: duplicateOf.fingerprint,
        recordIds: [duplicateOf.record.id, record.id],
        status: "pending",
        openedAt: receivedAt,
      };
      this.db.duplicateCandidates.push(candidate);
      record.duplicateCandidateIds.push(candidate.id);
      duplicateOf.record.duplicateCandidateIds.push(candidate.id);
      this.store.persist();
      return { record, idempotent: false };
    }

    // 观察记录不持有标本、不占配额；采集记录写入“预占对冲 + 确认占用”。
    // 全程同步执行，多团队并发排队，余额不足已在预检拦截，绝不超采。
    if (input.eventType === "collected" && permit && consumptionPlan) {
      this.applyConsumption(record, permit, consumptionPlan);
      this.commitRecordQuota(record, permit, "现场采集占用");
    }

    this.store.persist();
    return { record, idempotent: false };
  }

  private parsePhotos(
    input: NonNullable<SubmitFieldInput["photos"]>,
  ): FieldPhoto[] {
    const seen = new Set<string>();
    return input.map((p, index) => {
      if (!/^[a-f0-9]{64}$/i.test(p.sha256)) {
        throw invalidInput("invalid_photo_hash", `照片 ${index} 的 sha256 非法`);
      }
      const hash = p.sha256.toLowerCase();
      if (seen.has(hash)) {
        throw invalidInput("duplicate_photo_hash", `照片哈希 ${hash} 重复`);
      }
      seen.add(hash);
      const takenAt = Date.parse(p.takenAt);
      if (Number.isNaN(takenAt)) {
        throw invalidInput("invalid_field", `照片 ${index} 的 takenAt 非法`);
      }
      let lng: number | undefined;
      let lat: number | undefined;
      if (p.lng !== undefined || p.lat !== undefined) {
        if (
          typeof p.lng !== "number" ||
          typeof p.lat !== "number" ||
          !isValidLngLat(p.lng, p.lat)
        ) {
          throw invalidInput("invalid_coordinates", `照片 ${index} 坐标非法`);
        }
        lng = p.lng;
        lat = p.lat;
      }
      return {
        id: this.store.genId(),
        sha256: hash,
        takenAt: new Date(takenAt).toISOString(),
        lng,
        lat,
        caption: p.caption,
      };
    });
  }

  private commitRecordQuota(
    record: CollectionRecord,
    permit: Permit,
    reason: string,
  ): QuotaEntry {
    return assertAndReserve(this.db, {
      id: this.store.genId(),
      at: this.store.nowIso(),
      permitId: permit.id,
      speciesCode: record.speciesCode,
      recordId: record.id,
      delta: record.quantity,
      phase: "committed",
      reason,
    });
  }

  /**
   * 确定性重复指纹：同团队、同物种、同数量、5 分钟时间桶、约 100 米网格单元。
   * 两份离线记录落入同一指纹即成为候选，交人工复核而不自动合并。
   */
  private findDuplicate(
    record: CollectionRecord,
  ): { record: CollectionRecord; fingerprint: string } | null {
    const fingerprint = duplicateFingerprint(record);
    for (const other of this.db.records) {
      if (other.id === record.id) continue;
      // 隔离中的记录自身尚未准入，不作为重复锚点；准入时会补做查重。
      if (
        other.status === "merged" ||
        other.status === "rejected" ||
        other.status === "quarantined"
      )
        continue;
      if (other.speciesCode !== record.speciesCode) continue;
      if (other.teamId !== record.teamId) continue;
      if (other.quantity !== record.quantity) continue;
      if (duplicateFingerprint(other) !== fingerprint) continue;
      if (
        Math.abs(
          Date.parse(other.occurredAt) - Date.parse(record.occurredAt),
        ) > DUP_WINDOW_MS
      ) {
        continue;
      }
      return { record: other, fingerprint };
    }
    return null;
  }

  // ---------- 配额预占（多团队并发） ----------

  reserveQuota(input: {
    permitRef: string;
    speciesCode: string;
    teamId: string;
    quantity: number;
    note?: string | undefined;
  }): { reservation: QuotaReservation; entry: QuotaEntry } {
    const permit = this.requirePermit(input.permitRef);
    if (!permit.speciesCodes.includes(input.speciesCode)) {
      throw invalidInput(
        "species_out_of_scope",
        `物种 ${input.speciesCode} 不在许可证范围内`,
      );
    }
    if (!this.db.expeditions.some((e) => e.teamIds.includes(input.teamId))) {
      throw notFound("team_not_found", `团队 ${input.teamId} 不存在`);
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw invalidInput("invalid_field", "预占数量必须是正整数");
    }
    const stateNow = this.permitStateAt(permit, this.store.nowIso());
    if (stateNow !== "active") {
      throw conflict(
        `permit_${stateNow}`,
        `许可证当前为 ${stateNow}，不能预占配额`,
      );
    }
    const id = this.store.genId();
    const entry = assertAndReserve(this.db, {
      id: this.store.genId(),
      at: this.store.nowIso(),
      permitId: permit.id,
      speciesCode: input.speciesCode,
      recordId: null,
      reservationId: id,
      teamId: input.teamId,
      delta: input.quantity,
      phase: "hold",
      reason: input.note ? `团队预占：${input.note}` : "团队出发前预占",
    });
    const reservation: QuotaReservation = {
      id,
      permitId: permit.id,
      speciesCode: input.speciesCode,
      teamId: input.teamId,
      quantity: input.quantity,
      consumedQuantity: 0,
      createdAt: this.store.nowIso(),
      releasedAt: null,
      note: input.note,
    };
    this.db.reservations.push(reservation);
    this.store.persist();
    return { reservation, entry };
  }

  /** 释放预占单尚未被采集抵扣的剩余额度；已全部抵扣时返回 null。 */
  releaseReservation(
    reservationId: string,
  ): { reservation: QuotaReservation; entry: QuotaEntry | null } {
    const reservation = this.db.reservations.find((r) => r.id === reservationId);
    if (!reservation) throw notFound("reservation_not_found", "预占单不存在");
    if (reservation.releasedAt) {
      throw conflict("reservation_closed", "预占单已释放");
    }
    const hold = this.db.quotaEntries.find(
      (e) => e.reservationId === reservation.id && e.phase === "hold" && e.delta > 0,
    );
    if (!hold) throw new Error("预占配额条目缺失，数据不一致");
    const remaining = reservation.quantity - reservation.consumedQuantity;
    let entry: QuotaEntry | null = null;
    if (remaining > 0) {
      entry = releaseEntry(
        this.db,
        {
          id: this.store.genId(),
          at: this.store.nowIso(),
          permitId: reservation.permitId,
          speciesCode: reservation.speciesCode,
          recordId: null,
          reservationId: reservation.id,
          teamId: reservation.teamId,
          reason: "预占剩余释放",
        },
        hold,
        remaining,
      );
    }
    reservation.releasedAt = this.store.nowIso();
    this.store.persist();
    return { reservation, entry };
  }

  /**
   * 纯测算：按先进先出找出本团队同许可证同物种可抵扣的有效预占，不产生任何变更。
   * 预检阶段调用，保证超限时没有任何写入。
   */
  private planConsumption(
    teamId: string,
    permit: Permit,
    speciesCode: string,
    quantity: number,
  ): ConsumptionPlan {
    let needed = quantity;
    const items: ConsumptionItem[] = [];
    const holds = this.db.quotaEntries.filter(
      (e) =>
        e.phase === "hold" &&
        e.delta > 0 &&
        e.recordId === null &&
        e.reservationId !== undefined &&
        e.teamId === teamId &&
        e.permitId === permit.id &&
        e.speciesCode === speciesCode,
    );
    for (const hold of holds) {
      if (needed <= 0) break;
      const reservation = this.db.reservations.find(
        (r) => r.id === hold.reservationId,
      );
      if (!reservation || reservation.releasedAt) continue;
      const remaining = reservation.quantity - reservation.consumedQuantity;
      if (remaining <= 0) continue;
      const amount = Math.min(remaining, needed);
      items.push({ hold, reservation, amount });
      needed -= amount;
    }
    return {
      items,
      consumed: quantity - needed,
    };
  }

  /** 应用测算结果：写预占对冲条目并累加预占单的已抵扣量。 */
  private applyConsumption(
    record: CollectionRecord,
    permit: Permit,
    plan: ConsumptionPlan,
  ): void {
    for (const item of plan.items) {
      releaseEntry(
        this.db,
        {
          id: this.store.genId(),
          at: this.store.nowIso(),
          permitId: permit.id,
          speciesCode: record.speciesCode,
          recordId: record.id,
          reservationId: item.reservation.id,
          teamId: record.teamId,
          reason: `采集记录 ${record.deviceEventId} 抵扣预占`,
        },
        item.hold,
        item.amount,
      );
      item.reservation.consumedQuantity += item.amount;
    }
  }

  // ---------- 标本放归（释放配额） ----------

  releaseSpecimen(
    recordId: string,
    input: { handlerId: string; at?: string | undefined; note?: string | undefined },
  ): CollectionRecord {
    const record = this.requireRecord(recordId);
    if (record.eventType !== "collected") {
      throw conflict("not_collectable", "观察记录没有可释放的标本");
    }
    if (record.status !== "accepted") {
      throw conflict(
        "record_not_releasable",
        `记录状态为 ${record.status}，只有在库（accepted）记录可以放归`,
      );
    }
    const at = input.at
      ? new Date(Date.parse(input.at)).toISOString()
      : this.store.nowIso();
    if (at < record.occurredAt) {
      throw invalidInput("invalid_field", "放归时间不能早于采集时间");
    }
    // 对每条仍占用余额的正向条目做对冲释放。
    const active = entriesForRecord(this.db, record.id).filter(
      (e) => e.delta > 0 && !this.isReleased(e.id),
    );
    for (const hold of active) {
      releaseEntry(
        this.db,
        {
          id: this.store.genId(),
          at,
          permitId: hold.permitId,
          speciesCode: hold.speciesCode,
          recordId: record.id,
          reason: input.note ? `野外放归：${input.note}` : "野外放归",
        },
        hold,
      );
    }
    const holder = [...record.custody].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq,
    )[record.custody.length - 1];
    record.status = "released";
    record.releasedAt = at;
    record.custody.push({
      seq: record.custody.length,
      at,
      fromType: holder ? holder.toType : null,
      toType: "field_team",
      fromParty: holder ? holder.toParty : null,
      toParty: "野外放归",
      handlerId: input.handlerId,
      note: input.note ?? "标本放归，配额释放",
    });
    this.store.persist();
    return record;
  }

  private isReleased(entryId: string): boolean {
    return this.db.quotaEntries.some((e) => e.releasesEntryId === entryId);
  }

  // ---------- 经手交接 ----------

  transferCustody(
    recordId: string,
    input: {
      at: string;
      toType: CustodyTransfer["toType"];
      toParty: string;
      handlerId: string;
      note?: string | undefined;
    },
  ): CustodyTransfer {
    const record = this.requireRecord(recordId);
    if (record.eventType !== "collected") {
      throw conflict("not_transferable", "观察记录无标本可交接");
    }
    if (record.status === "quarantined" || record.status === "duplicate_review") {
      throw conflict("record_in_review", "记录仍在复核中，不能交接标本");
    }
    if (record.status === "released" || record.status === "rejected") {
      throw conflict("record_closed", `记录状态为 ${record.status}，不能交接`);
    }
    if (record.status === "accessioned") {
      throw conflict("record_accessioned", "记录已入馆，不能再进行现场交接");
    }
    if (!CUSTODY_TYPES.includes(input.toType)) {
      throw invalidInput("invalid_field", "交接对象类型非法");
    }
    const at = new Date(Date.parse(input.at));
    if (Number.isNaN(at.getTime())) {
      throw invalidInput("invalid_field", "交接时间必须是 ISO 8601 时间");
    }
    if (at.toISOString() < record.occurredAt) {
      throw invalidInput("invalid_field", "交接时间不能早于采集时间");
    }
    const last = [...record.custody].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq,
    )[record.custody.length - 1];
    const transfer: CustodyTransfer = {
      seq: record.custody.length,
      at: at.toISOString(),
      fromType: last ? last.toType : null,
      toType: input.toType,
      fromParty: last ? last.toParty : null,
      toParty: input.toParty,
      handlerId: input.handlerId,
      note: input.note,
    };
    record.custody.push(transfer);
    this.store.persist();
    return transfer;
  }

  // ---------- 入馆批次 ----------

  accessionBatch(input: {
    recordIds: string[];
    handlerId: string;
    at?: string | undefined;
    note?: string | undefined;
  }): AccessionBatch {
    if (input.recordIds.length === 0) {
      throw invalidInput("invalid_field", "入馆批次至少包含一条记录");
    }
    const at = input.at
      ? new Date(Date.parse(input.at)).toISOString()
      : this.store.nowIso();
    const records: CollectionRecord[] = [];
    for (const id of input.recordIds) {
      const record = this.requireRecord(id);
      if (record.eventType !== "collected") {
        throw conflict("not_accessionable", `记录 ${id} 是观察记录，不能入馆`);
      }
      if (record.status !== "accepted") {
        throw conflict(
          "record_not_accessionable",
          `记录 ${id} 状态为 ${record.status}，不能入馆`,
        );
      }
      records.push(record);
    }
    const batch: AccessionBatch = {
      id: this.store.genId(),
      at,
      handlerId: input.handlerId,
      recordIds: input.recordIds,
      note: input.note,
      createdAt: this.store.nowIso(),
    };
    this.db.accessions.push(batch);
    for (const record of records) {
      const last = [...record.custody].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq,
      )[record.custody.length - 1];
      record.custody.push({
        seq: record.custody.length,
        at,
        fromType: last ? last.toType : null,
        fromParty: last ? last.toParty : null,
        toType: "museum",
        toParty: "museum",
        handlerId: input.handlerId,
        note: `入馆批次 ${batch.id}`,
      });
      record.status = "accessioned";
      record.accessionId = batch.id;
    }
    this.store.persist();
    return batch;
  }

  // ---------- 隔离复核 ----------

  resolveQuarantine(
    caseId: string,
    input: { decision: "admitted" | "rejected"; reviewerId: string; note?: string | undefined },
  ): { quarantineCase: QuarantineCase; record: CollectionRecord } {
    const qc = this.db.quarantineCases.find((c) => c.id === caseId);
    if (!qc) throw notFound("quarantine_not_found", "隔离案例不存在");
    if (qc.decision) throw conflict("quarantine_closed", "隔离案例已复核");
    const record = this.requireRecord(qc.recordId);

    if (input.decision === "rejected") {
      // 拒绝：证据（记录、照片、原因）原样保留，仅置状态。
      applyDecision(qc, input, this.store.nowIso());
      record.status = "rejected";
      this.store.persist();
      return { quarantineCase: qc, record };
    }

    // 准入校验必须全部通过后才写复核结论，避免“已复核但实际未准入”。
    // 1) 重新解析许可证（隔离期间可能补登了旧编号别名）并复核全部边界。
    let permit: Permit | null = record.permitId
      ? this.requirePermit(record.permitId)
      : null;
    if (!permit) {
      const resolved = this.findPermitByNumber(record.permitNumberUsed);
      if (!resolved) {
        throw conflict(
          "permit_unresolved",
          "许可证编号仍无法解析，不能准入；请先登记旧编号别名后重新复核或拒绝",
        );
      }
      const remainingReasons = this.boundaryViolations(record, resolved);
      if (remainingReasons.length > 0) {
        throw conflict(
          "permit_boundary_still_violated",
          "重新解析后仍超出许可边界",
          { reasons: remainingReasons },
        );
      }
      permit = resolved;
    } else {
      const remainingReasons = this.boundaryViolations(record, permit);
      if (remainingReasons.length > 0) {
        throw conflict(
          "permit_boundary_still_violated",
          "记录仍超出许可证边界",
          { reasons: remainingReasons },
        );
      }
    }

    // 2) 补做查重（隔离期间未做）。
    const duplicateOf = this.findDuplicate(record);

    // 3) 采集记录测算预占抵扣并硬校验剩余额度。
    let plan: ConsumptionPlan | null = null;
    if (record.eventType === "collected") {
      plan = this.planConsumption(
        record.teamId,
        permit,
        record.speciesCode,
        record.quantity,
      );
      const usage = getUsage(this.db, permit.id, record.speciesCode);
      if (usage.limit === null) {
        throw conflict(
          "quota_not_defined",
          `许可证未为物种 ${record.speciesCode} 设定配额，不能准入`,
        );
      }
      const net = record.quantity - plan.consumed;
      if (net > (usage.available ?? 0)) {
        throw conflict(
          "quota_exceeded",
          "复核准入时剩余配额不足",
          { limit: usage.limit, occupied: usage.occupied, requested: net },
        );
      }
    }

    // 所有校验通过：写复核结论。
    applyDecision(qc, input, this.store.nowIso());
    record.permitId = permit.id;

    if (duplicateOf) {
      // 准入但与既有记录疑似同一标本：转入重复复核，暂不占配额。
      record.status = "duplicate_review";
      const candidate: DuplicateCandidate = {
        id: this.store.genId(),
        fingerprint: duplicateOf.fingerprint,
        recordIds: [duplicateOf.record.id, record.id],
        status: "pending",
        openedAt: this.store.nowIso(),
      };
      this.db.duplicateCandidates.push(candidate);
      record.duplicateCandidateIds.push(candidate.id);
      duplicateOf.record.duplicateCandidateIds.push(candidate.id);
      this.store.persist();
      return { quarantineCase: qc, record };
    }

    if (record.eventType === "collected" && plan) {
      this.applyConsumption(record, permit, plan);
      this.commitRecordQuota(record, permit, "隔离复核通过后占用");
    }
    record.status = "accepted";
    this.store.persist();
    return { quarantineCase: qc, record };
  }

  // ---------- 重复候选复核 ----------

  resolveDuplicate(
    candidateId: string,
    input: {
      conclusion: "distinct" | "duplicate";
      reviewerId: string;
      primaryRecordId?: string | undefined;
      note?: string | undefined;
    },
  ): { candidate: DuplicateCandidate; records: CollectionRecord[] } {
    const candidate = this.db.duplicateCandidates.find(
      (c) => c.id === candidateId,
    );
    if (!candidate) throw notFound("duplicate_not_found", "重复候选不存在");
    if (candidate.status === "resolved") {
      throw conflict("duplicate_closed", "重复候选已复核");
    }
    const [firstId, secondId] = candidate.recordIds;
    const first = this.requireRecord(firstId);
    const second = this.requireRecord(secondId);

    candidate.status = "resolved";
    candidate.conclusion = input.conclusion;
    candidate.decidedAt = this.store.nowIso();
    candidate.reviewerId = input.reviewerId;
    candidate.note = input.note;

    if (input.conclusion === "duplicate") {
      const primaryId = input.primaryRecordId ?? firstId;
      if (!candidate.recordIds.includes(primaryId)) {
        throw invalidInput(
          "invalid_primary",
          "主记录必须是候选中的一条",
        );
      }
      const duplicate = primaryId === first.id ? second : first;
      const primary = primaryId === first.id ? first : second;
      candidate.primaryRecordId = primary.id;
      // 合并：副记录不占配额（在先主记录已计数）；证据与交接链原样保留可查。
      duplicate.status = "merged";
      duplicate.mergedIntoRecordId = primary.id;
      this.store.persist();
      return { candidate, records: [primary, duplicate] };
    }

    // 判定为不同标本：在后记录转为正常占用。先抵扣本团队预占；若净增量
    // 仍超出此刻余额（可能已被其他团队用完），不能强行准入，转入隔离复核。
    if (second.eventType === "collected" && second.permitId) {
      const permit = this.requirePermit(second.permitId);
      const plan = this.planConsumption(
        second.teamId,
        permit,
        second.speciesCode,
        second.quantity,
      );
      const usage = getUsage(this.db, permit.id, second.speciesCode);
      const net = second.quantity - plan.consumed;
      if (usage.limit !== null && net > (usage.available ?? 0)) {
        second.status = "quarantined";
        const qc: QuarantineCase = {
          id: this.store.genId(),
          recordId: second.id,
          reasons: ["quota_exceeded_after_duplicate_review"],
          openedAt: this.store.nowIso(),
        };
        this.db.quarantineCases.push(qc);
        second.quarantineCaseId = qc.id;
        this.store.persist();
        return { candidate, records: [first, second] };
      }
      this.applyConsumption(second, permit, plan);
      this.commitRecordQuota(second, permit, "重复候选排除后占用");
    }
    second.status = "accepted";
    this.store.persist();
    return { candidate, records: [first, second] };
  }

  // ---------- 查询 ----------

  requireRecord(id: string): CollectionRecord {
    const record = this.db.records.find((r) => r.id === id);
    if (!record) throw notFound("record_not_found", `记录 ${id} 不存在`);
    return record;
  }

  /** 记录全链路视图：责任链、配额台账、隔离与重复结论、入馆批次。 */
  explainRecord(recordId: string, viewerResearcherId?: string) {
    const record = this.requireRecord(recordId);
    const viewer = viewerResearcherId
      ? (this.db.researchers.find((r) => r.id === viewerResearcherId) ?? null)
      : null;
    if (viewerResearcherId && !viewer) {
      throw notFound("researcher_not_found", "研究人员不存在");
    }
    const permit = record.permitId
      ? this.db.permits.find((p) => p.id === record.permitId)
      : undefined;
    const taxon = this.db.taxa.find((t) => t.code === record.speciesCode);
    const quotaEntries = entriesForRecord(this.db, record.id).map((e) => ({
      ...e,
      releasedBy: this.db.quotaEntries
        .filter((r) => r.releasesEntryId === e.id)
        .map((r) => r.id),
    }));
    const quarantineCase = record.quarantineCaseId
      ? this.db.quarantineCases.find((c) => c.id === record.quarantineCaseId)
      : undefined;
    const duplicates = this.db.duplicateCandidates
      .filter((c) => c.recordIds.includes(record.id))
      .map((c) => ({
        ...c,
        otherRecordId:
          c.recordIds.find((id) => id !== record.id) ?? null,
      }));
    const accession = record.accessionId
      ? this.db.accessions.find((a) => a.id === record.accessionId)
      : undefined;
    const chain = [...record.custody].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq,
    );
    return {
      record: projectRecord(record, taxon ?? null, viewer),
      permit: permit
        ? {
            id: permit.id,
            permitNumber: permit.permitNumber,
            aliases: permit.aliases,
            stateAtEvent: this.permitStateAt(permit, record.occurredAt),
          }
        : null,
      responsibilityChain: chain,
      quotaEntries,
      quarantineCase,
      duplicateCandidates: duplicates,
      accessionBatch: accession ?? null,
      mergedInto: record.mergedIntoRecordId
        ? this.deriveRecordRef(record.mergedIntoRecordId)
        : null,
    };
  }

  private deriveRecordRef(id: string) {
    const r = this.db.records.find((x) => x.id === id);
    return r
      ? {
          id: r.id,
          deviceEventId: r.deviceEventId,
          speciesCode: r.speciesCode,
          occurredAt: r.occurredAt,
        }
      : null;
  }

  /** 许可证视角：每个物种额度的限制、占用、预占、释放明细。 */
  explainPermit(ref: string) {
    const permit = this.requirePermit(ref);
    const usages = getUsageForPermit(this.db, permit.id).map((usage) => ({
      ...usage,
      entries: this.db.quotaEntries
        .filter(
          (e) =>
            e.permitId === permit.id && e.speciesCode === usage.speciesCode,
        )
        .map((e) => ({
          ...e,
          deviceEventId: e.recordId
            ? (this.db.records.find((r) => r.id === e.recordId)?.deviceEventId ??
              null)
            : null,
        })),
    }));
    const records = this.db.records
      .filter((r) => r.permitId === permit.id)
      .map((r) => this.recordSummary(r));
    const reservations = this.db.reservations.filter(
      (r) => r.permitId === permit.id,
    );
    return {
      permit: {
        ...permit,
        currentState: this.permitStateAt(permit, this.store.nowIso()),
      },
      usages,
      reservations,
      records,
    };
  }

  /** 考察队视角：各许可证额度用量、记录与复核结论。 */
  explainExpedition(expeditionId: string) {
    const expedition = this.db.expeditions.find(
      (e) => e.id === expeditionId,
    );
    if (!expedition) throw notFound("expedition_not_found", "考察队不存在");
    const records = this.db.records
      .filter((r) => r.expeditionId === expeditionId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .map((r) => this.recordSummary(r));
    const usages = getUsageForExpedition(this.db, expeditionId);
    const duplicateCandidates = this.db.duplicateCandidates.filter((c) =>
      c.recordIds.some((id) =>
        this.db.records.find(
          (r) => r.id === id && r.expeditionId === expeditionId,
        ),
      ),
    );
    const quarantineCases = this.db.quarantineCases.filter((qc) =>
      this.db.records.find(
        (r) => r.id === qc.recordId && r.expeditionId === expeditionId,
      ),
    );
    return {
      expedition,
      records,
      quotaUsages: usages,
      duplicateCandidates,
      quarantineCases,
    };
  }

  private recordSummary(record: CollectionRecord) {
    return {
      id: record.id,
      deviceEventId: record.deviceEventId,
      teamId: record.teamId,
      speciesCode: record.speciesCode,
      quantity: record.quantity,
      eventType: record.eventType,
      occurredAt: record.occurredAt,
      receivedAt: record.receivedAt,
      permitNumberUsed: record.permitNumberUsed,
      permitId: record.permitId,
      status: record.status,
      accessionId: record.accessionId,
      quarantineCaseId: record.quarantineCaseId,
    };
  }

  listDuplicateCandidates(status?: "pending" | "resolved") {
    return this.db.duplicateCandidates.filter((c) =>
      status ? c.status === status : true,
    );
  }

  listQuarantineCases(openOnly = false) {
    return this.db.quarantineCases.filter((c) =>
      openOnly ? !c.decision : true,
    );
  }

  /** 记录检索：可按许可证（当前号或旧编号）、考察队过滤，按权限遮蔽坐标。 */
  listRecords(filter: {
    permitRef?: string | undefined;
    expeditionId?: string | undefined;
    status?: CollectionRecord["status"] | undefined;
    viewerResearcherId?: string | undefined;
  }) {
    const viewer = filter.viewerResearcherId
      ? (this.db.researchers.find((r) => r.id === filter.viewerResearcherId) ?? null)
      : null;
    if (filter.viewerResearcherId && !viewer) {
      throw notFound("researcher_not_found", "研究人员不存在");
    }
    const permitId = filter.permitRef
      ? this.requirePermit(filter.permitRef).id
      : undefined;
    return this.db.records
      .filter((r) => (permitId ? r.permitId === permitId : true))
      .filter((r) => (filter.expeditionId ? r.expeditionId === filter.expeditionId : true))
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .map((r) =>
        projectRecord(
          r,
          this.db.taxa.find((t) => t.code === r.speciesCode) ?? null,
          viewer,
        ),
      );
  }

  private validateBounds(bounds: GeoBounds): void {
    if (bounds.type === "bbox") {
      const [minLng, minLat, maxLng, maxLat] = bounds.bbox;
      if (
        !bounds.bbox.every(Number.isFinite) ||
        minLat < -90 || maxLat > 90 || minLat >= maxLat ||
        minLng < -180 || maxLng > 180
      ) {
        throw invalidInput("invalid_bounds", "包围盒边界非法");
      }
      return;
    }
    if (
      bounds.type !== "polygon" ||
      bounds.coordinates.length === 0 ||
      bounds.coordinates.some(
        (ring) =>
          ring.length < 4 ||
          ring.some(
            (point) => {
              const lng = point[0];
              const lat = point[1];
              return (
                typeof lng !== "number" ||
                typeof lat !== "number" ||
                !Number.isFinite(lng) ||
                !Number.isFinite(lat) ||
                lng < -180 || lng > 180 ||
                lat < -90 || lat > 90
              );
            },
          ),
      )
    ) {
      throw invalidInput("invalid_bounds", "多边形边界非法");
    }
  }
}

const TRANSITIONS: Record<PermitState, PermitState[]> = {
  draft: ["active"],
  active: ["suspended", "expired", "revoked"],
  suspended: ["active", "expired", "revoked"],
  expired: [],
  revoked: [],
};

function assertTransitionAllowed(from: PermitState, to: PermitState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw conflict(
      "permit_transition_illegal",
      `许可证不能从 ${from} 变更为 ${to}`,
    );
  }
}

function applyDecision(
  qc: QuarantineCase,
  input: { decision: "admitted" | "rejected"; reviewerId: string; note?: string | undefined },
  resolvedAt: string,
): void {
  qc.decision = input.decision;
  qc.reviewerId = input.reviewerId;
  qc.note = input.note;
  qc.resolvedAt = resolvedAt;
}

/**
 * 设备事件号幂等的一致性校验：同一 deviceEventId 的补传必须描述同一事件。
 * 返回不一致字段名数组；一致返回 null。照片按 sha256 集合比较。
 */
export function idempotencyMismatch(
  stored: CollectionRecord,
  input: SubmitFieldInput,
): string[] | null {
  const mismatches: string[] = [];
  if (input.expeditionId !== stored.expeditionId) mismatches.push("expeditionId");
  if (input.teamId !== stored.teamId) mismatches.push("teamId");
  if (input.permitNumber !== stored.permitNumberUsed) mismatches.push("permitNumber");
  if (input.speciesCode !== stored.speciesCode) mismatches.push("speciesCode");
  if (input.quantity !== stored.quantity) mismatches.push("quantity");
  if (input.lng !== stored.lng) mismatches.push("lng");
  if (input.lat !== stored.lat) mismatches.push("lat");
  if (input.collectorId !== stored.collectorId) mismatches.push("collectorId");
  if (input.eventType !== stored.eventType) mismatches.push("eventType");
  if (new Date(input.occurredAt).toISOString() !== stored.occurredAt) {
    mismatches.push("occurredAt");
  }
  const storedHashes = stored.photos.map((p) => p.sha256).sort().join(",");
  const inputHashes = (input.photos ?? [])
    .map((p) => p.sha256.toLowerCase())
    .sort()
    .join(",");
  if (storedHashes !== inputHashes) mismatches.push("photos");
  return mismatches.length > 0 ? mismatches : null;
}

export function duplicateFingerprint(record: {
  teamId: string;
  speciesCode: string;
  quantity: number;
  occurredAt: string;
  lng: number;
  lat: number;
}): string {
  const bucket = Math.floor(Date.parse(record.occurredAt) / DUP_WINDOW_MS);
  // 0.001° 网格约百米；经纬度分别分桶，足以作为“同一件标本”的候选信号。
  const lngCell = Math.round(record.lng * 1000);
  const latCell = Math.round(record.lat * 1000);
  return [
    record.teamId,
    record.speciesCode,
    record.quantity,
    bucket,
    lngCell,
    latCell,
  ].join("|");
}

/** 约 10 公里网格模糊化（0.1° 纬度 ≈ 11 km）。 */
function redactCoordinate(value: number): number {
  return Math.round(value * 10) / 10;
}

export type ProjectedRecord = CollectionRecord & {
  coordinatePrecision: "exact" | "redacted";
};

/**
 * 敏感物种坐标投影：未授权查看者只得到约 10 公里网格的模糊坐标，
 * 照片内嵌坐标同步模糊；授权研究人员（含 "*" 通配）或非敏感物种可见精确坐标。
 */
export function projectRecord(
  record: CollectionRecord,
  taxon: Taxon | null,
  viewer: Researcher | null,
): ProjectedRecord {
  const clone = structuredClone(record);
  const authorized =
    viewer !== null &&
    (viewer.sensitiveTaxa.includes("*") ||
      viewer.sensitiveTaxa.includes(record.speciesCode));
  if (taxon?.sensitive && !authorized) {
    clone.lng = redactCoordinate(clone.lng);
    clone.lat = redactCoordinate(clone.lat);
    clone.photos = clone.photos.map((photo) =>
      photo.lng === undefined || photo.lat === undefined
        ? photo
        : {
            ...photo,
            lng: redactCoordinate(photo.lng),
            lat: redactCoordinate(photo.lat),
          },
    );
    return { ...clone, coordinatePrecision: "redacted" };
  }
  return { ...clone, coordinatePrecision: "exact" };
}
