import { useState } from "react";
import { Login } from "./Login";
import { Dashboard } from "./Dashboard";

export function App() {
  const [loggedIn, setLoggedIn] = useState(false);

  if (!loggedIn) {
    return <Login onLogin={() => setLoggedIn(true)} />;
  }

  return (
    <Dashboard
      onLogout={() => {
        fetch("/api/logout", { method: "POST" });
        setLoggedIn(false);
      }}
    />
  );
}
