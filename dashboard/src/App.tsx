import { useEffect, useState } from "react";
import { Login } from "./Login";
import { Dashboard } from "./Dashboard";
import { ToolPicker } from "./ToolPicker";
import { InboxPage } from "./InboxPage";
import { EmailManager } from "./EmailManager";
import { Gangsheet } from "./Gangsheet";
import { DmManager } from "./DmManager";
import { Sentiment } from "./Sentiment";
import { StockTake } from "./StockTake";
import { Roster } from "./Roster";
import { SideNav, type NavTool } from "./SideNav";
import { TopBar } from "./TopBar";

const TITLES: Record<NavTool, string> = {
  picker: "Home",
  support: "Support Assistant",
  email: "Email Manager",
  dms: "Instagram DMs",
  gangsheet: "Gangsheet Generator",
  sentiment: "Customer Sentiment",
  stocktake: "Stock View",
  roster: "Roster",
  bridge: "Dashboard",
};

function toolFromHash(): NavTool {
  const hash = window.location.hash;
  if (hash.startsWith("#/dms")) return "dms";
  if (hash.startsWith("#/bridge")) return "bridge";
  if (hash.startsWith("#/gangsheet")) return "gangsheet";
  if (hash.startsWith("#/email")) return "email";
  if (hash.startsWith("#/support")) return "support";
  if (hash.startsWith("#/sentiment")) return "sentiment";
  if (hash.startsWith("#/stocktake")) return "stocktake";
  if (hash.startsWith("#/roster")) return "roster";
  return "picker";
}

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [tool, setTool] = useState<NavTool>(toolFromHash);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => setLoggedIn(res.ok))
      .catch(() => setLoggedIn(false));
  }, []);

  useEffect(() => {
    const onHashChange = () => setTool(toolFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (loggedIn === null) return null;

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  const logout = () => {
    fetch("/api/logout", { method: "POST" });
    window.location.hash = "";
    setLoggedIn(false);
  };

  let page: React.ReactNode;
  if (tool === "support") page = <InboxPage />;
  else if (tool === "email") page = <EmailManager />;
  else if (tool === "bridge") page = <Dashboard />;
  else if (tool === "dms") page = <DmManager />;
  else if (tool === "gangsheet") page = <Gangsheet />;
  else if (tool === "sentiment") page = <Sentiment />;
  else if (tool === "stocktake") page = <StockTake />;
  else if (tool === "roster") page = <Roster />;
  else page = <ToolPicker />;

  return (
    <div className="app-shell">
      <SideNav active={tool} />
      <main className="app-main">
        <TopBar title={TITLES[tool]} onLogout={logout} />
        <div className="app-page">{page}</div>
      </main>
    </div>
  );
}
