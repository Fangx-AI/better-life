# 手机号、邮箱与会员接入

2026-10-03：双登录、绑定、会话、会员额度已实现。按用户要求，已复用 Image2 的阿里云短信和邮件服务配置，本机 `npm run auth:status` 确认两通道 `configured=true`、`missing=[]`，并已完成真实供应商元数据只读查询。**尚未发送真实验证码；真实送达、公网登录和收款尚未验收**，不能把配置齐全说成已正式开通。

## 目前使用的验证码服务

本机已设置 `MEMBERSHIP_EMAIL_PROVIDER=aliyun`、`MEMBERSHIP_SMS_PROVIDER=aliyun`。只从现有 Image2 生产配置中提取以下 5 项服务配置，安全写入 Better Life 的 ignored `.env.local`；未输出配置值，未修改 Image2 服务或用户数据。

| 通道 | 服务端配置名 | 使用方式 |
| --- | --- | --- |
| 共用服务凭据 | `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET` | 阿里云 POP v1 请求签名；仅服务端使用 |
| 邮箱 | `ALIYUN_EMAIL_ACCOUNT_NAME` | 阿里云 DirectMail `SingleSendMail`；使用已配置发件地址，发送 Better Life 登录/绑定邮件，无需另填邮件模板 ID |
| 手机 | `ALIYUN_SMS_SIGN`、`ALIYUN_SMS_TEMPLATE_CODE` | 阿里云 `SendSms`；签名填批准的签名文字，模板编号为 `SMS_…` |

短信先支持中国大陆 `+86` 手机号。当前阿里云适配器发送单变量模板参数 `{"code":"6位验证码"}`，既有获批模板使用唯一变量 `code`；不要直接使用需要额外变量的模板。系统验证码有效期为 **5 分钟**，邮件文案同样为 5 分钟；本次查询确认短信模板未写有效期，不与服务端的 5 分钟冲突。审核状态已通过只读查询确认，发送权限、余额及运营商实际投递仍需发送验收。

通道使用固定 HTTPS 端点、POP v1 HMAC-SHA1 签名、UTC 时间和随机请求 nonce，失败时不回退到模拟发送。短信 `BizId`、邮件 `EnvId` 只代表服务商受理，不能当作用户已收到验证码。

运行 `npm run auth:status` 只查看配置状态和缺项，不显示秘密，也不发送收费短信。密钥仅存本机 ignored `.env.local` 或部署商的服务端密钥设置中，**不要发到聊天、Git或前端，不使用 `VITE_` 前缀**。

如需更换通道，代码仍支持 `MEMBERSHIP_EMAIL_PROVIDER=resend`（`RESEND_API_KEY`、`MEMBERSHIP_EMAIL_FROM`）和 `MEMBERSHIP_SMS_PROVIDER=tencent`（`TENCENT_SMS_SECRET_ID`、`TENCENT_SMS_SECRET_KEY`、`TENCENT_SMS_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID`）。配置不同服务商时需另行验证其发件域、签名、模板和权限；不会因阿里云失败自动切换到其他收费通道。

## 本轮已验证的结果

- 真实调用 [`GetSmsTemplate`](https://help.aliyun.com/en/sms/developer-reference/api-dysmsapi-2017-05-25-getsmstemplate) 和 [`GetSmsSign`](https://help.aliyun.com/en/sms/developer-reference/api-dysmsapi-2017-05-25-getsmssign)：两次 HTTP 请求成功、`Code=OK`；模板为验证码类型且审核通过，唯一变量为 `code`，签名审核通过。未修改签名或模板。
- 真实调用 [`QueryMailAddressByParam`](https://help.aliyun.com/en/direct-mail/querymailaddressbyparam)：命中现有发信地址，`AccountStatus=0`、`DomainStatus=0`（均正常），`INTERNAL` 内部地址、`verificationStatus=2`（无需验证）。查询返回 `Sendtype=batch`，不据此擅改发信地址类型；发送实现仍沿用源服务的 `SingleSendMail`、`AddressType=1`。
- 本机实际请求 `/api/membership` 返回 HTTP 200，`emailLoginAvailable=true`、`phoneLoginAvailable=true`。这验证的是入口和配置可用，不是验证码已送达。
- `npm run check` 完成：181/181 测试通过，构建、650 条中文内容检查及 797 个引用检查通过。模拟发送测试与上述真实只读查询分别记录；没有把它们当作真机收码测试。

以上记录不包含具体签名、账号地址、模板 ID 或任何密钥；仍需完成下文真机验收。

## 复用边界与线上缺项

复用的是短信、邮件服务，不是 Image2 的账号系统。Better Life 的用户、验证码、登录会话、会员、额度、订单和个人内容使用独立数据库；没有复制 Image2 的用户数据、数据库或会话密钥。本机 `http://127.0.0.1:4190/` 已有独立数据库与匹配的本机秘密。

正式部署仍需独立服务配置：

| 配置 | 要求 |
| --- | --- |
| `MEMBERSHIP_AUTH_SECRET` | Better Life 独立会话/加密秘密，不复用 Image2 的会话秘密；迁移已有内容时保留匹配秘密 |
| `MEMBERSHIP_APP_ORIGIN` | 实际控制的独立 HTTPS 主站 origin，页面与 API 同源 |
| `MEMBERSHIP_DB_PATH` | 静态目录外持久磁盘上的 Better Life 独立数据库 |
| 运行参数 | `NODE_ENV=production`、`MEMBERSHIP_LOCAL_DEMO=false`、`MEMBERSHIP_ENFORCE=true` |

可复用现有服务器，但 Better Life 使用独立进程、监听端口、目录与数据库，不替换 Image2 的页面、反向代理或进程。独立子域须先配置 DNS，再申请覆盖该子域的 HTTPS 证书。现有 Image2 证书只覆盖主域和 `www`，**不覆盖新子域**；候选子域不能当成已上线地址，不能关闭 TLS 校验绕过证书问题。

## 已接上的流程

1. 手机或邮箱发送验证码，验证后建立服务端会话；新账号自动有免费权益（每30天10问、5份指南），无需下单。
2. 账户页绑定另一种登录方式：验证后两者对应同一个用户ID，会员、剩余额度、订单和已保存内容共用；换登录方式不会再送一套额度。
3. 绑定前已分别注册成两个账户的联系方式，不自动合并，也不能抢占他人身份；界面返回明确冲突提示。
4. 验证码5分钟有效、一次性使用、60秒发送间隔、最多5次错误尝试；手机号/邮箱、登录/绑定、目标用户各自隔离。短信日预算默认100次发送尝试，失败也计入。
5. 会话Cookie为HttpOnly、SameSite=Lax，正式HTTPS使用Secure；退出立即撤销当前会话。
6. 月度/年度权益仅由服务端核验真实支付后授予。**虎皮椒支付适配器已实现，默认关闭；本机尚未配置商户，未真实收款，不伪造已付会员。**正式开放须按 [生产发布与恢复清单](PRODUCTION-RELEASE.md) 完成商户、域名及支付/退款验收。

「本机体验」开发演示入口不是手机号或邮箱认证；该演示账户不能绑定正式身份，也不能获得付费权益。线上必须关闭此入口；它与本机真实手机号/邮箱验证码登录不是同一个流程。

## 最快同源部署

保留GitHub Pages免费阅读站。登录主站采用一台Node服务器+持久SQLite+独立HTTPS域名和反向代理；当前 Better Life 公网会员主站尚未部署，不引入跨站Cookie或多实例迁移。

```powershell
# 仓库根目录；线上根路径构建
$env:PUBLIC_BASE_PATH = '/'
npm run build
# 服务端环境：NODE_ENV=production、MEMBERSHIP_LOCAL_DEMO=false
# MEMBERSHIP_APP_ORIGIN=https://你实际控制的主站域名
# MEMBERSHIP_DB_PATH=静态根目录之外的持久数据库绝对路径
# MEMBERSHIP_ENFORCE=true（要求问答按账号额度核对）
npm run serve
```

`serve` 将 `dist/client` 和 `/api/` 托管为同源，默认仅监听127.0.0.1，由HTTPS代理对外服务。构建和运行的 `PUBLIC_BASE_PATH` 必须相同；保留 `/better-life/` 构建时不要改为 `/`。独立 `npm run api` 只提供API，没有网页。

默认限频只相信socket IP。自己的HTTPS代理上线时设置 `MEMBERSHIP_TRUSTED_PROXY_IPS` 为它的精确socket地址，并在入口**覆盖** `X-Real-IP` 为实际客户端地址（Nginx：`proxy_set_header X-Real-IP $remote_addr;`），防止所有用户共用一个验证码限频桶。不要信任公网任意代理或直接转发客户端伪造头；此配置不会放开本机体验。

不得丢失或随意更换 `MEMBERSHIP_AUTH_SECRET`。旧本机私人内容由其匹配密钥加密；切换服务或迁移前须保留数据库、WAL以及匹配秘密，并按会员服务文档备份。SQLite版本仅单实例，不应放在临时serverless磁盘上。

## 真机验收清单（本轮未完成）

- 实际手机收到短信、实际邮箱收到邮件；码未公开输出，未用开发万能码。
- 登录后查看免费权益；刷新仍登录；退出后受保护接口不可访问。
- 先登录一种方式，再绑定另一种；退出后换方式登录，用户ID与原会员/额度相同。
- 验证过期、错误码、重发旧码、已占用身份、发送失败和不可用通道。
- HTTPS主站真实Cookie、浏览器保存内容与服务重启后的持久性。
- 收费另需实际商户配置及订单、支付验签/查单、退款流程实测；价格页不是收款系统。

官方资料：[阿里云发送短信](https://help.aliyun.com/en/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)、[阿里云单封邮件](https://help.aliyun.com/en/direct-mail/api-dm-2015-11-23-singlesendmail)、[POP 请求与签名](https://help.aliyun.com/zh/vms/the-http-protocol-and-signature)、[DirectMail 签名](https://help.aliyun.com/en/direct-mail/signature)。其他通道：[腾讯云发送短信](https://cloud.tencent.com/document/api/382/55981)、[Resend发信接口](https://resend.com/docs/api-reference/emails/send-email)。
