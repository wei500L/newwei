import Link from 'next/link';

import { PageContainer } from '../components/page-container';

import { NewsHubPageHeader } from './news-hub-page-header';


const pillars = [
  {
    title: 'NewsNow 实时热榜',
    description: '高频追踪跨源热度变化，识别正在发酵的话题。',
    href: '/newsnow/hottest',
    cta: '进入热榜',
    tone:
      'from-sky-500/25 via-cyan-500/15 to-slate-900/0 border-sky-400/35 text-sky-100 shadow-[0_18px_45px_-30px_rgba(56,189,248,0.55)]',
  },
  {
    title: 'Items 深度文章',
    description: '查看结构化摘要、主题、实体与质量评分，快速完成深读筛选。',
    href: '/items',
    cta: '进入深读',
    tone:
      'from-emerald-500/25 via-teal-500/15 to-slate-900/0 border-emerald-400/35 text-emerald-100 shadow-[0_18px_45px_-30px_rgba(16,185,129,0.55)]',
  },
  {
    title: 'Events 事件脉络',
    description: '按事件聚类回看时间线、可信度和跨源证据，避免单篇噪音误导。',
    href: '/events',
    cta: '进入事件',
    tone:
      'from-fuchsia-500/25 via-violet-500/15 to-slate-900/0 border-fuchsia-400/35 text-fuchsia-100 shadow-[0_18px_45px_-30px_rgba(217,70,239,0.55)]',
  },
];

export default function NewsHubPage() {
  return (
    // shell 是页面级 padding 的唯一所有者（默认档 p-4 md:p-6）；本页只
    // 叠加纵向节奏。article 宽度档修复原先 1200px+px-4 的双重容器约束。
    <PageContainer contentWidth="article" className="flex flex-col gap-6">
      <NewsHubPageHeader />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {pillars.map((pillar) => (
          <article
            key={pillar.href}
            className={`rounded-2xl border bg-[linear-gradient(145deg,var(--tw-gradient-stops))] p-5 ${pillar.tone}`}
          >
            <h2 className="text-lg font-semibold tracking-[0.01em]">{pillar.title}</h2>
            <p className="mt-2 min-h-14 text-sm leading-6 text-zinc-200/90">{pillar.description}</p>
            <Link
              href={pillar.href}
              className="mt-4 inline-flex rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-zinc-100 transition-colors hover:bg-white/20"
            >
              {pillar.cta}
            </Link>
          </article>
        ))}
      </section>
    </PageContainer>
  );
}
