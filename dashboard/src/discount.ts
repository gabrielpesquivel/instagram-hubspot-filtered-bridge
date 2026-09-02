// Event bus (mirrors action.ts / amendment.ts) announcing a discount code the
// agent just created, so the open composer can re-draft the AI reply with the
// code included.
export interface CreatedDiscount {
  code: string;
  amount: string;
}

let listeners: ((d: CreatedDiscount) => void)[] = [];

export function announceDiscount(d: CreatedDiscount) {
  for (const l of listeners) l(d);
}

export function onDiscount(listener: (d: CreatedDiscount) => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}
