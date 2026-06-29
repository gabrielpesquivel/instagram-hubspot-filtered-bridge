// Tiny event bus (mirrors toast.tsx) so any sender can surface a proposed
// guideline amendment in the bottom-right popup after an edited send.
export interface Amendment {
  id: string;
  at: string;
  customer: string;
  draft: string;
  corrected: string;
  rule: string;
}

let listeners: ((a: Amendment) => void)[] = [];

/** Pop up a proposed guideline amendment from anywhere. */
export function showAmendment(a: Amendment) {
  for (const l of listeners) l(a);
}

export function onAmendment(listener: (a: Amendment) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
