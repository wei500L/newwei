/**
 * detection-mode-store.ts — 检测框模式的共享外部仓库。
 *
 * `initDetection(viewer, layers, onModeChange)` 的第三个参数（模式标签回调）
 * 在 G2 里只更新 VisualSettings 自己的按钮；G4 增加这里，让 React 的命令坞
 * 也能订阅到当前模式（`data/detection.js` 的 `getMode` / `cycleMode`）。
 */
import { createExternalStore } from "./external-store";

/** `data/detection.js` 的 `MODE_LABELS`：OFF / SPARSE / BALANCED / DENSE。 */
export const detectionModeStore = createExternalStore<string>("OFF");
