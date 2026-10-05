// Only the current question may publish a result, even if a cancelled fetch settles late.
export function createQaRequestGate({ timeoutMs = 55000 } = {}) {
  let current = null;
  const cancel = (reason = 'cancelled') => {
    if (!current) return;
    const request = current;
    current = null;
    clearTimeout(request.timeout);
    request.controller.abort(reason);
  };
  return {
    begin() {
      cancel('superseded');
      const request = { controller: new AbortController() };
      request.timeout = setTimeout(() => request.controller.abort('timeout'), timeoutMs);
      current = request;
      return request;
    },
    isCurrent(request) { return current === request; },
    finish(request) {
      clearTimeout(request.timeout);
      if (current !== request) return false;
      current = null;
      return true;
    },
    cancel,
  };
}

// Use an intact first sentence as the preview; every remaining word stays expandable.
export function previewQaStep(detail = '') {
  const text = detail.trim();
  const firstSentence = text.match(/^.*?[。！？](?:[”’」』）)]*)/s)?.[0];
  if (!firstSentence || firstSentence.length > 180 || !text.slice(firstSentence.length).trim()) {
    return { preview: text, remainder: '' };
  }
  return { preview: firstSentence, remainder: text.slice(firstSentence.length).trim() };
}
