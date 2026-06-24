// Placeholder only — confirms React + TypeScript + Vite + Tailwind + the shared
// @brokerforce/types package all wire together. Real UI for 001 Dashboard (and
// every other spec) is its own piece of work, per docs/Product_Principles.md's
// "nothing gets coded until there's a spec" discipline — this file exists to
// validate the scaffold, not to get ahead of it.
import type { AssetClass } from "@brokerforce/types";

const exampleClasses: AssetClass[] = ["blue-chip", "stable", "growth-exotic", "degen"];

export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900">BrokerForce</h1>
        <p className="text-neutral-500">Scaffold online. Tracked asset classes: {exampleClasses.join(", ")}.</p>
      </div>
    </div>
  );
}
