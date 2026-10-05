import { NavbarButton } from './ui/resizable-navbar';
import { guideLocationHref } from '../lib/guide-location.mjs';
import './service-info.css';

export function PublicServiceUnavailable() {
  const base = import.meta.env.BASE_URL;
  return <main className="service-info-page">
    <nav aria-label="网站导航"><NavbarButton href={base} className="outline-button">返回首页</NavbarButton></nav>
    <header><img src={`${base}media/brand.webp`} width="44" height="44" alt=""/><h1>会员服务暂未开放</h1><p>原书阅读、检索和下载照常免费。</p></header>
    <NavbarButton href={guideLocationHref(base)} className="coral-button">查看指南</NavbarButton>
  </main>;
}
