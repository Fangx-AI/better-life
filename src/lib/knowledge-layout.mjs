// Deterministic layout of real chapter memberships and the Vault's explicit references.
export const graphGroups = [
  { title: '工作', chapter: 19, color: '#82be8f', center: [330, 315], chapters: [19, 4, 7, 11, 12, 23, 26, 31, 32] },
  { title: '租房', chapter: 15, color: '#ff926b', center: [765, 205], chapters: [15, 8, 9, 10, 14, 21, 25] },
  { title: '消费', chapter: 5, color: '#81b4e5', center: [350, 575], chapters: [5, 6, 18, 22, 30] },
  { title: '健康', chapter: 2, color: '#e8be67', center: [845, 560], chapters: [1, 2, 3, 13, 16, 17, 20, 24, 27, 28, 29, 33, 34] },
];

export function createKnowledgeView(width, height, zoom = 1, pan = { x: 0, y: 0 }) {
  if (!(width > 0 && height > 0 && zoom > 0)) return null;
  const scale = Math.min(width / 1200, height / 820) * zoom;
  return { width, height, scale, ox: (width - 1200 * scale) / 2 + pan.x, oy: (height - 820 * scale) / 2 + pan.y };
}

export const knowledgeHubRadius = scale => 52 * Math.max(.5, scale);

// Use the same screen-space radius for painting and choosing a hub, including
// the minimum visible size on narrow screens.
export function findKnowledgeNode(layout, view, point, minimumRadius = 15) {
  if (!layout || !view || !(view.scale > 0)) return null;
  const project = node => ({ x: node.x * view.scale + view.ox, y: node.y * view.scale + view.oy });
  const group = [...graphGroups].reverse().find(g => {
    const center = project({ x: g.center[0], y: g.center[1] });
    return Math.hypot(center.x - point.x, center.y - point.y) <= knowledgeHubRadius(view.scale);
  });
  if (group) return layout.byId.get(`chapter-${group.chapter}`);
  let nearest = null, distance = minimumRadius;
  for (const node of layout.nodes) {
    const position = project(node), next = Math.hypot(position.x - point.x, position.y - point.y);
    const visibleRadius = (node.type === 'entry' ? 6 : 4) * Math.max(.7, view.scale);
    if (next <= Math.max(minimumRadius, visibleRadius) && (nearest === null || next < distance)) { nearest = node; distance = next; }
  }
  return nearest;
}

export function focusKnowledgeNode(view, node) {
  if (!view || !node) return { x: 0, y: 0 };
  // Desktop cards cover the right side of the canvas. The small-screen card is
  // below the drawing, so use its full width there.
  const x = view.width * (view.width > 760 ? .36 : .5), y = view.height * .55;
  return {
    x: x - node.x * view.scale - (view.width - 1200 * view.scale) / 2,
    y: y - node.y * view.scale - (view.height - 820 * view.scale) / 2,
  };
}

export function isKnowledgeTap(gesture, event) {
  if (!gesture || gesture.id !== event.pointerId || gesture.moved) return false;
  const threshold = gesture.type === 'mouse' ? 4 : 10;
  return Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= threshold;
}
export function createKnowledgeLayout(corpus, edges = []) {
  const nodes = [], links = [], byId = new Map();
  for (const group of graphGroups) {
    const chapters = group.chapters.map(id => corpus.chapters.find(c => c.id === id)).filter(Boolean);
    chapters.forEach((chapter, index) => {
      const main = chapter.id === group.chapter;
      const angle = index * 2.399963 + (group.chapter === 15 ? .5 : 0);
      const radius = main ? 0 : 65 + Math.sqrt(index) * 43;
      const x = group.center[0] + Math.cos(angle) * radius * 1.15;
      const y = group.center[1] + Math.sin(angle) * radius * .82;
      const hub = { id: `chapter-${chapter.id}`, x, y, color: group.color, chapter: chapter.id, title: chapter.title, main, type: 'chapter' };
      nodes.push(hub); byId.set(hub.id, hub);
      chapter.entries.forEach((entry, i) => {
        const a = i * 2.399963 + chapter.id * .6;
        const r = 29 + Math.sqrt((i + .5) / chapter.entries.length) * (main ? 118 : 58);
        const node = { ...entry, x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * .83, color: group.color, type: 'entry' };
        nodes.push(node); byId.set(node.id, node);
        links.push({ source: hub.id, target: node.id, type: 'membership' });
      });
    });
  }
  for (const [source, target] of edges) if (byId.has(source) && byId.has(target)) links.push({ source, target, type: 'reference' });
  return { nodes, links, byId };
}
