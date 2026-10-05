import { useState, useEffect } from 'react';
import { MotionConfig } from 'motion/react';
import { IconArrowRight, IconDownload, IconFileTypePdf, IconChevronRight, IconExternalLink, IconMenu2, IconX, IconBook2 } from '@tabler/icons-react';
import { Navbar, NavBody, NavItems, MobileNav, MobileNavHeader, MobileNavMenu, NavbarButton } from './components/ui/resizable-navbar';
import { GuideQuestion } from './components/guide-question';
import { KnowledgeMap } from './components/knowledge-map';
import { AnswerShowcase } from './components/answer-showcase';
import { BentoGrid, BentoGridItem } from './components/ui/bento-grid';
import { guideLocationHref, entryLocationHref } from './lib/guide-location.mjs';
import { ReaderContent } from './components/reader-content';
import { useMembership } from './components/membership/membership-context.jsx';
import { useAnalytics } from './components/analytics.jsx';
import { trackOptionalAnalytics } from './lib/analytics-flow.mjs';
import { PUBLIC_ONLY } from './lib/public-mode.mjs';

const base = import.meta.env.BASE_URL;
const media = name => `${base}media/${name}.webp`;
const repo = 'https://github.com/Fangx-AI/better-life';
const pdf = 'https://github.com/eternity4719/HowToLiveBetter/releases/download/epub-latest/HowToLiveBetter.pdf';
const libraryHref = guideLocationHref(base);
const scenes = [
  { chapter: 19, title: '工作与离职', description: '更稳的工作，更好的选择', image: 'scene-work' },
  { chapter: 5, title: '少花冤枉钱', description: '看清套路，把钱花在刀刃上', image: 'scene-money' },
  { chapter: 15, title: '租房与买房', description: '住得安心，生活才踏实', image: 'scene-home' },
];

function initialSaved() {
  try {
    const ids = JSON.parse(localStorage.getItem('better-life:saved') || '[]');
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function Brand() {
  return <a className="brand" href={base} aria-label="Better Life 首页">
    <img src={media('brand')} width="40" height="40" alt=""/>
    <span><b>BETTER LIFE</b><small>高性价比人生指南</small></span>
  </a>;
}

export function App() {
  const track = useAnalytics();
  const { openAccount, me } = useMembership();
  const [highlighted, setHighlighted] = useState([]), [questionRequest, setQuestionRequest] = useState(null);
  const [saved, setSaved] = useState(initialSaved), [corpus, setCorpus] = useState(null);
  const [error, setError] = useState(false), [reload, setReload] = useState(0), [menu, setMenu] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch(`${base}content.json`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw Error(response.status); return response.json(); })
      .then(setCorpus).catch(reason => { if (reason.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, [reload]);

  const openEntry = (entry, source) => { trackOptionalAnalytics(track, 'reader_open', { source }); window.location.assign(entryLocationHref(base, entry)); };
  const toggleSaved = entry => {
    const next = new Set(saved);
    if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
    setSaved(next);
    try {
      localStorage.setItem('better-life:saved', JSON.stringify([...next]));
      return next.has(entry.id) ? '已收藏' : '已取消收藏';
    } catch { return '本次已保存；浏览器不允许持久保存，刷新后可能丢失。'; }
  };
  const renderContent = entry => <ReaderContent key={entry.id} entry={entry} corpus={corpus} saved={saved} onToggleSaved={toggleSaved}/>;

  return <MotionConfig reducedMotion="user">
    <a className="skip-link" href="#hero-title">{PUBLIC_ONLY ? '跳到内容' : '跳到提问'}</a>
    <Navbar className="site-navbar fixed top-0">
      <NavBody className="desktop-nav">
        <Brand/>
        <NavItems className="nav-items" items={[
          { name: '按场景找', link: '#scenes' },
          { name: '查看指南', link: libraryHref },
          ...(!PUBLIC_ONLY ? [{ name: '我的指南', link: `${base}?view=guides` }] : []),
          { name: '会员方案', link: `${base}?view=pricing` },
        ]}/>
        {!PUBLIC_ONLY && <NavbarButton as="button" type="button" className="outline-button nav-account" onClick={openAccount}>{me?.user ? '我的账户' : '登录'}</NavbarButton>}
        <NavbarButton href={pdf} className="outline-button nav-download"><IconDownload size={18}/> 下载 PDF</NavbarButton>
      </NavBody>
      <MobileNav><MobileNavHeader><Brand/>
        <NavbarButton as="button" type="button" className="icon-button" aria-label={menu ? '关闭菜单' : '打开菜单'} aria-expanded={menu} aria-controls="mobile-menu" onClick={() => setMenu(!menu)}>{menu ? <IconX size={23}/> : <IconMenu2 size={23}/>}</NavbarButton>
      </MobileNavHeader><MobileNavMenu isOpen={menu} onClose={() => setMenu(false)}>
        <nav id="mobile-menu" aria-label="手机导航">
          <NavbarButton href="#scenes" variant="secondary" onClick={() => setMenu(false)}>按场景找</NavbarButton>
          <NavbarButton href={libraryHref} variant="secondary">查看指南</NavbarButton>
          {!PUBLIC_ONLY && <NavbarButton href={`${base}?view=guides`} variant="secondary">我的指南</NavbarButton>}
          <NavbarButton href={`${base}?view=pricing`} variant="secondary">会员方案</NavbarButton>
          {!PUBLIC_ONLY && <NavbarButton as="button" type="button" variant="secondary" onClick={() => { setMenu(false); openAccount(); }}>{me?.user ? '我的账户' : '登录'}</NavbarButton>}
          <NavbarButton href={pdf} className="outline-button"><IconDownload size={18}/> 下载 PDF</NavbarButton>
        </nav>
      </MobileNavMenu></MobileNav>
    </Navbar>
    <main>
      <div className="landing-background" aria-hidden="true" style={{ backgroundImage: `url(${media('hero-background')})` }}/>
      <section className="hero" aria-labelledby="hero-title">
        <p className="sr-only hero-tagline">学校没教，生活会考。</p>
        <h1 id="hero-title" tabIndex={-1}>高性价比<span>人生指南</span></h1>
        <p className="hero-subtitle">省钱、避坑、少走弯路。</p>
        <GuideQuestion corpus={corpus} loadError={error} renderSource={renderContent} onResult={setHighlighted} questionRequest={questionRequest}/>
        {error && <div className="home-corpus-error" role="alert"><p>指南暂时没加载成功，请重试。</p><NavbarButton as="button" type="button" className="outline-button" onClick={() => setReload(value => value + 1)}>重新加载指南</NavbarButton></div>}
        <div className="hero-meta"><span><b>{corpus?.counts.entries || 650}</b> 条建议 <span aria-hidden="true">·</span> <b>{corpus?.counts.chapters || 34}</b> 个主题</span><NavbarButton href={pdf} variant="secondary" className="meta-pdf"><IconFileTypePdf size={25}/> 下载 PDF</NavbarButton></div>
      </section>
      <section id="scenes" className="scene-section page-width" aria-label="按场景查指南"><BentoGrid className="scene-grid">
        {scenes.map(scene => <BentoGridItem key={scene.chapter} as="a" href={guideLocationHref(base, { chapter: String(scene.chapter) })} className="scene-card" aria-label={`查看${scene.title}`} header={<><img src={media(scene.image)} width="1245" height="624" alt=""/><span className="scene-shade"/></>} title={<h2>{scene.title}</h2>} description={<><p>{scene.description}</p><span className="scene-next"><IconChevronRight size={18}/></span></>}/>)}
      </BentoGrid></section>
      <KnowledgeMap corpus={corpus} onOpen={entry => openEntry(entry, 'graph')} highlighted={highlighted}/>
      <AnswerShowcase corpus={corpus} onOpen={entry => openEntry(entry, 'showcase')} onAsk={text => setQuestionRequest({ text, nonce: Date.now() })}/>
      <div className="browse-invitation page-width"><NavbarButton href={libraryHref} className="outline-button">查看全部 {corpus?.counts.entries || 650} 条建议 <IconArrowRight size={18}/></NavbarButton></div>
      <section id="formats" className="book-section">
        <img className="book-photograph" src={media('knowledge-book')} width="1774" height="887" loading="lazy" alt="书桌上的人生指南书页与 Obsidian 关系图示意"/>
        <div className="book-content page-width"><div className="book-copy"><h2>整套指南，<br/>直接带走。</h2><p>随时查阅，慢慢读。<br/>完整指南，免费带走。</p>
          <div className="download-actions"><NavbarButton href={pdf} className="coral-button"><IconDownload size={19}/> 下载完整 PDF</NavbarButton><NavbarButton href={`${base}downloads/better-life-obsidian.zip`} download className="outline-button"><IconBook2 size={19}/> 下载 Obsidian Vault</NavbarButton></div>
          <details className="more-formats"><summary>其他格式</summary><NavbarButton href={pdf.replace('.pdf', '.epub')} className="outline-button">EPUB 电子书</NavbarButton><NavbarButton href={pdf.replace('.pdf', '.html')} className="outline-button">离线单文件</NavbarButton></details>
          <p className="book-counts">650 条建议 · 34 个主题</p>
        </div></div>
      </section>
    </main>
    <footer className="page-width"><div><b>BETTER LIFE</b><p>学校没教，生活会考。好用，就留个入口。</p></div><NavbarButton href={repo} className="outline-button" target="_blank" rel="noopener noreferrer">GitHub 上看项目 <IconExternalLink size={17}/></NavbarButton><nav className="footer-links" aria-label="网站说明"><a href={`${base}content-source.html`} className="source-link">内容来源</a><a href={`${base}?view=privacy`} className="source-link">隐私说明</a><a href={`${base}?view=terms`} className="source-link">服务说明</a></nav></footer>
  </MotionConfig>;
}
