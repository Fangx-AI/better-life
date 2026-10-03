# 会员与私人指南服务（单实例原型）

2026-10-03。单实例服务、手机号/邮箱登录适配、默认关闭的真实支付适配器与加密备份已实现并测试；不等于验证码已实收、商户已收款或正式部署。

## 用户真正买到的价值

私人指南是自己保存、修改和持续整理的生活档案：按主题放好正文，关联原书依据，确认自己的具体情况，维护行动清单，需要时继续问，并先审阅 AI 更新稿再决定是否保存。

- 免费登录：5 份私人指南，每 30 天 10 次有依据的生成。
- 月度实验价：¥19 / 30 天，100 份私人指南，每 30 天 200 次生成。
- 年度实验价：¥129 / 365 天，100 份私人指南，每 30 天 200 次生成；默认仅价格预览。
- 一次购买到期，没有自动续费。到期后已有私人指南、版本、编辑、导出和删除仍可用；新增档案回到免费容量。
- 正文、原书、检索、出处和下载不付费、不扣次。私人指南继续提问和待确认更新稿已实现；自动提醒、自动执行、外部工具平台和退款界面尚未实现。

套餐真源是 `shared/membership-plans.mjs`。前端金额、用户 ID、会员状态、回跳 URL 和 `paid:true` 不具备开通权限。

## 当前交付状态

| 能力 | 实际状态 |
| --- | --- |
| 本机体验账号、指南、版本、个人情况、行动清单、导出 | 实际同源 API + SQLite 持久化，不是只有浏览器 mock |
| 结合当前指南继续问 | 已接入原有 DeepSeek 服务；需要服务端模型配置与剩余额度，成功只产生待确认草稿 |
| 手机号 / 邮箱登录与绑定 | 阿里云适配代码、同账号绑定与注入测试已完成；本机五项阿里云配置已复用，尚未实际收码；Resend 仍为邮箱可选方案；`loginAvailable` 只代表配置可用 |
| Pricing 与订单核对 | 固定套餐金额与虎皮椒 runtime adapter 已实现，默认关闭新收费单，商户与历史订单严格绑定 |
| 签名商户回调与退款撤权 | 已实现验签、归属/金额/流水核对、重复幂等、全额退款只撤本单；测试采用 Mock，不是实际收款验收 |
| 备份与恢复 | SQLite online WAL 快照、全库 AES-GCM、临时恢复校验与恢复到新文件已实现；未备份真实用户库，未启用定时器 |
| 实际收款 | **未开通真实收款**；`checkoutAvailable=false`，付费按钮只能展示等待开放 |
| 正式商业主站 | 需要自有 HTTPS 同源站点、持久数据和运维条件，不能将本机体验端口转发成生产服务 |

本机体验账号不是邮箱账号，也不会自动迁移成正式会员。当前没有账号迁移/合并接口；可以先导出自己的 Markdown，正式迁移必须另行验证归属并实现。

## 运行与配置

现有 `npm run dev` / `npm run preview` 安装同源 API；`npm run api` 启动单实例 Node API，独立启动默认按生产校验，不以缺省环境绕过计量。最低 Node 22.16（包含 online backup），本机测试为 Node 24.13。使用内置 `node:sqlite`，未新增数据库依赖；该 API 仍有 experimental 提示。[Node 官方说明](https://nodejs.org/api/sqlite.html)

开发默认数据库：`output/private/membership.sqlite`，位于已忽略的 `output/`；生产必须显式使用仓库外独立持久目录，拒绝 Image2、公有目录、临时目录与 symlink/junction。数据库品牌标记阻止误用其他应用的 SQLite。`.gitignore` 排除 DB、WAL、SHM 与 `.blbk`，但不替代服务器权限。数据库绝不复制到 `public/`、静态构建、GitHub 或分享截图。

Git 忽略并不阻止 HTTP 下载。Vite 明确保留当前默认 `.env`、证书/私钥、npm/yarn配置、`.git` 拒绝规则，再拒绝 `private/`、SQLite/DB/WAL/SHM；同源 middleware 在静态服务之前另行拒绝私人路径（含编码、Windows `@fs` 和大小写形式）。本机体验 dev 和 preview 默认绑定 loopback，不应以 CLI 覆盖成局域网地址。测试只使用假路径/内存请求，不通过 HTTP 读取实际秘密文件。

复制 `.env.example` 后在**服务端**配置，不在聊天、日志或静态前端放秘密：

| 配置 | 含义 |
| --- | --- |
| `MEMBERSHIP_AUTH_SECRET` | 开发至少 32、生产至少 48 字符高熵秘密；验证码 HMAC 与私人正文 AES-256-GCM 密钥来源，生产拒绝占位值 |
| `MEMBERSHIP_EMAIL_PROVIDER` / `MEMBERSHIP_SMS_PROVIDER` | 本项目默认选择阿里云邮件/短信；Resend 是可选邮箱方案，缺发送配置时该通道返回 503 |
| 五项阿里云变量 | `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_EMAIL_ACCOUNT_NAME`、`ALIYUN_SMS_SIGN`、`ALIYUN_SMS_TEMPLATE_CODE`；只放服务端，不在文档写实际值 |
| `RESEND_API_KEY` / `MEMBERSHIP_EMAIL_FROM` | 选择 Resend 时使用，需自己的已验证发件域；不是阿里云邮箱的必需项 |
| `MEMBERSHIP_DB_PATH` | 开发可选；生产必须显式指定独立私有 SQLite 文件，不是数据库连接串 |
| `MEMBERSHIP_APP_ORIGIN` | 正式商业主站唯一 HTTPS origin；本机留空按请求 origin |
| `MEMBERSHIP_ENFORCE` | 开发默认 `false`；生产强制 `true`，保护 `/api/ask`，缺项不启动 |
| `MEMBERSHIP_LOCAL_DEMO` | 默认 `false`；明确开启的非生产 HTTP loopback 本机体验，不是邮箱认证 |
| `MEMBERSHIP_ANNUAL_ENABLED` | 默认 `false`，年付仍为预览 |
| `MEMBERSHIP_PAYMENT_PROVIDER` / `MEMBERSHIP_PAYMENT_CREATE_ENABLED` | 默认不接收新收费单；虎皮椒需完整专属配置，只有明确 `true` 才开放新单 |
| `MEMBERSHIP_HUPIJIAO_APPID` / `MEMBERSHIP_HUPIJIAO_APPSECRET` | Better Life 独立支付字段；不得自动复制另一项目商户秘密或回调地址 |
| `MEMBERSHIP_BACKUP_DIR` / `MEMBERSHIP_BACKUP_ENCRYPTION_KEY` | 独立私有目录与独立 32 随机字节 canonical base64url（43 字符）key，不能复用 AUTH_SECRET |

秘密不能丢失或随意轮换，否则旧档案无法解密。加密备份与恢复校验已实现，密钥版本和自动轮换尚未实现；备份 key 与旧 AUTH_SECRET 都应独立安全托管。缺少或过短秘密时，旧会话也无法写私人数据，不能回退成公开可预测的加密密钥。邮件暂不可用但秘密正确时，已登录用户仍可读取自己的档案。

选择 Resend 时使用官方 `POST /emails` 的 from/to/subject/text，10 秒超时；阿里云是另外的受控发送适配器。已通过 mock 验证供应商验签/响应失败与 OTP 撤销，但未发送真实邮件或短信。[Resend 官方接口](https://resend.com/docs/api-reference/emails/send-email)

### 直接体验自己的私人指南（仅本机）

开发者可以只对本机进程显式设 `MEMBERSHIP_LOCAL_DEMO=true`，并绑定 `127.0.0.1`。同时要求非 `production`、HTTP loopback URL 与 origin、可信 Node socket IP 为 loopback。远程 IP、外部域名、HTTPS、跨站或无 Origin 的登录请求均不能使用本机入口。

适配器还拒绝带已知 Forwarded / X-Forwarded / CF 代理迹象的本机登录，内部标记覆盖客户端伪造值。这不能识别一个刻意删除全部代理头的自定义反向代理，因此绝不能将体验端口公开转发或套隧道上线。

`GET /api/membership` 多一个 `localDemoAvailable`；只有真实满足条件才为 true。随后 `POST /api/auth/local-demo` 创建持久的专用体验用户和随机 opaque 会话。响应 `user.authentication='local-demo'`、`user.email=null`、`user.label='本机体验账号'`，绝不把它标成邮箱已验证或付费用户。

这是真实本机存储而非浏览器 mock：可以新建、修改、导出私人指南；账号、Cookie 会话和档案可在服务重启后继续使用。只享有免费 5 份档案/每 30 天 10 次生成；真实邮箱 API 未配置仍返回 503。本机模式即使注入支付 provider 也强制关闭 checkout，不能制造已付会员。该会话换到远程客户端、关闭本机模式或进入生产环境后失效。

若没有配置 `MEMBERSHIP_AUTH_SECRET`，该明确模式会在 `output/private/local-demo.key` 自动生成持久高熵秘密，读取它来加密本机数据；不修改 `.env.local`、不显示/返回/记录秘密。整个目录与 `*.key` 均被 Git 忽略。应保留该文件，丢失后无法解密旧本机档案。此模式不能挂在公网或反向代理后，不提供公开 reset、开会员或测试付款接口。

### Windows 本机启动

完成依赖安装后，在仓库根目录的 PowerShell 执行，以下仅设置当前终端的环境，不写 `.env.local`，也不创建默认付费会员。下面目录为当前设备的实际项目位置；其他设备替换为自己的仓库绝对路径：

```powershell
Set-Location -LiteralPath 'C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\better-life'
$env:NODE_ENV = 'development'
$env:MEMBERSHIP_LOCAL_DEMO = 'true'
$env:MEMBERSHIP_APP_ORIGIN = 'http://127.0.0.1:4190'
$env:QA_HOST = '127.0.0.1'
npm run dev -- --host 127.0.0.1 --port 4190 --strictPort
```

打开 [本机体验](http://127.0.0.1:4190/)，从页面的本机体验入口进入私人指南。端口已被占用时启动会失败，不会悄悄跳到其他端口造成 Origin 不一致；先关闭占用者或同时修改端口与 `MEMBERSHIP_APP_ORIGIN`。

已构建的版本可用 `npm run preview -- --host 127.0.0.1 --port 4190 --strictPort`，但仍必须显式 `NODE_ENV=development`，否则 Vite preview 的生产环境会正确拒绝本机体验。preview 路径要与构建时的 `PUBLIC_BASE_PATH` 一致：默认 `/better-life/`，根路径构建则为 `/`。独立 `npm run api` 只启动 API，不提供上述网页，不应将另一端口的网页直接跨域拼接私人登录。

关闭进程可按 Ctrl+C；关闭当前终端撤销这些临时环境设置。**不要为重试而删除 key、数据库或 WAL，也不要重建一个不同秘密来“修复”旧档案**。登录失败先查 `GET /api/membership` 的非敏感状态、实际 origin 和 socket 本机条件，不输出任何秘密。

## 私人数据持久化、备份与恢复

这是单实例文件数据库，不是云端同步已经上线。`MEMBERSHIP_DB_PATH` 是 SQLite 文件路径，不是 PostgreSQL 连接串；多实例/PostgreSQL 迁移尚无实现。相同数据库、相同秘密和仍有效会话可以重启后继续使用；Cookie 30 天到期后需重新登录，本机账号仍复用原来的专用身份。

当前写入的用户、会话、指南、版本、个人情况、额度流水、订单和加密重试缓存都在数据库。正文加密不意味着业务元数据匿名：邮箱、订单金额/时间、计数与 ID 仍需保密。单篇 Markdown 导出是用户可读副本，**不包含完整账号/订单/额度/版本库，不是数据库备份**。

### 本机冷备份流程（手动，未自动执行）

1. 停止**所有**使用同一个数据库路径的 dev、preview 和独立 API 进程，确认没有其他写入者。
2. 在受保护的仓库外目录备份数据库主文件，以及此时仍存在的同名前缀 `-wal` / `-shm` 文件；保持为同一份停止写入后的备份，不混用不同日期文件。
3. 另行安全保存匹配的加密秘密：本机自动生成的是 `output/private/local-demo.key`；显式配置的秘密应从密钥管理系统备份，不要打印、截图或发送到聊天。数据库备份与秘密使用独立权限和加密存储。
4. 记录备份日期、数据库文件名、应用版本与资料快照，不记录完整问题或秘密；不要把备份放进 `public/`、`dist/` 或 Git。
5. 在独立隔离目录恢复副本，用同一秘密做本机验证，检查能否登录、读写自己指南、查看版本、导出及正确显示额度。验证成功再安排正式恢复，保留当前原库，不直接覆盖唯一副本。

WAL 可能包含已经提交、尚未合并到主文件的数据；运行中只复制主文件可能漏掉数据，不能手动删除 WAL 来“清理”。本仓库的 `npm run db:backup` 已用 SQLite Online Backup API 获取一致快照，随后全库加密；备份 key 和旧 AUTH_SECRET 均需保存。[SQLite WAL 说明](https://www.sqlite.org/wal.html)、[SQLite 备份接口](https://www.sqlite.org/backup.html)

`npm run db:restore-check` 只恢复到随机私人临时文件，检查数据库标记、完整性、外键和私人内容解密并清理；`npm run db:restore-new` 须明确确认且只能生成新的恢复文件，拒绝覆盖原库或已有文件。路径含 symlink/junction（包括缺失子目录的祖先链接）会在创建目录前拒绝。生产 preflight 共用同一 key/path 规则。完整部署、离机备份、事故切换步骤见 `docs/PRODUCTION-RELEASE.md`；定时 service/timer 只是模板，未启用。

备份和恢复是操作建议，不表示已替用户备份了真实私人数据。本轮文档核对没有读取真实数据库、私钥或 `.env.local`。

## API 合同

所有响应默认 `Cache-Control: no-store`。错误统一 `{error:{code,message}}`，不输出供应商错误正文或密钥。

| 接口 | 数据 |
| --- | --- |
| `GET /api/membership` | `{enforced,loginAvailable,emailLoginAvailable,phoneLoginAvailable,localDemoAvailable,checkoutAvailable,annualAvailable,plans}`；套餐含 `id,name,amountFen,currency,durationDays,quotaPerPeriod,periodDays,guideLimit,purchasable` |
| `GET /api/me` | `{user,membership,quota,orders}`；游客 `user:null`、额度 0；登录后用户自己的邮箱、会员到期、额度更新时间和最近 30 单 |
| `POST /api/auth/code` | `{email}` 或 `{phone}`，恰好一种身份 → `{sent:true,expiresIn:300,retryAfter:60}`；验证码只经发送通道，绝不在响应返回 |
| `POST /api/auth/verify` | `{email,code}` 或 `{phone,code}` → 与 `/api/me` 相同结构，并设置 Cookie |
| `POST /api/auth/link/code` / `POST /api/auth/link/verify` | 已登录本人凭另一身份 OTP 绑定同一 user ID；已被占用的身份不自动合并，登录 OTP 不能代替绑定 OTP |
| `POST /api/auth/local-demo` | 只在符合本机显式条件时创建真实免费本机体验会话，返回 `/api/me` 结构；其余 403 |
| `POST /api/auth/logout` | 撤销当前会话、清除 Cookie |
| `POST /api/orders` | `{planId,requestId}` → `{order}`；新单 201，同 ID 同套餐复用 200 |
| `GET /api/orders/:id` | 返回本人持久已验签状态及 `{order,user,membership,quota,orders}`；查询平台结果仅提示，不能单独开会员 |
| `POST /api/payments/hupijiao/notify` | 独立 bounded form 验签接口；仅商户签名事实可入账，无浏览器 Cookie/Origin 权限捷径 |
| `GET /api/health` | 进程/DB、计量、登录配置与支付新单开关；不输出秘密、路径和私人内容 |
| `GET /api/profile` | `{facts:[{id,label,value,confirmedAt}],revision}` |
| `PATCH /api/profile` | `{revision,facts:[{id?,label,value}]}` → 新 profile；**此显式操作才确认个人情况** |
| `GET /api/guides` | `{guides,limit,remaining}`，仅本人 |
| `POST /api/guides` | `{title,topic,content,sourceIds,factIds?,tasks?,snapshotDate?}` → `{guide}`，201 |
| `GET /api/guides/:id` | `{guide}` |
| `PATCH /api/guides/:id` | `{revision,title?,topic?,content?,sourceIds?,factIds?,tasks?}` → `{guide}` |
| `DELETE /api/guides/:id` | `{ok:true}`，正文与全部版本一起删除 |
| `GET /api/guides/:id/versions` | `{versions:[{id,revision,title,topic,createdAt}]}` |
| `GET /api/guides/:id/versions/:versionId` | `{version}`，包含当时完整正文、任务、引用与资料快照 |
| `POST /api/guides/:id/restore` | `{versionId,revision}` → `{guide}`；恢复生成新 revision，不改旧历史 |
| `GET /api/guides/:id/export` | `text/markdown` 下载附件，含正文、清单、已选个人情况与原书引用版本 |
| `POST /api/guides/:id/ask` | `{question,requestId,factIds?:[id]}` → 标准 QA + `draft`；不自动保存草稿 |

`guide`：`{id,title,topic,content,sourceIds,sourceSnapshots,snapshotDate,factIds,tasks,revision,createdAt,updatedAt}`。

`user`：`{id,email,phone,label,authentication:'email'|'phone'|'local-demo'}`，未绑定联系方式为 null；本机体验邮箱和手机号均为空；游客为 `null`。不要把本机 label 当邮箱地址，绑定不会改变原 user ID、额度或会员。

`draft`：成功私人问答为 `{title,topic,content,sourceIds,tasks,baseRevision}`，依据不足为 `null`；`tasks` 保留已保存指南的真实状态。包装器还返回 `quota`，幂等重取可能带 `reused:true`。用户确认更新时仍需向 PATCH 提交当前 `revision`；`baseRevision` 不是绕过版本检查的凭证。

`version.id` 是版本 ID，不是指南 ID。订单 `order.expiresAt` 是本页面付款链接提示期限，不是网关关单，也不是会员到期；到时可提示重新下单。若原单后来真实支付且签名/商户/金额/流水核对通过，仍按该订单历史价格和时长兑现，避免已付款丢权益。会员有效期读取 `/api/me` 的 `membership.expiresAt`。状态为 `created/pending/paid/failed/expired/refunded`，另有 `refundState` 的处理中/失败提示；已退款是终态，倒序退款消息或迟到 paid 不得复活。

- 标题 1–120 字符、主题 0–80、正文 0–12000，可先建空档案再问。
- 最多 128 个真实原书条目 ID；新增引用在服务端核对原始 corpus。`sourceSnapshots` 为每条依据记录其首次关联时的书本日期、revision、章节和标题；编辑不能把历史依据假装成已实时核验。
- 最多 50 个任务，每项 `{id,title,done:boolean}`。状态只能经用户明确 PATCH 变更，AI 结果没有写数据库的权限。
- 个人情况最多 30 项，每项 label 最多 80、value 最多 500 字符。服务端生成 `confirmedAt`，不信客户端伪造时间。
- 最多关联 20 个本人已确认事实 ID；继续提问只能显式选最多 8 项。模型不会拿到所有档案或全部个人情况。
- 更新和恢复必须带当前 revision；并发旧编辑返回 409 `revision_conflict`，不静默覆盖。
- 每份指南保留最新 100 个版本；删掉个人情况后，编辑旧档案会去掉失效关联，恢复也不会复活已删除事实。

兼容的主动回答保存接口：`GET/POST /api/saved-answers`、`DELETE /api/saved-answers/:id`。POST `{result}` 验证回答结构与原书引用，并按服务端资料重建 sources。因为此接口接受用户提供/改写的内容，保存结果标 `provenance:user-provided`、`model:用户保存`，不能宣称是平台验证过的模型原始输出。免费 10 份，有效付费会员 200 份，已有内容到期后仍可读取、删除。

## 登录与浏览器安全

- 邮箱/大陆手机号六位 OTP，随机生成；数据库保存含随机 salt 的 HMAC，不保存明文验证码。5 分钟有效、一次使用，5 次错误后失效；通道、登录/绑定用途与目标账号相互隔离。
- 发送按邮箱 5 次/小时、同可信客户端 20 次/小时、全实例 200 次/小时限频；同邮箱 60 秒冷却。验证也有邮箱/客户端限流。
- Cookie 是随机 256-bit opaque token；数据库只保存其 SHA-256，30 天到期，可注销。重新登录旋转当前浏览器旧会话。
- `HttpOnly; SameSite=Lax; Path=/`；正式 HTTPS 加 `Secure`。只有本机 loopback 允许 HTTP。
- 浏览器 POST/PATCH/DELETE 强制同源 Origin；无 Origin、错误 Origin、cross-site 请求都拒绝。唯一独立例外是必须商户验签的支付通知，不借此开放账号写入。账号/私人 API 不开放跨域 CORS。
- 正式运行必须配置 HTTPS 主站 origin，并把 API 反向代理在**同一商业主站**。GitHub Pages 保留免费入口；不采用 Pages + 第三方 Cookie 拼接会员登录。
- 适配器丢弃客户端伪造转发 IP，使用 Node socket 身份；仅显式精确可信代理 socket IP 可提供单一合法 `X-Real-IP`。网关必须覆盖而非透传客户端该头；短信有持久实例日预算（默认 100）。
- 私人写操作每用户 30 次/分钟、全实例 500 次/分钟，档案/版本/正文有容量边界。仍需生产网关防刷、账户滥用控制和总存储预算。

邮箱、订单和计数是服务端业务元数据；私人指南、个人情况、主动保存回答以及短期答案重试缓存为 AES-GCM 密文。**加密不替代权限控制、TLS、备份访问权限和合规删除**。所有私人实体按会话用户做 SQL 所属校验，不能从正文中的 userId 选账号。

## 收费边界：默认无法真实付款

虎皮椒 adapter 已由 runtime 接入，但完整商户配置与新单开关默认关闭：未配置时 `checkoutAvailable=false`、付费计划 `purchasable=false`，创建订单返回 503，不创建收费单、不扣款。当前未开通真实收款。不存在公开的 mock paid、手动开会员或 admin 开通接口。

服务端 adapter 合同（真实实现在 `server/payment-hupijiao.mjs`）：

```js
{
  merchantId,
  creationEnabled,
  createCheckout({ id, amountFen, currency, description, expiresAt, signal }),
  verifyPayment({ id, amountFen, currency, signal }),
  verifyNotification(request)
}
```

下单响应必须验签；支付 URL 仅允许无凭据 HTTPS `xunhupay.com` 或真实子域。通知限 16KB、拒绝重复字段/篡改/非法时戳，核心核对 `merchantId,orderId,amountFen,currency,transactionId`，支付事实与权益原子提交。查询的 nested data 没有可可靠核对的签名合同，因此始终为 advisory，不作为已付/已退款证据。支付方法等待 10 秒中止，未知结果不等于失败，漏通知需商户核对后重发已签名回调。

每单保存不可变 `merchant_id`；换商户不能接受/复用旧单。旧未绑定订单不自动猜测归属，有未绑定或其他商户历史订单时，runtime 与 preflight 都拒绝带新通道启动；保留原通道并人工核对迁移，不能直接换 env 掩盖。

同一交易流水不能付两单，同一成功订单只授予一次 entitlement。相同 requestId 重复创建不重复调用支付平台。平台未确认前，前端「已付」按钮、query 参数和 pending 订单都不能开通。

续购从已有最后一份权益到期后接续；月转年不立即双扣。年付最后 5 天仍有正常 200 次周期，周期到会员到期日结束。已签名全额退款 CD 撤本订单权益，RD/UD 只记处理/失败；时间倒序与同秒旧 pending 不抹掉更新失败事实，终态不复活。其他已付续购窗口不被挪动，退款造成排期空档需核对。运营后台、用户发起退款界面、自动退款调用、真实渠道验收与自动对账**尚未实现**，不能承诺已上线收款或自动退款。

### 正式接通前的检查单

1. **自有同源 HTTPS 主站**：生产设置 `NODE_ENV=production`、`MEMBERSHIP_LOCAL_DEMO=false`、唯一 `MEMBERSHIP_APP_ORIGIN`；前端和 `/api` 在同一 HTTPS origin，私人 API 不靠 CORS 或第三方 Cookie 拼接。静态下载服务器也要拒绝私人目录。
2. **持久化与权限**：独立持久卷/数据库文件、最小文件权限、空间监控、冷备或合格热备、隔离恢复演练。现有运行时只支持单实例 SQLite；采用正式数据库需实现迁移、事务和并发核验，不能只换环境变量。
3. **身份与秘密**：生产至少 48 字符高熵秘密进入密钥管理系统；真实邮箱/短信通道需收码、过期/限流/注销与安全 Cookie 验收。已配阿里云五项不等于已送达；Resend 是可选替代。开发本机身份在生产不能登录；不读本机 key 当生产秘密。
4. **模型保护**：真实 DeepSeek 配置、成功率/成本观测、平台预算与防刷告警。生产必须 `MEMBERSHIP_ENFORCE=true`，否则拒绝启动；价格本身不保护支出。
5. **支付 adapter**：确认自己商户对商品/新域名许可，配置独立字段并核对历史归属，真实支付/验签回调/退款/回跳验收后才开放新单。没有一个环境开关能直接开启真实收款：仅有 `true` 而缺完整商户配置不开放；配置通过也不能代替商户权限和实际验收。
6. **售后与对账**：签名回调、晚到支付、退款撤权已实现 Mock 回归；仍需生产异常通知恢复、实际退款测试、对账审计、用户条款与联系/退款入口。未达到可交付状态，按钮保持等待开放。

到期只改变新增容量与提问额度，不自动删除档案。即使原来创建超过免费 5 份，既有指南仍能编辑、恢复、查看版本、导出和删除；满免费容量时暂不能新建，删除后低于容量才能继续新建。账号会话过期需要重新认证，这与会员到期是两回事。

## 问答扣次与持续整理

开发公共 `/api/ask` 默认保留原行为；正式生产强制 `MEMBERSHIP_ENFORCE=true` 与登录额度。私人指南继续问始终要求本人登录并经过服务端额度。

会员 wrapper 注入 `personalQaHandler(request,{guide,profileFacts})`。只传当前选中的指南和显式选中的已确认事实，所有资料都是数据，不是新的系统指令。成功返回待确认 `draft`，由用户审阅后单独 PATCH；模型不写 facts、不勾任务、不改 revision。

- 请求 ID 8–128 个字母/数字/下划线/短横线，同用户幂等。
- hash 包含问题、经校验的连续聊天 history、guideId、guide revision 和选中事实内容；同 ID 换上下文返回 409。
- SQLite `BEGIN IMMEDIATE` 原子预占；一次成功、有依据且结构合格的结果消耗 1 次。
- insufficient、校验失败、超时、上游失败、用户取消都释放预占。每用户一次只允许一个在途生成；每分钟最多 6 次、每日成功最多 30 次，当前每日窗口按 UTC 日界计算。
- 完成结果加密短期缓存 24 小时，支持同 ID 重取，只扣一次；问题原文不存进默认 generation 表，仅 hash。缓存不是用户历史，过期后不能重取，下一次会员/私人 API 请求清理时清除密文；没有后台定时清理服务，生产需补齐。旧 ID 墓碑与额度流水保留，避免重新扣次。
- 失败/取消后的 requestId 不再执行，需新 ID 重试。重启或断连悬挂预占在 2 分钟到期后、下一次 API 请求清理时释放一次。
- 额度 reserve/consume/release 有持久流水；未实施真实 token 成本统计、平台模型预算和多实例限流，收费上线前须补齐。来源不足不扣用户次，但实际模型成本仍可能由平台承担。

## 验收与尚缺条件

自动化使用内存/临时 SQLite、注入邮件/支付/模型，覆盖 OTP 持久尝试与一次性、Cookie/CSRF、重启持久、固定金额、账号隔离、假支付不授予权益、额度并发/释放/重试、版本冲突、恢复、Markdown 导出、资料快照、显式事实选择和无自动草稿写入。

尚缺真实手机号/邮箱收码、商户商品/域名许可与真实支付/退款验收、生产独立数据库/离机备份及灾备演练、自动密钥轮换、商业同源 DNS/TLS 部署、账号删除与完整隐私/服务条款、生产对账、防刷、模型账单预算与告警。本文自动化采用内存或临时 SQLite 与 mock 发送/支付，不读取真实私库、不发码、不向真实支付平台下单、不实际扣款。真实 DeepSeek 验证以另行记录为准，不能由 mock PASS 推断生产接通。

没有运营管理界面。管理员不能通过公开 URL 修改 paid 状态。将来管理工具需独立身份授权、审计、最小权限，且付款仍以平台核验为准，不用直接 SQL「补单开会员」替代对账。
