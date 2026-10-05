import { useEffect } from 'react';
import { applyRouteMetadata } from '../lib/site-metadata.mjs';

export function SiteMetadata({ view }) {
  useEffect(() => { applyRouteMetadata({ view }); }, [view]);
  return null;
}
