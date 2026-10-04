import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { IconArrowLeft, IconArrowRight, IconBook2, IconBookmark, IconCheck, IconChevronRight, IconDownload, IconHeart, IconHome, IconSearch, IconX } from '@tabler/icons-react';
import { Navbar, NavBody, NavbarButton } from './ui/resizable-navbar';
import { Sidebar, SidebarBody, SidebarLink } from './ui/sidebar';
import { BentoGrid, BentoGridItem } from './ui/bento-grid';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tabs } from './ui/tabs';
import { TracingBeam } from './ui/tracing-beam';
import { ReaderContent } from './reader-content';
import { useMembership } from './membership/membership-context';
import { readGuideLocation, guideLocationHref, entryLocationHref } from '../lib/guide-location.mjs';
import { matchesGuideEntry } from '../lib/guide-filters.mjs';
import { readerText } from '../lib/reader-text.mjs';
import '../library-page.css';

const base = import.meta.env.BASE_URL;
const pdf = 'https://github.com/eternity4719/HowToLiveBetter/releases/download/epub-latest/HowToLiveBetter.pdf';
const blank = { q: '', chapter: '', free: false, saved: false };
const pageSize = 12;

function initialSaved() {
  try {
    const value = JSON.parse(localStorage.getItem('better-life:saved') || '[]');
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function localPageLink(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function readingReturnHref(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, location.origin);
    const view = url.searchParams.get('view'), previous = readGuideLocation(url);
    if (url.origin !== location.origin || url.pathname !== location.pathname || view === 'pricing' || view === 'guides' || !previous.browsing || url.hash.startsWith('#entry-')) return null;
    // Old ?q=/chapter=/saved= bookmarks are valid reading pages too. Return to
    // their canonical public filters instead of silently dropping that context.
    return guideLocationHref(url.pathname, previous.filters);
  } catch { return null; }
}

function readingListLimit(value) {
  return Number.isSafeInteger(value) && value >= pageSize ? Math.min(value, 1000) : pageSize;
}

export function LibraryPage() {
  const { me, openAccount } = useMembership();
  const [corpus, setCorpus] = useState(null), [loadError, setLoadError] = useState(false), [reload, setReload] = useState(0);
  const [route, setRoute] = useState(() => readGuideLocation(location));
  const [query, setQuery] = useState(() => readGuideLocation(location).filters.q);
  const [saved, setSaved] = useState(initialSaved), [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(pageSize), [directoryOpen, setDirectoryOpen] = useState(false);
  const heading = useRef(null), directoryNav = useRef(null), returnHref = useRef(null), returnLimit = useRef(pageSize), focusNext = useRef(false);
  const filters = route.filters, active = route.entry;
  const entries = useMemo(() => corpus?.chapters.flatMap(chapter => chapter.entries) || [], [corpus]);
  const selectedChapter = corpus?.chapters.find(chapter => String(chapter.id) === filters.chapter);
  const found = useMemo(() => entries.filter(entry => matchesGuideEntry(entry, filters, saved)), [entries, filters, saved]);
  const hasFilters = !!(filters.q || filters.free || filters.saved);
  const overview = !active && !selectedChapter && !hasFilters;
  const quickValue = filters.saved ? 'saved' : filters.free ? 'free' : 'all';
  const chapterEntries = selectedChapter?.entries || [];
  const activeIndex = active ? chapterEntries.findIndex(entry => entry.id === active.id) : -1;
  const missingEntry = route.missingEntry || (/^#entry-/.test(location.hash) && corpus && !active);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    fetch(`${base}content.json`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw Error('content unavailable');
      return response.json();
    }).then(value => {
      if (!Array.isArray(value.chapters) || !value.chapters.every(chapter => Array.isArray(chapter.entries))) throw Error('content invalid');
      setCorpus(value);
    }).catch(error => { if (error.name !== 'AbortError') setLoadError(true); });
    return () => controller.abort();
  }, [reload]);

  const syncRoute = useCallback(() => {
    const next = readGuideLocation(location, corpus);
    setRoute(next); setQuery(next.filters.q); setLimit(next.entry ? pageSize : readingListLimit(history.state?.libraryPageLimit)); setDirectoryOpen(false);
    returnHref.current = next.entry ? readingReturnHref(history.state?.libraryPageReturn) : null;
    returnLimit.current = next.entry ? readingListLimit(history.state?.libraryPageReturnLimit) : pageSize;
  }, [corpus]);

  useEffect(() => {
    syncRoute();
    const onHistory = () => { focusNext.current = true; syncRoute(); };
    window.addEventListener('popstate', onHistory); window.addEventListener('hashchange', onHistory);
    return () => { window.removeEventListener('popstate', onHistory); window.removeEventListener('hashchange', onHistory); };
  }, [syncRoute]);

  useEffect(() => {
    if (!focusNext.current || !corpus) return;
    focusNext.current = false;
    requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); });
  }, [route, corpus]);

  useEffect(() => {
    document.title = `${active?.title || selectedChapter?.title || '阅读指南'} · Better Life`;
  }, [active?.id, selectedChapter?.id]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const nav = directoryNav.current;
      const mobile = window.matchMedia('(max-width: 959px)').matches;
      // The closed mobile disclosure must never scroll or steal focus. Scroll
      // only its own directory surface; scrollIntoView would move the book too.
      if (!nav || (mobile && !directoryOpen)) return;
      const container = nav.closest(mobile ? '.reading-sidebar-content' : 'aside');
      const current = nav.querySelector('.library-directory-entries [aria-current="page"]') || nav.querySelector('[aria-current="page"]');
      if (!container || !current || !container.clientHeight) return;
      const bounds = container.getBoundingClientRect(), item = current.getBoundingClientRect();
      const top = bounds.top + 12, bottom = bounds.bottom - 12;
      if (item.top < top || item.height > bottom - top) container.scrollTop += item.top - top;
      else if (item.bottom > bottom) container.scrollTop += item.bottom - bottom;
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.id, selectedChapter?.id, overview, directoryOpen, corpus]);

  useEffect(() => {
    const onStorage = event => { if (event.key === 'better-life:saved' || event.key === null) setSaved(initialSaved()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const visit = (href, state = null) => {
    focusNext.current = true;
    if (href !== location.pathname + location.search + location.hash) history.pushState(state, '', href);
    syncRoute();
  };
  const changeFilters = patch => visit(guideLocationHref(location.pathname, { ...filters, ...patch }));
  const linkHandler = (href, state = null) => event => { if (localPageLink(event)) { event.preventDefault(); visit(href, state); } };
  const openEntry = entry => {
    const href = entryLocationHref(location.pathname, entry);
    const back = location.pathname + location.search + location.hash;
    return { href, onClick: linkHandler(href, { libraryPageReturn: active ? returnHref.current : back, libraryPageReturnLimit: active ? returnLimit.current : limit }) };
  };
  const showMore = () => {
    const next = Math.min(limit + pageSize, found.length);
    history.replaceState({ ...history.state, libraryPageLimit: next }, '', location.pathname + location.search + location.hash);
    setLimit(next);
  };
  const toggleSaved = entry => {
    const next = new Set(saved);
    if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
    setSaved(next);
    const message = next.has(entry.id) ? '已收藏，在“我的收藏”里随时查看。' : '已取消收藏。';
    try { localStorage.setItem('better-life:saved', JSON.stringify([...next])); setNotice(message); return message; }
    catch { const failed = '本次收藏已更新；浏览器不允许保存，刷新后可能丢失。'; setNotice(failed); return failed; }
  };

  const allHref = guideLocationHref(location.pathname, blank);
  const backHref = returnHref.current || guideLocationHref(location.pathname, { ...blank, chapter: filters.chapter });
  const backState = active ? { libraryPageLimit: returnLimit.current } : null;
  const chapterHref = guideLocationHref(location.pathname, { ...blank, chapter: filters.chapter });
  const returningToSearch = returnHref.current && !!new URL(returnHref.current, location.origin).searchParams.get('q');
  const title = active?.title || selectedChapter?.title || (filters.saved ? '我的收藏' : filters.free ? '不花钱的建议' : filters.q ? '搜索结果' : '高性价比人生指南');

  const directory = <>
    <div className="library-directory-heading"><h2>章节目录</h2><span>{corpus?.chapters.length || 34} 个主题</span></div>
    <nav ref={directoryNav} className="library-directory-nav" aria-label="指南章节">
      <SidebarLink link={{ label: '全部章节', href: allHref, icon: <IconBook2 size={18} aria-hidden="true"/> }} className={!selectedChapter && !hasFilters && !active ? 'is-current' : ''} aria-current={overview ? 'page' : undefined} onClick={linkHandler(allHref)}><small>{entries.length || 650}</small></SidebarLink>
      {corpus?.chapters.map(chapter => {
        const current = chapter.id === selectedChapter?.id;
        const href = guideLocationHref(location.pathname, { ...filters, chapter: String(chapter.id), q: '' });
        return <div className="library-directory-chapter" key={chapter.id}>
          <SidebarLink link={{ label: `${chapter.id}. ${chapter.title}`, href }} className={current ? 'is-current' : ''} aria-current={current && !active ? 'page' : undefined} aria-expanded={current} aria-controls={`chapter-entries-${chapter.id}`} onClick={linkHandler(href)}>
            <small>{chapter.entries.length}</small><IconChevronRight size={15} className={current ? 'is-open' : ''} aria-hidden="true"/>
          </SidebarLink>
          {current && <ol className="library-directory-entries" id={`chapter-entries-${chapter.id}`} aria-label={`${chapter.title}的条目`}>{chapter.entries.map(entry => <li key={entry.id}>
            <SidebarLink link={{ label: entry.title, ...openEntry(entry) }} {...openEntry(entry)} className={active?.id === entry.id ? 'is-current' : ''} aria-label={`第 ${entry.number} 条：${entry.title}`} aria-current={active?.id === entry.id ? 'page' : undefined}><span className="library-directory-entry-number" aria-hidden="true">{entry.number}</span></SidebarLink>
          </li>)}</ol>}
        </div>;
      })}
    </nav>
    <div className="library-directory-shortcuts"><a href={`${base}?view=guides`}>我的指南<IconArrowRight size={13} aria-hidden="true"/></a><a href={`${base}?view=pricing`}>会员方案<IconArrowRight size={13} aria-hidden="true"/></a></div>
    <div className="library-directory-footer"><IconBookmark size={15} aria-hidden="true"/><span>全部原文，免费阅读。</span></div>
  </>;

  return <MotionConfig reducedMotion="user"><div className="library-page">
    <a className="skip-link" href="#library-reading-main" onClick={event => { event.preventDefault(); (heading.current || document.getElementById('library-reading-main'))?.focus(); }}>跳到指南内容</a>
    <Navbar className="library-navbar"><NavBody className="library-navbar-body">
      <a className="brand library-brand" href={base} aria-label="Better Life 首页"><img src={`${base}media/brand.webp`} width="36" height="36" alt=""/><span><b>BETTER LIFE</b><small>高性价比人生指南</small></span></a>
      <form className="library-header-search" role="search" aria-label="搜索指南" onSubmit={event => { event.preventDefault(); changeFilters({ q: query.trim(), chapter: '' }); }}>
        <Label htmlFor="library-query" className="sr-only">搜索原书条目</Label><IconSearch size={19} aria-hidden="true"/>
        <Input id="library-query" type="search" maxLength={120} placeholder="搜索建议：离职、押金、睡眠……" value={query} onChange={event => setQuery(event.target.value)}/>
        <NavbarButton as="button" type="submit" className="library-search-submit" variant="secondary">搜索</NavbarButton>
      </form>
      <nav className="library-header-actions" aria-label="网站导航"><NavbarButton href={base} variant="secondary" className="library-home-link"><IconHome size={18} aria-hidden="true"/><span>首页提问</span></NavbarButton><NavbarButton href={`${base}?view=guides`} variant="secondary" className="library-my-guides">我的指南</NavbarButton><NavbarButton href={`${base}?view=pricing`} variant="secondary" className="library-pricing-link">会员方案</NavbarButton><NavbarButton as="button" type="button" className="outline-button library-account" onClick={openAccount}>{me?.user ? '我的账户' : '登录'}</NavbarButton></nav>
    </NavBody></Navbar>
    <div className="library-page-layout"><Sidebar open={directoryOpen} setOpen={setDirectoryOpen} animate={false}><SidebarBody className="library-page-sidebar">{directory}</SidebarBody></Sidebar>
      <main className="library-reading-main" id="library-reading-main" tabIndex={-1} aria-busy={!corpus && !loadError}>
        {loadError ? <div className="library-page-empty" role="alert"><IconBook2 size={30} aria-hidden="true"/><h1 ref={heading} tabIndex={-1}>指南暂时没加载成功</h1><p>可以重新加载，或直接阅读章节原文。</p><div><NavbarButton as="button" type="button" className="coral-button" onClick={() => setReload(value => value + 1)}>重新加载</NavbarButton><NavbarButton href="https://github.com/Fangx-AI/better-life/tree/main/library/book" className="outline-button" target="_blank" rel="noopener noreferrer">到 GitHub 阅读</NavbarButton></div></div> : !corpus ? <div className="library-page-loading" role="status"><IconBook2 size={27} aria-hidden="true"/><p>正在打开指南……</p></div> : <>
          <div className="library-reading-topline"><a href={active ? backHref : allHref} onClick={linkHandler(active ? backHref : allHref, backState)} className="library-breadcrumb"><IconArrowLeft size={16} aria-hidden="true"/>{active ? returningToSearch ? '返回搜索结果' : '返回条目列表' : selectedChapter || hasFilters ? '全部章节' : `${corpus.chapters.length} 个主题 · ${entries.length} 条建议`}</a><div className="library-reading-topline-actions">{active && <a href={chapterHref} onClick={linkHandler(chapterHref)} className="library-breadcrumb">回到本章</a>}<NavbarButton href={pdf} variant="secondary" className="library-pdf"><IconDownload size={16} aria-hidden="true"/>下载 PDF</NavbarButton></div></div>
          {missingEntry && <p className="library-page-notice" role="status">这条建议不存在。可以从目录重新选择。</p>}
          <header className={`library-content-heading${active ? ' is-reading' : ''}`}>
            {selectedChapter && <p className="library-chapter-kicker">第 {selectedChapter.id} 章{active ? ` · 第 ${active.number} 条` : ''}</p>}
            <h1 ref={heading} tabIndex={-1}>{title}</h1>
            {!active && <p>{overview ? '选择一个主题，找到眼前用得上的建议。' : filters.q ? `关于“${filters.q}”的原书建议` : selectedChapter ? `本章共 ${selectedChapter.entries.length} 条建议，点开查看完整内容。` : filters.saved ? '收藏过的建议，留在这里慢慢看。' : '从不花钱的做法开始。'}</p>}
          </header>
          {active ? <>
            <article className="library-entry-reader" aria-label={`完整条目：${active.title}`}><TracingBeam className="library-reading-beam"><ReaderContent key={active.id} entry={active} corpus={corpus} saved={saved} onToggleSaved={toggleSaved}/></TracingBeam></article>
            <nav className="library-entry-pagination" aria-label="前后条目">{activeIndex > 0 ? <a {...openEntry(chapterEntries[activeIndex - 1])}><span><IconArrowLeft size={15} aria-hidden="true"/>上一条</span><b>{chapterEntries[activeIndex - 1].title}</b></a> : <div/>}{activeIndex >= 0 && activeIndex < chapterEntries.length - 1 ? <a {...openEntry(chapterEntries[activeIndex + 1])}><span>下一条<IconArrowRight size={15} aria-hidden="true"/></span><b>{chapterEntries[activeIndex + 1].title}</b></a> : <div/>}</nav>
            <div className="library-ask-again"><IconBook2 size={21} aria-hidden="true"/><div><b>想知道怎样用在自己的情况里？</b><p>回到首页，结合原书直接提问。</p></div><NavbarButton href={base} className="outline-button">去提问<IconArrowRight size={17} aria-hidden="true"/></NavbarButton></div>
          </> : <>
            <div className="library-page-filters"><Tabs tabs={[{ title: '全部建议', value: 'all' }, { title: '不花钱', value: 'free' }, { title: `我的收藏${saved.size ? ` · ${saved.size}` : ''}`, value: 'saved' }]} value={quickValue} onChange={value => changeFilters({ free: value === 'free', saved: value === 'saved' })}/>{hasFilters && <NavbarButton as="button" type="button" className="library-clear-filters" variant="secondary" onClick={() => changeFilters({ ...blank, chapter: filters.chapter })}><IconX size={15} aria-hidden="true"/>清除筛选</NavbarButton>}</div>
            {notice && <p className="library-page-notice" role="status">{notice}</p>}
            {overview ? <BentoGrid className="library-chapter-grid">{corpus.chapters.map(chapter => {
              const href = guideLocationHref(location.pathname, { ...blank, chapter: String(chapter.id) });
              return <BentoGridItem as="a" href={href} onClick={linkHandler(href)} key={chapter.id} aria-label={`${chapter.title}，${chapter.entries.length} 条建议`} className="library-chapter-card" header={<div className="library-chapter-card-top"><span>第 {chapter.id} 章</span><small>{chapter.entries.length} 条</small></div>} title={<h2>{chapter.title}<IconArrowRight size={18} aria-hidden="true"/></h2>} description={<p>{chapter.entries.slice(0, 2).map(entry => entry.title).join(' · ')}</p>}/>;
            })}</BentoGrid> : <>
              <p className="library-result-count" role="status">{found.length ? `找到 ${found.length} 条建议 · 已显示 ${Math.min(limit, found.length)} 条` : '没有符合条件的建议'}</p>
              <div className="library-entry-list">{found.slice(0, limit).map(entry => <article className="library-entry-card" key={entry.id}>
                <a className="library-entry-card-link" {...openEntry(entry)}><div className="library-entry-card-meta">{!selectedChapter && <span>{corpus.chapters.find(chapter => chapter.id === entry.chapter)?.title}</span>}<span>第 {entry.number} 条</span>{entry.tags['钱'] === '0' && <span className="library-entry-free">不花钱</span>}</div><h2>{entry.title}<IconArrowRight size={18} aria-hidden="true"/></h2><p>{readerText(entry.summary)}</p></a>
                <NavbarButton as="button" type="button" variant="secondary" className={`library-entry-save${saved.has(entry.id) ? ' is-saved' : ''}`} aria-label={`${saved.has(entry.id) ? '取消收藏' : '收藏'}：${entry.title}`} aria-pressed={saved.has(entry.id)} onClick={() => toggleSaved(entry)}>{saved.has(entry.id) ? <IconCheck size={17} aria-hidden="true"/> : <IconHeart size={17} aria-hidden="true"/>}<span>{saved.has(entry.id) ? '已收藏' : '收藏'}</span></NavbarButton>
              </article>)}</div>
              {!found.length && <div className="library-page-empty"><IconSearch size={29} aria-hidden="true"/><h2>{filters.saved ? '还没有符合条件的收藏' : '换个关键词试试'}</h2><p>{filters.saved ? '打开建议后点“收藏”，就能在这里找到。' : '可以试试“离职”“押金”，或者清除筛选。'}</p><NavbarButton as="button" type="button" className="outline-button" onClick={() => changeFilters({ ...blank, chapter: filters.chapter })}>清除筛选</NavbarButton></div>}
              {found.length > limit && <div className="library-list-more"><NavbarButton as="button" type="button" className="outline-button" onClick={showMore}>再看 {Math.min(pageSize, found.length - limit)} 条<IconArrowRight size={17} aria-hidden="true"/></NavbarButton><span>还有 {found.length - limit} 条</span></div>}
            </>}
          </>}
          <footer className="library-reading-footer"><span>650 条建议 · 34 个主题</span><a href={`${base}content-source.html`}>内容来源</a></footer>
        </>}
      </main>
    </div>
  </div></MotionConfig>;
}
