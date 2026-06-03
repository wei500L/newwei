import Link from 'next/link';


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
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
      <header className="mb-6 rounded-2xl border border-white/10 bg-[linear-gradient(120deg,rgba(15,23,42,0.92),rgba(2,6,23,0.85))] p-5 text-zinc-100 shadow-[0_26px_70px_-42px_rgba(15,23,42,0.9)]">
        <h1 className="mb-2 text-2xl font-semibold text-inherit">
          News Hub
        </h1>
        <p className="mb-0 text-[rgba(228,228,231,0.88)]">
          统一入口：先看热榜，再进深读，最后回到事件脉络校验。
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {pillars.map((pillar) => (
          <article
            key={pillar.href}
            className={`rounded-2xl border bg-[linear-gradient(145deg,var(--tw-gradient-stops))] p-5 ${pillar.tone}`}
          >
            <h2 className="text-lg font-semibold tracking-[0.01em]">{pillar.title}</h2>
            <p className="mt-2 min-h-[56px] text-sm leading-6 text-zinc-200/88">{pillar.description}</p>
            <Link
              href={pillar.href}
              className="mt-4 inline-flex rounded-md border border-white/20 bg-white/8 px-3 py-1.5 text-sm text-zinc-100 transition-colors hover:bg-white/16"
            >
              {pillar.cta}
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
