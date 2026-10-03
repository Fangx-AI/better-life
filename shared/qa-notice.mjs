// Remove only standalone meta/disclaimer clauses. Real limitations and warnings stay.
const templates = [
  /^(?:以上|以下|上述|本次|这份|这|本回答|该回答)?(?:内容|回答|建议|说明)?(?:是|为|由|是由)?\s*(?:AI|人工智能)(?:根据|基于)?[^，,。；;！？\n]{0,120}(?:整理|生成)(?:的(?:内容|回答|建议))?$/iu,
  /^(?:这|以上|以下|上述)?(?:是|内容是|内容为)(?:结合|根据|基于)?(?:提供的|所提供的)?(?:原书|书中|条目)?(?:内容|条目)?(?:整理|生成)(?:的)?(?:建议|回答|内容)?$/u,
  /^(?:这|它|内容|回答)?(?:不是|并非|而非)(?:书中|原书)?原文(?:的)?(?:逐字回答|逐字内容|逐字引用)?$/u,
  /^(?:也|并|且)?(?:不能|不应|不可|不宜|不)(?:作为|用于)(?:诊断|治疗|诊疗)(?:或(?:诊断|治疗|诊疗))?(?:建议|依据|意见)?$/u,
  /^(?:本回答|以上内容|这些建议|内容)?(?:仅|只)?供参考$/u,
  /^(?:本回答|以上内容|这些建议|内容)?(?:不能|不可|不)(?:替代|代替)(?:医生|专业人士|专业医生|专业医疗人员)(?:的)?(?:诊断|诊疗|治疗|医疗)(?:或(?:诊断|诊疗|治疗|医疗))?(?:建议|意见)?$/u,
];

export function cleanQaNotice(value) {
  if (typeof value !== 'string') return '';
  const clauses = value.trim().match(/[^，,。；;！？\n]+[，,。；;！？\n]*/gu) || [];
  return clauses.filter(clause => {
    const words = clause.replace(/[，,。；;！？\n]+$/u, '').trim();
    return words && !templates.some(pattern => pattern.test(words));
  }).join('').replace(/^[，,。；;！？\s]+|[，,；;\s]+$/gu, '').trim();
}

export function qaNoticeParts(value) {
  const text = cleanQaNotice(value);
  const sentences = text.match(/[^。！？\n]+[。！？\n]*/gu) || [];
  const index = Math.max(0, sentences.findIndex(sentence => /不要|不得|切勿|急救|立即就医|戒断|禁忌|禁止/u.test(sentence)));
  return { primary: sentences[index]?.trim() || '', extra: sentences.filter((_, i) => i !== index).join('').trim() };
}
