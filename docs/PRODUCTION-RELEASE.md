# 人生指南：独立会员主站发布与恢复

## 当前实现与生产边界（更新于 2026-10-04）

- 已复用阿里云邮件/短信适配代码；本机配置不等于实际送达。
- 新增生产启动检查、同源健康检查、默认关闭的虎皮椒适配器、验签回调、原子幂等开会员/撤销已退款订单权益。
- 已验证的支付流程都是 mock transport / 临时 SQLite 测试。未读取/复制 Image2 商户凭据，未创建真实收费订单、未扣款、未发起退款。
- SQLite online WAL 快照、全库 AES-GCM 加密、恢复解密/完整性/原私文密钥校验已实现并在临时数据库测试。
- 私人指南、版本、个人情况与主动保存回答已有同源服务端持久化；追问待确认草稿只作短期加密重试缓存，不自动写入档案。原书阅读/检索/下载仍免费，原书条目收藏仍在本机浏览器。不能把个人内容服务笼统说成只有本地收藏。
- 独立运营后台、只读用户/订单/审计、用户退款申请及有限 revision 工单流转已接入。申请/批准不等于实际退款，不提供手工开会员或修改付款事实的后台权限。
- 账号逻辑注销已接入；最近 10 分钟认证、精确确认与未结事项闸门保护当前/未来权益和金融归属。主库私人内容/登录方式/全部会话移除，必要金融流水和脱敏账号保留；备份、日志、用户导出不随主库删除立即物理擦除。
- 模型每日/月度预算预占、token usage 结算、不确定成本保守计入与 80% 预警/上限停止新请求已实现。生产需要明确四项预算/费率配置，不自动继承旧供应商价格；后台估算不是供应商账单。
- 第一方匿名事件、可信到账持久去重与有界补偿扫描、隐私及服务说明页已接入。统计默认关闭，DNT/GPC 停发；统计补偿不写金融事实，可选统计失败不阻止支付确认。
- 已执行隔离自动化与全 API mock 的运营浏览器验收，覆盖桌面 1440、手机 390/320、分页/工单/401 清空/无索引及无横向溢出。最终检查状态以本轮实际报告为准，不用固定测试总数替代检查结果。
- 本目录 systemd / Nginx / timer 都是模板，尚未安装、未公网发布。未开启任何后台定时任务。

**API 可用不等于生产上线。** 实际新域名 DNS/TLS、双渠道真实收码、生产商户付款/签名回调/退款、定时加密备份及离机恢复、公开部署仍待外部配置和真人验证。不得用上述 mock 验收宣称已开通收款、真实退款或搜索收录。

### 本轮实际执行记录

- Windows 与独立 Linux 工作副本各 `npm run check` **397/397**，原书 650 条与 797 处引用通过；运营及账号浏览器全 API mock 各 **14/14**（1440/390/320）。报告在本机 output，不提交运行日志或模拟会话。
- 已按白名单生成并在 Linux 验证源码包，再执行真实 `--dry-stage` 到独立 release。可信 manifest SHA-256：`eb1967f8ac0dc90710dda0bb7785785d8d3daedb263dff2da0837228d6231b78`。此包为 **405 个源码文件**，没有 env、数据库、key、旧 dist 或 node_modules。其 manifest 的 `productionActivated=false` / `buildAndTestsVerified=false` 描述离线源码包自身，独立构建结果另记录，不能改包标签冒充激活。
- 独立 `better-life` 不可登录服务身份、私人数据/备份目录、root:0600 env 与独立会话/备份/运营密钥已准备。既有本项目 Aliyun 邮件/短信与 DeepSeek 配置只经加密 SSH stdin 传输，没有输出或复用其他站点的用户/商户/会话秘密。
- 以专用服务身份初始化了本项目**空库**，并完成首个全库加密备份及恢复检查；没有真实用户、订单或加密私文。不能据此声称真实生产灾备演练完成、已有离机副本或每日 timer 已执行。
- 生产 preflight 在已构建的隔离副本检查：provider 配置齐全，仍因 `MEMBERSHIP_APP_ORIGIN` / `QA_ALLOWED_ORIGINS` 缺真实独立域名失败；新单继续关闭，商户未配置。该 root 检查不是 systemd 服务身份的完整启动验收。
- 新站 systemd / Nginx / backup timer **仍未安装、未开启**。没有公网激活或 current 指针，已有站点前后健康口均返回 204；这仅是当时的健康观察，不承诺完全无影响或长期可用。

成本保护暂设日上限 10 元、月上限 100 元。当前本项目模型为 `deepseek-flash`；[官方美元高峰价](https://api-docs.deepseek.com/quick_start/pricing/)为每百万输入（缓存未命中）0.30 美元、输出 1.20 美元。独立 env 的保护估算费率设 3 / 12 元，使用**自行选择的 10 倍人民币记账上界因子**，不是声称当前汇率、不是供应商人民币报价，也不是实际账单。真实账户含人民币与美元币种；激活前仍应核对实际扣费币种/账单、复核官方价格与所需容量，不能因为暂设预算就承诺无限用户或永远不超真实供应商费用。

## 隔离原则

只复用允许共用的服务资源，不复用 Image2 用户、会话秘密、数据库、商品、套餐、订单和商户回调地址。单实例 Node + SQLite 足够首版；本服务独立系统用户、目录、端口、域名。不要挂到 Image2 主站的路径下，否则浏览器同源 JS/Cookie/storage 无法形成应用隔离。

推荐目录：

| 内容 | 独立位置 |
| --- | --- |
| 不可变 release | `/var/www/better-life-releases/<release-id>` |
| 当前 release 指针 | `/var/www/better-life-current` |
| 私人数据库 | `/var/lib/better-life/membership.sqlite` |
| 加密备份 | `/var/backups/better-life/*.blbk` |
| 独立 env | `/etc/better-life/production.env` |
| 服务用户 | `better-life`，不可登录，不与原站共用 `deploy` |
| 回环端口 | `4178` 是模板候选，先查空闲，不能抢占 Image2 3001 |

源码/release 由管理员只读管理；数据库/备份目录 0700，env 0600 或 root:better-life 0640，服务 UMask=0077。新私库以 exclusive 0600 创建，不依赖手动 shell 默认 umask；既有文件不自动改权限或覆盖。Windows 测试不能代替 Linux 权限验收。

## 1. 域名与 HTTPS

选择独立域名或用户管理的子域名，核对公开 DNS 真正指向部署入口并申请覆盖该名称的证书。不要用本机代理返回的 `198.18.x.x` 当作 DNS 已生效。

此前 Image2 证书只覆盖 `image2.fun` 和 `www.image2.fun`，不能直接给新子域使用。不要占用其现有 `test.image2.fun` 别名。此项未完成前，不开公网登录/付费。

## 2. 服务端 env

下面是字段示例，不是现有已上线地址；秘密只在部署主机/密钥管理器设置，禁止贴到聊天、Git、VITE_ 或命令行参数。

```dotenv
NODE_ENV=production
PUBLIC_BASE_PATH=/
PUBLIC_SITE_ORIGIN=https://better-life.example.test
PUBLIC_INDEXING_ENABLED=false
QA_HOST=127.0.0.1
QA_PORT=4178
MEMBERSHIP_APP_ORIGIN=https://better-life.example.test
QA_ALLOWED_ORIGINS=https://better-life.example.test
MEMBERSHIP_DB_PATH=/var/lib/better-life/membership.sqlite
MEMBERSHIP_ENFORCE=true
MEMBERSHIP_LOCAL_DEMO=false
MEMBERSHIP_ANNUAL_ENABLED=false
MEMBERSHIP_EMAIL_PROVIDER=aliyun
MEMBERSHIP_SMS_PROVIDER=aliyun
MEMBERSHIP_TRUSTED_PROXY_IPS=127.0.0.1,::1,::ffff:127.0.0.1
MEMBERSHIP_SMS_DAILY_LIMIT=100
MEMBERSHIP_PAYMENT_PROVIDER=none
MEMBERSHIP_PAYMENT_CREATE_ENABLED=false
MEMBERSHIP_BACKUP_DIR=/var/backups/better-life
OPERATIONS_ENABLED=false
ANALYTICS_ENABLED=false
QA_BUDGET_DAILY_CNY=
QA_BUDGET_MONTHLY_CNY=
QA_PRICE_INPUT_CNY_PER_MILLION=
QA_PRICE_OUTPUT_CNY_PER_MILLION=
```

四项 `QA_*` 留空是待部署负责人核实并填写的预算/当前 token 费率，不是可直接启动的生产配置；全部为正数、每日不大于月度，支持最多六位小数。生产缺项会拒绝启动。使用 Shanghai 日/月界进行全站成本保护；来源不足/取消不扣用户次数不代表平台没发生模型费用。

`PUBLIC_SITE_ORIGIN` 是示例 origin，发布实际域名时必须替换；保留 `PUBLIC_INDEXING_ENABLED=false` 可做无索引预演，只有真实域名验收后再考虑 `true`。已公开 Pages 默认 canonical 仍保留，并不宣称新主站已部署或收录。前端 `VITE_ANALYTICS_ENABLED=true` 是构建开关，服务端 `ANALYTICS_ENABLED=true` 是接收开关；启用前更新隐私披露，开关不替代同源部署。

运营默认关闭。需开放时配置 `OPERATIONS_ENABLED=true`、独立 48 随机字节 canonical base64url `OPERATIONS_SECRET`，可选不含联系方式的 `OPERATIONS_OPERATOR_ID`。此 secret 不能复用登录/支付/备份密钥，不能进入 VITE_、URL、浏览器持久存储或日志。`MEMBERSHIP_SUPPORT_URL` 若设置，须为负责人核实并实际有人处理的安全联系入口，不用占位链接假装客服在线。

另行设置 `DEEPSEEK_API_KEY`、原五项阿里云变量、**本项目独立** `MEMBERSHIP_AUTH_SECRET`（至少 48 字符的高熵秘密）和独立 `MEMBERSHIP_BACKUP_ENCRYPTION_KEY`（32 随机字节的 canonical base64url，43 字符，拒绝占位/非规范编码与复用 AUTH_SECRET）。生产不自动生成秘密/私人库目录，缺项会拒绝启动；数据库与备份都不能位于 release/public/dist/tmp/Temp，也不能误用 Image2/Image_2/image2-shared/image2-current/image2-releases 等原站家族目录。路径所有祖先都拒绝 symlink/junction；生产 preflight 与备份实现使用同一 key/path 校验。Node 最低 22.16（Online Backup API）；已有服务器 22.22.3 可用。

`AUTH_SECRET` 负责验证码 HMAC 与私文 AES-GCM，不可随意轮换；备份加密 key 保护整个 DB，包括联系方式，两把 key 分别离线托管。**只有 DB 备份没有旧 AUTH_SECRET，私人指南仍不可恢复。**

## 3. 构建、preflight 和独立启动

1. 在新 release 内安装锁定依赖；以 `PUBLIC_BASE_PATH=/` 和实际 `PUBLIC_SITE_ORIGIN` 构建并跑 `npm run check`，保留本次结果而不是引用旧总数。会员前端 API 必须同源，`VITE_QA_API_URL` 不得指向绕过会员计量的别的 API；无索引预演产物不能误当正式索引版本发布。
2. 手动准备独立私人目录、env 与权限。`sudo -u better-life /usr/bin/node --env-file=/etc/better-life/production.env scripts/production-preflight.mjs`。这个命令只报告键名/布尔，不发码、不创建付费订单、不读用户正文。以服务用户跑，不能用 root 成功掩盖权限问题。
3. 模板 `deploy/better-life.service` 的 ExecStartPre 再次检查。正式 runtime 强制 HTTPS origin、双发码通道、独立持久 DB、禁 demo、会员计量；`/api/ask` 不允许缺省配置变成公开无限额接口。
4. 新增独立 Nginx vhost，替换模板域名/证书/端口；代理必须**覆盖** X-Real-IP / X-Forwarded-For，不能照转客户端输入。先 `nginx -t`，再 reload，不能覆盖/重启 Image2 upstream。
5. `GET /api/health` 应为 ready、metering=true、localDemo=false；不输出密钥、DB 路径和用户数据。它只验证进程/数据库就绪，不证明验证码或模型网络实测成功。
6. 公网验收：登录收码→刷新保持→绑定另一身份→退出→另种身份登录相同 user ID；额度成功扣 1、失败不扣，免费用完真实 402；两用户指南/订单互不可读。桌面和手机都走真实 HTTPS。
7. 独立运营入口不出现在普通导航，运营 401/退出/刷新擦除凭据与数据；用户退款只能选自己的已付订单，工单批准不开会员、不修改 paid/refunded。账号注销先实测最近认证与当前/未来权益、未核清订单、退款/工单/在途生成阻塞，再验证身份释放与全端会话失效。
8. 以隔离合成数据验证预算到预警/上限、失败和重启后保守记账；启用统计时检查 DNT/GPC、无原文/联系方式/URL 载荷、日报仅聚合、重复与补偿到账不重复计数。真实模型 usage/账单需另行核对，不能由 mock 数字推断真实费用。

## 4. 商户收费开放闸门

Image2 公开实现使用虎皮椒，可以复用其协议经验，但本轮没有确认商户对人生指南商品/新域名的许可，也没有复制商户秘密。先在商户控制台确认允许的商品/域名/收款渠道，再设置 **Better Life 字段**：

```dotenv
MEMBERSHIP_PAYMENT_PROVIDER=hupijiao
MEMBERSHIP_HUPIJIAO_APPID=
MEMBERSHIP_HUPIJIAO_APPSECRET=
MEMBERSHIP_PAYMENT_CREATE_ENABLED=false
```

- 回调由本项目 origin 自动生成：`/api/payments/hupijiao/notify`；订单 wire ID 为独立 32 字符 `bl_...`，不发送私人 user ID；价格只由服务端 planId 决定。
- 每笔订单永久绑定创建时 `merchant_id`，不能通过换配置让另一商户核销原单。旧未绑定订单不自动猜商户；存在未绑定/其他商户历史单时，runtime 与 preflight 拒绝使用新通道启动。保留原商户通道，先审核历史绑定/退款处理再迁移；不得直接 SQL 填新商户冒充迁移或开会员。
- 下单返回必须验签，支付链接只允许 HTTPS `xunhupay.com` 或其真实子域，不允许用户名密码/跳转到外部 host。
- 根据[付款/回调官方契约](https://www.xunhupay.com/doc/api/pay.html)，回调金额/商户/订单/平台交易号全部核对后，支付事实与权益同事务提交；重复通知幂等、同流水不能付两个账号、未提交不返回 success。浏览器 `paymentOrder` / `status=paid` 不会开会员。
- [官方查询示例](https://www.xunhupay.com/doc/api/search.html)没有定义可验证 nested data 的 canonical 签名；这是本项目采取的保守判断，所以查单**只能作提示，绝不自动入账/退款**。漏回调需要商户核对并重发已签名通知，不能手工改 paid 或用前端截图开通。
- `OD` 开通，已验签全额 `CD` 撤销该订单权益；退款先到、重复或迟到 paid 不会复活已退款会员。`RD` / `UD` 只记录退款处理中/失败，不提前撤权益；签名时戳倒序/同秒 pending 不能抹掉更晚失败，确实更晚的新退款尝试可以重进 pending，CD 是不可逆终态。不挪动其他已付款续购窗口；退款形成的排期空档需人工核对并明确处理。
- 本地订单 30 分钟 `expiresAt` 只是支付链接显示/重新下单提示期限，**不是支付网关关单**。原单随后真实支付并完成全部验签核对，仍按原订单不可变历史金额、套餐与时长兑现；不拿今天套餐变化或页面到期拒绝已付用户。前端 `paid:true`、回跳和截图不能替代签名入账。
- 不开放面向用户的自动退款接口，不从本程序调用退款网关。[官方退款契约](https://www.xunhupay.com/doc/api/refund.html)与商户实际权限仍需真实验收。
- 用户已可在账号订单区提交/查看退款申请工单，运营可审核与跟进。`approved` 只代表人工批准，`awaiting_provider` 只代表等待渠道；`resolved` 必须已有受信退款事实。以上不改变前一条“无自动退款网关”的边界。
- 可选匿名到账统计只读取已提交的 paid/refunded 订单元数据，按高熵订单摘要持久去重并按实际 `paid_at` 记账；启动、健康/报表读取触发有界补偿，冻结扫描高水位以回访晚到支付。补偿只修统计，不修 orders/entitlements；失败不吞掉真实支付 ACK，不把查询提示或浏览器回跳算成到账。
- 最后经明确安排做真实金额的支付、验签回调、重复回调、退款及回跳测试，确认后才设 `MEMBERSHIP_PAYMENT_CREATE_ENABLED=true`。本轮未花钱测试，不能称收费闭环已上线。
- 停售：只改新单开关 false，保留 provider/商户秘密和已付回调入口，以免漏掉已有订单退款。

## 5. 备份、离机副本与恢复演练

正式环境以服务用户执行：

```sh
/usr/bin/node --env-file=/etc/better-life/production.env scripts/membership-backup.mjs create
```

用 SQLite Online Backup API 获取包含 WAL 已提交事务的一致快照；临时明文仅放私人目录并清理。最终 `.blbk` 用独立 AES-256-GCM key 加密。调用内再次解密校验完整性、外键、Better Life DB 标记与每段私文，验证失败退出非零，不伪装备份成功。不复制裸 `.sqlite` 文件冒充完整快照。

选择某份 `.blbk`，把其路径设在 `MEMBERSHIP_RESTORE_CHECK_FILE` 后执行 `scripts/membership-backup.mjs check`，默认只恢复到随机私人临时文件验证并清理，不覆盖原库。需要取出已验证恢复库时，指定新的私有 `MEMBERSHIP_RESTORE_DESTINATION` 与 `MEMBERSHIP_RESTORE_CONFIRM=restore-to-new-file`，执行 `scripts/membership-backup.mjs restore`；目标不得已存在或等于生产 DB。

事故恢复步骤：停止 Better Life 单实例→保留现有 DB/WAL/SHM 的完整故障副本→使用正确的两把旧 key 恢复到新文件→确认解密/外键/完整性及关键会员流水→在停机窗口由管理员切换 DB 路径→启动、健康检查、用户登录验收。严禁运行中覆盖数据库，严禁误操作 Image2 数据目录。

`better-life-backup.service` / timer 仅模板；启用前手动演练。推荐离机保存加密备份并按日 7 份/周 4 份/月 3 份保留，删除策略人工确认后实施，本脚本不自动删旧备份。磁盘至少预留 DB 的两倍快照空间；备份 key/旧 AUTH_SECRET 不与唯一机器同生共死。离机上传和真实生产灾备演练尚未配置。

## 6. 发布回滚

保留前一不可变 release。切换 current 指针后只重启 Better Life，失败切回旧指针再启动。数据库迁移采用加列/加表、不给旧列清空；回滚代码不回滚真实收费流水。大改 schema 前先备份并恢复校验，不把恢复旧 DB 当作日常代码回滚，以免丢掉已付订单。

最终上线记录须分别记录 DNS/TLS、真实收码、真实模型、扣次、真实支付/退款、备份恢复、原站健康的实际结果；未执行项继续标待验，不用 mock PASS 冒充生产完成。
