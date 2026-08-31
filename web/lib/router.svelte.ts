/**
 * Tiny history-mode router. The Hono app already serves index.html for any path
 * (SPA fallback), so clean URLs work on reload - no `#` needed.
 */
class Router {
  path = $state(typeof location !== 'undefined' ? location.pathname : '/');

  constructor() {
    if (typeof addEventListener !== 'undefined') {
      addEventListener('popstate', () => (this.path = location.pathname));
    }
  }

  go(to: string): void {
    // `to` may carry a query/hash (e.g. /graph?focus=<id>); history keeps the full
    // URL but route matching only ever sees the pathname - keep them apart.
    const path = to.split(/[?#]/, 1)[0] || '/';
    if (to === location.pathname + location.search + location.hash) return;
    history.pushState({}, '', to);
    this.path = path;
    scrollTo(0, 0);
  }
}

export const router = new Router();

export function navigate(to: string): void {
  router.go(to);
}

/** `use:link` on an `<a href="/...">` — intercepts plain left-clicks for client-side nav. */
export function link(node: HTMLAnchorElement) {
  const onClick = (e: MouseEvent) => {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    const href = node.getAttribute('href');
    if (!href || !href.startsWith('/')) return;
    e.preventDefault();
    navigate(href);
  };
  node.addEventListener('click', onClick);
  return { destroy: () => node.removeEventListener('click', onClick) };
}

/** Match a `/jobs/:id`-style pattern against a path; returns params or `null`. */
export function matchRoute(
  pattern: string,
  path: string
): Record<string, string> | null {
  if (pattern === '/') return path === '/' ? {} : null;
  const pp = pattern.split('/').filter(Boolean);
  const sp = path.split('/').filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    const val = sp[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}
