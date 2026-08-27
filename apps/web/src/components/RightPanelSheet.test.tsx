import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/sheet", () => ({
  Sheet: "mock-sheet",
  SheetPopup: "mock-sheet-popup",
}));

import { RightPanelSheet } from "./RightPanelSheet";

type SheetProps = {
  readonly open: boolean;
  readonly modal: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactElement<PopupProps>;
};

type PopupProps = {
  readonly side: "right";
  readonly showCloseButton: boolean;
  readonly keepMounted: boolean;
  readonly showBackdrop: boolean;
  readonly nonModal?: boolean;
  readonly className: string;
  readonly style: {
    readonly maxHeight?: string;
    readonly marginBottom?: string;
  };
  readonly "data-right-panel-sheet-mode": "modal" | "non-modal";
  readonly children: ReactNode;
};

type SheetElement = ReactElement<SheetProps>;

function inspectSheet(nonModal: boolean) {
  const onClose = vi.fn();
  const sheet = RightPanelSheet({
    children: "cloud desktop",
    open: true,
    nonModal,
    bottomInset: 128,
    onClose,
  }) as SheetElement;
  return { onClose, sheet, popup: sheet.props.children };
}

describe("RightPanelSheet", () => {
  it("passes the click-through cloud inspector contract to the sheet primitives", () => {
    const { sheet, popup } = inspectSheet(true);

    expect(sheet.type).toBe("mock-sheet");
    expect(sheet.props).toMatchObject({ open: true, modal: false });
    expect(popup.type).toBe("mock-sheet-popup");
    expect(popup.props).toMatchObject({
      side: "right",
      showCloseButton: false,
      keepMounted: true,
      showBackdrop: false,
      nonModal: true,
      className: expect.any(String),
      style: {
        maxHeight: "max(0px, calc(100% - 128px))",
        marginBottom: "128px",
      },
      "data-right-panel-sheet-mode": "non-modal",
    });
  });

  it("keeps ordinary sheets modal and closes only when the root closes", () => {
    const { onClose, sheet, popup } = inspectSheet(false);

    expect(sheet.props.modal).toBe(true);
    expect(popup.props).toMatchObject({
      showBackdrop: true,
      nonModal: false,
      "data-right-panel-sheet-mode": "modal",
    });
    sheet.props.onOpenChange(true);
    sheet.props.onOpenChange(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
