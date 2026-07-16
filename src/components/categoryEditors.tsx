import { useState } from "react";

// Shared category-editing widgets, used by the Budgets & Categories tab.

// Preset palette for the swatch picker — the seed colors plus a few extras.
export const CATEGORY_COLORS = [
  "#ff9500", "#ff9f0a", "#ffcc00", "#30d158", "#34c759", "#14b8a6",
  "#0a84ff", "#5e5ce6", "#64d2ff", "#bf5af2", "#a78bfa", "#ff375f",
  "#ff453a", "#ff6b6b", "#f97316", "#94a3b8", "#9ca3af", "#888888",
];

export function ColorCell({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-5 h-5 rounded border border-gray-300 shadow-sm"
        style={{ background: value ?? "#ffffff" }}
        title="Change color"
      />
      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 mt-1 p-2 bg-white border border-gray-200 rounded-lg shadow-xl w-44">
            <div className="grid grid-cols-6 gap-1.5">
              {CATEGORY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onPick(c);
                    setOpen(false);
                  }}
                  className={`w-5 h-5 rounded border ${
                    value === c ? "ring-2 ring-offset-1 ring-gray-900 border-white" : "border-gray-300"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <label className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 text-xs text-gray-600">
              Custom
              <input
                type="color"
                value={value ?? "#888888"}
                onChange={(e) => onPick(e.target.value)}
                className="w-7 h-6 p-0 border-0 bg-transparent cursor-pointer"
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

export function RenameableName({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editable || !editing) {
    return (
      <span
        className="text-gray-900 cursor-text"
        onDoubleClick={() => {
          if (!editable) return;
          setDraft(value);
          setEditing(true);
        }}
        title={editable ? "Double-click to rename" : ""}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="border border-gray-200 rounded px-1.5 py-0.5 text-sm bg-white"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}
