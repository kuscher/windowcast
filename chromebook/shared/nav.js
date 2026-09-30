// Address field input to a URL or a search, the way an omnibox would read it.

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const OTHER_URL = /^(about|chrome|file|view-source|mailto):/i;
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i;
const DOMAIN = /^[^\s/:]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

export function toUrlOrSearch(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^javascript:/i.test(t)) return { kind: 'search', query: t };
  if (SCHEME_URL.test(t) || OTHER_URL.test(t)) return { kind: 'url', url: t };
  if (LOCAL.test(t)) return { kind: 'url', url: `http://${t}` };
  if (DOMAIN.test(t)) return { kind: 'url', url: `https://${t}` };
  return { kind: 'search', query: t };
}
