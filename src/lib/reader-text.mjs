import { plainText } from '../../assets/search.mjs';

// 仅调整显示文案：移除编辑分级，不删研究局限、适用人群或操作条件。
// 不将字母等级换成推荐力度；原书数据与原文链接保持不变。
export function readerText(value = '') {
  let text = plainText(value);
  const grade = '[ABCＡＢＣ]\\s*(?:级)?';
  const leader = '(?:定(?:成)?|给|记|标(?:成)?|评(?:为|成)?|评级(?:为)?|证据(?:等级)?(?:只)?给)\\s*';
  const replace = (pattern, replacement) => { text = text.replace(new RegExp(pattern, 'g'), replacement); };

  // 保留外部推荐及其适用条件；括号里的纯字母分类不承担事实信息。
  replace('[（(]\\s*[ABCＡＢＣIＩ]\\s*级\\s*[）)]', '');
  replace('\\s*[ABCＡＢＣ]\\s*级(?=推荐)', '');
  replace(`${grade}\\s*只对应`, '这部分结论只对应');

  // 分级的理由恰恰是用户需要看到的限制，因此只改引导语。
  replace(`${leader}${grade}\\s*不是因为`, '需要说明，这不是因为');
  replace(`${leader}${grade}\\s*的(?:原因|理由)有([一二两三四五六七八九十\\d]+)条[。：:]`, '需要注意以下$1点：');
  replace(`${leader}${grade}\\s*的(?:原因|理由)有几条[：:]`, '需要注意以下几点：');
  replace(`${leader}${grade}\\s*的(?:原因|理由)\\s*(?:是[，,]?|[：:])?`, '需要注意：');
  replace(`${leader}${grade}\\s*[，,]?\\s*(?:是)?因为`, '需要注意：');
  replace(`[ABCＡＢＣ]\\s*级\\s*原因是`, '需要注意：');
  replace('推荐力度的评级', '推荐力度的说明');

  // 删除只承担分类功能的短语，而非整句的事实或安全提示。
  replace(`(?:证据)?记\\s*${grade}\\s*也是因为这个`, '');
  replace(`(?:，|,)?所以按(「[^」]+」)记\\s*${grade}`, '，$1');
  replace(`(?:，|,)?(?:所以)?证据等级只给\\s*${grade}(?=[。；;，,]|$)`, '');
  replace(`(?:，|,)?(?:所以)?(?:本条|这条)?(?:只)?(?:给|定(?:成)?|记|标(?:成)?|算)\\s*${grade}(?=[。；;，,]|$)`, '');
  replace(`(?:，|,)?(?:单独看)?属于\\s*[ABCＡＢＣ]\\s*级(?:证据)?`, '');
  replace(`(?:，|,)?单算(?:只有|是)\\s*[ABCＡＢＣ]\\s*级`, '');
  replace(`(?:，|,)?(?:相当于|故)\\s*[ABCＡＢＣ]\\s*级`, '');
  replace('法律条文本身是\\s*[ABCＡＢＣ]\\s*级[。]?', '');
  replace('[，,]?数字本身够\\s*[ABCＡＢＣ]\\s*级[。]?', '。');
  // 兜底只去字母分类字符，不覆盖未匹配的后续事实。
  replace('(?:证据等级|评级)\\s*(?:为|是|：|:)?\\s*[ABCＡＢＣ]\\s*(?:级)?', '');
  replace('[ABCＡＢＣ]\\s*级', '');
  replace(`给\\s*${grade}(?=[，,。；;：:]|$)`, '');

  return text.replace(/[，,]\s*([。；;：:])/g, '$1')
    .replace(/([。；;：:])\s*[，,]/g, '$1')
    .replace(/[，,]{2,}/g, '，').replace(/。{2,}/g, '。')
    .replace(/(^|[。；;])\s*[。；;，,]/g, '$1').trim();
}
