// Tiny hash router: #/dashboard (also the empty hash), #/runs, #/runs/:id, #/vr, #/vr/:id[?tab=pending], #/pending, #/vision-review, #/sim, #/sim/:id,
// #/settings, #/login. Auth = a token in sessionStorage; without one every
// page (except login) redirects to #/login.
import { useEffect } from 'react';

import { useT } from './i18n';
import { useHashRoute, requireAuth } from './components/hooks';
import type { Route } from './components/hooks';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { RunsListPage } from './pages/RunsList';
import { RunDetailPage } from './pages/RunDetail';
import { VrRunsPage } from './pages/VrRuns';
import { VrRunPage } from './pages/VrRun';
import { PendingPage } from './pages/Pending';
import { VisionReviewPage } from './pages/VisionReview';
import { SimPage } from './pages/Sim';
import { SimRunPage } from './pages/SimRun';
import { SettingsPage } from './pages/Settings';

function pageFor(route: Route) {
  switch (route.page) {
    case 'dashboard':
      return { node: <DashboardPage />, nav: 'dashboard' as const };
    case 'runs':
      return { node: <RunsListPage />, nav: 'runs' as const };
    case 'run':
      return {
        node: (
          <RunDetailPage
            key={`${route.id}:${route.tab ?? ''}:${route.notice ?? ''}`}
            id={route.id}
            initialTab={route.tab}
            highlightNoticeId={route.notice}
          />
        ),
        nav: 'runs' as const,
      };
    case 'vrRuns':
      return { node: <VrRunsPage />, nav: 'vr' as const };
    case 'vrRun':
      return {
        node: <VrRunPage key={`${route.id}:${route.tab ?? ''}`} id={route.id} initialTab={route.tab} />,
        nav: 'vr' as const,
      };
    case 'pending':
      return { node: <PendingPage />, nav: 'pending' as const };
    case 'visionReview':
      return { node: <VisionReviewPage />, nav: 'visionReview' as const };
    case 'sim':
      return { node: <SimPage />, nav: 'sim' as const };
    case 'simRun':
      return { node: <SimRunPage id={route.id} />, nav: 'sim' as const };
    case 'settings':
      return { node: <SettingsPage />, nav: 'settings' as const };
    default:
      return { node: <NotFound />, nav: 'dashboard' as const };
  }
}

function NotFound() {
  const t = useT();
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {t('routeNotFound')}
      <a href="#/dashboard" className="ml-2 text-primary underline">
        {t('navDashboard')}
      </a>
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const needsAuth = requireAuth(route);

  useEffect(() => {
    if (needsAuth) window.location.hash = '#/login';
  }, [needsAuth]);

  if (route.page === 'login') return <LoginPage />;
  if (needsAuth) return null;

  const { node, nav } = pageFor(route);
  return <Layout active={nav}>{node}</Layout>;
}
