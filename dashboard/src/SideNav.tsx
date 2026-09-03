import type { ReactElement } from "react";

// Persistent left navigation, shown on every tool. Route = URL hash; the
// active item tracks the current tool from App. Collapses to an icon rail on
// narrow screens (see .sidenav rules in theme.css).

export type NavTool =
  | "picker"
  | "support"
  | "email"
  | "dms"
  | "gangsheet"
  | "sentiment"
  | "stocktake"
  | "roster"
  | "bridge";

interface NavItem {
  tool: NavTool;
  hash: string;
  label: string;
  icon: ReactElement;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ICONS = {
  home: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9v11h13V9" />
    </svg>
  ),
  support: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M21 12a8 8 0 1 0-3.1 6.3L21 19l-.7-3A7.9 7.9 0 0 0 21 12Z" />
    </svg>
  ),
  gangsheet: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M4 9h16M4 14.5h16M9.5 9v11.5" />
    </svg>
  ),
  sentiment: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14.5s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
      <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.4} />
    </svg>
  ),
  stocktake: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4M12 11v9" />
    </svg>
  ),
  roster: (
    <svg viewBox="0 0 24 24" {...stroke}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M8.5 13.5h2M13.5 13.5h2M8.5 17h2" />
    </svg>
  ),
};

const HOME: NavItem = { tool: "picker", hash: "#/", label: "Home", icon: ICONS.home };

// Always-visible sections (headings are labels, not collapsible).
const GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Customer Support",
    items: [
      { tool: "support", hash: "#/support", label: "Support Assistant", icon: ICONS.support },
      { tool: "sentiment", hash: "#/sentiment", label: "Customer Sentiment", icon: ICONS.sentiment },
    ],
  },
  {
    heading: "Operations",
    items: [
      { tool: "gangsheet", hash: "#/gangsheet", label: "Gangsheet Generator", icon: ICONS.gangsheet },
      { tool: "stocktake", hash: "#/stocktake", label: "Stock View", icon: ICONS.stocktake },
      { tool: "roster", hash: "#/roster", label: "Roster", icon: ICONS.roster },
    ],
  },
];

// Email / DMs / stats live inside Customer Support flows — those routes keep
// working but highlight the Customer Support entry.
function navActive(active: NavTool): NavTool {
  return active === "email" || active === "dms" || active === "bridge" ? "support" : active;
}

function NavLink({ item, current }: { item: NavItem; current: NavTool }) {
  return (
    <a
      href={item.hash}
      className={`sidenav-item${current === item.tool ? " active" : ""}`}
      aria-current={current === item.tool ? "page" : undefined}
      title={item.label}
      onClick={(e) => {
        e.preventDefault();
        window.location.hash = item.hash;
      }}
    >
      <span className="sidenav-icon">{item.icon}</span>
      <span className="sidenav-label">{item.label}</span>
    </a>
  );
}

interface SideNavProps {
  active: NavTool;
}

export function SideNav({ active }: SideNavProps) {
  const current = navActive(active);
  return (
    <nav className="sidenav" aria-label="Tools">
      <a
        href="#/"
        className="sidenav-logo"
        onClick={(e) => {
          e.preventDefault();
          window.location.hash = "#/";
        }}
      >
        <img src="/logo.png" alt="BootInk" />
      </a>

      <div className="sidenav-items">
        <NavLink item={HOME} current={current} />
        {GROUPS.map((group) => (
          <div key={group.heading} className="sidenav-group">
            <div className="sidenav-heading">{group.heading}</div>
            {group.items.map((item) => (
              <NavLink key={item.tool} item={item} current={current} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
