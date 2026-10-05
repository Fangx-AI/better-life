import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../src/App.jsx', import.meta.url);
let source = readFileSync(file, 'utf8');
const anchor = '<NavbarButton href={pdf.replace(\'.pdf\',\'.html\')} className="outline-button">离线单文件</NavbarButton>';
if (!source.includes('下载 Obsidian Vault')) {
  if (!source.includes(anchor)) throw Error('下载区域已变更，需要人工合并');
  source = source.replace(anchor, anchor + '<NavbarButton href={`${base}downloads/better-life-obsidian.zip`} download className="outline-button">下载 Obsidian Vault</NavbarButton>');
}
source = source.replace('；DeepSeek 问答需接通服务端；Obsidian 尚未上线。', '；DeepSeek 问答由服务端提供；Obsidian Vault 可免费下载。');
writeFileSync(file, source);
