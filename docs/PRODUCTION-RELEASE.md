# 人生指南：独立会员主站发布与恢复

## 当前实现与生产边界（更新于 2026-10-05）

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
- 本项目每日加密备份 systemd/timer 已真实安装、手动触发成功且 timer active。会员主站 systemd/Nginx/current 尚未激活；健康/预算监控与告警代码已实现，负责人通知入口仍待配置，不宣称已收到通知。

**API 可用不等于商业生产上线。** 免费 Pages 已公开发布新版，独立会员主站的新域名 DNS/TLS、双渠道真实收码、生产商户付款/签名回调/退款、负责人告警及主站激活仍待外部配置和真人验证。服务器备份、Windows 离机副本及空库隔离恢复已有真实证据；它们不替代真实用户数据灾备、开通收款、真实退款或搜索收录。

### 当前完整目标验收与交接

免费站首次新版发布对应 main 合并提交 [`6ddea4f`](https://github.com/Fangx-AI/better-life/commit/6ddea4f5245f70f3f53d07f3a99e02c7138ebe24)；[Actions 37309802847](https://github.com/Fangx-AI/better-life/actions/runs/37309802847) 的 check/deploy 均成功。真实 HTTPS 浏览器确认新版首页、阅读页左目录、Obsidian 下载和分享页可达，未请求会员／模型／统计 API。GitHub README 的实际主分支渲染、全部四张图片、明暗主题和390px窄屏已检查。此记录是该免费站发布版本的上线证据，不缩减下面的完整商业目标。

| 目标 | 可证明的当前状态 | 正式完成仍需的证据 |
| --- | --- | --- |
| 独立 HTTPS 同源主站与持久数据库 | 独立身份、空 SQLite 私库、发布／回滚工具已准备；没有 current、主站 unit 或 Nginx vhost，TLS 目录为空 | 自有域名及 DNS 管理位置、真实证书与来源配置；以服务身份启动、站外 HTTPS 与重启自启验收 |
| 双渠道登录、绑定、跨设备账号隔离 | Aliyun 配置与登录／绑定／会话实现已存在，隔离 API 自动化通过；没有真人收码证据 | 测试负责人可接收的手机号和邮箱；实际送达、过期／重复码、绑定同账号、退出及第二设备隔离 |
| DeepSeek 有依据问答与私人指南 | 本机模型曾真实验证；保存、版本、追问、导出与隔离实现已完成，公网 AI 未开放 | 独立主站真实模型、原书依据核对、会员额度与成本账本、保存／跨设备读取的完整生产路径 |
| 支付、会员续购、额度、退款 | 默认关闭新单；验签、金额／商户归属、幂等与退款撤权已有模拟测试；没有商户、真实付款或退款 | 本项目合法可用的商户与商品权限；真实付款到账、重复／迟到回调、续购、成功回答扣次、退款实际到账及对应撤权 |
| 后台、用户售后与账号注销 | 后台只读／工单和注销闸门已实现，模拟浏览器通过；客服入口与经营信息缺 | 客服联系入口、经营主体／条款确认；真实运营身份、售后受理／退款核销、近期再认证注销闭环 |
| 成本保护、告警与灾备 | 预算估算、巡检、固定事件告警已实现；服务器每日加密备份与 Windows 离机任务实际自动执行，空库恢复通过；无通知收件端 | 实际账单／费率复核、负责人通知接收端与真实异常／恢复送达；实收认证测试账号保存的指南及订单记录备份恢复。当前 DPAPI 不能承诺任意设备恢复，双设备损失策略需另行确认，不能进行破坏性演练或捏造通过 |
| 收录、访问／转化 | 免费站 robots／sitemap／元信息已发布；商业统计实现存在但未启用 | 搜索站点所有权验证及实际收录；商业主站配置后的真实访问／可信到账事件汇总，不能由免费站无 API 的页面可达替代 |
| 可执行推广素材 | 三份分享网页已公开，租房／离职／省钱各有小红书标题、正文与朋友圈文案，来源／许可完整 | 制作与免费网页发布已完成。未执行社交发帖，也没有真实曝光、转化或排名证据；这些不能当作已有成果，不额外把社交账号发布要求冒充素材交付本身 |

最近真实服务器只读审计仍为：独立 origin、QA origin、商户、客服与告警接收端均未配置；新单关闭、统计关闭、主站／证书不存在；backup timer active，health timer inactive。不能用匿名免费站替代同源会员系统，也不能虚构域名、借用原站商户、发送到任意号码、手改付款事实或把未通知算作已通知。

外部资料集中补齐即可续接：**域名和 DNS 管理位置；Better Life 商户／商品权限；可实收测试码的手机号与邮箱；客服和负责人告警接收端、经营主体／条款。** 密钥只放受控服务端环境，不在聊天、文档、前端或日志中发送。之前已提供的本项目模型／Aliyun 配置无需重交；API 配置并不证明送达。

### 2026-10-04 历史执行记录（后续状态见下一节）

- Windows 与独立 Linux 工作副本各 `npm run check` **397/397**，原书 650 条与 797 处引用通过；运营及账号浏览器全 API mock 各 **14/14**（1440/390/320）。报告在本机 output，不提交运行日志或模拟会话。
- 已按白名单生成并在 Linux 验证源码包，再执行真实 `--dry-stage` 到独立 release。可信 manifest SHA-256：`eb1967f8ac0dc90710dda0bb7785785d8d3daedb263dff2da0837228d6231b78`。此包为 **405 个源码文件**，没有 env、数据库、key、旧 dist 或 node_modules。其 manifest 的 `productionActivated=false` / `buildAndTestsVerified=false` 描述离线源码包自身，独立构建结果另记录，不能改包标签冒充激活。
- 独立 `better-life` 不可登录服务身份、私人数据/备份目录、root:0600 env 与独立会话/备份/运营密钥已准备。既有本项目 Aliyun 邮件/短信与 DeepSeek 配置只经加密 SSH stdin 传输，没有输出或复用其他站点的用户/商户/会话秘密。
- 以专用服务身份初始化了本项目**空库**，并完成首个全库加密备份及恢复检查；没有真实用户、订单或加密私文。不能据此声称真实生产灾备演练完成、已有离机副本或每日 timer 已执行。
- 生产 preflight 在已构建的隔离副本检查：provider 配置齐全，仍因 `MEMBERSHIP_APP_ORIGIN` / `QA_ALLOWED_ORIGINS` 缺真实独立域名失败；新单继续关闭，商户未配置。该 root 检查不是 systemd 服务身份的完整启动验收。
- 新站 systemd / Nginx / backup timer **仍未安装、未开启**。没有公网激活或 current 指针，已有站点前后健康口均返回 204；这仅是当时的健康观察，不承诺完全无影响或长期可用。

成本保护暂设日上限 10 元、月上限 100 元。当前本项目模型为 `deepseek-flash`；[官方美元高峰价](https://api-docs.deepseek.com/quick_start/pricing/)为每百万输入（缓存未命中）0.30 美元、输出 1.20 美元。独立 env 的保护估算费率设 3 / 12 元，使用**自行选择的 10 倍人民币记账上界因子**，不是声称当前汇率、不是供应商人民币报价，也不是实际账单。真实账户含人民币与美元币种；激活前仍应核对实际扣费币种/账单、复核官方价格与所需容量，不能因为暂设预算就承诺无限用户或永远不超真实供应商费用。

### 2026-10-05 真实推进记录

- 每日备份 service/timer 已独立安装，专属 `backup.env` root:0600 只含数据库/备份路径与两把恢复 key，不携模型/短信/支付/运营秘密。服务返回 `Result=success` / `ExecMainStatus=0`，timer active，初始两份密文备份。已核对当时原站健康口仍 204。下一次 daily 触发未以等待时间冒充已经执行。
- 已通过固定只读 SSH 将实际最新密文拉到本台 Windows 私人目录，SHA256 一致；两把 key 仅在内存经 CurrentUser DPAPI 加密托管。密文/托管包分目录，NTFS ACL 仅当前用户与 SYSTEM，没有明文 key 文件。又从 DPAPI 包在内存取出恢复 key，实际恢复到独立新 SQLite 文件，应用标记、完整性、外键均通过，生产源库未改动。结果 `no-encrypted-content`，不是验证了真实用户私文。
- Windows `BetterLife-OffsiteBackup` 当前用户 Interactive / Limited 任务已注册：本机中国标准时间每日 04:00、Hidden、失败有限重试；实际由 Task Scheduler 触发一次，退出码 0。维护源码独立保存到私人目录，不依赖工作仓库后续切换。PC 必须登录且在线；关机/登出/本机或 DPAPI 环境损失均可能令拉取/恢复失败，不能承诺独立云存储、跨设备 key 恢复或固定灾备 RPO。脚本不自动删旧备份。
- 新完整发布工具包含只读 preflight、降权构建、候选同端口健康、独立 Nginx/current 切换、持久 journal/代码回滚/中断恢复；合成验证与真实本机无网络 npm 配置探针通过。没有真实 DNS/TLS，不执行 `activate`。工具只 start，不自动 enable 主站开机启动；正式激活后须明确配置并验收重启自启，不拿 committed 冒充此事实。
- 固定事件告警持久 pending/去重/退避/恢复和只读健康/预算巡检已实现；预算巡检不恢复预占、不写成本账本、不读取私文。负责人 webhook 尚未配置，未执行真实通知送达，主站未激活前不启用健康 timer 对不存在的域名巡检。
- 三张原书摘编分享页及发布文案已生成，真实本机静态页 Playwright 在 1440/390/320 共 12/12，通过无横溢、真实品牌字体/图像、三步/适用条件/出处；无脚本或外部 API 调用。素材未在社交平台发布，也未把本机页面当公网部署。未调用付费生图或虚报传播量。

最新全检查、Linux维护安装与源码版本证据持续追加，不用上述历史测试总数冒充未来发布验收。

#### 本次收尾验证与维护安装

- Windows 全检查与隔离 Linux 工作副本均无失败：本机跳过 Unix 专属权限项，Linux 跳过 Windows DPAPI/ACL 动态项；本机实际离机演练另有证据，不能把 Linux skip 当作 DPAPI PASS。当前最终结果见末尾，不拿旧总数代替本次版本验收。原书 650 条零违规、797 处引用通过。
- 白名单维护源码包 `goal-20261005-ops-a`：428 文件，manifest SHA256 `3c0129c20d15ff1ed03c361bd78ac16fb788cdbb6c5bda37c51f73e85edc3226`；远端验证后仅 source dry-stage。独立构建/检查日志另存；source manifest 没有变成虚构的生产激活 receipt。此包是当时的维护快照，不冒充后续本机 Windows 拉取脚本的补丁版本。
- 独立维护 release 赋 root-owned 0755/0644 只读权限；备份 service、固定事件 alert 模板与 health service/timer 已安装并通过 `systemd-analyze verify`。备份及 alert handler 钉在该稳定 source release，不依赖尚不存在的 current。备份 OnFailure 已连接专属 handler，恢复通知非致命；新一次真实 backup service 返回成功，daily timer active，health timer **inactive**。
- 专用 `alerts.env` / `monitor.env` 均 root:0600。通知 URL/Host 空，明确未配置负责人；monitor 仅七项非秘密 origin/路径/预算字段，backup 仍仅四项恢复字段。无模型/短信/商户秘密进入巡检或告警配置。
- 专属服务 UID 实际只读汇总空库预算，结果 normal；没有账本写入或正文读取。另在分开的私有 drill 状态目录模拟 BACKUP_FAILED → RECOVERED，实际 pending/nonzero、sent=false；不造真实备份故障，不宣称收件成功，也不把模拟 incident 写入生产告警状态。
- 维护辅助检查最初把已引用的 env 数值直接当带引号的字面量传入子进程，预算校验拒绝；改为数据语义解析后复验通过，预算数值未变。production.env 在内存校验前后解析值相同后规范为严格 KEY=value，密钥/provider 值不变。以服务身份检查已构建隔离副本，实际只剩 `MEMBERSHIP_APP_ORIGIN` / `QA_ALLOWED_ORIGINS` 缺项；不是 root 权限掩盖目录问题。
- Windows 实际拉取暴露 transport 完成时两个空运行时对象污染 JSON 输出，已抑制非业务返回值并增加真实 DPAPI/合成 transport 回归；没有秘密回显或传输/恢复失败。最新实际密文又完成 DPAPI 解包和新文件恢复，仍为 `no-encrypted-content`。
- 主站 unit/current/Nginx vhost 仍不存在，新单关闭。维护前后原站健康口均 204；未 reload 原站 Nginx、停止原站或访问原站秘密/用户库。未向真实号码/邮箱发码、付费模型调用、真实下单或退款。

## 隔离原则

### 免费 Pages 与独立服务的发布边界

- GitHub Actions 的 Pages 构建固定 `VITE_PUBLIC_ONLY=true`、空 `VITE_QA_API_URL`、关闭统计；仅 main 分支可上传和部署。免费站继续提供完整阅读、章节目录、检索、收藏、出处、下载和分享页。
- 公共构建在调用网络之前阻断会员、问答与运营客户端；不查询不存在的 `/api/me` 或 `/api/membership`，不发问题到旧外部地址，不以静态页面或价格预览假装接通服务。私人指南／运营深链接显示未开放页，不加载商业页面；导航不显示无效登录。
- 独立同源服务的正常构建默认不启用该标记，既有 DeepSeek、登录、会员与私人内容实现保留。本机展示、免费 Pages 发布和正式会员主站三者分别验收；部署任务成功后还需实际站外浏览器检查，不能用本机截图代替。
- 已在真实服务器新增独立 `better-life-build` 不可登录构建身份（与服务身份不同 UID/GID、无附加组）以及 root:0700 的空 `/etc/better-life/tls` 目录。没有借用原站证书、申请虚构域名、安装主站 unit 或切换 Nginx/current；证书仍缺，主站仍未激活。准备后原站只读健康口返回 204。

### 2026-10-05 自动调度实查（北京时间）

- 10:10 只读核验 systemd：每日 timer 在 03:00:18 实际触发，backup service 03:00:19 结束，`Result=success / ExecMainStatus=0`；最新独立 `.blbk` 大小 266273 字节。并非再次手动触发来冒充自动结果。
- Windows Task Scheduler：`BetterLife-OffsiteBackup` 的 `LastRunTime=04:00:00 / LastTaskResult=0 / MissedRuns=0`，最新密文在 04:00:11 已落入私有离机目录；下一次为 10 月 6 日 04:00。PC 登录在线是前提，不把该任务当独立云端全天候保障。
- 健康 timer 仍 inactive，主站仍未激活；通知接收端未配置。原站只读健康口 204，不改其 Nginx、服务或秘密。空库备份与恢复证据仍不代表真实用户私文或双设备损失验收。

### 2026-10-05 最终业务修复与源码检查

- 本人只读订单历史分页与退款独立选择已实现，旧已付单不被最近30条未付款挤出；回归包含同时间游标、跨账号、失效会话、1–50边界及金融快照不变。到期降级删除指南按实际篇数重算，不虚增容量。
- 问答、取消/迟到、支付回跳、离线 HTML 下载及图谱/示例阅读已完整接线。仅固定枚举、每请求单次终态；统计故障不阻断业务，前端回跳不产生到账事件。隐私页准确说明30分钟固定会话、90 UTC 日聚合和非即时清理。
- Windows 当前构建成功，完整测试495项：494通过、0失败、1 Unix 专属权限跳过；650条原书零违规、797处引用通过。首次默认18进程并行因本机可提交内存不足，出现子进程/原生内存分配失败；不是以失败日志冒充通过。`npm test` 已限制4并行，复跑全部通过；最终构建使用会话内低内存线程/堆配置，不修改系统内存或终止其他项目。
- 新隔离 Linux 白名单源码快照 `goal-20261005-final-b`：432文件，manifest SHA256 `438c780fb23c8fd9b308635c85773485ae2c7daa1db1cb62c2161e332288e368`，archive SHA256 `fc953554b833897cd71e4acbc486ff24c36529d56ce1f4086cdf2974cd8269b6`。无秘密环境构建并运行 `npm run check`：495项、489通过、0失败、6 Windows动态项跳过，原书与引用通过；源码包前后验 hash 一致。此源码快照在本节验收记录加入前生成，不冒充后续最终 Git commit 字节完全相同，也未激活生产主站。
- 浏览器使用实际 React、空 envDir 与全合成 API：本人订单历史8项、匿名事件真实操作15项均通过，1440/390/320无横溢，非预期 console/pageerror/外网请求0。显式503故障分别登记，不隐藏失败请求；专用浏览器与4196/4197已关闭。
- 本机4190已用最新构建和 API 重新启动，实际健康 `ready / localDemo=true / metering=false / creationEnabled=false`，未登录本人订单历史401。它是开发体验，不是生产计量/正式收费；两渠道 configured 仍不等于实际收码。

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

`better-life-backup.service` / timer 已在本项目独立目录手动演练并启用，使用最小 `backup.env`；成功备份的恢复通知使用非致命前缀，缺通知入口不得令备份成功变成失败。Windows 离机拉取与空库隔离恢复实际完成，限制见 [OFFSITE-BACKUP.md](./OFFSITE-BACKUP.md)。推荐保留策略仍为方案，删除须另行确认，本脚本不自动删旧备份。磁盘至少预留 DB 的两倍快照空间；尚未完成真实用户私文及 Windows/服务器同时损失场景的灾备演练。

## 6. 发布回滚

保留前一不可变 release。切换 current 指针后只重启 Better Life，失败切回旧指针再启动。数据库迁移采用加列/加表、不给旧列清空；回滚代码不回滚真实收费流水。大改 schema 前先备份并恢复校验，不把恢复旧 DB 当作日常代码回滚，以免丢掉已付订单。

最终上线记录须分别记录 DNS/TLS、真实收码、真实模型、扣次、真实支付/退款、备份恢复、原站健康的实际结果；未执行项继续标待验，不用 mock PASS 冒充生产完成。
