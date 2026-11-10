import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource-variable/unbounded";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/dialog.css";
import "./styles/player.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
