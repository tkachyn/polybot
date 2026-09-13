import "@fontsource/sora/400.css";
import "@fontsource/sora/500.css";
import "@fontsource/sora/600.css";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/600.css";
import "./styles/tokens.css";
import "./styles/global.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { preloadFightIntro } from "./features/fight/introVideo";
import { FightsProvider } from "./state/fights";
import { SessionProvider } from "./state/session";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element.");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SessionProvider>
        <FightsProvider>
          <App />
        </FightsProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);

// The fight intro downloads in the background once the page itself has
// loaded, so it plays with no wait whenever a fight is about to start.
if (document.readyState === "complete") void preloadFightIntro();
else window.addEventListener("load", () => void preloadFightIntro(), { once: true });
