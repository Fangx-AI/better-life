import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
const entry={id:'15-1',title:'真实原文',summary:'真实正文',sources:'https://source.example'};
const corpus={source:{snapshotDate:'2026-10-03'},chapters:[{title:'租房',file:'15.md',entries:[entry]}]};
const valid=()=>({status:'answered',answer:{intro:'先看合同。',steps:[{title:'核对押金约定',detail:'核对合同内的退还期限。',entryIds:['15-1']}],caveat:''},sources:[{id:'15-1',title:'untrusted',sources:'https://fake.example'}]});
test('前端用真实书本替换接口来源信息，保持安全文本输出',()=>{
  const result=validateQaResponse(valid(),corpus);
  assert.equal(result.sources[0].title,entry.title);
  assert.equal(result.sources[0].sources,entry.sources);
  assert.equal(result.snapshotDate,corpus.source.snapshotDate);
});
test('非法成功答案结构和假引用不会进入渲染状态',()=>{
  for(const change of [v=>v.answer.steps={},v=>v.answer.intro={},v=>v.answer.steps[0].detail={},v=>v.sources[0].id='fake',v=>v.answer.steps[0].entryIds=['fake'],v=>v.answer.steps=[],v=>v.status='insufficient']){
    const value=valid();change(value);assert.throws(()=>validateQaResponse(value,corpus));
  }
});
