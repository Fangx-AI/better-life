// A cancelled server reservation is permanently released. Retry it once using
// a fresh ID; never replace an ID for pending/paid/cached or conflicting work.
import { assertServerFeatures } from './public-mode.mjs';
export async function sendConversationQuestion(url, payload, { signal, fetchImpl = fetch, isCurrent = () => true,
  newId = () => crypto.randomUUID(), onRequestId = () => {} } = {}) {
  assertServerFeatures();
  let body = { ...payload };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await response.json().catch(() => null);
    if (attempt === 0 && response.status === 409 && data?.error?.code === 'request_released'
      && !signal?.aborted && isCurrent()) {
      body = { ...body, requestId: newId() }; onRequestId(body.requestId); continue;
    }
    return { response, data, requestId: body.requestId };
  }
}
