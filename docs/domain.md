# 领域说明

野外采集受许可证的**物种范围、地理边界、数量配额、有效期**四重约束。现场采集、移动端补传、经手交接与入馆发生在不同时间，账册严格区分**事件发生时刻**（`occurredAt`）与**平台接收时刻**（`receivedAt`），并以事件发生时刻核验许可状态。

## 核心实体与不变量

### 许可证（Permit）

- `permitNumber` 为当前编号；`aliases` 登记合作方仍在使用的**旧编号**，提交记录时旧编号自动解析到同一许可证。上传时实际填写的编号原样保存在记录 `permitNumberUsed`，作为来源证据。
- `history` 是带时间戳的状态变更序列（draft/active/suspended/expired/revoked）。某事件时刻的有效状态按历史回放判定：
  - **撤回（revoked）/暂停（suspended）只影响其生效时刻之后的采集**；撤回前已形成的记录、配额占用与证据链不受影响、不可抹去。
  - 越过 `validUntil` 自动视为 expired；revoked/expired 为终态。
- 物种范围 `speciesCodes`、地理边界 `bounds`（bbox 或带孔洞的多边形）、分物种配额 `quotaLimits`。

### 采集记录（CollectionRecord）与隔离复核

提交时依次做：设备事件幂等 → 输入校验 → 边界核验 → 配额预检 → 查重 → 占用落账。

任何超出许可边界的情况（`permit_number_unresolved`、`species_out_of_scope`、`location_out_of_bounds`、`permit_*_at_event`、`quota_exceeded`、`quota_not_defined`）**不丢弃记录**，而是置为 `quarantined` 并生成隔离案例（QuarantineCase）：

- 复核 **拒绝（rejected）**：记录、照片、违例原因全部保留可查，仅状态置 rejected。
- 复核 **准入（admitted）**：全部边界重新校验（隔离期间补登的旧编号别名此时生效）、补做查重、硬校验配额，全部通过后才占用额度；任何一步不过，复核结论不落写。

### 配额台账（QuotaEntry）

只追加、不可修改的台账。每条含 `delta`（释放为负）、`phase`（hold/committed）、关联的记录或预占单，释放条目以 `releasesEntryId` 对冲原条目。

- 现场采集写 committed 占用；标本放归写对冲释放，额度立即可再用。
- 团队可在出发前 `reserveQuota` 预占（hold）；真正采集时按**本团队 + 同许可证 + 同物种**先进先出抵扣预占（写对冲条目），净增占用 = 采集量 − 抵扣量，绝不双重计数。预占可随时手工释放剩余部分，且只能被本团队抵扣。
- **多团队并发不超采**：全部业务逻辑在 Node 单线程内同步完成“读余额 → 判定 → 写占用”，请求天然串行落账；余额不足的记录进入隔离复核而非超量占用。

### 幂等与重复

- 移动端以 `deviceEventId` 全局幂等：同号补传返回既有记录（HTTP 200），不重复占额；同号但载荷不一致返回 409 `device_event_conflict`。
- 确定性重复指纹 = 团队 + 物种 + 数量 + 5 分钟时间桶 + 约 100 米网格，且事件时间相差 ≤5 分钟。命中只生成**重复候选**（DuplicateCandidate）交人工复核：
  - `duplicate`：副记录置 merged 并入主记录，不占配额，但照片等证据保留；
  - `distinct`：在后记录正常占用，若此刻配额已被他队用完则转隔离复核。

### 责任链与入馆

- 每次交接（CustodyTransfer）记录时间、出让方/接收方（field_team / partner_institution / carrier / museum）、经手人，追加成有序责任链。
- 入馆以批次（AccessionBatch）进行：批次内任一记录不合格则整批拒绝，不产生部分入馆；入馆记录追加 museum 环节并置 accessioned。
- 放归（released）、拒绝（rejected）、合并（merged）、入馆（accessioned）均为终态；终态记录不能再交接。

### 敏感坐标

物种可标记 `sensitive`。查询记录时：

- 获授权研究人员（`sensitiveTaxa` 含该物种或 `*`）可见精确坐标；
- 其他查看者只得到约 10 km 网格的模糊坐标，记录与照片内嵌坐标同步遮蔽，并标记 `coordinatePrecision: "redacted"`。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PUT | `/taxa/:code`、`/researchers/:id`、`/expeditions/:id` | 档案登记（敏感标记、授权物种、团队列表） |
| POST | `/permits` | 创建许可证（含 aliases、bounds、quotaLimits、有效期） |
| POST | `/permits/:ref/aliases` | 补登旧编号别名 |
| POST | `/permits/:ref/state` | 状态变更（state、at、reason） |
| GET | `/permits/:ref` | 许可证视角：每物种额度限制/占用/预占/释放逐条台账、预占单、记录 |
| GET | `/permits/:ref/records?status=&viewer=` | 按许可证（可用旧编号）列记录 |
| POST | `/records` | 提交/补传现场记录（`deviceEventId` 幂等，201 新建 / 200 幂等 / 409 冲突） |
| GET | `/records?permit=&expedition=&status=&viewer=` | 记录检索（坐标按 viewer 授权遮蔽） |
| GET | `/records/:id?viewer=` | 单件全链路解释：许可状态、责任链、配额台账、隔离与重复结论、入馆批次 |
| POST | `/records/:id/transfers` | 经手交接 |
| POST | `/records/:id/release` | 标本放归，释放额度 |
| POST | `/reservations`、`/reservations/:id/release` | 团队预占 / 释放剩余 |
| GET | `/quarantine?open=true`、`POST /quarantine/:id/resolve` | 隔离复核 |
| GET | `/duplicates?status=`、`POST /duplicates/:id/resolve` | 重复候选复核 |
| POST | `/accessions` | 入馆批次 |
| GET | `/expeditions/:id` | 考察队视角：记录、各许可证用量、隔离与重复结论 |
| GET | `/health` | 健康检查 |

## 持久化

数据以单个 JSON 文件原子写入（`DATA_FILE`，默认 `.runtime/ledger.json`，临时文件 rename 提交），变更后排队串行落盘；不配置文件时为纯内存存储（测试用）。`reference/domain.json` 仅保存公开枚举，不写入业务数据。
