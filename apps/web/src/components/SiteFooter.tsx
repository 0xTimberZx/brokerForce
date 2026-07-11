// Persistent, site-wide not-financial-advice disclaimer. A disclaimer that
// only lives in docs/legal/ protects nobody -- it has to be where users
// actually are, on every page. Kept deliberately quiet (muted, hairline-ruled,
// no accent) so it reads as a standing legal notice, not a call to action, but
// it is always present. Full text: docs/legal/DISCLAIMER.md and TERMS.md.

export function SiteFooter() {
  return (
    <footer className="border-t border-line mt-16">
      <div className="max-w-5xl mx-auto px-6 md:px-10 py-6 space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Informational only — not financial advice
        </p>
        <p className="font-body text-xs text-ink-muted max-w-prose leading-relaxed">
          BrokerForce is an analytics tool. ORT scores, rankings, and metrics are for general
          information only and are not investment, trading, legal, or tax advice, nor a
          recommendation to buy, sell, or hold any asset. Data may be inaccurate, delayed, or
          incomplete; DeFi carries risk of total loss. Do your own research — any decision is
          your own, made at your own risk.
        </p>
      </div>
    </footer>
  );
}
