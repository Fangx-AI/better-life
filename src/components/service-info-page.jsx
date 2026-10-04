import { NavbarButton } from './ui/resizable-navbar';
import { useMembership } from './membership/membership-context.jsx';
import './service-info.css';

const base = import.meta.env.BASE_URL;
const sections = {
  privacy: [
    ['登录信息', '手机号或邮箱用于验证身份、绑定登录方式和关联会员。验证码由你选择的短信或邮件服务发送；登录会话使用 HttpOnly Cookie，不把登录凭据保存在浏览器存储中。'],
    ['提问与保存', '提问、相关书本条目及你主动选用的个人情况会发送给 DeepSeek 生成回答。不要提交他人的隐私。正式会员问答会短期加密缓存结果，以支持重试不重复扣次；主动保存的指南、历史版本和个人情况在服务端加密保存。'],
    ['订单与统计', '我们保存订单、付款通知、会员权益和额度流水，不接收你的支付密码。启用访问统计时，仅记录固定事件和短期随机会话，不记录问题正文、答案、手机号或邮箱；尊重浏览器 DNT 与 GPC 设置。运营后台不能查看私人指南正文。'],
    ['删除与备份', '你可以删除已保存内容，或在账号内申请注销。注销需重新验证身份并处理未结订单、会员与退款申请；主库中的私人内容及登录方式会移除，必要金融流水以脱敏账号记录保留。备份、日志及自己导出的文件不会随主库操作立即物理擦除。'],
    ['第三方服务与联系', '验证码、DeepSeek 和支付平台会处理完成各自服务所需的信息。退款申请通过账号内的订单入口提交；如本站已配置客服，可以使用下方入口联系。'],
  ],
  terms: [
    ['免费内容', '原书阅读、检索、来源、PDF 与 Obsidian 下载保持免费。原书内容归原作者，本项目的整理和 AI 回答不代表原作者背书。'],
    ['会员权益', '会员购买的是问答额度和个人内容保存能力，价格、有效期、次数及容量以订单确认页为准。一次购买到期，不自动续费；年度会员仅在实际开放后可购买。成功生成才扣次数，上游失败、取消或依据不足不扣用户次数。'],
    ['付款与售后', '只有服务端核对真实付款后才开通权益，回跳页面不代表付款成功。你可在“我的账户”对已付订单提交退款申请。申请和审核通过都不代表退款到账，以支付平台确认的退款结果为准；处理期间可查询工单。'],
    ['使用范围', '问答结合书中资料回答具体问题，不能保证解决每一种情况。书中有时间、地区及人群限制，原文依据可以随时展开查看。不能用本站实施违法活动、侵犯他人权益或绕过次数与付款校验。'],
    ['可用性', '服务实际开放状态以本站显示为准。出现故障时可以继续阅读和导出已有内容；不要把本机演示、价格预览或模拟支付当作正式会员购买。'],
  ],
};

export function ServiceInfoPage({ view = 'privacy' }) {
  const { status } = useMembership();
  const privacy = view === 'privacy';
  return <main className="service-info-page">
    <nav aria-label="服务说明导航"><NavbarButton href={base} className="outline-button">返回首页</NavbarButton><NavbarButton href={`${base}?view=${privacy ? 'terms' : 'privacy'}`} variant="secondary">{privacy ? '服务说明' : '隐私说明'}</NavbarButton></nav>
    <header><img src={`${base}media/brand.webp`} width="44" height="44" alt=""/><h1>{privacy ? '隐私说明' : '服务说明'}</h1><p>更新于 2026 年 10 月 4 日</p></header>
    {sections[privacy ? 'privacy' : 'terms'].map(([title, content]) => <section key={title}><h2>{title}</h2><p>{content}</p></section>)}
    {status.supportUrl && <NavbarButton href={status.supportUrl} className="coral-button" rel="noopener noreferrer" target="_blank">联系客服</NavbarButton>}
  </main>;
}
