#!/usr/bin/env bash
# 第一阶段模板：只做独立源码 dry-stage；不安装、不启动、不切链接、不配置 Nginx。
set -euo pipefail
umask 077

fail() { printf '%s\n' 'Better Life dry-stage失败；未激活、未修改现网服务。' >&2; exit 1; }
[[ "${1:-}" == '--dry-stage' && $# == 4 ]] || fail
BUNDLE=$2
MANIFEST_SHA256=$3
RELEASE_ID=$4
[[ "$BUNDLE" == /* && "$MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ && "$RELEASE_ID" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || fail
[[ "$(uname -s)" == 'Linux' && "$EUID" -eq 0 ]] || fail
command -v node >/dev/null 2>&1 || fail
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<16))process.exit(1)' || fail

# 固定应用作用域；任何 root / ancestor 链接或已有 release 均拒绝。
RELEASE_ROOT=/var/www/better-life-releases
DATA_ROOT=/var/lib/better-life
ENV_FILE=/etc/better-life/production.env
TARGET="$RELEASE_ROOT/$RELEASE_ID"
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" && -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || fail
[[ -d /etc/better-life && ! -L /etc/better-life && -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail
# 仅看专用 env 元数据；不 source、不打印、不复制、不读取秘密。
[[ "$(stat -c '%u:%a' "$ENV_FILE")" == '0:600' ]] || fail
[[ "$(stat -c '%u:%a' /etc/better-life)" == '0:700' ]] || fail
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || fail
[[ -f "$BUNDLE/scripts/release-manifest.mjs" && ! -L "$BUNDLE/scripts/release-manifest.mjs" ]] || fail
# 不跟随系统目录祖先链接；dry-stage也不能把文件写到另一个项目的目录。
node -e 'const fs=require("node:fs"),p=require("node:path");for(const value of process.argv.slice(1)){for(let part=p.resolve(value);;part=p.dirname(part)){const s=fs.lstatSync(part);if(!s.isDirectory()||s.isSymbolicLink())process.exit(1);if(p.dirname(part)===part)break}}' "$RELEASE_ROOT" "$DATA_ROOT" /etc/better-life || fail
[[ "$(stat -c '%u' "$RELEASE_ROOT")" == '0' ]] || fail

# 本脚本应来自本地已审核 checkout，而不是执行上传包里的可替换校验器。
SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
VERIFIER="$SCRIPT_DIRECTORY/../scripts/release-manifest.mjs"
[[ -f "$VERIFIER" && ! -L "$VERIFIER" ]] || fail
node "$VERIFIER" stage --bundle "$BUNDLE" --destination "$TARGET" --expected-sha256 "$MANIFEST_SHA256" || fail
printf '%s\n' '仅完成Better Life离线源码dry-stage；没有部署或上线。'
printf '%s\n' '后续激活尚未实现，必须先人工验收：独立真实域名/TLS证书、root-only专用env、生产build+tests、preflight、空闲4178端口、候选回环health、仅better-life.service原子切换/rollback、新独立Nginx文件与nginx -t。'
# 禁止在此模板添加 source 原站env、停Image2、覆盖已有server、自动升级依赖或开启新单。
# --activate 不受支持；未来实现前不得把此脚本改名冒充完整原子deploy。
