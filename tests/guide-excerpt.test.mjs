import test from 'node:test';
import assert from 'node:assert/strict';
import { guideExcerpt } from '../src/lib/guide-excerpt.mjs';

test('directory excerpts remove headings, list and task markers without rewriting the source', () => {
  const source = '# 租房清单\n## 签字之前\n- 核对身份\n1. 问清押金\n* [x] 留下合同';
  assert.equal(guideExcerpt(source), '租房清单 签字之前 核对身份 问清押金 留下合同');
  assert.match(source, /^# 租房清单/);
});

test('inline formatting becomes readable text while useful numbers and punctuation stay', () => {
  assert.equal(guideExcerpt('**预算 2000 元**，_通勤 30 分钟_。\n> [查看原文](https://example.com) · ~~旧版本~~ · `2026-10-03`'), '预算 2000 元，通勤 30 分钟。 查看原文 · 旧版本 · 2026-10-03');
});

test('HTML and executable blocks are not returned as markup', () => {
  assert.equal(guideExcerpt('<h2>记录情况</h2>\n<script>alert(1)</script><!-- secret --><img src=x onerror=alert(2)>\n<b>先核对合同</b>'), '记录情况 先核对合同');
  assert.doesNotMatch(guideExcerpt('<iframe src="x">unsafe</iframe>好建议'), /[<>]|unsafe/);
});

test('code fences and reference syntax do not leak into directory copy', () => {
  assert.equal(guideExcerpt('标题\n===\n```text\n自己的记录\n```\n[原文][1]\n[1]: https://example.com\n---'), '标题 自己的记录 原文');
});

test('excerpt length keeps Unicode characters whole and handles missing values', () => {
  assert.equal(guideExcerpt('生活🌱，慢慢来', 3), '生活🌱');
  assert.equal(guideExcerpt('生活🌱', 0), '');
  assert.equal(guideExcerpt(null), '');
});

test('numeric conditions in angle comparisons are not mistaken for HTML', () => {
  assert.equal(guideExcerpt('房租 < 3000 元，通勤 > 15 分钟。'), '房租 < 3000 元，通勤 > 15 分钟。');
});
