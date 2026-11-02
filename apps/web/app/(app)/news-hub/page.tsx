import { PageContainer } from '../components/page-container';

import { NewsHubPageHeader } from './news-hub-page-header';
import { NewsHubPillars } from './news-hub-pillars';


export default function NewsHubPage() {
  return (
    // shell 是页面级 padding 的唯一所有者（默认档 p-4 md:p-6）；本页只
    // 叠加纵向节奏。article 宽度档修复原先 1200px+px-4 的双重容器约束。
    <PageContainer contentWidth="article" className="flex flex-col gap-6">
      <NewsHubPageHeader />
      <NewsHubPillars />
    </PageContainer>
  );
}
