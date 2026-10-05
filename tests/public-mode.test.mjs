import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPublicOnlyBuild, PUBLIC_ONLY, assertServerFeatures, publicRouteBlocked, publicAnalyticsEnabled } from '../src/lib/public-mode.mjs';
import { routeMetadata } from '../src/lib/site-metadata.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// Execute the actual non-JSX client modules under a synthetic compile-time flag.
// No browser, environment file, provider, DB or external transport is involved.
const publicModeUrl = dataModule(read('src/lib/public-mode.mjs').replaceAll('import.meta.env', "({ VITE_PUBLIC_ONLY: 'true' })"));
async function publicClient(path) {
  let source = read(`src/lib/${path}`);
  source = source.replaceAll("'./public-mode.mjs'", JSON.stringify(publicModeUrl));
  source = source.replaceAll("'../../shared/analytics-schema.mjs'", JSON.stringify(new URL('../shared/analytics-schema.mjs', import.meta.url).href));
  source = source.replaceAll('import.meta.env', "({ BASE_URL: '/better-life/' })");
  return import(dataModule(source));
}

test('public mode: explicit true selects public-only, normal service default is unchanged', () => {
  assert.equal(PUBLIC_ONLY, false);
  for (const value of [undefined, {}, { VITE_PUBLIC_ONLY: 'false' }, { VITE_PUBLIC_ONLY: '' }, { VITE_PUBLIC_ONLY: true }, { VITE_PUBLIC_ONLY: 'TRUE' }]) assert.equal(isPublicOnlyBuild(value), false);
  assert.equal(isPublicOnlyBuild({ VITE_PUBLIC_ONLY: 'true' }), true);
  assert.doesNotThrow(() => assertServerFeatures(false));
  assert.throws(() => assertServerFeatures(true), error => error.status === 503 && error.code === 'public_only');
  for (const view of ['guides', 'operations']) { assert.equal(publicRouteBlocked(view, true), true); assert.equal(publicRouteBlocked(view, false), false); }
  for (const view of ['home', 'library', 'pricing', 'privacy', 'terms']) assert.equal(publicRouteBlocked(view, true), false);
  assert.equal(publicAnalyticsEnabled('true', false), true); assert.equal(publicAnalyticsEnabled('false', false), false); assert.equal(publicAnalyticsEnabled('true', true), false);
});

test('public mode: actual membership client refuses URL construction and requests before any network call', async t => {
  const client = await publicClient('membership-api.mjs'), original = globalThis.fetch;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('must_not_fetch'); }; t.after(() => { globalThis.fetch = original; });
  assert.throws(() => client.membershipApiUrl('me', 'https://public.fixture.test'), error => error.code === 'public_only');
  for (const path of ['membership', 'me', 'auth/code', 'orders', 'guides', 'account']) await assert.rejects(client.membershipRequest(path), error => error.code === 'public_only');
  assert.equal(calls, 0);
});

test('public mode: actual question and operations clients refuse even supplied external URL and valid injected transport', async () => {
  const qa = await publicClient('qa-conversation-request.mjs'), operations = await publicClient('operations-api.mjs');
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('must_not_fetch'); };
  await assert.rejects(qa.sendConversationQuestion('https://unverified-qa.fixture.test/ask', { question: '合成问题' }, { fetchImpl }), error => error.code === 'public_only');
  await assert.rejects(operations.operationsRequest('status', { origin: 'https://public.fixture.test', fetchImpl }), error => error.code === 'public_only');
  assert.equal(calls, 0);
});

test('public mode: actual analytics remains off despite enabled=true and never creates a stored session', async () => {
  const analytics = await publicClient('analytics.mjs'); let calls = 0, writes = 0;
  const client = analytics.createAnalyticsClient({ enabled: true, origin: 'https://public.fixture.test', basePath: '/better-life/', navigator: {}, window: {}, storage: { getItem: () => null, setItem: () => { writes++; } }, fetchImpl: async () => { calls++; return new Response('{}'); } });
  assert.equal(await client.track('page_view', { view: 'home' }), false); assert.equal(calls, 0); assert.equal(writes, 0);
});

test('public mode: Pages workflow no longer injects arbitrary legacy QA URL, publication is public-only and main-only', () => {
  const workflow = read('.github/workflows/pages.yml');
  assert.match(workflow, /VITE_PUBLIC_ONLY: 'true'/); assert.match(workflow, /VITE_QA_API_URL: ''/); assert.match(workflow, /VITE_ANALYTICS_ENABLED: 'false'/); assert.match(workflow, /PUBLIC_BASE_PATH: \/better-life\//);
  assert.doesNotMatch(workflow, /vars\.QA_API_URL|secrets\./);
  assert.equal(workflow.match(/github\.ref == 'refs\/heads\/main'/g).length, 3);
  assert.match(workflow, /path: dist\/client/); assert.doesNotMatch(workflow, /path: dist\/server/);
});

test('public mode: entry route blocks private lazy modules and account effects; homepage remains honest, not fake keyword AI', () => {
  const main = read('src/main.jsx'), context = read('src/components/membership/membership-context.jsx'), question = read('src/components/guide-question.jsx');
  assert.match(main, /publicRouteBlocked\(view\) \? <PublicServiceUnavailable\/> : view === 'operations'/);
  assert.match(main, /!PUBLIC_ONLY && <AccountDialog \/>/);
  assert.match(context, /return PUBLIC_ONLY \? <MembershipContext.Provider value=\{publicMembership\}>/);
  assert.match(context, /function LiveMembershipProvider/); assert.match(context, /publicOnly: true/);
  assert.match(question, /if \(PUBLIC_ONLY\) return <div className="guide-question public-question">/);
  const publicQuestion = question.slice(question.indexOf('if (PUBLIC_ONLY)'), question.indexOf('function LiveGuideQuestion'));
  assert.match(publicQuestion, /AI提问暂未开放/); assert.match(publicQuestion, /查看指南/); assert.doesNotMatch(publicQuestion, /sendConversationQuestion|onSubmit=|onClick=.*ask|查一查/);
  for (const path of ['src/App.jsx', 'src/components/library-page.jsx', 'src/components/membership/pricing-page.jsx']) assert.match(read(path), /!PUBLIC_ONLY && <NavbarButton[^>]+onClick=\{openAccount\}/);
  const pricing = read('src/components/membership/pricing-page.jsx'); assert.match(pricing, /PUBLIC_ONLY \? <NavbarButton href=\{guideLocationHref\(base\)\}/); assert.match(pricing, /此页仅为价格与权益预览/);
});

test('public mode: free content links remain local and homepage metadata does not claim live AI availability', () => {
  const app = read('src/App.jsx'), unavailable = read('src/components/public-service-unavailable.jsx');
  for (const text of ['查看全部', '下载 Obsidian Vault', 'downloads/better-life-obsidian.zip', 'content-source.html', 'AnswerShowcase', 'KnowledgeMap']) assert.ok(app.includes(text), text);
  assert.match(unavailable, /会员服务暂未开放/); assert.match(unavailable, /guideLocationHref\(base\)/); assert.doesNotMatch(unavailable, /membershipRequest|operationsRequest|fetch\(/);
  const metadata = routeMetadata({ view: 'home', siteUrl: 'https://public.fixture.test/better-life/', publicOnly: true });
  assert.match(metadata.description, /AI 提问暂未开放/); assert.match(metadata.description, /Obsidian/);
  assert.match(routeMetadata({ view: 'home', siteUrl: 'https://service.fixture.test/', publicOnly: false }).description, /直接提问/);
});
