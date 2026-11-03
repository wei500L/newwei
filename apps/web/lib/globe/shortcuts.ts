/**
 * shortcuts.ts — 复刻 GEV 的键盘快捷键（`ui/applicationShortcuts.js`）。
 *
 * 键位：`1`–`6` 视觉风格、`Esc` 关闭搜索、`H` HUD、`O` 自动旋转、
 * `V` 纯净视图、`F` 图层面板、`D` 检测框、`C` 摄像头图层。
 *
 * 规则与 GEV 一致：
 * - 输入框 / 下拉框 / 文本框里不响应，只有 `Esc` 例外（`applicationShortcuts.js:29`）；
 * - GEV 之外再加一条：任何修饰键（Ctrl / Meta / Alt）按下时不响应，避免和浏览器
 *   快捷键冲突。
 */
import { styleIdForKey, type GlobeStyleId } from "./command-model";

export interface GlobeShortcutActions {
  /** `1`–`6`：切换视觉风格。 */
  setStyle(style: GlobeStyleId): void;
  /** `Esc`：关闭搜索。 */
  dismissSearch(): void;
  /** `H`：切换 HUD（本批派发 `globe:toggle-hud`，交给 G5）。 */
  toggleHud(): void;
  /** `O`：自动旋转。 */
  toggleOrbit(): void;
  /** `V`：纯净视图（隐藏所有 React 面板）。 */
  toggleCleanView(): void;
  /** `F`：显示 / 隐藏图层面板。 */
  toggleLayers(): void;
  /** `D`：切换检测框。 */
  cycleDetection(): void;
  /** `C`：开关摄像头图层（不是驾驶舱）。 */
  toggleCctv(): void;
}

export interface GlobeShortcutOptions {
  /** 搜索框是否聚焦（GEV 的 `searchInput` 额外编辑目标）。 */
  isSearchFocused?: () => boolean;
}

const FORM_CONTROL_SELECTOR = "select, input, textarea";

function isEditingTarget(target: EventTarget | null): boolean {
  const element = target as
    | (Element & { matches?: (selector: string) => boolean })
    | null;
  if (element?.matches?.(FORM_CONTROL_SELECTOR)) return true;
  if (typeof (target as HTMLElement | null)?.isContentEditable === "boolean") {
    return (target as HTMLElement).isContentEditable;
  }
  return false;
}

/**
 * 绑定全局快捷键，返回解绑函数（同步、幂等）。
 * 监听冒泡阶段的 `keydown`；捕获阶段的界面仍拥有第一优先权（与 GEV 相同）。
 */
export function bindGlobeShortcuts(
  target: Document,
  actions: GlobeShortcutActions,
  { isSearchFocused }: GlobeShortcutOptions = {},
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // 修饰键组合留给浏览器。
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const editing =
      isEditingTarget(event.target) || Boolean(isSearchFocused?.());
    if (editing && event.key !== "Escape") return;

    const style = styleIdForKey(event.key);
    if (style) {
      actions.setStyle(style);
      return;
    }

    if (event.key === "Escape") {
      actions.dismissSearch();
      return;
    }

    switch (event.key.toLowerCase()) {
      case "h":
        actions.toggleHud();
        break;
      case "o":
        actions.toggleOrbit();
        break;
      case "v":
        actions.toggleCleanView();
        break;
      case "f":
        actions.toggleLayers();
        break;
      case "d":
        actions.cycleDetection();
        break;
      case "c":
        actions.toggleCctv();
        break;
      default:
        break;
    }
  };

  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
  };
}
