import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";
import { usePaneFocusRef } from "../pane-focus";

/** 명령 창은 버튼을 선택하지 않은 상태로 열고 키보드 이동을 창 안에 유지한다. */
export function CommandDialog({ name, onClose, children }: { name: string; onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const paneFocus = usePaneFocusRef();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && (dialog.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!paneFocus.current || event.defaultPrevented || event.isComposing) return;
      const dialog = ref.current;
      if (!dialog) return;
      const target = event.target instanceof Element ? event.target : null;
      // 별도로 열린 대화상자의 키까지 가로채지 않는다.
      if (target?.closest('[role="dialog"][aria-modal="true"]') && !dialog.contains(target)) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); onClose();
        return;
      }
      if ((target === dialog || !dialog.contains(target)) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); event.stopPropagation();
        dialog.focus({ preventScroll: true });
        return;
      }
      if (!dialog.contains(target) && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); dialog.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      const controls = [...dialog.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [tabindex]")]
        .filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && !control.closest("[inert]") && control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden");
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? controls[index <= 0 ? controls.length - 1 : index - 1] : controls[index < 0 || index === controls.length - 1 ? 0 : index + 1];
      (next ?? dialog).focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, paneFocus]);

  return <Modal variant="pane" onClose={onClose} className="max-h-[80%] w-[min(620px,95%)] overflow-auto p-5">
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`/${name}`} tabIndex={-1} className="outline-none">
      <div className="mb-4 flex justify-between"><h2 className="font-semibold">/{name}</h2><button onClick={onClose}>{t("session.codexUi.close")}</button></div>
      {children}
    </div>
  </Modal>;
}
