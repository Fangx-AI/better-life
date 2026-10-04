# Better Life 日常运营与成本 / 灾备检查

本页只补充本项目运维，不操作 Image2、其他项目、商户系统或真实用户库。部署、DNS/TLS、真实收码、真实模型、真实付款退款仍须分别验收，不能由单元测试或配置通过代替。既有正式发布步骤见同目录 `PRODUCTION-RELEASE.md`，运营后台权限与人工退款工单见 `OPERATIONS-ADMIN.md`。

## 1. 模型成本预算：与会员次数分开

`server/usage-budget.mjs` 是全站成本估计护栏，复用会员数据库事务和备份；它不改变会员套餐次数。后者是用户成功生成一次后的权益扣次，而成本在请求发给供应商后，即使超时、断网或答案校验失败，也可能已经产生。因此失败不扣会员次数，**不等于上游调用没有成本**。

生产环境须明确设置下面四项；价格来自运营人员核对的对应模型供应商报价，仓库没有默认真实价格，也不自动查价。测试中的数值只作算术样例，不可照抄上线：

| 字段 | 单位 / 含义 |
| --- | --- |
| `QA_BUDGET_DAILY_CNY` | 北京时间自然日全站上限，人民币元 |
| `QA_BUDGET_MONTHLY_CNY` | 北京时间自然月全站上限，人民币元，不能低于日上限 |
| `QA_PRICE_INPUT_CNY_PER_MILLION` | 每百万输入 token 的最高适用价格，人民币元 |
| `QA_PRICE_OUTPUT_CNY_PER_MILLION` | 每百万输出 token 的最高适用价格，人民币元 |

只接受正数、普通十进制、最多六位小数；不接受零、科学记数法、占位文字或部分配置。四项全缺时模块明确显示未配置，**不能称生产成本保护已开启**；生产启动检查已强制四项齐全。更换 `DEEPSEEK_MODEL` 时先复核价格，不能沿用另一模型的费率。输入费率应覆盖非缓存、缓存策略和其他实际适用情形；当前不假定缓存折扣，不使用余额截图编造单次成本。

账本金额为整数微元人民币（`1_000_000` 微元 = 1 元），每次计算向上取整。显示的是**配置费率下的估计金额，不是供应商正式账单**；定期与上游账单核对，无法核对时保留“不确定”而非写成实付金额。

### 请求生命周期与异常恢复

1. 检索完成、实际请求体确定后，用服务器计算的输入 token 保守上界和最大输出 token **事务预占**，日/月任一剩余额度不够即拒绝，不调用模型。无依据直接返回时不预占。
2. 真正调用 `fetch` 前 `markDispatched(id)`；返回 `false` 时不得调用。输入上界可用请求 JSON 的 UTF-8 字节数加协议裕量，输出上界与请求 `max_tokens` 保持一致。
3. 读到上游 JSON 后，立即用 `usage.prompt_tokens / completion_tokens` 结算，**在校验答案内容之前**，不能因回答质量不合格而漏计已产生用量。缺失、不合法或彼此不一致的 usage 按预占金额保守记账。
4. 发出前失败释放预占；发出后超时、取消、网络错误、HTTP 错误、不可解析回复均按预占最坏金额保守记账，不把无法证明无计费的失败当作零成本。
5. 预占持久化，进程重启不会归零。120 秒过期时，未发送项释放，已发送项转保守费用；`reserve / settle / fail / snapshot / cleanup` 会处理过期项。有效迟到 usage 可以修正保守费用；已准确结算的记录不能重复扣费。
6. 已报告用量若超过声明上界，记录真实报告的估计成本及越界告警，不能把金额截断成预占金额掩盖支出。跨北京时间午夜发送时重新检查新日预算。

账本只存服务器随机请求 ID、时间、日/月键、token 计数、费率、整数金额和有限状态；不存用户身份、问题/回答/私人指南正文、上游密钥。只向已认证且已授权的运营后台开放聚合快照，不开放公网账本明细。

### 80% 提醒与处理

后台 `snapshot()` 的日/月 `committedMicroCny` 同时包含已计费用和未完成预占；达 80% 时 `alert=true / state=warning`，达上限时 `state=blocked`。越界和保守记账数量应一起看：保守计账持续上升通常意味着网络、超时或回复异常，不能简单扩大预算掩盖故障。

这是**告警状态接口，不是已安装的短信/邮件告警系统**。实际通知渠道、接收人和失败升级须由部署方配置并验收。先确认费用明细与异常调用，再决定提高预算或降载；不会自动充值、删账本或借用其他项目余额。

此护栏不代替 IP / 身份持久限流、验证码短信预算、会员次数、网关防刷或供应商余额 / 限额（如供应商提供）。SQLite 事务可以协调同库预占，但不适合任意横向扩容、跨主机各自一份数据库，不能靠新建多个独立账本规避总预算。任何意外恢复旧库都会丢失备份之后的账本事实；恢复后先保持 AI / 新单关闭、核对上游账单和收费事实，再恢复使用，不能误把旧库剩余额度当作当前余额。

## 2. 只读运维巡检

新增 `scripts/operations-health.mjs`。仅以服务用户手动运行，使用部署专用配置，不读取项目的 `.env.local`：

```sh
/usr/bin/node --env-file=/etc/better-life/production.env scripts/operations-health.mjs
```

本轮未执行该命令到真实主站、未安装定时任务；测试只使用 mock GET 和临时目录。

巡检只做：

- 请求配置的本项目 HTTPS origin 下 `/api/health`，拒绝重定向，检查 Better Life 品牌标记、ready、生产计量开启、demo 关闭及邮件 / 短信 provider 配置状态。请求最长 10 秒，返回体最多 4 KiB，不输出上游错误正文。
- 读取独立私人数据库与 WAL/SHM 的**文件元数据**，不打开数据库、不读用户记录，不允许 Image2/public/dist/release 或目录链接。
- 查找本项目命名的 `.blbk` 元数据，超过 26 小时或没有备份即报错；异常未来时间报时钟告警。
- 检查数据库与备份所在磁盘：余量至少 1 GiB、至少当前 DB/WAL/SHM 大小的两倍，且可用空间比例不低于 15%。

输出只有脱敏状态 / 告警码，不含密钥、完整路径、问题或联系方式。`status=unavailable` / 有 `problems` 时退出码为 1；关闭新单只产生 `PAYMENT_CREATION_DISABLED` 警告，可能是有意停售，不自动当作数据故障。

`backupFreshness=fresh-unverified` **只证明文件看起来新鲜**，不证明加密内容完好、成功离机、可恢复或计费流水无缺口。`backupRestorationVerified / liveDeliveryVerified / livePaymentVerified` 始终为 `false`，实际验收需另做。80% 模型预算在运营后台看，不从公网健康口泄露账本。

| 告警 | 第一动作 |
| --- | --- |
| `API_HEALTH_UNAVAILABLE` | 检查本项目进程、vhost/TLS、服务日志；先勿动其他站点 |
| `PRODUCTION_METERING_OR_DEMO` | 停止公网 AI 使用，复核 production env / release |
| `LOGIN_PROVIDER_NOT_CONFIGURED` | 检查本项目 provider 配置，不用真实群发探测 |
| `BACKUP_MISSING / BACKUP_STALE` | 检查本项目 backup timer / 最近 oneshot 退出码，手动创建并恢复校验 |
| `BACKUP_CLOCK_SKEW` | 核对主机时间同步，不用改 mtime 假装备份完成 |
| `DISK_SPACE_LOW` | 临时停新单/模型，保留收费及恢复证据；先确认副本与保留策略再处理旧文件 |
| `PRIVATE_DATABASE_METADATA_UNAVAILABLE / BACKUP_DIRECTORY_UNAVAILABLE` | 核对独立目录权限、挂载和链接，不能随意 mkdir 到别的应用目录 |

部署后可以将此命令接入**独立 Better Life** 的外部监控 / systemd 单元；先确认失败退出码能送达负责人，再建立巡检频率和升级机制。本仓库没有自动安装，也没有在本机后台监控。日志仅记状态码、有限告警码、时间及发布版本，不开启问题/答案、OTP、完整请求、authorization、支付密钥日志。其他服务健康信息由其自身运维记录提供，不能从本项目巡检宣称原站无影响。

## 3. 已实现的备份与实际缺口

既有 `membership-backup.mjs` 已实现 Online Backup 一致 WAL 快照、独立 AES-GCM 全库加密、临时文件清理、品牌 / 完整性 / 外键 / 私文解密校验、不覆盖原库的恢复到新文件。预算、运营审计与工单表同在会员数据库，会被全库快照包含。

`deploy/better-life-backup.service` 与 `.timer` 只是模板。当前并未证明以下事项已完成：

- 服务用户 / 独立目录权限已在生产 Linux 验收；timer 已安装启用、主机重启后仍执行。
- 最近一次**真实生产**备份与恢复校验成功；主机磁盘余量 / 加密 key / 原 AUTH_SECRET 可用。
- 加密备份已复制到离机介质并可取回；离机上传失败能告警。凭本机文件存在不能判断该项成功。
- 日 7 / 周 4 / 月 3 保留策略执行、容量评估与安全删除已经安排；脚本不会自动删除旧备份。
- 独立备份 key 和每个仍需要的旧 AUTH_SECRET 已分别离线保管、恢复负责人可用；只有 DB 不足以恢复私文。
- 全流程停机恢复、登录、已付订单 / 退款 / 权益、日/月成本账本和私人档案经授权抽验；RPO/RTO 已由真实演练测量。
- backup oneshot 的非零退出 / timer 缺席 / 备份过期 / 磁盘不足 / 80%预算有实际通知负责人和升级渠道。

正式启用前，在授权窗口执行一次 create → check → restore-to-new-file → 隔离恢复实例验收，记录各步骤时间、退出状态、备份 ID（不记密钥或个人内容）、审批人及真实 RPO/RTO。备份存储可以建议每日执行，但不能据模板宣称 RPO 已达 24 小时，不能预先承诺未测的 RTO。

## 4. 故障处置与恢复边界

1. 新收费有风险时关闭**新单创建**，保留正确商户回调入口、验签与已付/退款核销；不能通过删除商户配置使已有用户的付款通知失效。AI 异常时先关闭模型入口，不停掉已有会员资料读取所必需的服务。
2. 恢复数据库前只停止 Better Life 实例，保留当前 DB/WAL/SHM 和版本记录；不重启、删库或移动 Image2。不要对运行中 SQLite 文件直接覆盖。
3. 使用备份独立 key 与对应旧 AUTH_SECRET 恢复到**新文件**；完整性、外键、私文解密全部通过后，由管理员在停机窗口切换本项目 DB 路径。
4. 旧备份之后的付款、退款、会员次数与成本必须核对，漏回调走商户已签名通知重发 / 人工工单，不能凭截图改 `paid`，不能删审计改结果。成本账本落后时先停模型，核对供应商实际用量。
5. 启动后验收健康、两种身份登录同一账号、已付会员 / 已退权益、私人指南归属与保存；重新手动 create + check，再恢复新单和模型。
6. 代码回滚只切换 Better Life release；**不把恢复旧数据库当日常代码回滚**，否则会丢失已付款事实。迁移需加表/加列兼容，并先备份校验。

本轮本地验证：`node --test tests/usage-budget.test.mjs tests/operations-health.test.mjs`，全部使用临时文件或模拟网络；没有真实送码、扣款、退款、模型调用、生产备份/恢复和线上部署。

## 5. 第一阶段离线发布包与 dry-stage（不是上线）

新增 `scripts/release-manifest.mjs` 与 `deploy/install-release.sh`。**只实现源码包完整性与独立目录暂存，不实现生产激活 / 候选启动 / 原子 current 切换 / Nginx 配置或回滚。** `--activate` 会拒绝执行。不能因为 dry-stage 成功就说网站上线，也不能标记正式运营 Goal 完成。

### 源码发布包

由已审核 checkout 使用 Node 创建，目标必须是源码目录之外的**不存在的新目录**：

```sh
node scripts/release-manifest.mjs create --source /absolute/reviewed/better-life --destination /absolute/new/offline-bundle --release-id release-20261004-a
node scripts/release-manifest.mjs verify --bundle /absolute/new/offline-bundle --expected-sha256 <first-command-manifestSha256>
```

明确白名单包含 server/shared/scripts/src/assets/public/docs/library/tests/deploy/worker、少数根文件以及公开 `.openai/hosting.json` / `public/.nojekyll`；不使用 Git 文件列表，也不把整个工作目录打 tar。`.env`、output/private、日志、node_modules、数据库/WAL/SHM、key/pem、凭据/会话/token/auth 导出文件、隐藏配置和压缩档案均不进入发布包。所有 `dist` 与旧 Obsidian ZIP 也不打包；正式构建必须在已验证源码副本上重新生成，不能拿旧缓存冒充生产构建。

包内 manifest 记录每个白名单文件的路径、长度和 SHA-256。拒绝目录 / 文件链接、路径穿越、反斜线、控制字符、ADS、重复路径和未列文件；验证时任何额外 env/私库/任意文件同样失败。文件大小限制 64 MiB、总量 512 MiB、文件数 20,000，manifest 最多 4 MiB。新目标 exclusive 创建，失败只清理本次创建的目录，不覆盖已有包或现网目录。

SHA-256 只验证完整性，**不是作者签名、可信来源、无秘密的内容扫描或供应链审计**。运营方仍需审核这些公开源码目录，不得将个人材料 / 秘密写进看似普通的源码文件。manifest 的期望 SHA 必须通过可信的独立渠道记录，不能只相信和包一起上传的 hash 文本。不要以 root 执行未审核上传包的脚本；Linux模板校验器来自本地已审核 checkout，而非包内可替换代码。

### 暂存与作用域

本机可以用 Node 模拟 dry-stage，依然只复制经哈希校验的文件，不调用网络 / npm / 服务：

```sh
node scripts/release-manifest.mjs stage --bundle /absolute/new/offline-bundle --destination /absolute/new/staged-source --expected-sha256 <trusted-manifestSha256>
```

Linux `install-release.sh` 当前仅接受：

```sh
bash /absolute/reviewed/better-life/deploy/install-release.sh --dry-stage /absolute/uploaded/offline-bundle <trusted-manifestSha256> release-20261004-a
```

它要求 Linux、root、Node ≥22.16、已存在且无祖先链接的 `/var/www/better-life-releases` / `/var/lib/better-life` / `/etc/better-life`，专用 env 只检查 root:0600 元数据，配置目录须 root:0700；不读取、source、打印或复制秘密。release root 必须 root 拥有，目标固定为 `/var/www/better-life-releases/<release-id>`，禁止覆盖现有目录。暂存目录先为 root-only，尚不赋予服务运行权限。模板不会创建这些系统目录、安装软件、运行 npm、开放端口、启动服务、配置证书、修改 current、改 Nginx 或自动删除既有 release。没有读取 / 停止 / 改写 Image2 的路径或命令。

本地验证仅覆盖 Node 临时目录与脚本静态安全断言；Windows 测试**不代替 Linux bash / 文件权限 / systemd / Nginx 验收**。部署方后续可在授权的独立临时 Linux 目录做源码验证与构建测试，但不应因此放到公网。

### 完整原子激活尚待实现 / 真实验收的闸门

- 独立、已授权的真实域名；拒绝 example/测试域名真实发布。证书 SAN 覆盖此域名、证书有效期与私钥权限通过检查，不能借用只覆盖其他站点的证书。当前 dry-stage **没有进行证书/域名检查**。
- 专用生产 env 的全部启动配置与真实 OTP / 模型 / 本项目商户验收；不得复制原站 env，不得自动打开新单。
- 在另一个构建工作副本安装锁定依赖，`PUBLIC_BASE_PATH=/` 的生产 build + tests + 原书校验完整通过；不自动 npm audit 修复或升级依赖。源码包哈希在构建前校验；构建会生成 dist/output/node_modules 并更新派生 public 文件，因此构建后不能把原源码 manifest 的严格校验当作构建产物证明，须另存明确的产物验收记录。
- 生产 preflight 以 `better-life` 用户成功；独立持久数据/备份目录、权限、商户绑定、成本预算和恢复已核对。
- 仅 `127.0.0.1:4178` 的端口占用属于本项目；禁止抢占别的服务。候选回环 health 达标后才允许切换 current；只有 `better-life.service` 可受控停止/启动。单实例切换及故障回滚需要处理同端口冲突、数据库兼容及本项目候选清理，当前模板没有实现。
- 只创建新的本项目独立 Nginx vhost 文件，不覆盖已有 server/upstream；`nginx -t` 通过后单次 reload，既有站点继续保留。当前模板没有执行 Nginx 变更或 reload。
- 实际失败回滚、健康、TLS、公网登录、计量、已付回调与原站健康验收后才确认发布；没有实际支付权限/商户事实时保持新单关闭。

任何一步未完成，仍标注“待生产激活 / 待真实验收”，不以“模板齐全”或“临时 Linux PASS”替代正式运行事实。
