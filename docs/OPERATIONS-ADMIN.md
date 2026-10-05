# 运营后台：只读汇总与人工退款工单

此模块提供操作能力，不代表后台已在生产开放、付款已接通，或退款已完成。实际开通由服务部署、独立凭据和受信支付通知决定。

## 浏览器工作区

独立页面路由为 `?view=operations`，不在普通用户导航中放后台入口。`src/components/operations/operations-page.jsx` 沿用已有 Aceternity Input、Label、NavbarButton 与白底珊瑚视觉；提供开放状态、独立凭据输入、总览、用户、订单、退款工单、审计和游标前后分页。前端不能读取私人正文，也不能手工改付款状态。

运营凭据只保留在当前页 React 内存 state；输入为 password，不写 URL、浏览器存储或日志。退出/刷新后需重新输入；API 401 会同时擦除凭据和已经读取的后台数据。请求固定同源 `api/operations/…`，`Authorization: Bearer`，不带会员 Cookie，`Cache-Control: no-store`，无 referrer，拒绝自动跟随重定向，10 秒超时。页面不会复用普通会员登录。

总览区分别展示真实可读的用户/订单状态汇总、配置费率预算估算和最近 90 天匿名事件。未配置、未接通和空记录明确区分；空记录不会被宣称为零访问或零成本。预算不是供应商账单，订单金额不是会计净收入。事件聚合不提供个人轨迹、真实新注册人数、留存或跨渠道用户级漏斗。

工单界面只提供当前状态的合法下一步，提交现有 revision 作为乐观锁。批准工单不等于网关退款到账；关闭为已退款仍须服务端已有受信退款事实。所有变更都会明确提示“未调用支付网关，也未改动付款或退款事实”。

`tests/operations-api.test.mjs` 覆盖同源 URL、凭据不进 query、Bearer/omit/no-store、私密字段剔除、状态权限、revision PATCH、401/409/超时/离线错误不回显秘密；`tests/operations-ui.test.mjs` 检查状态擦除、页面边界、既有组件、分页与手机单列布局。实际 UI 浏览器验收另由集成方执行，静态结构测试不能代替真实视觉验收。

## 启用与权限

- 默认关闭。只有 `OPERATIONS_ENABLED=true` 和有效 `OPERATIONS_SECRET` 同时存在，员工接口才可用。启用但配置无效时，应在创建数据库前调用 `assertOperationsConfig(env)`，启动失败而非降级开放。
- `OPERATIONS_SECRET` 必须是独立生成的 48 个随机字节的规范 base64url 表示（64 字符）。格式校验不能证明随机性；请用密码学随机源和部署密钥管理器生成、保存、轮换。不得复用会员登录、支付或备份密钥，不使用 `VITE_` 前缀。
- 只接受 `Authorization: Bearer …`；先 SHA-256 散列为固定长度，再用 constant-time 比较。会员 Cookie、URL 参数、前端付款回跳都不能授权运营操作。
- 可设置不含联系方式的 `OPERATIONS_OPERATOR_ID`（1–64 个字母、数字、下划线或连字符）。这是单凭据部署的配置标识，**不是多员工独立认证，也不能证明具体自然人身份**。
- 生产经同站 HTTPS 入口访问。未提供 CORS 授权；拒绝跨站 `Origin` 和 `Sec-Fetch-Site: cross-site`。服务器侧命令行客户端可不发送 Origin，但仍必须提供凭据。
- 浏览器只应在当前页面内存持有凭据，退出或刷新清除；不得写 localStorage、sessionStorage、IndexedDB、持久 Cookie、URL、导出文件或日志。服务器不签发运营 Cookie。服务器模块本身无法检查调用方是否私下持久化凭据。
- 建议为运营入口增加网络访问限制。当前有进程内每分钟全局 600、客户端 120、工单写入 20 的上限；重启后重置，不能替代网关级限流或独立员工身份系统。

## 员工 API

前缀为 `/api/operations`。除状态外均需独立 Bearer，响应 `Cache-Control: no-store`。不支持额外请求字段、重复筛选参数或隐含的“显示私人资料”选项。

| 方法与路径 | 能力 |
| --- | --- |
| `GET /status` | 仅 `enabled/configured/available` 及能力关闭标识，无密钥、私人路径或供应商配置值；这是配置状态，不是数据库健康证明 |
| `GET /summary` | 用户数量、订单状态数量、按币种和订单状态分组的金额、工单状态数量 |
| `GET /users` | 用户匿名编号、创建时间、登录通道类型、会员到期、已有配额计数、私人资料数量/存在标识 |
| `GET /orders` | 订单编号、用户编号、套餐、金额/币种、存储的付款与退款状态、时间 |
| `GET /refund-tickets` | 脱敏退款工单列表 |
| `POST /refund-tickets` | 录入申请：`orderId`、幂等 `requestId`、`reasonCode` |
| `PATCH /refund-tickets/:id` | `revision` 乐观锁 + 有限 `state` 变更 |
| `GET /audit` | 操作审计（不提供删除或修改接口） |
| `GET /usage-budget` | 可选注入的全站预算估算聚合；未注入仅 `configured:false`，估算不是供应商账单 |
| `GET /analytics` | 可选 `getAnalyticsReport({from,to})` 的站内聚合，返回 `{configured,items}`；日期必须有效、不逆序；未注入为空列表 |

列表返回 `{items,nextCursor,limit}`。`limit` 为 1–100，默认 25；`cursor` 是路由专属 keyset 游标，相同创建时间通过编号排序，不能混用。用户支持精确 `userId` 与 `authentication`；订单支持 `userId/orderId/status/refundState`；工单支持 `userId/orderId/state`；审计支持 `action`。不提供联系方式模糊搜索。

**默认及当前均不返回**邮箱、手机号、用户标签、问题、AI 回答、个人事实、指南正文、支付跳转地址、商户密钥、支付交易号、认证会话或验证码。汇总读取不调用会产生配额写入的会员 `me()`。订单金额汇总只是数据库中按状态分类的订单金额，不应称为收入、会计利润或实际净结算。

## 退款工单边界

申请原因只允许 `mistaken_purchase`（误购）、`service_issue`（服务问题）、`duplicate_charge`（重复扣款疑问）、`other`（其他），不存自由文本和联系方式。类别本身不证明扣款有误或具备退款资格。

只有已核验支付、尚未退款的订单可新增申请。同一订单只允许一个未关闭工单；员工重复 `orderId+requestId` 返回同一工单，改原因会拒绝。原因、归属和金额创建后不可修改，金额取自订单，不接受客户端自报。

允许的流转：

```text
requested → reviewing / cancelled
reviewing → approved / rejected / cancelled
approved → awaiting_provider / cancelled
awaiting_provider → reviewing / resolved
resolved / rejected / cancelled → 不可再改
```

- `approved` 只表示人工审核决定，**不是银行/支付网关退款成功**；它不承诺退款时限，也不规定商品退款政策。
- `awaiting_provider` 表示需要线下按商户真实规则跟进，模块不调用退款网关。
- 只有原订单已经由受信、核验过的支付事实成为 `refunded`，才允许工单改为 `resolved`。即使员工已经批准，也不能手工写 `orders.status=refunded`。
- 所有工单创建和流转都只写 `operations_*` 表。不能手工置 `paid`、开会员、修改金额/套餐、调整配额或撤销权益；支付模块验签通知负责金融事实和对应权益变动。
- 本模块仅支持整单申请快照，不提供部分退款能力。不编造退款政策；正式商户条款、支付平台操作和人工判断另行核实。

## 登录用户退款接口的服务端组合

`createOperationsStore({membershipStore,now})` 接收已有、品牌验证后的会员数据库连接，不打开环境变量指向的另一个文件，也不拥有连接关闭权。为登录用户申请可始终创建此 store，而员工 handler 仍默认关闭。

- `submitRefundRequest(user,{orderId,reason}) → {ticket,created}`：`reason` 只能用上述枚举，订单必须属于调用用户。重复未关闭申请返回原工单（不会改动原原因）；终态后新的合法申请会有新工单。会员 handler 必须先验证登录、同站来源并严格拒绝额外字段，**不能接受客户端 userId**。
- `listUserRefundRequests(user) → {items}`：只返回该用户最近至多 100 个工单。
- helper 抛出 `OperationsError`；集成方映射其 `status/code/message`，不得把其他数据库异常详情返回客户端。
- helper 不需要运营 Bearer，也不为用户提供工单审核、审计列表或其他人的订单权限。用户动作以 `actor=user` 记录，不记录联系方式。

## 持久化、审计与注销

新增同库表 `operations_refund_tickets` 与 `operations_audit`。工单 `order_id`、`user_id` 分别引用订单和用户，不设置级联删除。审计不依赖用户/订单外键，避免软注销破坏操作记录。软注销用户、删除私人指南/档案/保存回答/身份/会话不删除金融工单；硬删除金融关联用户会受到现有外键约束，应遵循明确的金融记录保留与隐私删除策略，而不是静默清空。

工单写入与成功审计在一个 `BEGIN IMMEDIATE` 事务中；审计写失败则回滚工单。成功的敏感读取、拒绝操作也有审计。未认证请求每客户端每分钟只采样一次，减少爆破导致审计膨胀。客户端网络标识只保存由运营密钥 HMAC 得到的摘要，不保存原始 IP。

审计只存允许的动作、结果、匿名目标编号、配置操作员标识、原因类别、版本和状态；不转存 Authorization、Cookie、原始请求 body、Origin、用户自由文本或数据库异常。审计表有禁止 UPDATE/DELETE 的 SQLite trigger，且无 API 修改能力；**这不是密码学防篡改**，拥有主机/数据库管理权限的人仍可移除 trigger 或修改库。

全库在线加密备份会包含新表。应执行受控备份、恢复校验、主机访问控制和离线审计保留；本模块不自动安装备份计划，不删除审计，不声称已经完成生产恢复演练。审计保留策略需要业务与适用规则确认。

## 已验证与未执行

`tests/operations.test.mjs` 使用内存 SQLite 和临时合成数据库、随机测试凭据、模拟受信支付事件，覆盖默认关闭、独立认证、来源限制、无私人数据输出、分页、工单幂等/状态/版本、审计回滚、防改写、归属隔离、软注销及重开持久化。

未读取真实私人库或环境密钥，未发送 OTP，未真实付款/退款，未测试真实支付网关退款调用；此模块也没有这样的调用能力。
