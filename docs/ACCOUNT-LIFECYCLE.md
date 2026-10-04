# 账号注销服务端边界

`server/account-lifecycle.mjs` 复用已验证的会员 SQLite 连接，不读取环境密钥、不另开真实数据库、不调用付款或退款网关，也不拥有连接关闭权。会员 handler 负责登录、同站来源检查、限流、JSON 体积及严格字段校验。

## 最近验证与接口

- `createAccountLifecycle({store,now})` 返回 `markAuthenticated(tokenHash)`、`freshnessStatus(user,{tokenHash})`、`accountStatus(user,{tokenHash})`、`deleteAccount(user,{tokenHash,confirmation})`。
- `markAuthenticated` 仅由服务端真正成功的身份验证调用。不可提供公开的“刷新鲜登录”端点，也不能仅因已有 Cookie 有效就标记。既有 session 没有标记时必须重新登录验证。
- 标记记录在 `account_session_freshness`，其主键引用 `sessions.token_hash` 并 `ON DELETE CASCADE`。有效 session 必须属于当前用户；不能借用其他用户或其他设备的鲜登录。
- 鲜登录期限为严格小于 10 分钟，恰好第 10 分钟过期；未来时间标记不接受。普通会话期限不替代此期限。
- 新绑定通道的 OTP 仅证明新通道控制权，不自然证明原账号持有人。集成时应优先以原有身份正常重新登录作为敏感操作验证；不要无条件让新绑定操作替代原有身份再次验证。
- `freshnessStatus` 返回自身验证时间、到期时间及是否需要重新验证，无 session hash。`accountStatus` 另外返回有限阻塞原因键和 `canDelete`，不返回私人正文、联系方式或订单详情。
- 确认文本必须精确等于 `删除我的账号`（不自动 trim）。本机体验账号不能走正式注销流程。`markAuthenticated` 也不接受体验账号。

## 注销阻塞

注销在一个 `BEGIN IMMEDIATE` 事务中重新检查当前数据库状态，任一条件成立即拒绝并回滚：

| 错误键 | 实际条件 |
| --- | --- |
| `active_membership` | 存在 `ends_at > now` 的权益，包括尚未开始的未来续期窗口 |
| `unsettled_orders` | 任一订单尚非已核验 `paid` / `refunded`，包括 `created/pending/failed/expired`；本地请求失败或显示到期不是网关关单证明 |
| `refund_pending` | 任一订单的支付退款状态为 `refund_pending` |
| `open_refund_request` | 退款工单为 `requested/reviewing/approved/awaiting_provider` |
| `generation_in_progress` | `reserved` 且尚未到期的问答预占 |

这不是退款资格、退款时限或合同政策。需要退款的用户应先走独立退款申请/受信支付事实流程；注销不会触发退款，不会把订单改为已付或已退。

支付链接的本地 30 分钟到期、下单网络失败都不能证明供应商不会接受迟付或没有实际订单。有效迟到支付仍需入账；若先释放身份并生成 deleted 墓碑，付款将只能开通到无法登录的旧账号。因此这些订单继续阻塞注销，不能仅等待、刷新状态或设置 `failed/expired` 绕过。

用户应先联系本站客服**人工核对商户记录**。人工核对是解除前提，不是本轮已实现的“强制解除”接口：当前没有受信签名关单/终止支付事实实现，不能宣称未付单已自动关单或已自动恢复删除。真实已付/已退事实及权益处理完成后重新检查；对于确认未付款但仍可迟付的订单，需先补充受信关单协议/状态及验证再开放自动注销。不得用 SQL 将未付款改成 `paid/refunded`、删金融流水或通过禁用回调冒充解决。

## 删除与保留

满足条件后，事务删除该用户的指南与版本、个人档案、保存回答、全部 generation（含问题散列与结果密文）、配额周期、身份信息、关联验证码以及所有端 session 和对应鲜登录标记。可归属的验证码投递摘要、身份验证码限流记录和主体私写限流记录也删除；全局及网络限流/短信费用保护不重置。其他用户不受影响。

只清理 `ends_at <= now` 的过期权益；不能丢弃未来权益。订单、支付事件、扣次流水与闭合退款工单保持原样。用户行保留为金融关联 tombstone：邮箱改为 `deleted-<匿名编号>@local.invalid`、`auth_kind=deleted`、`label=NULL`。它不能登录；原联系方式释放后，下次真实登录创建新的用户编号，不继承旧会员或私人资料。旧 Cookie 在所有端失效。

成功响应的 `privateContentDeleted:true` 仅表示**在线数据库相应逻辑记录已删除**，不意味着 SQLite 空闲页、WAL、离线加密备份、用户主动导出的文件或其他设备已物理擦除。备份保留、加密密钥、物理销毁和适用规则需要独立、明确的运营策略；此模块不编造保留期限，也不宣称完成全介质销毁。金融关联 tombstone 与流水仍可能具有可关联性，不能宣称完全匿名化。

任何意外数据库错误均转换为无私人信息的 `AccountLifecycleError(503,account_unavailable,…)`，且删除回滚。集成方只映射已知错误的 status/code/message，不把 SQLite 错误、密钥或用户信息返回客户端。

## 测试结果范围

`tests/account-lifecycle.test.mjs` 只用内存/临时 SQLite、合成身份、散列会话和模拟受信支付事件，验证鲜登录期限与持久化、确认文本、全部阻塞条件、failed/expired 注销拒绝后迟到付款仍归属可登录用户、事务回滚、金融记录不变、其他用户不受影响、联系方式释放/新账号、旧会话撤销及外键完整性。

未读取真实私人库或环境密钥，未发送真实验证码、付款或退款，未删除实际用户账号、备份或导出文件。
