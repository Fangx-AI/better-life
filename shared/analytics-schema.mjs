// Never accept free text, URLs, account identifiers, questions or answers here.
// Values are fixed product states, not identifiers supplied by an account.
const fields = {
  view: ['home', 'library', 'pricing', 'guides'],
  source: ['navigation', 'hero', 'scene', 'graph', 'showcase', 'formats', 'quota', 'guides'],
  format: ['pdf', 'obsidian', 'epub', 'html'],
  kind: ['public', 'personal'],
  outcome: ['success', 'unavailable', 'error', 'cancelled'],
  channel: ['email', 'phone'],
  plan: ['member-month', 'member-year'],
};
const events = {
  page_view: ['view'], reader_open: ['source'], download_click: ['format', 'source'],
  qa_submit: ['kind'], qa_result: ['kind', 'outcome'],
  login_open: ['source'], login_complete: ['channel'],
  pricing_open: ['source'], checkout_start: ['plan'], checkout_return: ['outcome'],
  payment_confirmed: ['plan'],
};
export const CLIENT_ANALYTICS_EVENTS = Object.freeze(Object.keys(events).filter(name => name !== 'payment_confirmed'));
export const SERVER_ANALYTICS_EVENTS = Object.freeze(['payment_confirmed']);
export const ANALYTICS_SESSION_MS = 30 * 60 * 1000;
export const ANALYTICS_VERSION = 1;
export const validAnalyticsSession = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function analyticsDimensions(name, input = {}) {
  if (!Object.hasOwn(events, name) || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const output = {};
  for (const key of events[name]) if (Object.hasOwn(input, key) && fields[key].includes(input[key])) output[key] = input[key];
  return output;
}

export function validateAnalyticsPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['version', 'name', 'sessionId', 'dimensions'].includes(key))) return null;
  if (input.version !== ANALYTICS_VERSION || !CLIENT_ANALYTICS_EVENTS.includes(input.name) || !validAnalyticsSession(input.sessionId)) return null;
  const dimensions = analyticsDimensions(input.name, input.dimensions);
  // Client sanitization strips accidental fields; the server rejects them too.
  if (!dimensions || JSON.stringify(Object.keys(dimensions).sort()) !== JSON.stringify(Object.keys(input.dimensions || {}).sort())) return null;
  return { version: ANALYTICS_VERSION, name: input.name, sessionId: input.sessionId, dimensions };
}
