import { createRoot } from "react-dom/client";
import "./theme.css";
import "./theme"; // applies stored/OS theme before first paint
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
