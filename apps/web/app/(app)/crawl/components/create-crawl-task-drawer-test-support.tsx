import { act, fireEvent, screen } from "@testing-library/react";
import { Form, type FormInstance } from "antd";
import { useState, type ReactNode } from "react";

import { renderWithProviders } from "@/test/render";
import type { CreateCrawlTaskFormValues } from "../types";

import { CreateCrawlTaskDrawer } from "./CreateCrawlTaskDrawer";

/**
 * CreateCrawlTaskDrawer 行为测试共享支撑（FE-批5B characterization tests）。
 *
 * 还原真实父组件的所有权契约：Form 实例由父（本 harness）持有并跨开合
 * 存活；提交值经 onFinish 原样传给 onSubmit；关闭仅由父决定是否 reset
 * （crawl-tasks 不 reset 保留草稿 / news-sources 在 open+close 均 reset，
 * 由 resetOnClose 选项模拟）。Drawer 本身不发起任何 API 请求。
 *
 * 注意：handleNext 在 basic→advanced 时 await validateFields，步骤前进
 * 发生在微任务中——clickNext/advanceToAdvanced 必须配合 settle 等待
 * Promise 链与 React 更新落定后再断言。
 */

export interface RenderCreateCrawlTaskDrawerOptions {
  /** 初始是否打开（默认 true；false 用于测试关闭态与重新打开）。 */
  open?: boolean;
  loading?: boolean;
  canWriteItems?: boolean;
  title?: ReactNode;
  submitLabel?: ReactNode;
  defaultTemplateKey?: string;
  /** 关闭时模拟 news-sources 父组件同步 form.resetFields()。 */
  resetOnClose?: boolean;
  onSubmit?: (values: CreateCrawlTaskFormValues) => void | Promise<void>;
  onClose?: () => void;
}

export interface CreateCrawlTaskDrawerHandle {
  /** 父组件持有的 Form 实例（跨 Drawer 开合存活）。 */
  form: FormInstance<CreateCrawlTaskFormValues>;
  /** 模拟父组件 setDrawerOpen(true/false)。 */
  setOpen: (open: boolean) => void;
  /** onClose 被调用的次数。 */
  closeCalls: () => number;
}

export function renderCreateCrawlTaskDrawer(
  options: RenderCreateCrawlTaskDrawerOptions = {},
): CreateCrawlTaskDrawerHandle {
  const closeCount = { value: 0 };
  const handle = {} as CreateCrawlTaskDrawerHandle;

  function TestHarness() {
    const [form] = Form.useForm<CreateCrawlTaskFormValues>();
    const [open, setOpen] = useState(options.open ?? true);

    handle.form = form;
    handle.setOpen = setOpen;

    return (
      <CreateCrawlTaskDrawer
        form={form}
        open={open}
        loading={options.loading ?? false}
        canWriteItems={options.canWriteItems ?? true}
        title={options.title}
        submitLabel={options.submitLabel}
        defaultTemplateKey={options.defaultTemplateKey}
        onClose={() => {
          closeCount.value += 1;
          if (options.resetOnClose) {
            form.resetFields();
          }
          options.onClose?.();
          setOpen(false);
        }}
        onSubmit={(values) => options.onSubmit?.(values)}
      />
    );
  }

  renderWithProviders(<TestHarness />);
  handle.closeCalls = () => closeCount.value;
  return handle;
}

/** 等待全部微任务与 React 状态更新落定（macrotask 边界 + act 刷帧）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** 点击「Next」并等待步骤推进落定（basic→advanced 有异步校验）。 */
export async function clickNext(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await settle();
}

/** 点击「Previous」回到上一步（同步状态更新）。 */
export function clickPrevious(): void {
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
}

/**
 * 从模板步直达高级步：填入 URL 通过 basic 校验。
 * 返回使用的 URL。
 */
export async function advanceToAdvanced(
  handle: CreateCrawlTaskDrawerHandle,
  url = "https://example.com/article",
): Promise<string> {
  await clickNext();
  fireEvent.change(screen.getByLabelText("Target URL"), {
    target: { value: url },
  });
  await clickNext();
  return url;
}

/** 关闭 Drawer（经 Cancel 按钮，触发组件内 resetAndClose：step 复位 + onClose）。 */
export function closeDrawer(): void {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}
