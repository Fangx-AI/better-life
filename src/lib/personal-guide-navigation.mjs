const historyKey = '__betterLifeGuideNavigation';
export const pendingGuideMessage = '还有未保存的内容。离开会放弃这些内容，确定离开吗？';

// This guard stores only history indices/URLs, never private drafts or facts.
// A rejected traversal is reversed once, rather than pushing a trapping entry.
export function createGuideNavigationGuard({ window: win, hasPending, onNavigate, confirm = message => win.confirm(message) }) {
  const token = win.crypto.randomUUID();
  let index = 0, currentUrl = win.location.href, restoring = false, leaveApproved = false;
  const marker = value => value?.[historyKey];
  const stateAt = value => ({ ...(win.history.state || {}), [historyKey]: { token, index: value } });
  win.history.replaceState(stateAt(index), '', currentUrl);
  const allowed = () => !hasPending() || confirm(pendingGuideMessage);
  const pop = event => {
    const next = marker(event.state);
    if (restoring) { restoring = false; return; }
    if (win.location.href === currentUrl) return;
    if (!allowed()) {
      if (next?.token === token && Number.isInteger(next.index) && next.index !== index) {
        restoring = true; win.history.go(index - next.index);
      } else {
        // Unmanaged same-document hash entries cannot unmount the editor. Keep
        // the accepted route in place without adding another history entry.
        win.history.replaceState(stateAt(index), '', currentUrl);
      }
      return;
    }
    index = next?.token === token && Number.isInteger(next.index) ? next.index : index + 1;
    currentUrl = win.location.href;
    win.history.replaceState(stateAt(index), '', currentUrl);
    onNavigate(currentUrl);
  };
  const unload = event => {
    if (!leaveApproved && hasPending()) { event.preventDefault(); event.returnValue = ''; }
  };
  const click = event => {
    const link = event.target.closest?.('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || link.target && link.target !== '_self') return;
    const url = new URL(link.href, win.location.href), current = new URL(currentUrl);
    if (url.origin === current.origin && url.pathname === current.pathname && url.search === current.search) return;
    if (!allowed()) { event.preventDefault(); event.stopPropagation(); return; }
    // Let a normal link navigate, with no duplicate beforeunload confirmation.
    leaveApproved = true;
    win.setTimeout(() => { leaveApproved = false; }, 0);
  };
  win.addEventListener('popstate', pop);
  win.addEventListener('beforeunload', unload);
  win.document.addEventListener('click', click, true);
  return {
    confirmLeave: allowed,
    push(url, { confirmed = false } = {}) {
      if (!confirmed && !allowed()) return false;
      index += 1; currentUrl = new URL(url, win.location.href).href;
      win.history.pushState(stateAt(index), '', currentUrl);
      onNavigate(currentUrl); return true;
    },
    dispose() {
      win.removeEventListener('popstate', pop);
      win.removeEventListener('beforeunload', unload);
      win.document.removeEventListener('click', click, true);
    },
  };
}

export function validatePersonalGuideCorpus(value) {
  if (!value || !Array.isArray(value.chapters) || !value.chapters.length || typeof value.source?.snapshotDate !== 'string' || value.chapters.some(chapter => !Array.isArray(chapter.entries) || chapter.entries.some(entry => typeof entry?.id !== 'string' || typeof entry.title !== 'string'))) throw new Error('书中原文暂时没有加载成功。');
  return value;
}
