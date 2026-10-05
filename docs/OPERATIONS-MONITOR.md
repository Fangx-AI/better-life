# 固定告警运维巡检（模板已实现，未生产启用）

更新于 2026-10-05。`scripts/operations-monitor.mjs` 把既有只读健康巡检与固定事件告警连通，并独立读取成本账本汇总。root 已安装 health service/timer 与最小配置并做服务身份空库预算只读检查，health timer 仍 inactive，没有巡检不存在的正式主站，也没有通过真实 webhook 发送告警。合成测试通过不等于接收人已收到通知或主站已上线。实际安装证据见 `PRODUCTION-RELEASE.md`。

## 做什么，不做什么

- 复用 `operations-health.mjs`：仅 GET 本项目 HTTPS `/api/health`，检查 ready、生产计量/demo、登录通道配置；检查 DB/WAL/SHM 与备份的文件元数据、备份新鲜度和磁盘余量。健康口不证明真实收码、模型、收款或恢复成功。
- 预算使用 `DatabaseSync(...,{readOnly:true})`，验证独立私路径、所有祖先无链接、文件/目录权限及归属、普通文件/单硬链接、WAL/SHM 元数据与 Better Life 会员库 `application_id`。缺库不会创建，标记不匹配拒绝。
- 只执行读取品牌标记的 PRAGMA 和一条原子 SELECT；只引用 `usage_budget_requests` 的日/月键、有限状态和整数金额。不会读取账号、订单、指南、问题、回答或个人情况，不执行 UPDATE、迁移、清理、恢复、计费或 `createUsageBudget.snapshot()`。
- 复用 shared 四项预算/费率校验，按北京时间（`Asia/Shanghai`）自然日/月统计。`reserved/dispatched` 的最坏预占 **加上所有 charged** 形成 committed；80% 预警，100% 满额。两个期间任一达到阈值即告警，整数溢出/负数/小数/非法状态均拒绝读数。
- 过期预占仍保守计入，巡检不会释放或转费用，避免一个“观察”动作变成计费写操作。应用自身下一次账本操作的恢复可能调整读数；巡检数字不能代替供应商正式账单。
- 唯一可写目录是独立 `alerts` 状态目录；写的是固定事件排队、重试与回执，不是业务数据库。既有健康 API 若有自己的内部维护动作，归 API 实现，不由巡检直接修改数据库。
- 不发 OTP、不调用模型、不下单/付款/退款、不重启服务、不删除备份、不安装 timer；不读取应用 AUTH_SECRET、模型/商户/备份密钥或 `.env.local`。

## 事件与失败语义

| 巡检结果 | 固定事件 |
| --- | --- |
| 健康不可用、预算配置缺失或预算库不可读 | `HEALTH_UNAVAILABLE`（health） |
| 健康可用且预算已可靠读取 | `RECOVERED health` |
| 可靠账本达到日/月 80% | `BUDGET_WARNING`（budget） |
| 可靠账本达到日/月 100% | `BUDGET_EXHAUSTED`（budget） |
| 可靠账本恢复正常 | `RECOVERED budget` |

预算不可读标为 `budget=unavailable`，不能混成真正满额，也不发送 budget 恢复。新单有意关闭是可见健康 warning，不冒充付款验收完成。RECOVERED 由既有告警模块按 scope 去重；从未发生故障时不虚发恢复通知，也不会清掉其他 scope 的事件。

告警复用持久队列、有限批次、指数退避与固定 payload。缺 webhook 是 `pending/unconfigured`、`sent=false`、非零，不会因为主站能访问就报“通知已送达”。HTTP 2xx 与回执只说明接收端接受，不证明负责人已读；当前仍待真实通知渠道及升级接收人验证。

stdout/stderr 只有固定应用标记、有限状态/代码、布尔和固定退出码，不输出 origin/私路径/金额、自由异常、账户或配置值。退出码：正常或已通知的 warning 为 0；健康/账本不可用、满额或通知失败为 1；其余健康正常但通知未配置为 2。任何非零都不假装健康。

## 最小配置

由管理员准备 `/etc/better-life/monitor.env`，只放以下 **7 项**（值需核实，空值/示例不能直接启用）：

```dotenv
MEMBERSHIP_APP_ORIGIN=https://YOUR-ACTUAL-BETTER-LIFE-DOMAIN
MEMBERSHIP_DB_PATH=/var/lib/better-life/membership.sqlite
MEMBERSHIP_BACKUP_DIR=/var/backups/better-life
QA_BUDGET_DAILY_CNY=
QA_BUDGET_MONTHLY_CNY=
QA_PRICE_INPUT_CNY_PER_MILLION=
QA_PRICE_OUTPUT_CNY_PER_MILLION=
```

四项必须与当前应用使用的配置一致，均为正十进制、最多六位小数，日预算不大于月预算。费率由负责人查验，不照抄测试数值。监控 env 不包含任何业务秘密。

通知设置另放 `/etc/better-life/alerts.env`：`OPERATIONS_ALERT_WEBHOOK_URL`、与 HTTPS URL hostname 精确一致的 `OPERATIONS_ALERT_WEBHOOK_HOST`、`OPERATIONS_ALERT_STATE_DIR=/var/lib/better-life/alerts`。webhook URL 可能带秘密，不能放命令行/Git/聊天；此处不提供真实 URL。既有告警模块拒绝私有/特殊 IP、混合 DNS、公网目标不符和重定向，通知正文只有固定事件，不携带业务内容。

配置文件最小权限由管理员安排，例如 root:better-life 0640，配置目录禁止其他用户访问；`better-life` 拥有私库父目录和 alerts，目录 0700、文件 0600。alerts 必须预建且为普通私目录，不用宽权限修复启动问题。应用库/WAL/SHM 仅可读；若 SQLite WAL 只读访问不能成立，应保持巡检失败并核对 Linux/SQLite 配置，不能为“读健康”给监控增加数据库写权限。

## 手动验收后再安排 timer

在已激活的本项目 release 内，以专用服务用户执行：

```sh
/usr/bin/node --env-file=/etc/better-life/monitor.env --env-file-if-exists=/etc/better-life/alerts.env scripts/operations-monitor.mjs
```

命令仅示例，本轮没有向真实主站执行。环境文件由 Node/systemd 解析，不使用 shell `source`。先核对固定状态、预算真实汇总口径、通知队列/回执和负责人实际收到的固定测试事件，再由获授权的管理员安装 `better-life-health.service` 与 `.timer` 并启用。timer 每 5 分钟一次，启动后首次约 5 分钟；只有实际自有 HTTPS 主站已 ready 且通知负责人明确时才启用，不对 Pages 静态站冒充会员 API 巡检。

service 以 `better-life` 运行、`ProtectSystem=strict`，只对 `/var/lib/better-life/alerts` 声明 `ReadWritePaths`；不载入 production.env/backup.env，不获取业务秘密。可选 alerts.env 缺失仍可持久排队并非零。

**没有 health OnFailure。** monitor 自己发固定事件；预算满额或 webhook pending 的非零，不应被第二个失败单元误报成新的健康故障。脚本启动前崩溃、systemd 依赖失败、机器离线和 timer 缺席无法产生本程序内告警，仍需要独立外部可用性监测/值班检查。不要给告警单元添加递归 OnFailure，也不要把本模板描述成完整生产监控体系。

定向验证：`node --test tests/operations-monitor.test.mjs`，只用临时私目录、合成 SQLite、注入 health/alert/只读 DB，验证阈值/北京时间、恢复/重试、隐私及无 DB 写操作。Windows 测试不替代 Linux 权限、WAL/systemd 沙箱、真实通知端和生产上线验收。
