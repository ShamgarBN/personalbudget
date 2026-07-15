import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUndo } from "@/lib/undo";

/// Global Cmd+Z handler + the "Undid …" toast. Mounted once in App. Text
/// inputs keep their native undo — the handler steps aside while one is
/// focused so typing corrections don't swallow ledger undos.
export default function UndoHost() {
  const qc = useQueryClient();
  const toast = useUndo((s) => s.toast);
  const hideToast = useUndo((s) => s.hideToast);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const entry = useUndo.getState().pop();
      if (!entry) {
        useUndo.getState().showToast("Nothing to undo");
        return;
      }
      try {
        await entry.run();
        useUndo.getState().showToast(`Undid ${entry.label}`);
      } catch (err) {
        useUndo.getState().showToast(`Couldn't undo ${entry.label}: ${String(err)}`);
      }
      // Whatever the inverse touched, refetch everything visible.
      qc.invalidateQueries();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qc]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(hideToast, 3500);
    return () => clearTimeout(t);
  }, [toast, hideToast]);

  if (!toast) return null;
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm shadow-lg pointer-events-none">
      {toast}
    </div>
  );
}
