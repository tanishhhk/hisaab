import { useCallback, useEffect, useState } from 'react';

// Three surfaces, so three routes. Not react-router: for this many routes the
// History API is a smaller thing to understand than a routing library, and it
// leaves nothing to keep in sync with a config.
//
//   /                 the landing page
//   /app              your trips
//   /app/<tripId>     one trip, open
//
// Anything unrecognised falls back to the landing page rather than rendering
// an error, because the only way to reach an unknown path here is a stale or
// mistyped link.
export type Route =
  | { name: 'landing' }
  | { name: 'trips' }
  | { name: 'trip'; id: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'app') return { name: 'landing' };
  if (parts.length === 1) return { name: 'trips' };
  return { name: 'trip', id: parts[1] };
}

export function routeHref(route: Route): string {
  if (route.name === 'landing') return '/';
  if (route.name === 'trips') return '/app';
  return `/app/${route.id}`;
}

export function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof window === 'undefined' ? '/' : window.location.pathname)
  );

  // The back and forward buttons are the whole reason to use real URLs, so
  // they have to move the app rather than leave it stranded on the last screen.
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: Route, replace = false) => {
    const href = routeHref(to);
    if (href !== window.location.pathname) {
      window.history[replace ? 'replaceState' : 'pushState']({}, '', href);
    }
    setRoute(to);
  }, []);

  return [route, navigate];
}
