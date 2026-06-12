import { useEffect, useState } from "react";

export interface ToastItem {
  id: number;
  text: string;
  kind: "error" | "success" | "info";
}

let listeners: ((t: ToastItem) => void)[] = [];
let nextId = 1;

/** Fire a toast from anywhere (components, fetch handlers). */
export function toast(text: string, kind: ToastItem["kind"] = "error") {
  const item: ToastItem = { id: nextId++, text, kind };
  for (const l of listeners) l(item);
}

const KIND_COLORS: Record<ToastItem["kind"], string> = {
  error: "#d32f2f",
  success: "#2e7d32",
  info: "#1565c0",
};

/** Mount once near the app root. */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = (t: ToastItem) => {
      setItems((prev) => [...prev.slice(-4), t]);
      setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== t.id));
      }, 5000);
    };
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div style={styles.stack}>
      {items.map((t) => (
        <div
          key={t.id}
          style={{ ...styles.toast, background: KIND_COLORS[t.kind] }}
          onClick={() => setItems((prev) => prev.filter((i) => i.id !== t.id))}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: "fixed",
    bottom: "1.5rem",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    zIndex: 1000,
    maxWidth: "90vw",
  },
  toast: {
    color: "#fff",
    padding: "0.7rem 1.2rem",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    fontSize: "0.85rem",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
  },
};
