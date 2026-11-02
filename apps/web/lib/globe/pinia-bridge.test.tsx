import { act, render, screen } from "@testing-library/react";
import { createPinia, defineStore, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick, shallowRef } from "vue";

import { useGevStore } from "./pinia-bridge";

interface TestView {
  value: string;
}

/**
 * 仿照 `gev-context` 的写法：`shallowRef` 保存视图，`publish` 每次替换成新对象
 * （见 vendor/gods-eye-view/src/ui/stores/context.js:12-19）。
 */
const useTestStore = defineStore("gev-test-view", () => {
  const view = shallowRef<TestView | null>(null);
  function publish(next: TestView) {
    view.value = next;
  }
  return { view, publish };
});

function Probe({ store }: { store: ReturnType<typeof useTestStore> }) {
  const view = useGevStore(store, (state) => state.view);
  return <div data-testid="view">{view ? view.value : "none"}</div>;
}

describe("useGevStore", () => {
  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
  });

  it("publish 之后组件重新渲染并拿到新值", async () => {
    const store = useTestStore();

    render(<Probe store={store} />);
    expect(screen.getByTestId("view")).toHaveTextContent("none");

    // Pinia 的 $subscribe 走 Vue 调度器（微任务），因此 await nextTick()。
    await act(async () => {
      store.publish({ value: "hello" });
      await nextTick();
    });
    expect(screen.getByTestId("view")).toHaveTextContent("hello");

    await act(async () => {
      store.publish({ value: "world" });
      await nextTick();
    });
    expect(screen.getByTestId("view")).toHaveTextContent("world");
  });
});
