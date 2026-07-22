import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree } from "@/lib/categories";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";

interface Draft {
  date: string;
  accountId: number | null;
  amount: string;
  categoryId: number | null;
  description: string;
  memo: string;
}

const empty = (defaults: Partial<Draft> = {}): Draft => ({
  date: todayISO(),
  accountId: null,
  amount: "",
  categoryId: null,
  description: "",
  memo: "",
  ...defaults,
});

export function useGlobalShortcut(onOpen: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+N (Mac) or Ctrl+N (other). Avoid double-fire when typing in an input.
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && (e.key === "n" || e.key === "N") && !e.shiftKey) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

export default function QuickAdd({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  // Savings isn't tracked in this tool anymore — only bank + credit are offered.
  const accounts = useMemo(
    () => ({ data: (accountsQuery.data ?? []).filter((a) => a.kind !== "savings") }),
    [accountsQuery.data],
  );
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);

  const [draft, setDraft] = useState<Draft>(empty());
  // Credit-card specifics: a Payment starts a new dropdown; a Charge joins
  // one — Auto (oldest-first), a specific payment's dropdown, or the payoff.
  const [ccKind, setCcKind] = useState<"charge" | "payment">("charge");
  const [ccTarget, setCcTarget] = useState<string>("auto");
  const amountRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const creditAccount = (accounts.data ?? []).find((a) => a.kind === "credit");
  const isCc = draft.accountId != null && draft.accountId === creditAccount?.id;
  const ccPayments = useQuery({
    queryKey: ["transactions", "quickadd-cc-payments", creditAccount?.id],
    queryFn: () =>
      api.listTransactions({ account_id: creditAccount!.id, limit: 50000 }),
    enabled: open && isCc && !!creditAccount,
    select: (page) => page.rows.filter((r) => r.amount > 0), // DESC (newest first)
  });

  useEffect(() => {
    if (open) {
      // Pre-fill the first account if none chosen, then focus the date.
      setDraft((d) => ({
        ...d,
        accountId: d.accountId ?? accounts.data?.[0]?.id ?? null,
      }));
      setTimeout(() => dateRef.current?.focus(), 0);
    } else {
      setDraft(empty());
    }
  }, [open, accounts.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft.accountId) throw new Error("Pick an account");
      let amt = parseFloat(draft.amount);
      if (Number.isNaN(amt)) throw new Error("Bad amount");
      if (isCc) {
        // Enforce the sign by kind: charges are negative, payments positive.
        amt = ccKind === "payment" ? Math.abs(amt) : -Math.abs(amt);
      }
      const id = await api.createTransaction({
        account_id: draft.accountId,
        date: draft.date,
        description:
          draft.description.trim() ||
          (isCc && ccKind === "payment" ? "Credit Card Payment" : "(quick add)"),
        amount: amt,
        category_id: draft.categoryId,
        memo: draft.memo.trim() ? draft.memo.trim() : null,
        cleared: false,
        flagged: false,
      });
      // A charge can be placed directly into a chosen dropdown. It never
      // creates a new dropdown — only payments do that.
      if (isCc && ccKind === "charge" && ccTarget !== "auto") {
        await api.updateTransaction({ id, ccPaymentId: Number(ccTarget) });
      }
      return id;
    },
    onSuccess: (_id, _vars, _ctx) => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const submit = async (keepOpen: boolean) => {
    try {
      await save.mutateAsync();
      if (keepOpen) {
        setDraft((d) => ({ ...empty(), date: d.date, accountId: d.accountId }));
        setTimeout(() => amountRef.current?.focus(), 0);
      } else {
        onClose();
      }
    } catch (e) {
      alert(String(e));
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[520px] p-4 space-y-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center pb-1">
          <h2 className="text-sm font-semibold">Quick Add</h2>
          <kbd className="text-[10px] text-gray-400">Enter to save · ⌘Enter to save & repeat · Esc to close</kbd>
        </div>
        <form
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") {
              e.preventDefault();
              submit(e.metaKey || e.ctrlKey);
            }
          }}
          className="grid grid-cols-6 gap-2"
        >
          <input
            ref={dateRef}
            type="date"
            className="col-span-2 border rounded px-2 py-1.5 text-sm bg-white"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
          <select
            className="col-span-2 border rounded px-2 py-1.5 text-sm bg-white"
            value={draft.accountId ?? ""}
            onChange={(e) => setDraft({ ...draft, accountId: Number(e.target.value) })}
          >
            <option value="">Account…</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            ref={amountRef}
            type="number"
            step="0.01"
            placeholder={isCc ? "Amount" : "Amount (negative = outflow)"}
            className="col-span-2 border rounded px-2 py-1.5 text-sm bg-white text-right"
            value={draft.amount}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
          />
          {isCc && (
            <>
              <div className="col-span-3 flex rounded-md border border-gray-200 overflow-hidden text-sm">
                {(
                  [
                    ["charge", "Charge"],
                    ["payment", "Payment (new dropdown)"],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setCcKind(k)}
                    className={`flex-1 px-2 py-1.5 ${
                      ccKind === k
                        ? "bg-amber-500 text-white"
                        : "bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <select
                className="col-span-3 border rounded px-2 py-1.5 text-sm bg-white disabled:opacity-40"
                value={ccTarget}
                disabled={ccKind === "payment"}
                onChange={(e) => setCcTarget(e.target.value)}
                title="Which Credit Card Payment dropdown this charge belongs to"
              >
                <option value="auto">Pay off: Auto (oldest-first)</option>
                <option value="-1">Pay off: hold for payoff</option>
                {(ccPayments.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    Pay off in: {fmtDate(p.date)} · {fmtUSD(-p.amount)}
                  </option>
                ))}
              </select>
            </>
          )}
          <select
            className="col-span-3 border rounded px-2 py-1.5 text-sm bg-white"
            value={draft.categoryId ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                categoryId: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">Category…</option>
            {categoryTree.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Description"
            className="col-span-3 border rounded px-2 py-1.5 text-sm bg-white"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <input
            type="text"
            placeholder="Memo (optional)"
            className="col-span-6 border rounded px-2 py-1.5 text-sm bg-white"
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
          />
          <div className="col-span-6 flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border bg-white">
              Close
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              className="px-3 py-1.5 text-sm rounded bg-black text-white"
              disabled={save.isPending}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
