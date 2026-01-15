# Discovery Summary: AkShare 模块数据项展示问题

**Discovery ID**: DSC-20260115-akshare-display  
**Date**: 2026-01-15  
**Scope**: akshare 模块及相关前端展示组件

## 概览

| 视角 | 发现数量 | Critical | High | Medium | Low |
|------|----------|----------|------|--------|-----|
| Maintainability | 12 | 0 | 2 | 6 | 4 |
| Best Practices | 14 | 0 | 3 | 8 | 3 |
| UX | 12 | 0 | 1 | 6 | 5 |
| Bug | 12 | 0 | 3 | 7 | 2 |
| Test | 15 | 0 | 3 | 9 | 3 |
| Quality | 15 | 0 | 4 | 6 | 5 |
| Performance | 11 | 0 | 3 | 6 | 2 |
| Security | 8 | 0 | 1 | 5 | 2 |
| **Total** | **99** | **0** | **20** | **53** | **26** |

## 关键发现 (High Priority)

### 🐛 Bug 类
1. **BUG-001/002**: `economic-chart-card.tsx` 中除零错误 - `percentChange` 和 `diffFromAvg` 计算未检查分母为零
2. **BUG-005/006**: `akshare.service.ts` 日期解析静默回退到当前日期，可能导致时序数据损坏

### 🏗️ 可维护性
1. **MAINT-001**: `AkshareService` 超过1200行，承担6+职责（目录、调度、HTTP、解析、持久化、状态）
2. **MAINT-002**: 解析器类型硬编码 switch 语句违反开闭原则

### ⚡ 性能
1. **PERF-001**: `ensureCatalog` 中 N+1 查询模式 - 40+ 定义导致 40+ 数据库往返
2. **PERF-003**: React Hook 使用 Map 导致不必要的重渲染
3. **PERF-006**: `getDataByCategory` 无分页，大时间范围可能返回百万行

### 🔒 安全
1. **SEC-004**: `/admin/akshare/upgrade` 端点无速率限制，可能被滥用导致 DoS

### 🧪 测试
1. **TEST-001**: `EconomicDataResolver` 无单元测试
2. **TEST-002**: `AdminAkshareController` 无测试覆盖
3. **TEST-014**: `fetchAndPersist` 错误处理路径未测试

### 📐 最佳实践
1. **BP-003**: 元数据类型断言无运行时验证
2. **BP-004**: React Hook 使用 Map 数据结构导致浅比较问题
3. **BP-013**: 升级端点缺少速率限制

### 🎨 用户体验
1. **UX-001**: 硬编码中文字段名 (`美元`, `欧元`, `日元`) 绕过 i18n 系统

### 📊 代码质量
1. **QUAL-001**: `useEconomicData.ts` 中复杂嵌套的单位解析逻辑
2. **QUAL-002**: Resolver 方法中重复的 item 映射逻辑
3. **QUAL-003**: 5个解析器方法共享几乎相同的去重和字段处理逻辑
4. **QUAL-009**: Service 类过长，违反单一职责原则

## 建议优先修复

### P0 - 立即修复
- [ ] 修复除零错误 (BUG-001, BUG-002)
- [ ] 添加升级端点速率限制 (SEC-004)

### P1 - 短期修复
- [ ] 修复日期解析静默回退问题 (BUG-005, BUG-006)
- [ ] 添加 EconomicDataResolver 测试 (TEST-001)
- [ ] 优化 ensureCatalog N+1 查询 (PERF-001)
- [ ] 添加 getDataByCategory 分页 (PERF-006)

### P2 - 中期重构
- [ ] 拆分 AkshareService 为多个专注服务 (MAINT-001)
- [ ] 使用策略模式重构解析器 (MAINT-002)
- [ ] 修复 i18n 硬编码问题 (UX-001)
- [ ] 优化 React Hook Map 使用 (PERF-003, BP-004)

## 文件分析覆盖

### 后端
- `apps/api/src/modules/akshare/akshare.service.ts` (1200+ lines)
- `apps/api/src/modules/akshare/akshare.definitions.ts` (500+ lines)
- `apps/api/src/modules/akshare/akshare.types.ts`
- `apps/api/src/modules/akshare/akshare.processor.ts`
- `apps/api/src/modules/akshare/akshare.module.ts`
- `apps/api/src/modules/akshare/admin-akshare.controller.ts`
- `apps/api/src/graphql/resolvers/economic-data.resolver.ts`

### 前端
- `apps/web/hooks/useEconomicData.ts`
- `apps/web/app/(app)/dashboard/components/economic-chart-card.tsx`
- `apps/web/app/(app)/dashboard/components/candlestick-card.tsx`
- `apps/web/app/(app)/dashboard/components/market-pulse.tsx`
- `apps/web/app/(app)/dashboard/components/global-sentiment-trend.tsx`
- `apps/web/app/(app)/dashboard/utils/series.ts`
- `apps/web/app/(app)/dashboard/key-monitor/page.tsx`
