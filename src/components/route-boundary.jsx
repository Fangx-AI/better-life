import React from 'react';
import { NavbarButton } from './ui/resizable-navbar';

export class RouteBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <main className="route-loading">
      <div role="alert"><p>页面暂时打不开</p><NavbarButton as="button" type="button" variant="secondary" onClick={() => window.location.reload()}>重新加载</NavbarButton></div>
    </main>;
    return this.props.children;
  }
}
