# Better Life 独立运维告警

## 实现与真实状态

`scripts/operations-alert.mjs` 已实现固定事件、私人文件持久去重、待发送队列、有限批次重试与恢复通知。`deploy/better-life-alert@.service` 只是隔离模板，不会自动安装、启动 timer、编辑其他服务或读取金融数据库。

**通知入口和负责人收件验收仍需部署方明确配置。** 未配置或配置被拒绝会返回非零，`sent:false`；有已知事件则保留 pending。合成测试成功不等于真实 webhook 或负责人通知已接通。HTTP 2xx receipt 仅表示配置的接收端接受请求，不证明收件人已阅读、升级机制成立或真实业务恢复。

2026-10-05：root 已实际安装本项目 alert 模板、backup OnFailure 与非致命恢复，专属 env/状态目录及稳定 source drop-in 已校验；真实负责人入口仍空。隔离 Linux drill 验证 pending/nonzero 和恢复排队，不是真实发送。详见 `PRODUCTION-RELEASE.md`，不要将“已安装 handler”写成“负责人已收到故障通知”。

## 配置（仅服务端）

专用 `/etc/better-life/alerts.env` 由部署方创建，文件应仅授权服务用户读取。systemd 的 `EnvironmentFile` 读取配置；脚本只读自身进程环境，不 `source`、不执行 shell、不开启 `VITE_` 配置，也不将 URL/凭据放在命令参数中。

| 配置 | 边界 |
| --- | --- |
| `OPERATIONS_ALERT_WEBHOOK_URL` | 部署方实际选择的 HTTPS webhook；只允许 443，无 user/password/fragment，不允许 IP literal、localhost、内网域后缀 |
| `OPERATIONS_ALERT_WEBHOOK_HOST` | 必须精确匹配上项的小写主机名，无通配符；与 URL 一起显式授权目的地 |
| `OPERATIONS_ALERT_STATE_DIR` | 默认 `/var/lib/better-life/alerts`；生产路径必须位于独立 `better-life/alerts` 或 `better-life-private/alerts` 目录，不能位于发布目录、public/dist、临时目录或其他项目 |

生产发送前解析全部 DNS 地址，任何私人、环回、链路本地、保留/文档或不支持的地址使该发送失败；HTTPS 的 DNS lookup 固定为已检查的公网地址，保留主机名证书验证，禁止重定向。没有“先查 DNS、随后 fetch 重新解析”的重绑定窗口。发往通知服务的数据由部署方明确授权，不接受 CLI URL 覆盖。HTTP 响应正文、Location、错误正文和自由文本不会被保存或回显。

主机应由部署方先创建专用目录、归属 `better-life` 服务用户、权限 **0700**；状态、锁和原子写入临时文件使用 **0600**，POSIX 检查当前用户归属、拒绝组/其他用户可写祖先，并拒绝 symlink/junction/hardlink、不安全权限与异品牌/损坏状态。Windows 合成测试不能代替生产 Linux 文件权限/ACL验收。其他项目与金融 DB 不在工具写入范围。

## 固定事件与安全载荷

CLI 只接受以下精确命令形式，不接受自由事件、说明文字、URL、用户资料或任意 unit：

```text
node scripts/operations-alert.mjs BACKUP_FAILED
node scripts/operations-alert.mjs APP_FAILED
node scripts/operations-alert.mjs HEALTH_UNAVAILABLE
node scripts/operations-alert.mjs BUDGET_WARNING
node scripts/operations-alert.mjs BUDGET_EXHAUSTED
node scripts/operations-alert.mjs RECOVERED backup
node scripts/operations-alert.mjs RECOVERED app
node scripts/operations-alert.mjs RECOVERED health
node scripts/operations-alert.mjs RECOVERED budget
```

webhook JSON **仅有** `application/event/status/version/time` 五个键。`application` 固定 `better-life`、`version` 固定 `1`、`time` 为事件首次入队 UTC 时间。`event` 是上面六种事件码；`status` 也是固定枚举：`backup_failed/app_failed/health_unavailable/budget_warning/budget_exhausted` 或对应 scope 的 `backup_recovered/app_recovered/health_recovered/budget_recovered`。恢复 scope 通过固定 status 表达，不携带 unit/路径/URL。

载荷没有账号、订单、联系方式、问题/答案、IP、发布 URL、凭据或错误自由文。stdout/stderr 只报告固定状态/原因码、时间与队列数量，不输出配置值。环境变量中的认证、支付、模型和备份秘密均不参与告警。

## 去重、重试与恢复

- 状态存放在专用 `alerts-state.json`，不是会员 SQLite。入队与尝试次数/下次重试时间先原子保存、fsync，随后才发送；成功后保存 HTTP 状态、事件时间、发送时间和尝试次数 receipt。
- 同 scope、同未恢复事件持久去重；再次执行同命令会重试已到期的队列，而不重复建事件。预算 WARNING 与 EXHAUSTED 可独立升级，各只通知一次。
- 失败返回非零并保留 pending。默认退避为 60 秒、120 秒等，最多 1 小时。未到期不会发请求，也返回非零。每次最多发送该 scope 的 8 份，最多 32 个 pending；每 scope 保留最近 32 个 receipt。容量不足或状态损坏时失败关闭，不丢弃待通知事件。
- `RECOVERED scope` 仅结束该 scope 已记录的 incident；不抹掉其他 scope。失败尚未送达时，恢复排在失败之后；重复恢复不另建通知。无已知 incident 时不制造“已恢复”的通知；若入口仍未配置，返回非零、`unconfigured`，而不是已发送。
- 故障复发在恢复之后建立新 incident，可再次通知。CLI 不探测或宣称真实恢复；必须由对应健康/备份/预算检查在确认事实后调用固定码。
- **至少一次，不保证跨网络崩溃的恰好一次**：接收端已收到而进程在 receipt 落盘前崩溃时，可能再次发送同一载荷。接收端可用固定事件/status/首次 time 去重；不要把告警当付款或退款指令。
- 独占 `alerts.lock` 防并发发送/覆盖。正常退出会清锁；强制终止/主机崩溃遗留锁会 `STATE_BUSY`，不自动抢锁。部署方应先确认本项目告警进程已停止，再核对专用目录/文件归属与状态、仅清理该锁，保留 `alerts-state.json` 供重试；不能递归删除目录或触碰其他项目。磁盘/权限写入失败不会假称通知已落盘。

工具本身不是后台守护或重试 timer。后续专用健康/预算调度器可重复提交对应固定事件/恢复 scope；没有安装调度器时 pending 不会自行发送。

## systemd OnFailure（只读告警，不递归）

模板使用 `--unit %i`，**不是 `%I` 或 shell 插值**。代码只接受：

| 完整实例参数 | 事件 |
| --- | --- |
| `better-life.service` | `APP_FAILED` |
| `better-life-backup.service` | `BACKUP_FAILED` |
| `better-life-health.service` | `HEALTH_UNAVAILABLE` |

未安装的 `better-life-health.service` 名字只预留给该项目未来明确的巡检单元，不代表已存在或已监控。其他名字（包括其他站点、路径、参数注入）立即拒绝，不执行 shell 或 `systemctl`。

部署方仅在上述 **Better Life** 单元的独立 drop-in 中接入：

```ini
[Unit]
OnFailure=better-life-alert@%n.service
```

实例示例为 `better-life-alert@better-life-backup.service.service`；重复 `.service` 是完整失败 unit 名作为实例参数，代码按精确白名单校验。**不要**给告警模板本身添加 `OnFailure`，不要给原站添加 drop-in，不要对所有服务使用任意实例告警。

备份成功与通知发送失败是两件事。当前备份单元已接入以下非致命恢复命令和独立 `alerts.env`；实际安装/通知送达状态以 `PRODUCTION-RELEASE.md` 为准：

```ini
[Service]
ExecStartPost=-/usr/bin/node scripts/operations-alert.mjs RECOVERED backup
```

未配置通知仍保留 pending/非零事实，但 `-` 防止成功备份被通知失败变成 unit 失败，引发失败/恢复循环。不能把缺 webhook 记录成备份文件生成失败，也不能覆盖真实备份退出码。

## 合成测试与真实验收界限

`tests/operations-alert.test.mjs` 仅临时独立目录、合成环境/HTTP/DNS/request/时钟，实际 webhook、真实 env、私库、OTP、支付和模型均未访问。覆盖未配置、成功 receipt、持久去重、退避、待发送失败后恢复、预算升级、并发锁、权限/链接/损坏状态、CLI 精确名单，以及 DNS 全地址检查/固定连接/禁止重定向。

真实生产仍需部署方验证：实际 HTTPS 接收端、负责人收件与升级路径、Linux 权限和模板安装、失败 OnFailure 与非致命恢复、pending 定时重试和强制终止锁恢复。手工失败测试只提交固定 `BACKUP_FAILED` 等事件，不必也不应破坏数据库/备份、停原站或制造真实扣款。当前没有真实负责人通知验收凭据，不宣称通知已接通。
