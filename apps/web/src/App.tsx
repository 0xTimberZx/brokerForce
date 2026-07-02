// Renders the real 003 Pair Analysis page -- the scaffold-confirmation
// placeholder this file used to be has done its job (proving React +
// TypeScript + Vite + Tailwind + @brokerforce/types wire together) now that
// there's an actual spec implementation to render instead. No router yet --
// 001 Dashboard and 002 Search, which would normally own navigation into
// this page, aren't built. This is the only page; add routing when there's
// a second one to route to, not before.
import { PairAnalysisPage } from "./pages/PairAnalysis";

export default function App() {
  return <PairAnalysisPage />;
}
