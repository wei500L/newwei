import { Modal } from "antd";

/**
 * 危险操作统一走 antd Modal.confirm 二次确认。文案由调用方传入 i18n 结果，
 * `onConfirm` 内部自行捕获错误（不向 Modal 抛异常），因此确认框不会因为
 * 请求失败而卡在 loading 状态。
 */
export interface QueueOpsConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function confirmQueueOpsAction(
  options: QueueOpsConfirmOptions,
): void {
  Modal.confirm({
    title: options.title,
    content: options.description,
    okText: options.confirmLabel,
    cancelText: options.cancelLabel,
    okButtonProps: options.danger ? { danger: true } : undefined,
    onOk: options.onConfirm,
  });
}
