import { useEffect, useRef, useState, useCallback, useId } from 'react';
import { IconArrowRight, IconBook2, IconChevronDown, IconMessageCircle, IconPlus, IconRefresh, IconX } from '@tabler/icons-react';
import { PlaceholdersAndVanishInput } from './ui/placeholders-and-vanish-input';
import { NavbarButton } from './ui/resizable-navbar';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ExpandableCards } from './ui/expandable-card';
import { TracingBeam } from './ui/tracing-beam';
import { validateQaResponse } from '../lib/qa-response.mjs';
import { buildQaPayload } from '../../shared/qa-history.mjs';
import { readerText } from '../lib/reader-text.mjs';
import { SaveAnswer } from './save-answer';
import { QaNotice } from './qa-notice';
import { useMembership } from './membership/membership-context.jsx';
import { createQaRequestGate, previewQaStep } from '../lib/qa-request-gate.mjs';
import { sendConversationQuestion } from '../lib/qa-conversation-request.mjs';
import { guideLocationHref } from '../lib/guide-location.mjs';
import '../qa-polish.css';

const placeholders = ['直接问：房东不退押金，我该怎么办？', '直接问：准备离职，哪些材料要先留下？', '直接问：最近总是睡不着，怎么调整？'];
const examples = ['房东不退押金怎么办？', '离职前要准备什么？', '总是睡不着怎么办？'];
const api = import.meta.env.VITE_QA_API_URL?.replace(/\/$/, '') || `${import.meta.env.BASE_URL}api/ask`;
const motionBehavior = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';

function AnswerStep({ step, index }) {
  const { preview, remainder } = previewQaStep(readerText(step.detail));
  return <div className="qa-step"><span className="qa-step-number" aria-hidden="true">{index + 1}</span><div className="qa-step-copy"><h3>{readerText(step.title)}</h3><p>{preview}</p>{remainder && <details className="qa-step-detail"><summary>展开做法 <IconChevronDown size={15} aria-hidden="true" /></summary><p>{remainder}</p></details>}</div></div>;
}

function ConversationAnswer({ turn, renderSource }) {
  const [active, setActive] = useState(null);
  const { question, result } = turn;
  const close = useCallback(() => setActive(null), []);
  const cards = result.sources.map(entry => ({ ...entry, displayTitle: readerText(entry.title), displayDescription: `${entry.chapterTitle} · 第 ${entry.number} 条`, icon: <IconBook2 size={24} /> }));
  const intro = previewQaStep(readerText(result.answer.intro));
  const steps = result.answer.steps;
  return <div className="qa-result">
    <TracingBeam className="qa-answer"><div className="qa-intro"><p>{intro.preview}</p>{intro.remainder && <details className="qa-step-detail"><summary>展开说明 <IconChevronDown size={15} aria-hidden="true" /></summary><p>{intro.remainder}</p></details>}</div>{steps.slice(0, 3).map((step, index) => <AnswerStep step={step} index={index} key={index} />)}{steps.length > 3 && <details className="qa-more-steps"><summary><span>后续步骤：{steps.slice(3).map(step => readerText(step.title)).join('、')}</span><IconChevronDown size={16} aria-hidden="true" /></summary>{steps.slice(3).map((step, index) => <AnswerStep step={step} index={index + 3} key={index + 3} />)}</details>}</TracingBeam>
    <QaNotice value={result.answer.caveat} />
    {cards.length > 0 && <details className="qa-sources"><summary><span><IconBook2 size={18} aria-hidden="true" /> 查看 {cards.length} 条原文</span><IconChevronDown size={18} aria-hidden="true" /></summary><ExpandableCards cards={cards} active={active} onOpen={setActive} onClose={close} renderContent={renderSource} /></details>}
    <SaveAnswer question={question} result={result} />
  </div>;
}

export function GuideQuestion({ corpus, loadError, renderSource, onResult, questionRequest }) {
  const { me, openAccount, refresh, status: membershipStatus } = useMembership();
  const owner = me?.user?.id || '', ownerRef = useRef(owner), previousOwner = useRef(owner);
  ownerRef.current = owner;
  const retryKey = useRef(null), turnsRef = useRef([]);
  const [conversationOwner, setConversationOwner] = useState(owner);
  const [draft, setDraft] = useState(''), [followup, setFollowup] = useState('');
  const [question, setQuestion] = useState(''), [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(null), panel = useRef(null), pendingPanel = useRef(null), lastRequested = useRef(null);
  const followupId = useId();
  if (!gate.current) gate.current = createQaRequestGate();
  // 身份变更当帧也不显示旧账号对话；匿名开始的内容可随主动登录保留。
  const canViewConversation = !conversationOwner || conversationOwner === owner;
  const visibleTurns = canViewConversation ? turns : [];
  const clearConversation = useCallback(() => {
    gate.current.cancel('new-conversation'); retryKey.current = null; turnsRef.current = [];
    setTurns([]); setDraft(''); setFollowup(''); setQuestion(''); setBusy(false); setError(''); setConversationOwner(ownerRef.current);
    onResult?.([]);
  }, [onResult]);
  const focusQuestion = () => {
    const input = document.getElementById('query');
    input?.scrollIntoView({ behavior: motionBehavior(), block: 'center' }); input?.focus({ preventScroll: true });
  };
  const newConversation = () => {
    if ((turnsRef.current.length || busy) && !window.confirm('开始新的对话？没有收进指南的回答会从当前页面清除。')) return;
    clearConversation(); focusQuestion();
  };

  useEffect(() => () => gate.current.cancel('unmounted'), []);
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== owner) clearConversation();
    else if (owner && !conversationOwner) setConversationOwner(owner);
    previousOwner.current = owner;
  }, [owner, conversationOwner, clearConversation]);

  const ask = useCallback(async value => {
    const text = value.trim();
    if (!text || !corpus || loadError) return;
    const request = gate.current.begin(), signal = request.controller.signal, requestOwner = ownerRef.current;
    setConversationOwner(requestOwner); setDraft(text); setFollowup(''); setQuestion(text); setError(''); setBusy(true);
    requestAnimationFrame(() => {
      if (gate.current.isCurrent(request)) (pendingPanel.current || panel.current)?.scrollIntoView({ behavior: motionBehavior(), block: 'nearest' });
    });
    try {
      const payload = buildQaPayload(text, turnsRef.current);
      const signature = JSON.stringify(payload);
      if (!retryKey.current || retryKey.current.signature !== signature) retryKey.current = { signature, id: crypto.randomUUID() };
      payload.requestId = retryKey.current.id;
      const { response, data, requestId } = await sendConversationQuestion(api, payload, { signal,
        isCurrent: () => gate.current.isCurrent(request) && ownerRef.current === requestOwner,
        onRequestId: id => { if (retryKey.current?.signature === signature) retryKey.current.id = id; },
      });
      if (!gate.current.isCurrent(request) || ownerRef.current !== requestOwner) return;
      signal.throwIfAborted();
      if (!response.ok) {
        if (['login_required', 'quota_exhausted'].includes(data?.error?.code)) openAccount();
        if (data?.error?.code !== 'request_pending') retryKey.current = null;
        throw new Error(data?.error?.message || '暂时没能回答，请再试一次。');
      }
      const result = validateQaResponse(data, corpus);
      const turn = { id: requestId, question: text, result };
      turnsRef.current = [...turnsRef.current, turn].slice(-20); setTurns(turnsRef.current);
      setDraft(''); setQuestion(''); onResult?.(result.sources.map(entry => entry.id)); retryKey.current = null;
      if (membershipStatus.enforced) refresh();
      requestAnimationFrame(() => document.getElementById(followupId)?.focus({ preventScroll: true }));
    } catch (value) {
      if (!gate.current.isCurrent(request) || ownerRef.current !== requestOwner) return;
      setError(signal.aborted && signal.reason === 'timeout' ? '这次等得有点久，可以再试一次。' : value.message || '连接失败，请再试一次。');
    } finally { if (gate.current.finish(request)) setBusy(false); }
  }, [corpus, loadError, onResult, openAccount, refresh, membershipStatus.enforced, followupId]);

  useEffect(() => {
    if (!questionRequest || lastRequested.current === questionRequest) return;
    if (questionRequest.text.trim() && (!corpus || loadError)) return;
    const frame = requestAnimationFrame(() => {
      lastRequested.current = questionRequest;
      document.getElementById('hero-title')?.scrollIntoView({ behavior: motionBehavior() });
      if (questionRequest.text.trim()) ask(questionRequest.text); else focusQuestion();
    });
    return () => cancelAnimationFrame(frame);
  }, [questionRequest, corpus, loadError, ask]);

  const stop = () => { gate.current.cancel(); setBusy(false); setError('已停止。之前的回答还在，可以修改问题或再试一次。'); };
  return <div className="guide-question">
    <PlaceholdersAndVanishInput placeholders={placeholders} descriptionId={undefined} inputValue={canViewConversation ? draft : ''} disabled={!corpus || loadError} busy={busy && canViewConversation} onChange={event => setDraft(event.target.value)} onSubmit={() => ask(draft)} />
    <div className="question-examples" aria-label="试着问一问">{examples.map(text => <NavbarButton key={text} as="button" type="button" variant="secondary" disabled={busy || !corpus || loadError} onClick={() => ask(text)}>{text}</NavbarButton>)}</div>
    {canViewConversation && (busy || visibleTurns.length > 0 || error) && <section className="qa-panel qa-conversation" ref={panel} aria-labelledby="qa-title">
      <div className="qa-heading"><h2 id="qa-title"><IconMessageCircle size={20} /> 当前对话</h2><NavbarButton as="button" type="button" variant="secondary" onClick={newConversation}><IconPlus size={17} /> 新对话</NavbarButton></div>
      <div className="qa-transcript">{visibleTurns.map((turn, index) => <article className="qa-conversation-turn" key={turn.id} aria-label={`第 ${index + 1} 轮问答`}><h3 className="qa-user-question">{turn.question}</h3><ConversationAnswer turn={turn} renderSource={renderSource} /></article>)}</div>
      {(busy || error) && <div className="qa-pending" ref={pendingPanel}><h3 className="qa-user-question">{question}</h3>{busy && <div className="qa-progress" role="status"><p>正在结合原文整理……</p><NavbarButton as="button" type="button" variant="secondary" onClick={stop}><IconX size={17} /> 停止</NavbarButton></div>}{error && <div className="qa-error" role="alert"><p>{error}</p><div className="qa-error-actions"><NavbarButton as="button" type="button" className="outline-button" onClick={() => ask(question)}><IconRefresh size={18} /> 再试一次</NavbarButton><NavbarButton href={guideLocationHref(import.meta.env.BASE_URL, {})} variant="secondary">先读指南</NavbarButton></div></div>}</div>}
      {visibleTurns.length > 0 && <form className="qa-followup" aria-label="继续这次对话" onSubmit={event => { event.preventDefault(); if (!busy && followup.trim()) ask(followup); }}>
        <Label htmlFor={followupId}>接着问</Label><div className="qa-followup-controls"><Input id={followupId} aria-label="继续提问" value={followup} placeholder="例如：第二步具体怎么做？" maxLength={500} autoComplete="off" disabled={busy || !corpus || loadError} onChange={event => setFollowup(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} /><NavbarButton as="button" type="submit" className="coral-button" disabled={busy || !followup.trim() || !corpus || loadError}>发送<IconArrowRight size={18} /></NavbarButton></div><p>有用的回答，可以收进自己的指南。</p>
      </form>}
    </section>}
  </div>;
}
