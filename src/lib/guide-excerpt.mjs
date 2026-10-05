import { readerText } from './reader-text.mjs';

// Display-only summary text. The original Markdown stays intact for editing/export.
// This returns plain text for React text nodes, never HTML for innerHTML.
export function guideExcerpt(content = '', limit = 100) {
  if (typeof content !== 'string') return '';
  const text = content
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style|iframe|object)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>/g, '')
    .replace(/^\s*```[^\n]*$|^\s*~~~[^\n]*$/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$|^\s*=+\s*$/gm, '')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*>+\s*/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/(?<!\w)_{1,3}([^_\n]+)_{1,3}(?!\w)/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\\([*_~#[\]()>`])/g, '$1');
  const max = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 500) : 100;
  return Array.from(readerText(text).replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}
