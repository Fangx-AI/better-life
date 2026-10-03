import { useEffect, useRef, useState, useId } from 'react';
import { IconBook2, IconCheck, IconCopy, IconX } from '@tabler/icons-react';
import { useMembership } from './membership/membership-context.jsx';
import { membershipRequest } from '../lib/membership-api.mjs';
import { answerGuide } from '../lib/answer-guide.mjs';
import { isCurrentGuideOwner } from '../lib/personal-guide-api.mjs';
import { NavbarButton } from './ui/resizable-navbar';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function SaveAnswer({ question, result }) {
  const formId = useId();
  const { me, openAccount, refresh } = useMembership();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [title, setTitle] = useState(''), [topic, setTopic] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [savedId, setSavedId] = useState('');
  const [guides, setGuides] = useState([]), [target, setTarget] = useState(''), [loadingGuides, setLoadingGuides] = useState(false);
  const owner = me?.user?.id || '', ownerRef = useRef(owner), previousOwner = useRef(owner), answerRef = useRef(result);
  ownerRef.current = owner; answerRef.current = result;
  useEffect(() => { setOpen(false); setPending(false); setNotice(''); setSavedId(''); setTarget(''); setGuides([]); setBusy(false); }, [question, result]);
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== owner) { setOpen(false); setPending(false); setNotice(''); setSavedId(''); setBusy(false); }
    setGuides([]); setTarget(''); previousOwner.current = owner;
  }, [owner]);
  useEffect(() => { if (pending && me?.user) { setOpen(true); setPending(false); } }, [pending, me?.user]);
  useEffect(() => {
    if (!open || !me?.user) return;
    const controller = new AbortController(), requestOwner = owner; setLoadingGuides(true);
    const current = () => isCurrentGuideOwner(ownerRef.current, requestOwner, controller.signal);
    membershipRequest('guides', { signal: controller.signal }).then(data => { if (current()) setGuides(Array.isArray(data.guides) ? data.guides : []); }).catch(error => { if (current()) setNotice(error.message); }).finally(() => { if (current()) setLoadingGuides(false); });
    return () => controller.abort();
  }, [open, me?.user?.id]);
  const prepare = () => { const guide = answerGuide(question, result); setTitle(guide.title); setTopic(guide.topic); setNotice(''); if (!me?.user) { setPending(true); openAccount(); } else setOpen(true); };
  const copy = async () => { try { const guide = answerGuide(question, result); await navigator.clipboard.writeText(`# ${guide.title}\n\n${guide.content}`); setNotice('已复制，可以放进你的笔记。'); } catch { setNotice('复制未成功，可以选中回答文字复制。'); } };
  const save = async event => {
    event.preventDefault(); if (busy) return; const requestOwner = owner, requestAnswer = result;
    const current = () => isCurrentGuideOwner(ownerRef.current, requestOwner) && answerRef.current === requestAnswer;
    setBusy(true); setNotice('');
    try {
      const guide = answerGuide(question, result);
      const existing = target ? guides.find(item => item.id === target) : null;
      if (target && !existing) throw new Error('这篇指南已改变，请重新选择。');
      const body = existing ? { revision: existing.revision, content: `${existing.content}\n\n## 本次补充：${guide.title}\n\n${guide.content}`, sourceIds: [...new Set([...existing.sourceIds, ...guide.sourceIds])], tasks: [...existing.tasks, ...guide.tasks] } : { ...guide, title: title.trim(), topic: topic.trim() };
      if (body.content.length > 12000) throw new Error('这篇指南内容较多，可以新建一篇，或到原指南中精简后再补充。');
      const data = await membershipRequest(existing ? `guides/${encodeURIComponent(existing.id)}` : 'guides', { method: existing ? 'PATCH' : 'POST', body });
      if (!current()) return;
      if (!data?.guide?.id) throw new Error('保存状态未确认，请到我的指南查看。'); setSavedId(data.guide.id); setOpen(false); setNotice('已收进你的指南，之后可以编辑、记录行动，或接着问。'); await refresh();
    }
    catch (error) { if (current()) { setNotice(error.message); if (error.status === 401) openAccount(); } }
    finally { if (current()) setBusy(false); }
  };
  if (result.status !== 'answered') return null;
  return <div className="save-answer">
    <div className="save-answer-actions"><NavbarButton as="button" type="button" className="coral-button" onClick={prepare}><IconBook2 size={18} /> 收进我的指南</NavbarButton><NavbarButton as="button" type="button" className="outline-button" onClick={copy}><IconCopy size={17} /> 复制答案</NavbarButton>{savedId && <NavbarButton href={`${import.meta.env.BASE_URL}?view=guides&guide=${encodeURIComponent(savedId)}`} className="outline-button"><IconCheck size={18} /> 打开我的指南</NavbarButton>}</div>
    {open && <form className="save-answer-form" onSubmit={save}><div className="save-answer-heading"><h3>收进哪篇指南？</h3><NavbarButton as="button" type="button" variant="secondary" aria-label="取消保存" onClick={() => setOpen(false)}><IconX size={18} /></NavbarButton></div><p>整理成可编辑的方案和行动清单，仅保存在你的账号中。</p><Label htmlFor={`${formId}-target`}>新建，或补充到已有指南</Label><select id={`${formId}-target`} value={target} disabled={busy || loadingGuides} onChange={event => setTarget(event.target.value)}><option value="">新建一篇指南</option>{guides.map(guide => <option key={guide.id} value={guide.id}>{guide.title}</option>)}</select>{target ? <p>这次回答和行动会追加到现有指南，不替换原有内容，也不修改已完成的行动。</p> : <><Label htmlFor={`${formId}-title`}>指南名称</Label><Input id={`${formId}-title`} maxLength={120} required value={title} onChange={event => setTitle(event.target.value)} /><Label htmlFor={`${formId}-topic`}>放在哪个主题？</Label><Input id={`${formId}-topic`} maxLength={80} value={topic} onChange={event => setTopic(event.target.value)} /></>}<NavbarButton as="button" type="submit" className="coral-button" disabled={busy || loadingGuides || !title.trim()}>{busy ? '正在保存…' : target ? '确认追加到这篇指南' : '保存指南'}</NavbarButton></form>}
    {notice && <p className="save-answer-notice" role="status">{notice}</p>}
  </div>;
}
