# 人生指南：独立会员主站发布与恢复

## 本轮实际状态（2026-10-03）

- 已复用阿里云邮件/短信适配代码；本机配置不等于实际送达。
- 新增生产启动检查、同源健康检查、默认关闭的虎皮椒适配器、验签回调、原子幂等开会员/撤销已退款订单权益。
- 已验证的支付流程都是 mock transport / 临时 SQLite 测试。未读取/复制 Image2 商户凭据，未创建真实收费订单、未扣款、未发起退款。
- SQLite online WAL 快照、全库 AES-GCM 加密、恢复解密/完整性/原私文密钥校验已实现并在临时数据库测试。
- 本目录 systemd / Nginx / timer 都是模板，尚未安装、未公网发布。未开启任何后台定时任务。

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
```

另行设置 `DEEPSEEK_API_KEY`、原五项阿里云变量、**本项目独立** `MEMBERSHIP_AUTH_SECRET`（至少 48 字符的高熵秘密）和独立 `MEMBERSHIP_BACKUP_ENCRYPTION_KEY`（32 随机字节的 canonical base64url，43 字符，拒绝占位/非规范编码与复用 AUTH_SECRET）。生产不自动生成秘密/私人库目录，缺项会拒绝启动；数据库与备份都不能位于 release/public/dist/tmp/Temp，也不能误用 Image2/Image_2/image2-shared/image2-current/image2-releases 等原站家族目录。路径所有祖先都拒绝 symlink/junction；生产 preflight 与备份实现使用同一 key/path 校验。Node 最低 22.16（Online Backup API）；已有服务器 22.22.3 可用。

`AUTH_SECRET` 负责验证码 HMAC 与私文 AES-GCM，不可随意轮换；备份加密 key 保护整个 DB，包括联系方式，两把 key 分别离线托管。**只有 DB 备份没有旧 AUTH_SECRET，私人指南仍不可恢复。**

## 3. 构建、preflight 和独立启动

1. 在新 release 内安装锁定依赖；以 `PUBLIC_BASE_PATH=/` 构建并跑 `npm run check`。会员前端 API 必须同源，`VITE_QA_API_URL` 不得指向绕过会员计量的别的 API。
2. 手动准备独立私人目录、env 与权限。`sudo -u better-life /usr/bin/node --env-file=/etc/better-life/production.env scripts/production-preflight.mjs`。这个命令只报告键名/布尔，不发码、不创建付费订单、不读用户正文。以服务用户跑，不能用 root 成功掩盖权限问题。
3. 模板 `deploy/better-life.service` 的 ExecStartPre 再次检查。正式 runtime 强制 HTTPS origin、双发码通道、独立持久 DB、禁 demo、会员计量；`/api/ask` 不允许缺省配置变成公开无限额接口。
4. 新增独立 Nginx vhost，替换模板域名/证书/端口；代理必须**覆盖** X-Real-IP / X-Forwarded-For，不能照转客户端输入。先 `nginx -t`，再 reload，不能覆盖/重启 Image2 upstream。
5. `GET /api/health` 应为 ready、metering=true、localDemo=false；不输出密钥、DB 路径和用户数据。它只验证进程/数据库就绪，不证明验证码或模型网络实测成功。
6. 公网验收：登录收码→刷新保持→绑定另一身份→退出→另种身份登录相同 user ID；额度成功扣 1、失败不扣，免费用完真实 402；两用户指南/订单互不可读。桌面和手机都走真实 HTTPS。

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
