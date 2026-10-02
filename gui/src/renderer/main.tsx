import React from "react";
import ReactDOM from "react-dom/client";
import { setApiBaseUrl } from "./api/client";
import { App } from "./app/App";
import { AppProviders } from "./app/providers";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/features/reference.css";

setApiBaseUrl(window.desktopApi?.backendBaseUrl || "http://127.0.0.1:4001");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>
);
