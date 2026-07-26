import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initThemeFromStorage } from "./hooks/useTheme";
import "./styles/global.css";

initThemeFromStorage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
