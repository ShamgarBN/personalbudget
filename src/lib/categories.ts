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
