import { createContext, useContext } from "react";
import type { Category } from "@/api/types";

export interface CategoryOption {
  id: number;
  label: string;
  depth: number;
  isParent: boolean;
}

/// Walks the category list and returns it in tree-render order:
/// parents alphabetically, each followed by its children alphabetically.
/// `label` already includes the visual indent for use as <option> text.
export function asTree(categories: Category[]): CategoryOption[] {
  const parents = categories
    .filter((c) => c.parent_id === null && !c.archived)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const childrenOf = (id: number) =>
    categories
      .filter((c) => c.parent_id === id && !c.archived)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

  const out: CategoryOption[] = [];
  for (const p of parents) {
    out.push({ id: p.id, label: p.name, depth: 0, isParent: true });
    for (const child of childrenOf(p.id)) {
      out.push({
        id: child.id,
        label: `    ↳ ${child.name}`,
        depth: 1,
        isParent: false,
      });
    }
  }
  return out;
}

/// Returns a lookup that resolves a category id to its display color. A
/// category with no color of its own inherits its parent's color, so the
/// seed taxonomy (colored parents, uncolored children) still shows meaningful
/// color on every ledger row.
export function makeColorResolver(
  categories: Category[],
): (id: number | null | undefined) => string | null {
  const byId = new Map<number, Category>(categories.map((c) => [c.id, c]));
  const cache = new Map<number, string | null>();
  return (id) => {
    if (id == null) return null;
    if (cache.has(id)) return cache.get(id)!;
    let cur: Category | undefined = byId.get(id);
    let color: string | null = null;
    let guard = 0;
    while (cur && guard < 20) {
      if (cur.color) {
        color = cur.color;
        break;
      }
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
      guard++;
    }
    cache.set(id, color);
    return color;
  };
}

export type ColorResolver = (id: number | null | undefined) => string | null;

/// Lets deeply-nested ledger rows read the active category-color resolver
/// without threading it through every grouping wrapper.
export const CategoryColorContext = createContext<ColorResolver>(() => null);
export const useCategoryColor = (): ColorResolver => useContext(CategoryColorContext);
