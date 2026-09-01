import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./state/AppState";
import { installClientDiagnostics } from "./services/diagnostics";
import App from "./App";
import "./index.css";

// Webview-side error capture must be live before the first React render —
// a crash during boot is the most important thing to have on disk.
installClientDiagnostics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
