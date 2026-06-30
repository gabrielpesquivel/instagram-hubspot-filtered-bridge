// Event bus (mirrors toast.tsx / amendment.ts) for proposed order actions the
// AI detected while drafting. The ActionPrompt card's "Review" opens a per-type
// modal that writes to Shopify (+ StarShipit) via /api/shopify/actions/*.
export interface ActionProposal {
  id: string;
  type: string;
  orderNumber?: string;
  summary: string; // "Update #18032 address"
  args: Record<string, unknown>;
}

let listeners: ((a: ActionProposal[]) => void)[] = [];

/** Enqueue one or more proposed actions for confirmation. */
export function showActions(actions: ActionProposal[]) {
  if (!actions?.length) return;
  for (const l of listeners) l(actions);
}

export function onActions(listener: (a: ActionProposal[]) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
