/**
 * Create Crawl Task 抽屉的字段路径类型（FE-批5B）。
 *
 * antd 的 NamePath<Values> 是深层字面量元组联合；历史实现把 multi URL
 * 嵌套路径标注为 (string | number)[] 导致 8 处 as any。此模块以字面量
 * 元组类型声明嵌套路径，使 setFields/getFieldValue/NamePath 全链路
 * 获得类型检查，无需任何 unsafe cast。
 */

/** multi URL 策略 options 段（第 n 个策略）。 */
export type MultiUrlOptionsPath = ["multiUrlConfigs", number, "options"];

/** multi URL 策略内嵌 virtualScroll 对象路径。 */
export type MultiUrlVirtualScrollPath = [...MultiUrlOptionsPath, "virtualScroll"];
