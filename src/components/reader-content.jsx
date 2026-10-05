import { useState } from 'react';
import { IconCheck, IconHeart, IconExternalLink, IconLink } from '@tabler/icons-react';
import { NavbarButton } from './ui/resizable-navbar';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { plainText } from '../../assets/search.mjs';
import { readerText } from '../lib/reader-text.mjs';
import { entryLocationHref } from '../lib/guide-location.mjs';

function SourceText({ value }) {
  const text = plainText(value), parts = [], regex = /https?:\/\/[^\s<>\]\)）。，；]+/g;
  let end = 0;
  for (const m of text.matchAll(regex)) { parts.push(text.slice(end, m.index)); parts.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>); end = m.index + m[0].length; }
  parts.push(text.slice(end)); return <>{parts}</>;
}

export function ReaderContent({ entry, corpus, saved, onToggleSaved }) {
  const [notice, setNotice] = useState(''), [shareVisible, setShareVisible] = useState(false);
  const chapter = corpus.chapters.find(c => c.id === entry.chapter);
  const href = entryLocationHref(location.pathname, entry), absolute = new URL(href, location.origin).href;
  const copy = async () => {
    try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(absolute); setNotice('链接已复制'); setShareVisible(false); }
    catch { setShareVisible(true); setNotice('选中链接即可复制'); }
  };
  return <>
    <p className="reader-meta">{chapter.title} · 第 {entry.number} 条</p>
    <p className="reader-summary">{readerText(entry.summary)}</p>
    <div className="reader-actions">
      <NavbarButton as="button" type="button" className={saved.has(entry.id) ? 'coral-button' : 'outline-button'} aria-pressed={saved.has(entry.id)} onClick={() => setNotice(onToggleSaved(entry))}>{saved.has(entry.id) ? <IconCheck size={19} /> : <IconHeart size={19} />} {saved.has(entry.id) ? '已收藏' : '收藏这条'}</NavbarButton>
      <NavbarButton href={`https://github.com/Fangx-AI/better-life/blob/main/library/book/${encodeURIComponent(chapter.file)}`} target="_blank" rel="noopener noreferrer" className="outline-button"><IconExternalLink size={18} /> 章节原文</NavbarButton>
      <NavbarButton as="button" type="button" className="outline-button" onClick={copy}><IconLink size={18} /> 复制链接</NavbarButton>
    </div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {shareVisible && <div className="reader-share"><Label htmlFor={`share-${entry.id}`}>本条链接</Label><Input id={`share-${entry.id}`} readOnly value={absolute} onFocus={e => e.target.select()} onClick={e => e.currentTarget.select()} /></div>}
    <dl className="reader-fields">{[['成本', entry.cost], ['收益（原文）', entry.benefit], ['备注与适用条件', entry.notes], ['来源', entry.sources]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === '来源' ? <SourceText value={value} /> : readerText(value)}</dd></div>)}</dl>
  </>;
}
