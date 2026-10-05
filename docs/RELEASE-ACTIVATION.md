# 独立 Linux 发布、代码回滚与中断恢复

## 当前事实与授权边界

`scripts/release-activation.mjs` 已实现完整发布状态机，不再仅暂存源码。默认是**只读预检**，必须显式选择 `activate` 才安装锁定依赖、构建/检查、启动本项目服务及切换本项目入口。

本轮服务、DNS、证书和变更验收使用本机虚拟 Linux FS、命令 runner、证书 metadata 和 health 的合成测试；另执行了**真实本机 npm CLI 的无网络 `config get registry` 配置加载回归**，只使用临时合成项目、两份不同空白 npmrc 和白名单环境。**没有执行真实依赖安装/构建、systemd/Nginx 变更、读取真实 production.env/用户库/证书私钥、远端执行或公网激活**。真实独立域名和商户尚不齐，不能据此宣称正式公网运营或开放收费。已有 `deploy/install-release.sh` 仍只支持 dry-stage，未改名冒充新工具。

本工具始终要求新单创建关闭，既有订单/已验签事实处理仍由应用负责。它不创建商户、不发 OTP、不调用模型、不创建/退款订单、不执行 SQL 修改金融状态、不恢复旧数据库、不更新备份 timer，也不停止/重载 Image2 服务。Nginx 的配置测试和 reload 是共享 master 的正常操作：只改一个本项目文件，其余 server 文件保持原样；仍须在维护窗口观察其他站点。

## 固定范围及预置条件

工具不创建用户、安装 Node/Nginx、申请证书或复制原站 env。调用前由授权管理员独立准备：

| 项目 | 唯一允许位置/要求 |
| --- | --- |
| 源码包 | `/var/www/better-life-releases/incoming/<release-id>`，root 所有、不可被非 root 写入 |
| 构建/发布目录 | `/var/www/better-life-releases/<release-id>`，必须全新；不覆盖已有 release |
| current | `/var/www/better-life-current`，只允许 root 所有的绝对 symlink，目标为本项目单层 release |
| 数据 | `/var/lib/better-life/membership.sqlite`，专用 `better-life` 用户/组，文件 0600、目录 0700 |
| 备份 | `/var/backups/better-life`，专用服务用户/组、0700；与既有独立备份配置一致 |
| 配置 | `/etc/better-life` root 0700；`production.env` root 0600、非链接、非硬链接 |
| TLS | `/etc/better-life/tls` root 0700；`fullchain.pem` root 0644；`privkey.pem` root 0600；非链接、非硬链接 |
| unit | `/etc/systemd/system/better-life.service`，不存在或与工具生成的本项目 owned 内容完全一致 |
| Nginx | `/etc/nginx/conf.d/better-life.conf`，不存在或与工具生成的 owned 内容完全一致 |
| journal/lock | `/etc/better-life/activation-state.json` root 0600、`activation.lock` root 0700 |

系统目录祖先必须 root 所有、无链接且不可组/其他用户写入；只有固定数据/备份目录及正在准备的本项目候选目录允许其专用身份所有。release 根及其祖先必须让两个非 root 身份可 traverse（通常 root 0755），数据/备份的祖先也必须让服务身份可 traverse；不能把 root 0700 的 release 根误认为服务可读取。工具创建的原子文件先为 0600，再显式设定目标权限并 fsync；build HOME 也显式 chmod，避免调用方 root 的 0077 umask 令空白 npmrc/HOME 对 builder 不可读。构建完成后所有发布文件/目录归 root，不再允许构建用户修改。

需要两套**独立、专用、无其他任务**的非 root `nologin` 身份：`better-life` 与 `better-life-build`，UID/GID 不同，各自仅一个主组，无特权附加组。预检要求构建身份空闲。构建后及失败清理前，会终止 **better-life-build 的进程**并证明已经空闲；不要把这个身份借给其他项目/定时任务。它不能读取 root 0700 的 env/TLS，或另一个服务 UID 的 0700 数据/备份。

固定系统工具为 `/usr/bin/node`、`npm`、`env`、`setpriv`、`getent`、`id`、`systemctl`、`openssl`、`ss`、`ps`、`pkill` 和 `/usr/sbin/nginx`；真实路径必须 root 所有且不可被组/其他用户写入，Node/npm/env 必须可被降权身份执行。Node 必须至少 22.16。不自动升级依赖/系统工具。

`ps -u better-life-build -o pid=` 的退出 1 且空输出被识别为 Linux 正常零进程；其他错误/非 PID 输出拒绝。`pkill` 只允许 0 或正常无匹配的 1，并再次确认空闲。`getent`/`id` 缺身份或 `ss` 检查错误必须拒绝，而不能当作空闲/无人占用。网络接口使用 Node 的 OS API，不执行 `ip` 修改命令。

## 专用 env 与域名闸门

env 只由工具读取到内存，不 `source`、不复制、打印或出现在 argv/URL。只接受 `KEY=value` 的严格单行子集，允许空行/整行 `#` 注释；拒绝重复、引号、空白值、转义、变量替换及 `NODE_OPTIONS`、`LD_*`、shell/npm 等非应用 loader 配置。带显示名的邮件 From 需改用无需空格的已验证邮箱；不要临时放宽解析规则。

在既有生产配置/登录 provider/预算/备份加密验证之外，固定要求：

```text
NODE_ENV=production
QA_HOST=127.0.0.1
QA_PORT=4178
PUBLIC_BASE_PATH=/
MEMBERSHIP_LOCAL_DEMO=false
MEMBERSHIP_ENFORCE=true
MEMBERSHIP_PAYMENT_CREATE_ENABLED=false
MEMBERSHIP_TRUSTED_PROXY_IPS=127.0.0.1
```

数据库、备份地址必须为上表固定位置；`MEMBERSHIP_APP_ORIGIN`、`PUBLIC_SITE_ORIGIN`、唯一 `QA_ALLOWED_ORIGINS` 必须与用户明确提供的 `https://<真实独立域名>` 完全一致。密钥、商户、OTP 通道及预算费率用管理员真实配置，本文不提供可误用的假值/旧报价。

- 拒绝 localhost、IP、example/test/invalid/local/internal 等占位域名。
- 所有 DNS A/AAAA 结果都必须匹配这台机器已分配的非本地公网接口地址；NAT/CDN/外部负载均衡或未直连本机的部署不受支持，不绕过这个闸门。
- 必须有覆盖该域名的 **DNS SAN**，禁止 CN-only 回退；证书已经生效且至少剩余 7 天，私钥公钥必须配对。OpenSSL 还验证本机 CA trust 和证书链；最终 HTTPS 回环 SNI 验证 CA、域名及同一 leaf fingerprint。
- TLS 文件需独立复制到本项目固定目录，不沿 Let's Encrypt 或其他项目 symlink 自动读取/修改。
- 读取 `nginx -T`，拒绝与任何其他 server 的 exact/wildcard 域名冲突；无法证明不冲突的 regex/动态 server_name 也拒绝。未知同名文件或仅伪造 own marker 的内容不覆盖。
- Nginx 新文件同时配置 IPv4/IPv6 80/443；不支持内核禁用 IPv6等导致该配置无法通过 `nginx -t` 的环境。它只代理回环 4178，不静态托管仓库/env/DB，不添加默认 server。此文件关闭 access log；全局 error log 仍由系统管理员按隐私政策管理。

## 调用接口

从**管理员已审核的工具 checkout**执行脚本，不执行上传包内可被替换的 verifier。`expected-sha256` 必须从独立可信通道取得并确认对应源码；包内自己声称的 SHA 不算授权。SHA 提供完整性/人工授权锚点，不是发行人数字签名。

```text
node /可信工具目录/scripts/release-activation.mjs preflight \
  --bundle /var/www/better-life-releases/incoming/<release-id> \
  --release-id <release-id> --domain <已经验证的真实独立域名> \
  --expected-sha256 <可信的64位小写manifest散列>
```

省略 mode、直接以 `--bundle` 等选项开头时同样是 `preflight`；无参数也只选择预检，随后因缺必要资料而拒绝。未知 mode/选项、重复选项、缺值或奇数参数均拒绝，不回退为激活。它不建目录/锁、不安装/构建、不请求应用 health（health 会触发统计补偿写入），不修改 unit/current/Nginx/DB；已有 DB 仅通过 100-byte SQLite header 检查应用 ID。若旧迁移的 application_id 尚仅在 WAL 中，应由管理员先通过既有应用维护流程完成 checkpoint，再复验，不能在预检内隐式改库。

完整激活用完全相同参数，将 mode 显式改为 `activate`。不是 `--dry-stage` 的别名，也不自动执行任何一次未来上线。

```text
node /可信工具目录/scripts/release-activation.mjs rollback
node /可信工具目录/scripts/release-activation.mjs recover
```

`rollback` 仅接受已 committed 的本工具 journal，恢复其上一版 sealed release；首次发布无上一版时移除本项目入口/unit/current，仍保留数据。`recover` 只接受未完成或 `recovery-required` 的 journal。活锁/仍存活的 PID 拒绝恢复，不提供 force、任意路径、任意 unit/端口、env 值参数或 DB 恢复参数。

代码接口为 `releaseActivation(options, dependencies?)`，参数与 CLI 对应，mode 为 `action`（默认 `preflight`）。所有 OS runner、FS、DNS、证书检查、header 身份检查、health、时钟/等待可注入合成测试；正式 CLI 不允许通过参数覆盖这些依赖或固定作用域。

返回 JSON 仅含安全状态/错误 code。成功激活的 `productionActivated=true` 指本机 unit 和同源代理已经完成切换，不代表外部防火墙/公网可达、实码投递、模型体验或真实支付已验收；这些 live 标志保持 false，新单也保持关闭。失败非零退出；不打印原始异常/子进程 stdout/stderr/env。

## prepare → activate 状态机

1. **只读闸门**：可信 source manifest、无 source 链接/穿越、锁定 npm registry/integrity、准确项目 check/build/test 脚本、目录/角色/DB header、专用 env、域名/证书/CA/DNS、Nginx 域名不冲突、磁盘空间。4178 必须空闲，或 listener 的唯一 PID 正是已有 owned `better-life.service` MainPID；不接受共享监听、0.0.0.0、未知 drop-in/unit。
2. **preparing**：原子建立专用锁、fsync journal，记录上一版 current/unit/Nginx/运行状态。只拷贝可信 source 文件到全新候选目录，记录仅含应用/release/hash 的 owner marker。
3. **隔离 build/check**：`setpriv` 降为专用 build UID/GID、清空附加组、NoNewPrivileges。只携带固定 PATH/LANG/TZ、独立 HOME/cache、两份受控空白 npm 配置、生产 NODE_ENV 及已验证的公开 origin/basePath/noindex/统计 bool。HOME 是 root 0755；`user.npmrc` 和 `global.npmrc` 分别由 root 独占创建为 0644，builder 只读，npm cache 单独由 builder 所有；ci 前后和 check 后复验文件空白、权限、所有者及非链接。不能把两个配置都设为 `/dev/null`：npm 会以重复加载配置拒绝启动。源码/构建脚本必须来自管理员审核的可信包，此隔离不是恶意源码沙箱。**不携带任何后端密钥或生产 env**。运行 `npm ci --include=dev --ignore-scripts --no-audit --no-fund`，再运行现有 `npm run check`（包括生产 Vite build、测试、原书检查）；包锁只允许 npm 官方 HTTPS registry + SHA512 integrity，不自动 audit/fix/升级。
4. **prepared**：终止专用 builder 遗留进程并确认空闲、去掉候选 build HOME，拒绝产物私密文件/逃逸链接/硬链接。只有 node_modules/.bin 的内部链接可保留。root 封存文件并保存完整 SHA256 receipt；以服务 UID 携带专用生产 env 运行候选真实 `production-preflight`，此步骤只输出已审核脚本的安全 readiness，父工具捕获不回显。再次验 manifest/env fingerprint/TLS/current/unit/Nginx/端口，发现外部变化就停止。
5. **maintenance**：已有本域名公开入口时，先只把 owned Nginx 文件切维护 503，`nginx -t` 后 reload；避免单实例候选启动期间向用户曝光未探活的新代码。首次发布此时还没有公网入口。
6. **candidate**：只 stop `better-life.service`；再次证明 4178 空闲。写候选绝对代码路径的 owned unit、daemon-reload、start 同一个 service。等待冷启动回环 health，然后重新证明 MainPID/回环 listener 的所有权。只接受本站 ready、计量开启、非 demo、两个登录配置齐全、收费创建关闭。
7. **switching**：health 通过后原子替换专属 current；unit 仍钉候选绝对路径（不依赖 current race）。写仅本域名的新 owned Nginx proxy，`nginx -t` 后 reload，验证 443 回环 SNI health/证书。
8. **committed**：只有 committed journal 原子写入并 fsync 成功才返回成功、释放锁。落盘失败不会被当作成功；上一版 release 保留。

已有服务更新是**有维护窗口的单实例切换**，不是无停机/双实例升级；旧与新代码不会同时写同一个 SQLite。unit 停止控制器允许 90 秒，配合应用 unit 的 60 秒停止超时。health 最多 20 次，每次 3 秒超时、间隔 1 秒。build/check 每个子进程最长 30 分钟，总输出硬上限 2 MiB；超时/异常输出均失败，不截掉错误后假装通过。

## 失败、回滚与崩溃恢复

- build/预检阶段失败：原站未切换，仅清掉此 journal 明确声明且 owner/可信 manifest 可验证、尚未封存的全新候选；不删除 incoming、旧 release、backup timer 钉住的 release 或任何 DB。
- 切换阶段失败：重新维护本域名，stop 候选服务，恢复上一版 current/unit，daemon-reload/start 旧代码并探活，通过后再恢复原 owned Nginx。首次发布恢复到不存在本项目入口。
- 旧代码、receipt、unit/current/Nginx 被外部改动：不覆盖未知对象、不盲目启动。env fingerprint 改动会阻止重启旧服务，尤其不能借回滚打开新单。
- rollback 自身失败：保持 journal/candidate，尽力把 owned 入口留维护并 stop **本项目** service，返回 `recovery-required`。未知文件不覆盖；OS 控制器失灵时不能保证已经停妥，需要管理员立刻按本项目状态处理。修正闸门后显式 `recover`，不忙循环。
- 进程崩溃后的锁只在品牌为 `better-life`、PID 为正安全整数且已不存活时由 `recover` 接管；未知品牌/非法 PID 的锁不删除、不探测其进程。原子 journal 支持 preparing/prepared/maintenance/candidate/switching/rolling-back 的幂等恢复。若盘/目录损坏连 journal 都不能写，不凭空宣称自动恢复成功。
- **绝不恢复旧 DB、撤销已到账事实、补开会员或修改配额**。新代码可能已经执行迁移/统计/金融事实，因此上线前必须人工审核前后兼容迁移；旧代码不兼容时保持维护，执行修复发布或既有灾备流程，而不是用旧备份抹掉新付款/私人资料。代码回滚与数据灾备不是同一操作。
- 只自动清理本次失败且未封存的 source stage。**已经封存/prepared 的 release 即使激活失败或显式回滚也保留**：独立 backup unit/维护任务可能钉住它，不能以“不再是 current”为理由删除；durable prepared 标记与 receipt 都会阻止自动删除。历史 release 和已有独立备份系统不做保留期删除。另行人工盘点 unit/drop-in/任务引用及在用路径后才可回收，不要 unlink 活跃 current 或删掉备份 unit 的钉住路径。保留的 release-id 不能重复部署。

## 验证清单

依赖预检现在与真实 `package.json` 的固定4并行命令一致，并在虚拟系统中读取真实锁文件回归，不只依赖手写简化 fixture。当前 Tailwind WASM 包含6个 `inBundle` 子包；[npm 锁文件说明](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) 将该标记定义为随父包分发的依赖。工具只接受规范嵌套路径、明确布尔与版本、无额外 fetch/link 字段，并沿声明关系找到最近官方 registry/SHA512 父包；不因该标记放开任意无校验条目。顶层伪标记、无声明/坏父包、外部URL、链接和命令篡改都拒绝。

本机定向检查：`node --test tests/release-activation.test.mjs tests/release-manifest.test.mjs` 及 `node --check scripts/release-activation.mjs`。合成测试覆盖只读模式、身份/权限/路径/域名/价格配置接口闸门、Linux ps 退出码、无敏感 build env、候选/最终 TLS 失败、Nginx/systemd 失败、原子 committed journal 写失败、活锁/未知品牌与非法 PID、旧代码篡改、prepare 崩溃、旧 env 变化、备份钉住 release 保留、回滚失败 quarantine 和显式 recover；真实 npm 配置加载 probe 不安装依赖、不访问网络。它们**不证明真实 SAN/私钥/CA/DNS/systemd/Nginx/锁定依赖安装或现场迁移通过**；默认代码使用 Node X509/OpenSSL 真实验证这些，必须在真实独立前置资料齐全后验收。

未来真实激活后，还需从站外检查公网 DNS/HTTPS/页面/API、其他现有站点、真实收码、模型质量/预算及独立备份恢复演练。收费上线另需用户明确授权、真实商户与政策验收；本工具不会自动改变 `MEMBERSHIP_PAYMENT_CREATE_ENABLED=false`。
