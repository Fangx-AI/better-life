import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import { MembershipProvider } from './components/membership/membership-context.jsx';
import { AccountDialog } from './components/membership/account-dialog.jsx';
import './membership.css';
import { RouteBoundary } from './components/route-boundary.jsx';
import { readAppView } from './lib/guide-location.mjs';
import { AnalyticsPageView } from './components/analytics.jsx';
import { SiteMetadata } from './components/site-metadata.jsx';
import { AnalyticsInteractions } from './components/analytics-interactions.jsx';
import { PUBLIC_ONLY, publicRouteBlocked } from './lib/public-mode.mjs';
import { PublicServiceUnavailable } from './components/public-service-unavailable.jsx';

const PricingPage = React.lazy(() => import('./components/membership/pricing-page.jsx').then(module => ({ default: module.PricingPage })));
const PersonalGuidePage = React.lazy(() => import('./components/personal-guide/index.jsx').then(module => ({ default: module.PersonalGuidePage })));
const LibraryPage = React.lazy(() => import('./components/library-page.jsx').then(module => ({ default: module.LibraryPage })));
const OperationsPage = React.lazy(() => import('./components/operations/operations-page.jsx').then(module => ({ default: module.OperationsPage })));
const ServiceInfoPage = React.lazy(() => import('./components/service-info-page.jsx').then(module => ({ default: module.ServiceInfoPage })));

const view = readAppView(window.location);

const routeLabel = view === 'operations' ? '运营后台' : view === 'privacy' || view === 'terms' ? '服务说明' : view === 'library' ? '人生指南' : view === 'pricing' ? '会员与价格' : '我的人生指南';

function RouteLoading() {
  return <main className="route-loading member-route-loading" aria-busy="true">
    <div className="member-route-loading-card" role="status">
      <img src={`${import.meta.env.BASE_URL}media/brand.webp`} width="42" height="42" alt=""/>
      <p>正在打开{routeLabel}……</p>
      <small>好建议，慢慢变成自己的生活。</small>
    </div>
  </main>;
}

const root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root"));
if (import.meta.hot) import.meta.hot.data.root = root;

root.render(
  <React.StrictMode>
    <MembershipProvider>
      <SiteMetadata view={view}/>
      <AnalyticsPageView view={view}/>
      <AnalyticsInteractions view={view}/>
      <RouteBoundary><React.Suspense fallback={<RouteLoading />}>
        {publicRouteBlocked(view) ? <PublicServiceUnavailable/> : view === 'operations' ? <OperationsPage/> : view === 'privacy' || view === 'terms' ? <ServiceInfoPage view={view}/> : view === 'pricing' ? <PricingPage /> : view === 'guides' ? <PersonalGuidePage /> : view === 'library' ? <LibraryPage /> : <App />}
      </React.Suspense></RouteBoundary>
      {!PUBLIC_ONLY && <AccountDialog />}
    </MembershipProvider>
  </React.StrictMode>,
);
