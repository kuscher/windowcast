// Address field input to a URL or a search, the way an omnibox would read it. Only web addresses navigate:
// Chrome's own pages, files, scripts and other schemes are refused, which limits what a leaked key could reach.

const WEB = /^https?:\/\/\S+$/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i;
const DOMAIN = /^[^\s/:]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BLOCKED = /^(chrome|chrome-extension|chrome-untrusted|devtools|file|filesystem|blob|data|javascript|view-source|about|mailto|tel|intent|ftp|ws|wss):/i;

export function toUrlOrSearch(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^about:blank$/i.test(t)) return { kind: 'url', url: 'about:blank' };
  if (WEB.test(t)) return { kind: 'url', url: t };
  if (LOCAL.test(t)) return { kind: 'url', url: `http://${t}` };
  if (DOMAIN.test(t)) return { kind: 'url', url: `https://${t}` };
  if (OTHER_SCHEME.test(t) || BLOCKED.test(t)) return { kind: 'blocked', text: t };
  return { kind: 'search', query: t };
}
