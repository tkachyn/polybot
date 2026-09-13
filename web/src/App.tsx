import { Route, Routes } from "react-router-dom";
import { NotFoundPage } from "./app/NotFoundPage";
import { AppShell } from "./components/AppShell";
import { EvaluationsPage } from "./features/evaluation/EvaluationsPage";
import { JudgeStandingsPage } from "./features/demo/JudgeStandingsPage";
import { FightRoute } from "./features/fight/FightRoute";
import { HomePage } from "./features/home/HomePage";
import { PortfolioPage } from "./features/portfolio/PortfolioPage";
import { ResolvedPage } from "./features/resolved/ResolvedPage";
import { WalletPage } from "./features/wallet/WalletPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="resolved" element={<ResolvedPage />} />
        <Route path="fights/:raceId" element={<FightRoute />} />
        <Route path="fights/:raceId/standings" element={<JudgeStandingsPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="evaluations" element={<EvaluationsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
