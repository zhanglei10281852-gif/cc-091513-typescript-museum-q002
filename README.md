# 野外标本采集许可账册

面向自然博物馆野外采集许可、数量配额和现场交接的 TypeScript 后端服务。把许可证的**物种范围、地理边界、数量配额、有效期**同采集事件、现场照片、经手交接和入馆批次关联成一本账：每一次额度占用与释放、每一份隔离复核与重复处理结论、每一件标本从现场到入馆的责任链，都可以按许可证或考察队查询解释。

## 运行

需要 Node.js 22 或更高版本。执行 `npm ci` 安装依赖，`npm test` 完成编译与测试，`npm start` 启动已编译服务。服务默认监听 8000 端口，访问 `GET /health` 可确认进程状态。也可以使用 `docker compose up --build` 启动容器。

运行时账册快照写入 `.runtime/ledger.json`（可用 `LEDGER_PATH` 覆盖），重启后自动恢复；该目录已列入 `.gitignore`。

## 角色与认证

请求头 `x-actor-id`（操作人）与 `x-actor-role`（角色）标识调用方：

| 角色 | 说明 |
| --- | --- |
| `registrar` | 馆方登记员：许可证管理、复核处理、入馆 |
| `curator` | 馆长：撤回许可证、授权敏感坐标 |
| `collector` | 野外队 / 合作单位：提交采集记录、照片、交接 |
| `researcher` | 研究人员：只读；敏感坐标需授权 |
| `viewer` | 匿名只读（无需请求头） |

写操作必须携带 `x-actor-id`，否则 401；角色不符返回 403。

## 核心规则

- **许可校验**：采集记录按许可证当前版本校验物种范围、地理边界（bbox / 多边形）、有效期、授权队伍与许可证状态；任一不满足即进入**隔离复核**，复核通过（可按修订后的版本重新校验）或驳回，全程留痕。
- **配额账**：`collected` 记录占用配额，`observed` 不占用。占用（hold）→ 入馆转实占（confirm）；复核驳回、野外放归、重复合并则释放（release）。隔离中的记录同样预占配额，防止复核期间被其他队伍超采。配额检查与落账在同一同步临界区内完成，多队伍并发提交不会超采。
- **许可证版本**：修订产生新版本，旧编号保留在索引中；引用旧编号的记录被识别为 `stale_permit_reference` 进入隔离，由馆方确认后按当前版本入账。
- **撤回**：`revoke` 只阻止撤回时点之后的采集（按事件发生时间判定），已形成的采集记录、照片、交接与入馆数据全部保留，来源证据不可抹除；撤回前的在途标本仍可完成入馆。
- **幂等**：移动端补传以 `deviceId + deviceEventNo` 为幂等键，重复提交（含并发）返回既有记录；同一事件号但要素不一致返回 409。
- **重复候选**：不同记录指向同一野外编号时生成重复候选组，处理结论为合并（正本保留，其余释放配额）或确认为不同标本，结论可查。
- **敏感坐标**：敏感物种的精确坐标仅馆方与获授权研究人员可见，其余角色得到粗化坐标（约 0.1°）。
- **交接链**：首次交接必须从野外队或合作机构开始，后续环节交出方必须与上一环节接收方一致；入馆要求交接链末端已到馆。

## API 概览

| 方法与路径 | 说明 |
| --- | --- |
| `POST /permits` | 创建许可证（草稿） |
| `GET /permits` / `GET /permits/:id` | 许可证列表 / 详情（含版本沿革） |
| `POST /permits/:id/activate` `/suspend` `/resume` | 生效 / 暂扣 / 恢复 |
| `POST /permits/:id/amend` | 修订（产生新版本，可换发新编号） |
| `POST /permits/:id/revoke` | 撤回（仅馆长；保留历史证据） |
| `GET /permits/:id/quota` | 配额账：限额 / 占用 / 实占 / 释放 / 剩余 + 全部流水 |
| `GET /permits/:id/explain` | 按许可证解释：版本、配额、记录、隔离、重复、审计 |
| `POST /records` | 提交采集记录（设备事件号幂等；越界即隔离） |
| `GET /records` `?permitId&teamId&status&taxon` | 记录查询（按角色脱敏） |
| `GET /records/:id` / `GET /records/:id/chain` | 记录详情 / 从现场到入馆的完整责任链 |
| `POST /records/:id/photos` | 追加现场照片（SHA-256 锚定证据） |
| `POST /records/:id/custody` | 登记经手交接（链条连续性校验） |
| `POST /records/:id/release` | 野外放归（释放配额） |
| `GET /quarantine?status=` / `POST /quarantine/:id/resolve` | 隔离复核列表 / 处理 |
| `GET /duplicates?status=` / `POST /duplicates/:id/resolve` | 重复候选列表 / 处理 |
| `POST /accession-batches` `/items` `/close` | 入馆批次管理 |
| `GET /teams/:id/explain` | 按考察队解释：记录、配额占用与释放、未决事项 |
| `POST /sensitive-access-grants` / `GET` | 敏感坐标授权（仅馆长）/ 授权列表 |

错误响应统一为 `{ "error": <code>, "message": <说明>, "details": <细节> }`。

## 工程结构

```
src/
  domain/    类型、枚举（与 reference/domain.json 对齐）、地理边界计算
  ledger/    账册核心：状态与持久化、业务规则、视图（脱敏、责任链）
  http/      路由器、输入校验、HTTP 服务
  app.ts     组装入口；index.ts 进程入口
tests/       node:test 测试（生命周期、配额并发、隔离、撤回、重复、交接、脱敏、持久化）
```
