import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ThemeToggle } from "./ThemeToggle";

// Shared sticky header across every tool: current tool name on the left,
// page-specific actions + theme toggle + log out on the right. Pages inject
// their own header buttons with <TopBarActions> (portals into the slot div).

interface TopBarProps {
  title: string;
  onLogout: () => void;
}

export function TopBar({ title, onLogout }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-spacer" />
      <span className="topbar-title">{title}</span>
      <div className="topbar-right">
        <div id="topbar-actions" className="topbar-actions" />
        <ThemeToggle />
        <button className="topbar-logout" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}

/** Render children into the top bar's action slot (right side, before the
 *  theme toggle). Use from any page for its own header buttons. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("topbar-actions"));
  }, []);
  return target ? createPortal(children, target) : null;
}
