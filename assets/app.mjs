import { matchesEntry, plainText } from './search.mjs';

const $ = id => document.getElementById(id);
const controls = ['query', 'chapter', 'grade', 'free', 'saved'];
const params = new URLSearchParams(location.search);
let entries = [], chapters = [], limit = 12, saved = new Set();
try {
  const stored = JSON.parse(localStorage.getItem('better-life:saved') || '[]');
  if (Array.isArray(stored)) saved = new Set(stored.filter(id => typeof id === 'string'));
} catch { /* 不支持存储时仍可使用本次会话的收藏。 */ }
const state = { q: (params.get('q') || '').slice(0, 120), chapter: params.get('chapter') || '', grade: params.get('grade') || '', free: params.get('free') === '1', saved: params.get('saved') === '1' };

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function syncUrl() {
  const search = new URLSearchParams();
  for (const key of ['q', 'chapter', 'grade']) if (state[key]) search.set(key, state[key]);
  for (const key of ['free', 'saved']) if (state[key]) search.set(key, '1');
  const hash = location.hash.startsWith('#entry-') ? '#library' : location.hash;
  history.replaceState(null, '', `${location.pathname}${search.size ? '?' + search : ''}${hash}`);
}
function readControls() {
  state.q = $('query').value;
  state.chapter = $('chapter').value;
  state.grade = $('grade').value;
  state.free = $('free').checked;
  state.saved = $('saved').checked;
}
function fillControls() {
  $('query').value = state.q;
  $('chapter').value = state.chapter;
  $('grade').value = state.grade;
  $('free').checked = state.free;
  $('saved').checked = state.saved;
}
function field(label, value, linkify = false) {
  const dt = element('dt', '', label), dd = element('dd');
  if (!linkify) dd.textContent = plainText(value);
  else {
    // 使用 DOM 和 textContent，不把上游文字注入 HTML。
    const text = plainText(value);
    const regex = /https?:\/\/[^\s<>\]\)）。，；]+/g;
    let end = 0;
    for (const match of text.matchAll(regex)) {
      dd.append(document.createTextNode(text.slice(end, match.index)));
      const a = element('a', '', match[0]);
      a.href = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; dd.append(a);
      end = match.index + match[0].length;
    }
    dd.append(document.createTextNode(text.slice(end)));
  }
  return [dt, dd];
}
function entryCard(e) {
  const card = element('article', 'entry'); card.id = `entry-${e.id}`;
  const top = element('div', 'entry-top');
  const c = chapters.find(c => c.id === e.chapter);
  top.append(element('span', 'entry-meta', `${c.title} · 第 ${e.number} 条 · 证据 ${e.grade}`));
  const save = element('button', 'save', saved.has(e.id) ? '已收藏' : '收藏');
  save.type = 'button'; save.setAttribute('aria-pressed', String(saved.has(e.id)));
  save.setAttribute('aria-label', `收藏：${e.title}`);
  save.addEventListener('click', () => {
    if (saved.has(e.id)) saved.delete(e.id); else saved.add(e.id);
    try { localStorage.setItem('better-life:saved', JSON.stringify([...saved])); } catch { /* 会话收藏仍然可用。 */ }
    if (state.saved) render();
    else { save.textContent = saved.has(e.id) ? '已收藏' : '收藏'; save.setAttribute('aria-pressed', String(saved.has(e.id))); }
  });
  top.append(save); card.append(top, element('h3', '', plainText(e.title)), element('p', 'entry-summary', plainText(e.summary)));
  const details = element('details'); details.append(element('summary', '', '看成本、收益和出处'));
  const dl = element('dl');
  for (const [label, value, links] of [['成本', e.cost], ['收益（原文）', e.benefit], ['证据等级', e.gradeText || e.grade], ['来源', e.sources, true], ['备注与适用条件', e.notes]]) if (value) dl.append(...field(label, value, links));
  details.append(dl); card.append(details);
  const source = element('a', 'source-link', '阅读这一章原文 ↗');
  source.href = `https://github.com/Fangx-AI/better-life/blob/main/library/book/${encodeURIComponent(c.file)}`;
  source.target = '_blank'; source.rel = 'noopener'; card.append(source);
  const share = element('a', 'source-link', '本条链接 ↗');
  const query = new URLSearchParams({ chapter: String(e.chapter) });
  share.href = `${location.pathname}?${query}#entry-${e.id}`; share.style.marginLeft = '18px'; card.append(share);
  return card;
}
function render() {
  const found = entries.filter(e => matchesEntry(e, state, saved));
  $('result-status').textContent = `找到 ${found.length} 条 · 已显示 ${Math.min(limit, found.length)} 条 · 全书 ${entries.length} 条`;
  const fragment = document.createDocumentFragment();
  for (const e of found.slice(0, limit)) fragment.append(entryCard(e));
  if (!found.length) fragment.append(element('div', 'empty', state.saved ? '还没有符合条件的收藏。先收藏几条，或清除筛选条件。' : '没有找到。试试更短的关键词，或重置筛选。'));
  $('results').replaceChildren(fragment); $('more').hidden = found.length <= limit;
}
function update() { readControls(); limit = 12; syncUrl(); render(); }
let timer;
$('query').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 180); });
for (const id of controls.slice(1)) $(id).addEventListener('change', update);
$('search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(timer); update(); });
$('more').addEventListener('click', () => { limit += 12; render(); });
$('clear').addEventListener('click', () => { Object.assign(state, { q: '', chapter: '', grade: '', free: false, saved: false }); limit = 12; fillControls(); syncUrl(); render(); });
for (const scene of document.querySelectorAll('[data-chapter]')) scene.addEventListener('click', event => {
  event.preventDefault();
  Object.assign(state, { q: '', chapter: scene.dataset.chapter, grade: '', free: false, saved: false });
  limit = 12; fillControls(); history.replaceState(null, '', '#library'); syncUrl(); render(); $('library').scrollIntoView();
});
fillControls();
try {
  const res = await fetch('assets/content.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const corpus = await res.json();
  chapters = corpus.chapters; entries = chapters.flatMap(c => c.entries);
  for (const c of chapters) { const option = element('option', '', `${c.id}. ${c.title}`); option.value = c.id; $('chapter').append(option); }
  if (!chapters.some(c => String(c.id) === state.chapter)) state.chapter = '';
  if (!['A', 'B', 'C'].includes(state.grade)) state.grade = '';
  $('stat-entries').textContent = corpus.counts.entries; $('stat-chapters').textContent = corpus.counts.chapters;
  $('snapshot-date').textContent = corpus.source.snapshotDate;
  const id = location.hash.replace('#entry-', '');
  if (location.hash.startsWith('#entry-') && entries.some(e => e.id === id)) {
    const selected = entries.find(e => e.id === id);
    Object.assign(state, { q: '', chapter: String(selected.chapter), grade: '', free: false, saved: false });
    limit = Math.max(12, chapters.find(c => c.id === selected.chapter).entries.findIndex(e => e.id === id) + 1);
  }
  fillControls(); render();
  if (location.hash.startsWith('#entry-')) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) { target.querySelector('details').open = true; requestAnimationFrame(() => target.scrollIntoView()); }
  }
} catch {
  $('result-status').textContent = '指南暂时没加载成功。刷新重试，或通过 GitHub 阅读正文。';
  const link = element('a', 'btn secondary', '直接读 Markdown 原文 ↗');
  link.href = 'https://github.com/Fangx-AI/better-life/tree/main/library/book';
  $('results').replaceChildren(link);
  for (const id of controls) $(id).disabled = true;
  $('search-form').querySelector('button').disabled = true;
  $('clear').disabled = true;
  for (const scene of document.querySelectorAll('[data-chapter]')) scene.replaceWith(scene.cloneNode(true));
}
