import { type ReactNode } from "react";

import { resolveRightPanelSheetStyle, RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  /** Reserve the composer overlay so the narrow-window sheet never covers it. */
  bottomInset?: number;
  /** Cloud desktop is an in-layout inspector and must not block the composer. */
  nonModal?: boolean;
}) {
  const nonModal = props.nonModal === true;

  return (
    <Sheet
      open={props.open}
      modal={!nonModal}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        showBackdrop={!nonModal}
        nonModal={nonModal}
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
        style={resolveRightPanelSheetStyle(props.bottomInset ?? 0)}
        data-right-panel-sheet-mode={nonModal ? "non-modal" : "modal"}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
