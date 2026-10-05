# Windows 离机拉取与密钥托管

## 目标与实际边界

`scripts/offsite-backup-pull.ps1` 从明确授权的 SSH 主机**只读**拉取 Better Life 最新 `.blbk`，核对传输 SHA256，将原有 AES-GCM 密文与 DPAPI CurrentUser 密钥包保存在 Windows 私人目录的两个子目录。不修改远端目录、数据库、env、服务、timer，也不注册本机任务或删除远端文件。

此工具只报告 `cipherSha256Matched:true` 与 `keyEscrow:DPAPI-CurrentUser`，**始终 `restorationVerified:false`**。SHA256 证明此次传输与远端读到的密文一致，不证明 AES-GCM 解密、SQLite 完整性、私人字段解密或事故切换已经通过。真实恢复须另用现有 `membership-backup.mjs check/restore` 在隔离私人目录校验，不能覆盖在线库。

本轮生产事实由 root 独立记录：专用 Better Life 每日备份 timer 已安装并执行成功，使用 backup-only 配置，不含模型/短信/支付密钥。这不是本拉取脚本完成公网登录、支付、模型或用户数据恢复的证据。当前新库无加密私人内容时，恢复结果 `no-encrypted-content` 只能证明没有待解密私文，不能称为“已验证用户数据恢复”。

## 使用前提

- **Windows + PowerShell 7 或以上**，可用 `ssh.exe`，服务器可用固定 `/usr/bin/python3`。
- 用授权服务账号/SSH 私钥读取固定 `/var/backups/better-life` 与 `/etc/better-life/backup.env`；脚本不会提权、执行 sudo、搜索其他路径或要求支付/模型秘密。
- 主机公钥必须先由部署方通过可信渠道核验并写入自己的 known_hosts。`StrictHostKeyChecking=yes` 与 `BatchMode=yes` 不会自动信任新主机、交互输密码或口令。不要用关闭校验、`accept-new` 或复制未核验指纹来绕过失败。
- 连接固定 SSH 默认端口，HostName 为 `user@FQDN` 或 `user@IPv4`（也可省略 user）；不支持 URL、自由参数、端口、IPv6、代理或 SSH 配置别名。`-F NUL` 禁止用户/全局配置意外执行 ProxyCommand 或改变固定连接策略；不转发 agent/端口。
- `SshKeyPath` 是现有本地绝对私钥文件路径；检查真实普通文件与非链接，但工具不读取其私钥内容、不修改其 ACL。部署方应事先确认 OpenSSH 可安全使用该私钥。
- `Destination` 是本地盘符绝对路径，不能是 UNC、ADS、发布源码目录、public/dist 或其他被禁止项目目录；它的父目录应已存在。目标可为新目录，或已有的**当前用户拥有、DACL 不继承且仅当前用户与 SYSTEM**的私人目录；不会改宽松旧目录的 ACL 来强行通过。

调用只提供公开连接/文件路径，不把任何业务秘密放进命令行：

```powershell
& .\scripts\offsite-backup-pull.ps1 `
  -HostName $ApprovedSshHost `
  -SshKeyPath $ExistingPrivateKeyFile `
  -Destination $PrivateOffsiteDirectory
```

这三个变量由部署方明确指定，本仓库不编造主机、私钥或存储位置。生产任务使用 `pwsh -NoProfile -NonInteractive -File`，进程隐藏窗口；自动注册、频率、日志与告警接入由 root 独立处理，不是脚本的副作用。

## 数据、权限与安全语义

目标布局：

```text
Destination/
  ciphertext/better-life-时间戳-8位hex.blbk
  key-escrow/better-life-时间戳-8位hex.blbk.keys.dpapi
```

- 原密文不重新解密/打包。每份 DPAPI 包解密后的 JSON **只包含** `MEMBERSHIP_AUTH_SECRET` 与 `MEMBERSHIP_BACKUP_ENCRYPTION_KEY`，没有 DB 路径、模型、短信、支付或运营凭据。
- 两个业务密钥都必要：BACKUP_KEY 解开全库 AES-GCM；AUTH_SECRET 派生私人字段密钥。仅保存 `.blbk` 或只保存 BACKUP_KEY 不足以证明完整私人数据可恢复。
- 固定 Python 程序经 SSH stdin 传入；密钥只经 SSH 二进制 stdout 管道进入本机 RAM，立即 DPAPI 加密后才写盘，不 source/env 执行、不传秘密参数、不打印密钥或远端 stderr/任意异常。
- JSON 元数据、密钥包与密文都有长度限制：header 4 KiB、两密钥 8 KiB、backup 256 MiB；单次拉取总超时 180 秒。超过上限失败关闭，不能把部分文件当可恢复备份。大库未来需先评估并明确调整限制，不自动放开。
- 文件名仅接受现有备份脚本生成的精确时间戳/8位小写 hex 形式。远端路径无调用者插值；最新以 mtime 与文件名排序，但名称/新鲜度不是恢复证明。
- 远端拒绝链接/hardlink、宽松权限、组/其他用户可写祖先、文件变动、非 BLBK1、无匹配快照和不完整密钥。环境只解析两个精确键，不执行文件文本。
- Windows 在创建时就应用受保护 DACL：当前用户 + SYSTEM。每层路径拒绝 reparse/junction；已有文件通过 Win32 `OPEN_REPARSE_POINT` 打开并检查真实 handle 的链接数和类型，拒绝硬链接。密文与托管包使用 CreateNew/独占共享；原子公布不覆盖旧文件。
- 同一最新快照再拉取时，先核对旧密文 SHA256/长度与旧 DPAPI 包解密后的两密钥，再核对新传输；一致则 `alreadyPresent:true`，不覆盖原包。只有一半旧文件、旧内容不同或旧包与当前密钥不同则失败，不能“修复覆盖”。
- 失败仅清理该次独占新建文件，不递归删除，不移除旧备份。异常信息固定为“Better Life 离机备份拉取失败；未覆盖旧文件。”，不回显主机/路径/密码/服务端自由文。
- 成功只返回固定应用/版本/状态与核对布尔值，不输出密钥、连接信息和完整文件路径。CLR 字符串可能等待 GC；字节缓冲会尽力清零，但这不是内存取证防护，不能启用把内部对象/管道转录到日志的自定义调试。

## DPAPI 的灾备限制（必须明确）

**CurrentUser DPAPI 绑定原 Windows 用户/登录凭据与其 DPAPI 主密钥环境，通常也依赖原机器/用户配置。它不是任意机器能解开的通用离线密码。** Linux 上不能直接使用 `.keys.dpapi`，把包复制给另一账号/机器也不证明可解密。

若服务器失去，但这台 Windows 与原用户环境仍可用，可以在 RAM 中 DPAPI 解出两密钥，再通过受控管道/隔离进程环境用于恢复校验；不得写明文 env、把密钥拼入命令参数或打印到终端。root 的实际 DPAPI 解包/隔离恢复验收应只报告安全布尔值和恢复结果。

若 Windows 机器/用户环境同时失去，只有这份 DPAPI 包可能**不可恢复**。部署方还需要明确规划并验收 Windows 用户/DPAPI 主密钥的安全恢复，或另外选择明确授权的独立离线密钥托管；当前脚本没有实现或宣称“任何设备都能恢复”。密文与密钥包虽分目录，仍在同一 Windows 设备，不等于不同介质/地理位置的灾备副本。

密钥轮换不能盲目覆盖旧托管包。新密钥应对应新快照并完成实际解密/私文校验；旧快照保留原配套包直到明确保留策略结束。脚本不会根据当前 env 假定历史快照一定可解密。

## 合成与真实验收

`tests/offsite-backup-pull.test.mjs` 使用临时目录、合成两密钥/密文、内存 transport，不启动 SSH、不读取真实 env/库/私钥、不访问远端。Windows PowerShell 7 可用时真实调用本地 DPAPI 与 NTFS ACL API；验证成功、重复不覆盖、协议上限/坏哈希/额外秘密/路径注入/链接/旧文件保护与固定错误。没有该运行时则明确跳过动态部分，不把静态断言当 DPAPI PASS。

部署方真实验收还需：可信 host key、远端只读权限、最新实际密文 SHA256、DPAPI 当前用户解包、同密钥隔离 AES-GCM/SQLite/品牌/外键与私人字段恢复检查、本机隐藏定时任务与失败告警，以及保留/离线用户环境恢复演练。脚本本身不代表这些事项已完成；相关真实状态须以 root 实际结果为准。
