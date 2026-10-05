import { useEffect, useState } from 'react';
import { IconSearch, IconArrowRight, IconBook2, IconMessageCircle, IconHome } from '@tabler/icons-react';
import { NavbarButton } from './ui/resizable-navbar';
import { TracingBeam } from './ui/tracing-beam';
import { validateQaResponse } from '../lib/qa-response.mjs';
import { readerText } from '../lib/reader-text.mjs';
import { QaNotice } from './qa-notice';
import { PUBLIC_ONLY } from '../lib/public-mode.mjs';
import { guideLocationHref } from '../lib/guide-location.mjs';

export function AnswerShowcase({ corpus, onOpen, onAsk }) {
  const [example, setExample] = useState(null), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!corpus) return;
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}qa-example.json`, { signal: controller.signal }).then(r => { if (!r.ok) throw Error(); return r.json(); }).then(d => setExample(validateQaResponse(d, corpus))).catch(() => {});
    return () => controller.abort();
  }, [corpus]);
  const fallback = corpus?.chapters.find(c => c.id === 15)?.entries.find(e => e.id === '15-1');
  return <section id="answer-example" className="answer-showcase page-width" aria-labelledby="answer-showcase-title">
    <div className="showcase-heading"><h2 id="answer-showcase-title">你的问题，<br />有迹可循。</h2><p>把相关建议找出来，<br />每一步都能回到原文。</p>{PUBLIC_ONLY ? <NavbarButton href={guideLocationHref(import.meta.env.BASE_URL)} className="outline-button">查看指南<IconArrowRight size={18}/></NavbarButton> : <NavbarButton as="button" className="outline-button" onClick={() => onAsk('')}>问个自己的问题 <IconArrowRight size={18} /></NavbarButton>}</div>
    <div className="answer-exhibit">
      <div className="exhibit-source"><div><IconHome size={23} /><b>租房与买房</b></div>{(example?.sources || (fallback ? [fallback] : [])).map((entry, i) => <NavbarButton as="button" variant="secondary" key={entry.id} onClick={() => onOpen(entry)}><IconBook2 size={16} /><span>{entry.title}</span><IconArrowRight size={15} /></NavbarButton>)}</div>
      <article className="exhibit-answer"><div className="exhibit-question"><IconSearch size={21} /><span>房东不退押金怎么办？</span>{PUBLIC_ONLY ? <NavbarButton href={guideLocationHref(import.meta.env.BASE_URL, { chapter: '15' })} className="icon-button" aria-label="查看租房相关建议"><IconArrowRight size={19}/></NavbarButton> : <NavbarButton as="button" className="icon-button" aria-label="试着问这个问题" onClick={() => onAsk('房东不退押金怎么办？')}><IconArrowRight size={19} /></NavbarButton>}</div><p className="exhibit-label"><IconMessageCircle size={15} /> 回答示例</p>
        {example ? <><TracingBeam className="exhibit-steps">{example.answer.steps.slice(0, expanded ? undefined : 3).map((step, index) => <div className="exhibit-step" key={index}><span className="step-number">{index + 1}</span><div><h3>{readerText(step.title)}</h3><p>{readerText(step.detail)}</p></div></div>)}</TracingBeam><NavbarButton as="button" variant="secondary" className="exhibit-expand" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>{expanded ? '收起回答' : '展开完整回答'} <IconArrowRight size={15} /></NavbarButton>{expanded && <QaNotice value={example.answer.caveat}/>}</> : <p className="exhibit-fallback">{fallback ? readerText(fallback.summary) : '正在加载建议……'}</p>}
        <div className="exhibit-reference"><p>参考原文</p><NavbarButton as="button" variant="secondary" disabled={!fallback} onClick={() => fallback && onOpen(fallback)}><IconBook2 size={25} /><span><b>押金的数额、退还时间和扣减情形</b><small>《租房与买房》 · 第 1 条</small></span><IconArrowRight size={17} /></NavbarButton></div>
      </article>
    </div>
  </section>;
}
