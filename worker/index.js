import { createQaHandler } from '../server/qa.mjs';
const handlers = new WeakMap();
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      if (!handlers.has(env)) {
        let corpus;
        const origin = new URL(request.url).origin;
        handlers.set(env, createQaHandler({ env, getClientId:request=>request.headers.get('cf-connecting-ip') || 'shared', getCorpus: async () => {
          if (!corpus) {
            const response = await env.ASSETS.fetch(new Request(`${origin}/content.json`));
            if (!response.ok) throw new Error('Corpus unavailable');
            corpus = await response.json();
          }
          return corpus;
        } }));
      }
      return handlers.get(env)(request);
    }
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
