import { Modal } from "antd";
import { describe, expect, it, vi } from "vitest";

import { confirmQueueOpsAction } from "./queue-ops-confirm";

describe("confirmQueueOpsAction", () => {
  it("routes confirmations through Modal.confirm with the provided labels", () => {
    const confirmSpy = vi.spyOn(Modal, "confirm").mockImplementation(() => ({
      destroy: () => undefined,
      update: () => undefined,
    }));
    const onConfirm = vi.fn();

    confirmQueueOpsAction({
      title: "Pause queue?",
      description: "Paused queues stop processing new jobs.",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      danger: true,
      onConfirm,
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toMatchObject({
      title: "Pause queue?",
      content: "Paused queues stop processing new jobs.",
      okText: "Confirm",
      cancelText: "Cancel",
      okButtonProps: { danger: true },
    });
    expect(onConfirm).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });
});
