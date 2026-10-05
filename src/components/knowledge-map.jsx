import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowRight, IconPlus, IconMinus, IconFocus2, IconHome, IconBook2, IconBriefcase, IconWallet, IconHeart, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { NavbarButton } from './ui/resizable-navbar';
import { createKnowledgeLayout, createKnowledgeView, findKnowledgeNode, focusKnowledgeNode, graphGroups, isKnowledgeTap, knowledgeHubRadius } from '../lib/knowledge-layout.mjs';
import { readerText } from '../lib/reader-text.mjs';
import './graph-polish.css';

const EMPTY_IDS = [];

export function KnowledgeMap({ corpus, onOpen, highlighted = EMPTY_IDS }) {
  const [graph, setGraph] = useState(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState('15-1'), [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(null), [showRelated, setShowRelated] = useState(false), [dragging, setDragging] = useState(false);
  const canvas = useRef(null), drag = useRef(null), view = useRef(null), renderer = useRef(null), drawing = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetch(`${import.meta.env.BASE_URL}knowledge-graph.json`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw Error('graph-unavailable'); return r.json(); })
      .then(data => {
        if (!Array.isArray(data.edges) || !data.edges.every(edge => Array.isArray(edge) && edge.length === 2 && edge.every(id => typeof id === 'string')) || !Number.isInteger(data.counts?.crossReferences)) throw Error('graph-invalid');
        if (!controller.signal.aborted) setGraph(data);
      })
      .catch(e => { if (!controller.signal.aborted && e.name !== 'AbortError') setFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  const layout = useMemo(() => corpus && graph ? createKnowledgeLayout(corpus, graph.edges) : null, [corpus, graph]);
  const entry = layout?.byId.get(selected);
  const chapter = corpus?.chapters.find(c => c.id === entry?.chapter);
  const group = graphGroups.find(g => g.chapters.includes(entry?.chapter));
  const EntryIcon = { 19: IconBriefcase, 15: IconHome, 5: IconWallet, 2: IconHeart }[group?.chapter] || IconBook2;
  const related = useMemo(() => graph && layout ? [...new Set(graph.edges.flatMap(([a, b]) => a === selected ? [b] : b === selected ? [a] : []))].filter(id => layout.byId.get(id)?.type === 'entry') : EMPTY_IDS, [graph, layout, selected]);
  const highlightKey = highlighted.join('|');
  const activeHighlights = useMemo(() => layout ? [...new Set(highlightKey.split('|'))].filter(id => layout.byId.get(id)?.type === 'entry') : EMPTY_IDS, [layout, highlightKey]);
  const entryIndex = chapter?.entries.findIndex(e => e.id === selected) ?? -1;

  const choose = (node, focus = true) => {
    if (!node || !layout) return;
    const target = node.type === 'entry' ? node : layout.byId.get(corpus.chapters.find(c => c.id === node.chapter)?.entries[0]?.id);
    if (!target) return;
    setSelected(target.id); setShowRelated(false); setHovered(null);
    if (focus && view.current) setPan(focusKnowledgeNode(view.current, target));
  };

  useEffect(() => {
    if (!activeHighlights.length) return;
    const target = layout.byId.get(activeHighlights[0]);
    setSelected(target.id); setShowRelated(false);
    if (view.current) setPan(focusKnowledgeNode(view.current, target));
  }, [layout, activeHighlights]);

  // Interaction changes only request one paint per animation frame. Resizing
  // the backing canvas and recreating its observer are reserved for real size
  // or dataset changes, rather than every drag/hover event.
  useEffect(() => {
    drawing.current = { selected, related, highlighted: activeHighlights, zoom, pan };
    renderer.current?.schedule();
  }, [selected, related, activeHighlights, zoom, pan]);

  useEffect(() => {
    if (!layout || !canvas.current) return;
    const surface = canvas.current, ctx = surface.getContext('2d');
    if (!ctx) return;
    let frame = null, size = { width: 0, height: 0 };
    const draw = () => {
      frame = null;
      const state = drawing.current;
      if (!state) return;
      const nextView = createKnowledgeView(size.width, size.height, state.zoom, state.pan);
      if (!nextView) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(size.width * ratio), height = Math.round(size.height * ratio);
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, size.width, size.height);
      view.current = nextView;
      const { scale, ox, oy } = nextView;
      const chosen = new Set([state.selected, ...state.related, ...state.highlighted]);
      const path = n => [n.x * scale + ox, n.y * scale + oy];
      for (const link of layout.links) {
        const a = layout.byId.get(link.source), b = layout.byId.get(link.target);
        const hot = link.type === 'reference' ? chosen.has(a.id) && chosen.has(b.id) : chosen.has(b.id);
        const [ax, ay] = path(a), [bx, by] = path(b);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.strokeStyle = hot ? '#ff6547' : link.type === 'reference' ? '#d6c6bb36' : `${a.color}39`;
        ctx.lineWidth = hot ? 2 : .7; ctx.stroke();
      }
      const drawNode = node => {
        const [x, y] = path(node), isEntry = node.type === 'entry', hot = isEntry && chosen.has(node.id);
        if (!isEntry && node.main) return;
        const r = (isEntry ? hot ? 6 : 2.5 : 4) * Math.max(.7, scale);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = hot ? '#ff6547' : node.color; ctx.globalAlpha = hot || !isEntry ? 1 : .7; ctx.fill(); ctx.globalAlpha = 1;
        if (hot) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
        if (!isEntry && scale > .67) { ctx.font = '11px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#7b8188'; ctx.textAlign = 'center'; ctx.fillText(node.title.length > 10 ? node.title.slice(0, 9) + '…' : node.title, x, y - 9); }
      };
      for (const node of layout.nodes) if (node.id !== state.selected) drawNode(node);
      for (const group of graphGroups) {
        const [x, y] = path({ x: group.center[0], y: group.center[1] });
        const r = knowledgeHubRadius(scale);
        ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2); ctx.fillStyle = `${group.color}25`; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = `${group.color}85`; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
        ctx.font = `700 ${Math.max(16, 28 * scale)}px "Microsoft YaHei", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#172326'; ctx.fillText(group.title, x, y); ctx.textBaseline = 'alphabetic';
      }
      // A selected tip can sit inside a large hub; keep its marker visible.
      const selectedNode = layout.byId.get(state.selected);
      if (selectedNode) drawNode(selectedNode);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(draw); };
    const measure = () => {
      const rect = surface.getBoundingClientRect(), resized = size.width > 0 && (size.width !== rect.width || size.height !== rect.height);
      size = { width: rect.width, height: rect.height };
      const state = drawing.current;
      if (resized && state && (state.zoom !== 1 || state.pan.x !== 0 || state.pan.y !== 0)) {
        const resizedView = createKnowledgeView(size.width, size.height, state.zoom, state.pan);
        setPan(focusKnowledgeNode(resizedView, layout.byId.get(state.selected)));
      }
      schedule();
    };
    renderer.current = { schedule };
    const observer = new ResizeObserver(measure); observer.observe(surface); measure();
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); renderer.current = null; view.current = null; };
  }, [layout]);

  const hit = event => {
    if (!canvas.current) return null;
    const rect = canvas.current.getBoundingClientRect();
    return findKnowledgeNode(layout, view.current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, event.pointerType === 'mouse' ? 15 : 22);
  };
  const endGesture = event => {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    if (isKnowledgeTap(gesture, event)) choose(hit(event), false);
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <section id="knowledge-map" className="knowledge-map page-width" aria-labelledby="map-title">
    <div className="map-heading"><h2 id="map-title">把生活经验，<br />连成一张地图。</h2><p className="map-counts">{corpus?.counts.entries || 650} 条建议 · {corpus?.counts.chapters || 34} 个主题{graph && <> · {graph.counts.crossReferences} 条关联</>}</p><p>从一个问题，发现更多解决办法。</p></div>
    <div className="map-stage" aria-busy={!layout && !failed}>
      {layout ? <canvas ref={canvas} aria-label="650 条建议的互动关系图，点选主题或节点可预览建议；也可以使用预览卡片的建议切换按钮，或通过查看指南按章节阅读。" onPointerDown={e => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        drag.current = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, pan, moved: false };
        setHovered(null);
        if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={e => {
        const gesture = drag.current;
        if (gesture && gesture.id === e.pointerId) {
          const threshold = gesture.type === 'mouse' ? 4 : 10;
          if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > threshold) gesture.moved = true;
          if (gesture.moved && gesture.type === 'mouse') { setDragging(true); setPan({ x: gesture.pan.x + e.clientX - gesture.x, y: gesture.pan.y + e.clientY - gesture.y }); }
        } else if (e.pointerType === 'mouse') setHovered(hit(e));
      }} onPointerUp={endGesture} onPointerCancel={() => { drag.current = null; setDragging(false); }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }} onPointerLeave={() => setHovered(null)} style={{ cursor: dragging ? 'grabbing' : hovered ? 'pointer' : 'grab' }} /> : <div className="map-loading"><p role="status">{failed ? '图谱暂时无法加载' : '正在展开生活地图……'}</p>{failed && <NavbarButton as="button" type="button" variant="secondary" onClick={() => setAttempt(n => n + 1)}>重新加载 <IconArrowRight size={15} /></NavbarButton>}</div>}
      {entry && <div className="map-preview"><div className="map-preview-heading" aria-live="polite" aria-atomic="true"><span className="map-entry-icon"><EntryIcon size={23} /></span><div><small>{chapter?.title}</small><h3>{entry.title}</h3></div></div><p>{readerText(entry.summary)}</p><NavbarButton as="button" type="button" variant="secondary" onClick={() => onOpen(entry)}>查看完整内容 <IconArrowRight size={17} /></NavbarButton><div className="map-entry-nav" aria-label="切换本主题建议"><NavbarButton as="button" type="button" variant="secondary" aria-label="上一条建议" disabled={entryIndex <= 0} onClick={() => choose(layout.byId.get(chapter.entries[entryIndex - 1]?.id))}><IconChevronLeft size={16} /></NavbarButton><span>{entryIndex + 1} / {chapter?.entries.length}</span><NavbarButton as="button" type="button" variant="secondary" aria-label="下一条建议" disabled={!chapter || entryIndex >= chapter.entries.length - 1} onClick={() => choose(layout.byId.get(chapter.entries[entryIndex + 1]?.id))}><IconChevronRight size={16} /></NavbarButton></div></div>}
      <div className="map-tools" aria-label="图谱视图"><NavbarButton as="button" type="button" className="icon-button" aria-label="放大图谱" disabled={!layout || zoom >= 2} onClick={() => setZoom(z => Math.min(2, Math.round((z + .2) * 10) / 10))}><IconPlus size={18} /></NavbarButton><NavbarButton as="button" type="button" className="icon-button" aria-label="缩小图谱" disabled={!layout || zoom <= .6} onClick={() => setZoom(z => Math.max(.6, Math.round((z - .2) * 10) / 10))}><IconMinus size={18} /></NavbarButton><NavbarButton as="button" type="button" className="icon-button" aria-label="恢复完整图谱" disabled={!layout} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); setHovered(null); }}><IconFocus2 size={18} /></NavbarButton></div>
      {hovered && <p className="map-hover" aria-hidden="true">{hovered.title}</p>}
    </div>
    {related.length > 0 && <div className="map-related"><IconBook2 size={17} /><span>原文里的相关建议</span><div id="map-related-items" className="map-related-items">{(showRelated ? related : related.slice(0, 3)).map(id => <NavbarButton key={id} as="button" type="button" variant="secondary" onClick={() => choose(layout.byId.get(id))}>{layout.byId.get(id).title} <IconArrowRight size={14} /></NavbarButton>)}</div>{related.length > 3 && <NavbarButton as="button" type="button" variant="secondary" className="map-related-toggle" aria-expanded={showRelated} aria-controls="map-related-items" onClick={() => setShowRelated(value => !value)}>{showRelated ? '收起' : `全部 ${related.length} 条`} <IconArrowRight size={14} /></NavbarButton>}</div>}
  </section>;
}
