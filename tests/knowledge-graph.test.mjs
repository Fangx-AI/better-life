import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKnowledgeLayout, createKnowledgeView, findKnowledgeNode, focusKnowledgeNode, graphGroups, isKnowledgeTap, knowledgeHubRadius } from '../src/lib/knowledge-layout.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
const corpus = JSON.parse(readFileSync(new URL('../public/content.json', import.meta.url)));
const graph = JSON.parse(readFileSync(new URL('../public/knowledge-graph.json', import.meta.url)));

test('首页图谱不再堆重复主题目录，仍保留图谱交互与条款入口', () => {
  const source = readFileSync(new URL('../src/components/knowledge-map.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /map-bottom|map-group-tabs|map-topics|setTopics|全部 34 个主题|下方主题按钮/);
  for (const label of ['放大图谱', '缩小图谱', '恢复完整图谱', '上一条建议', '下一条建议', '查看完整内容', '查看指南按章节阅读']) assert.ok(source.includes(label), label);
  assert.match(source, /<canvas ref=\{canvas\}/);
  assert.match(source, /onClick=\{\(\) => onOpen\(entry\)\}/);
});

test('网站图谱完整覆盖原书主题与条目，全部关联可解析', () => {
  const layout = createKnowledgeLayout(corpus, graph.edges);
  assert.equal(new Set(layout.nodes.map(n => n.id)).size, corpus.counts.entries + corpus.counts.chapters);
  assert.equal(layout.nodes.filter(n => n.type === 'entry').length, corpus.counts.entries);
  assert.equal(layout.nodes.filter(n => n.type === 'chapter').length, corpus.counts.chapters);
  const ids = new Set(corpus.chapters.flatMap(c => c.entries.map(e => e.id)));
  for (const [a, b] of graph.edges) { assert.ok(ids.has(a)); assert.ok(ids.has(b)); assert.notEqual(a, b); }
  assert.equal(layout.links.filter(l => l.type === 'reference').length, graph.counts.crossReferences);
  for (const n of layout.nodes) { assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y)); assert.ok(n.x > 0 && n.x < 1200 && n.y > 0 && n.y < 820, n.id); }
});
test('首页真实问答示例通过接口引用校验，来源均可打开原文', () => {
  const example = JSON.parse(readFileSync(new URL('../public/qa-example.json', import.meta.url)));
  const validated = validateQaResponse(example, corpus);
  assert.equal(validated.status, 'answered');
  assert.ok(validated.sources.length > 0);
  for (const entry of validated.sources) assert.ok(corpus.chapters.find(c => c.id === entry.chapter).entries.some(e => e.id === entry.id));
});

test('手机缩小图谱时，主题的可点范围与可见圆圈一致，重叠处选择上层主题', () => {
  const layout = createKnowledgeLayout(corpus, graph.edges);
  const view = createKnowledgeView(325, 340, .6);
  const rental = graphGroups.find(g => g.chapter === 15);
  const point = { x: rental.center[0] * view.scale + view.ox + knowledgeHubRadius(view.scale) * .9, y: rental.center[1] * view.scale + view.oy };
  assert.equal(findKnowledgeNode(layout, view, point)?.id, 'chapter-15');
  // The consumption hub is painted above the work hub where their minimum
  // 26px radii overlap; choosing must follow that visible stacking order.
  const work = graphGroups.find(g => g.chapter === 19), consumption = graphGroups.find(g => g.chapter === 5);
  const overlap = { x: (work.center[0] + consumption.center[0]) / 2 * view.scale + view.ox, y: (work.center[1] + consumption.center[1]) / 2 * view.scale + view.oy };
  assert.equal(findKnowledgeNode(layout, view, overlap)?.id, 'chapter-5');
});

test('全部 650 个建议在最大缩放和偏移后均能重新定位到可见区', () => {
  const layout = createKnowledgeLayout(corpus, graph.edges);
  for (const [width, height] of [[325, 340], [720, 490], [1180, 770]]) {
    const view = createKnowledgeView(width, height, 2, { x: 10000, y: -10000 });
    for (const node of layout.nodes.filter(n => n.type === 'entry')) {
      const focused = createKnowledgeView(width, height, 2, focusKnowledgeNode(view, node));
      const x = node.x * focused.scale + focused.ox, y = node.y * focused.scale + focused.oy;
      assert.ok(x > 20 && x < width - 20 && y > 20 && y < height - 20, `${width}px ${node.id}`);
      if (width > 760) assert.ok(x < width * .5, '桌面节点应避开右侧原文卡');
    }
  }
  assert.equal(createKnowledgeView(0, 340), null);
});

test('触屏轻触可选择，纵向滑动、多指与鼠标拖动不会误选节点', () => {
  const touch = { id: 2, type: 'touch', x: 100, y: 120, moved: false };
  assert.ok(isKnowledgeTap(touch, { pointerId: 2, clientX: 104, clientY: 124 }));
  assert.equal(isKnowledgeTap(touch, { pointerId: 2, clientX: 100, clientY: 180 }), false);
  assert.equal(isKnowledgeTap(touch, { pointerId: 3, clientX: 100, clientY: 120 }), false);
  assert.equal(isKnowledgeTap({ ...touch, moved: true }, { pointerId: 2, clientX: 100, clientY: 120 }), false);
  assert.equal(isKnowledgeTap({ ...touch, type: 'mouse' }, { pointerId: 2, clientX: 105, clientY: 120 }), false);
});
