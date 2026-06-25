import { useTheme } from "./theme";

/** Small light/dark switch. Sits next to Log out in page headers. */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const dark = theme === "dark";
  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle light/dark mode"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.4rem 0.9rem",
        background: "var(--surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: "8px",
        cursor: "pointer",
        fontSize: "0.8rem",
        fontWeight: 600,
        lineHeight: 1,
        color: "var(--text-muted)",
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
