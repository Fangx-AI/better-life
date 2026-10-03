import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = loadCorpus(root);
const vault = resolve(root, 'output/obsidian', `Better-Life-${corpus.source.snapshotDate}`);
test('Vault 原书章节与快照逐字一致，条目节点完整保留所有字段', () => {
  const notes = readdirSync(resolve(vault, '条目')).map(file => readFileSync(resolve(vault, '条目', file), 'utf8'));
  assert.equal(notes.length, corpus.counts.entries);
  for (const c of corpus.chapters) {
    assert.deepEqual(readFileSync(resolve(vault, '原书/book', c.file)), readFileSync(resolve(root, 'library/book', c.file)));
    for (const entry of c.entries) {
      const note = notes.find(text => text.includes(`entry_id: "${entry.id}"\n`));
      assert.ok(note, entry.id);
      for (const key of ['summary', 'cost', 'benefit', 'gradeText', 'sources']) assert.ok(note.includes(entry[key]), `${entry.id} ${key}`);
    }
  }
});
test('Vault 双链目标全部存在，图谱核心插件与配置一并交付', () => {
  const report = JSON.parse(readFileSync(resolve(root, 'output/obsidian/report.json'), 'utf8'));
  assert.equal(report.brokenWikiLinks, 0);
  assert.ok(report.wikiLinks > 2000);
  assert.ok(report.crossReferences > 400);
  assert.equal(report.entries, 650);
  const plugins = JSON.parse(readFileSync(resolve(vault, '.obsidian/core-plugins.json'), 'utf8'));
  assert.ok(plugins.includes('graph'));
  const graph = JSON.parse(readFileSync(resolve(vault, '.obsidian/graph.json'), 'utf8'));
  assert.equal(graph.colorGroups.length, 3);
  assert.ok(!plugins.includes('community-plugins'));
});
