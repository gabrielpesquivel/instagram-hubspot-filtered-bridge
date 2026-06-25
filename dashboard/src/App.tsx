import { useEffect, useState } from "react";
import { Login } from "./Login";
import { Dashboard } from "./Dashboard";
import { ToolPicker } from "./ToolPicker";
import { InboxPage } from "./InboxPage";
import { EmailManager } from "./EmailManager";
import { Gangsheet } from "./Gangsheet";
import { DmManager } from "./DmManager";

type Tool = "picker" | "support" | "email" | "bridge" | "gangsheet" | "dms";

function toolFromHash(): Tool {
  const hash = window.location.hash;
  if (hash.startsWith("#/dms")) return "dms";
  if (hash.startsWith("#/bridge")) return "bridge";
  if (hash.startsWith("#/gangsheet")) return "gangsheet";
  if (hash.startsWith("#/email")) return "email";
  if (hash.startsWith("#/support")) return "support";
  return "picker";
}

export function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [tool, setTool] = useState<Tool>(toolFromHash);

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
  const goPicker = () => {
    window.location.hash = "#/";
  };
  const goSupport = () => {
    window.location.hash = "#/support";
  };

  if (tool === "support") return <InboxPage onLogout={logout} onBack={goPicker} />;
  if (tool === "email") return <EmailManager onLogout={logout} onBack={goSupport} />;
  if (tool === "bridge") return <Dashboard onLogout={logout} onBack={goSupport} />;
  if (tool === "dms")
    return (
      <DmManager
        onLogout={logout}
        onBack={() => {
          window.location.hash = "#/bridge";
        }}
      />
    );
  if (tool === "gangsheet") return <Gangsheet onLogout={logout} onBack={goPicker} />;
  return (
    <ToolPicker
      onLogout={logout}
      onSelect={(t) => {
        window.location.hash = `#/${t}`;
      }}
    />
  );
}
