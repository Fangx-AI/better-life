import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { readerText } from '../src/lib/reader-text.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const entries = corpus.chapters.flatMap(chapter => chapter.entries);
const entry = id => entries.find(item => item.id === id);

test('完整语料显示字段不暴露编辑字母分级，原数据不变', () => {
  const before = JSON.stringify(corpus);
  for (const item of entries) for (const field of ['title', 'summary', 'cost', 'benefit', 'notes']) {
    const output = readerText(item[field] || '');
    assert.doesNotMatch(output, /[ABCＡＢＣ]\s*级|给\s*[ABCＡＢＣ](?![a-zA-Z0-9])/u, `${item.id}.${field}: ${output}`);
    assert.doesNotMatch(output, /所以证据等级[，,。]|推荐力度的评级/u, `${item.id}.${field}: ${output}`);
    assert.doesNotMatch(output, /[（(]\s*[IＩ]\s*级\s*[）)]/u, `${item.id}.${field}`);
    // 数字不属于编辑分级，不得因为清理而丢掉数字与操作条件。
    assert.deepEqual(output.match(/\d+(?:\.\d+)?/g) || [], (item[field] || '').match(/\d+(?:\.\d+)?/g) || [], `${item.id}.${field} 数字改变`);
    assert.equal(readerText(output), output, `${item.id}.${field} 重复清理改变了文字`);
  }
  assert.equal(JSON.stringify(corpus), before);
});

test('普通Markdown去格式；分级引导改为限制提醒，不冒充推荐', () => {
  assert.equal(readerText('**说明** [原文](https://example.test)'), '说明 原文');
  assert.equal(readerText('定 B 级是因为没有直接试验。'), '需要注意：没有直接试验。');
  assert.equal(readerText('给 Ｂ 的原因：只来自一个案例。'), '需要注意：只来自一个案例。');
  assert.equal(readerText('A级只对应特定人群。'), '这部分结论只对应特定人群。');
  assert.equal(readerText('作者建议，属于 C 级：先查原因。'), '作者建议：先查原因。');
  assert.equal(readerText('只是经验，所以定 B 级。仍然先咨询。'), '只是经验。仍然先咨询。');
  assert.equal(readerText('药物需要维生素 B1，检测指标是 HbA1c。'), '药物需要维生素 B1，检测指标是 HbA1c。');
  assert.equal(readerText('所以证据等级只给 B，收益按原文说明。'), '收益按原文说明。');
});

test('1-20保留心血管病适用范围与健康老人的证据不足', () => {
  const output = readerText(entry('1-20').notes);
  assert.ok(output.includes('这部分结论只对应有心血管病的人'));
  assert.ok(output.includes('对本来健康的老年人'));
  assert.ok(output.includes('可信度评为「低」'));
  assert.ok(output.includes('死亡率方面的证据评为「极低」'));
});

test('2-13保留观察研究性质与因果倒置，2-20保留戒酒安全条件', () => {
  const sleep = readerText(entry('2-13').notes);
  assert.ok(sleep.includes('两项跟踪研究支持，都是只记录、不分组的'));
  assert.ok(sleep.includes('多半是因果反过来了'));
  assert.ok(sleep.includes('不必刻意去压缩睡眠时间'));
  const alcohol = readerText(entry('2-20').notes);
  assert.ok(alcohol.includes('占一条就别自己硬停'));
  assert.ok(alcohol.includes('不是「自己硬戒会怎么样」，两者之间是推断'));
  assert.ok(alcohol.includes('酒还是要戒，只是换成去医院戒'));
  assert.ok(alcohol.includes('维生素 B1'));
});

test('2-37保留因果不足、不能降死亡率与排查操作', () => {
  const output = readerText(entry('2-37').notes);
  for (const phrase of ['只记录、不分组的研究', '说不清', '没有查到午睡对冠心病和糖尿病有因果影响', '别把「少睡午觉」当成降死亡率的手段', '那半是作者建议', '打呼噜和睡觉憋气要查睡眠呼吸暂停', '再查血常规和甲状腺']) assert.ok(output.includes(phrase), phrase);
});

test('28-8保留适用小部分人及百分比的不确定性', () => {
  const output = readerText(entry('28-8').notes);
  for (const phrase of ['2.21%', '56.67%', '不能把 15.04% 当准确数字', '想做医美的人绝大多数没有心理问题', '「反复、持续、已经影响到工作和社交」这一小部分人', '手术解决不了他们的问题']) assert.ok(output.includes(phrase), phrase);
});

test('27-6保留孕24周、无症状人群与证据不足，外部分级只去标记', () => {
  const output = readerText(entry('27-6').benefit);
  for (const phrase of ['推荐：', '对没有症状（自己没觉出不舒服）的孕妇', '孕 24 周及以后', '孕 24 周之前就筛查好不好', '现有证据不足以判断好处和坏处']) assert.ok(output.includes(phrase), phrase);
  assert.doesNotMatch(output, /[BI]\s*级/);
  assert.ok(readerText(entry('27-5').benefit).includes('对子痫前期高危的人，在孕 12 周之后'));
  assert.ok(readerText(entry('1-39').benefit).includes('男性证据不足，没有表态'));
});
