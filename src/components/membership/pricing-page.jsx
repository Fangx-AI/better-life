import { useState, useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconArrowLeft, IconArrowRight, IconCheck, IconChevronDown, IconBook2, IconUser, IconMessageCircle, IconDownload } from '@tabler/icons-react';
import { Navbar, NavBody, MobileNav, MobileNavHeader, NavbarButton } from '../ui/resizable-navbar';
import { BentoGrid } from '../ui/bento-grid';
import { useMembership } from './membership-context';
import { formatMoney } from '../../lib/membership-api.mjs';
import { PUBLIC_ONLY } from '../../lib/public-mode.mjs';
import { guideLocationHref } from '../../lib/guide-location.mjs';

const base = import.meta.env.BASE_URL;
const faqs = [
  ['不买会员，还能用什么？', '650 条生活建议、全文检索、原文出处、浏览器收藏，以及 PDF 和 Obsidian 下载，都继续免费。手机号或邮箱登录后，免费账号可保存 5 篇个人指南，每 30 天有 10 次书本 AI 提问。'],
  ['“我的人生指南”可以怎样用？', '把有用的回答保存成自己的指南。按主题整理，写下你确认过的情况，记录完成的行动，再带着新的问题继续完善。每次更新都由你确认，不会替你自动修改情况或勾选任务。可以导出 Markdown，放入 Obsidian。'],
  ['什么情况下会扣一次提问？', '系统成功生成一份有书中依据的回答，才扣 1 次。生成失败、超时或书中依据不足不扣次数。阅读原文、收藏和下载不扣次数。'],
  ['一次能问多少？有没有使用频率限制？', '每 30 天的总次数之外，每分钟最多 6 次、每天最多 30 次，同一账号同时只能生成 1 份回答。次数不结转；页面会根据剩余次数和更新时间提示你。'],
  ['会员会自动续费吗？', '不会。首版是一次购买，到期结束，不自动扣款。到期后仍然可以免费阅读指南；是否续购由你自己决定。'],
  ['会员到期，自己的指南会消失吗？', '不会。已经保存的个人指南仍可以查看、编辑、勾选行动项、导出和删除，也能查看历史版本。新建指南的篇数和继续提问的次数回到免费套餐范围；不会因为到期就锁住已有内容。'],
  ['年付的提问次数怎么发放？', '年度会员有效期为 365 天，每 30 天提供 200 次提问，不是一次发放全年次数。次数不结转。年度套餐未开放时，页面只展示价格，不接受付款。'],
  ['为什么现在还不能付款？', '只有登录、收款和会员权益都准备好，才会开放购买。显示“付款待开放”时，你可以查看完整的订单明细，但不会扣钱，也不会生成虚假的已付款记录。'],
];

// Inline expansion follows the existing Aceternity Expandable Card pattern.
function PricingFaq() {
  const [active, setActive] = useState(null), id = useId();
  const items = PUBLIC_ONLY ? faqs.map(([question, answer], index) => [question, index === 0 ? '650 条生活建议、全文检索、原文出处、浏览器收藏，以及 PDF 和 Obsidian 下载都免费。当前为免费阅读站，AI、登录与会员尚未开放；以下会员权益仅为预览。' : index === 7 ? '当前免费阅读站不提供登录与付款，只展示价格和权益预览，不创建订单或扣款。' : answer]) : faqs;
  return <div className="pricing-faq-list">{items.map(([question, answer], index) => <article className="pricing-faq" key={question}>
    <NavbarButton as="button" variant="secondary" type="button" className="pricing-faq-trigger" aria-expanded={active === index} aria-controls={`${id}-${index}`} onClick={() => setActive(active === index ? null : index)}>{question}<IconChevronDown size={19} className={active === index ? 'is-open' : ''}/></NavbarButton>
    <AnimatePresence initial={false}>{active === index && <motion.div id={`${id}-${index}`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .2 }}><p>{answer}</p></motion.div>}</AnimatePresence>
  </article>)}</div>;
}

function PlanCard({ plan }) {
  const { status, me, openAccount, openCheckout } = useMembership();
  const monthly = plan.id === 'member-month', free = plan.id === 'free', annual = plan.id === 'member-year';
  const isCurrent = me?.user && me.membership.planId === plan.id;
  const canBuy = status.checkoutAvailable && plan.purchasable;
  const descriptions = { free: '先把眼前的问题，理清楚。', 'member-month': '需要的时候，多问几次。', 'member-year': '留给打算长期使用的你。' };
  return <motion.article className={`pricing-card${monthly ? ' pricing-card-featured' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .35 }}>
    <div className="pricing-card-top"><h2>{plan.name}</h2>{monthly ? <span className="pricing-badge">从这个开始</span> : annual && !canBuy ? <span className="pricing-badge pricing-badge-muted">价格预览</span> : isCurrent ? <span className="pricing-badge pricing-badge-muted">当前套餐</span> : null}</div>
    <p className="pricing-plan-description">{descriptions[plan.id]}</p>
    <p className="pricing-amount"><span>¥</span><b>{formatMoney(plan.amountFen)}</b><small>{free ? '一直免费' : `/ ${plan.durationDays} 天`}</small></p>
    <p className="pricing-amount-note">{annual ? `折合每月 ¥${(plan.amountFen / 1200).toFixed(2)} · 一次支付 ¥${formatMoney(plan.amountFen)}` : free ? '内容和下载不设阅读门槛' : '一次购买 · 不自动续费'}</p>
    <ul className="pricing-benefits">
      <li><IconCheck size={18}/><span>保存 <strong>{plan.guideLimit || (free ? 5 : 100)} 篇</strong>自己的生活指南</span></li>
      <li><IconCheck size={18}/><span>确认个人情况，持续提问完善</span></li>
      <li><IconCheck size={18}/><span>行动勾选、历史版本与撤回</span></li>
      <li><IconCheck size={18}/><span>导出 Markdown，放进 Obsidian</span></li>
      <li><IconCheck size={18}/><span>每 {plan.periodDays} 天 <strong>{plan.quotaPerPeriod} 次</strong>书本 AI 提问</span></li>
    </ul>
    {PUBLIC_ONLY ? <NavbarButton href={guideLocationHref(base)} className={`${monthly ? 'coral-button' : 'outline-button'} pricing-plan-button`}>先免费阅读<IconArrowRight size={18}/></NavbarButton> : <NavbarButton as="button" type="button" className={`${monthly ? 'coral-button' : 'outline-button'} pricing-plan-button`} onClick={() => free ? openAccount() : openCheckout(plan.id)}>{free ? (me?.user ? '查看我的免费额度' : '免费登录') : canBuy ? `选择${plan.name}` : '查看套餐明细'}<IconArrowRight size={18}/></NavbarButton>}
    <p className="pricing-card-footnote">{free ? '不登录也能免费阅读全部指南' : canBuy ? '成功回答才扣次，剩余次数不结转' : annual ? '年度套餐暂未开放购买' : '付款待开放，当前不会扣款'}</p>
  </motion.article>;
}

export function PricingPage({ onHome }) {
  const { status, me, loading, openAccount } = useMembership();
  const homeProps = onHome ? { as: 'button', type: 'button', onClick: onHome } : { href: base };
  const brand = <a className="brand" href={base}><img src={`${base}media/brand.webp`} width="40" height="40" alt=""/><span><b>BETTER LIFE</b><small>高性价比人生指南</small></span></a>;
  const actions = <div className="pricing-nav-actions"><NavbarButton {...homeProps} variant="secondary" className="pricing-home-link"><IconArrowLeft size={17}/> 返回指南</NavbarButton>{!PUBLIC_ONLY && <NavbarButton as="button" type="button" className="outline-button" onClick={openAccount}><IconUser size={17}/>{me?.user ? '我的会员' : '登录'}</NavbarButton>}</div>;
  return <div className="pricing-page">
    <a className="skip-link" href="#pricing-plans">跳到会员套餐</a>
    <Navbar className="site-navbar pricing-navbar fixed top-0"><NavBody className="desktop-nav">{brand}{actions}</NavBody><MobileNav><MobileNavHeader>{brand}{actions}</MobileNavHeader></MobileNav></Navbar>
    <main><div className="pricing-wash" aria-hidden="true"/>
      <header className="pricing-hero page-width"><p className="eyebrow">BETTER LIFE MEMBERSHIP</p><h1>不是更多答案。<br/><span>是越来越懂自己的指南。</span></h1><p className="pricing-hero-description">把每一次提问，变成自己的生活笔记。<br className="pricing-mobile-break"/>记录行动，持续完善，让好建议真正用起来。</p><div className="pricing-trust"><span><IconBook2 size={17}/> 原文依据可查看</span><span><IconCheck size={17}/> 不自动续费</span><span><IconDownload size={17}/> 指南一直免费</span></div></header>
      <section className="page-width pricing-plans-section" id="pricing-plans" aria-label="会员套餐" aria-busy={loading}>
        {PUBLIC_ONLY && <p className="pricing-availability" role="status">会员服务暂未开放，此页仅为价格与权益预览。</p>}
        <BentoGrid className="pricing-grid">{status.plans.map(plan => <PlanCard key={plan.id} plan={plan}/>)}</BentoGrid>
        <p className="pricing-availability" role="status">{PUBLIC_ONLY ? '原书阅读、检索和下载一直免费。' : loading ? '正在确认套餐开放状态……' : status.preview ? '当前为价格预览：登录与付款尚未开放。免费阅读和下载照常可用。' : !status.checkoutAvailable ? '付款待开放。你可以先免费阅读，或登录查看提问额度。' : '套餐金额和权益以订单确认页为准。'}</p><p className="pricing-frequency-note">每分钟最多 6 次 · 每天最多 30 次 · 同时生成 1 份回答。以上与套餐总次数共同生效。</p>
      </section>
      <section className="pricing-free-story page-width"><div className="pricing-story-photo"><img src={`${base}media/scene-home.webp`} alt="窗边的阳光，桌上的钥匙和生活用品" loading="lazy"/></div><div className="pricing-story-copy"><p className="eyebrow">GOOD ADVICE, OPEN TO EVERYONE</p><h2>好用的生活建议，<br/>不该隔着一道付费墙。</h2><p>从租房、离职，到省钱和睡眠。<br/>650 条建议、34 个主题，完整指南一直开放。</p><p className="pricing-story-note">会员是自己的指南、行动记录与更多提问。不是买下一本原本就免费的书。</p><NavbarButton {...homeProps} className="outline-button">先回指南看看<IconArrowRight size={18}/></NavbarButton></div></section>
      <section className="pricing-faq-section page-width"><div className="pricing-section-heading"><p className="eyebrow">BEFORE YOU DECIDE</p><h2>把这些说清楚。</h2><p>花不花钱，你都应该心里有数。</p></div><PricingFaq/></section>
      <section className="pricing-final page-width"><IconMessageCircle size={30}/><div><h2>先解决一个真实的问题。</h2><p>从你正在遇到的事开始，不用一次改变整个人生。</p></div><NavbarButton {...homeProps} className="coral-button">{PUBLIC_ONLY ? '回去读指南' : '回去问一问'}<IconArrowRight size={18}/></NavbarButton></section>
    </main><footer className="page-width pricing-footer"><div><b>BETTER LIFE</b><p>学校没教，生活会考。</p></div><a href={`${base}content-source.html`} className="source-link">内容来源与许可</a>{!PUBLIC_ONLY && <NavbarButton as="button" type="button" variant="secondary" onClick={openAccount}>我的账号</NavbarButton>}</footer>
  </div>;
}
