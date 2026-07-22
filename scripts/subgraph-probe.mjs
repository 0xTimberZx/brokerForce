// TEMPORARY discovery probe for spec 012 (Uniswap-v3 subgraph enrichment).
// Runs ONLY on a CI runner (open egress + GRAPH_API_KEY secret); reverted
// before the real feature PR. It answers the open questions the spec flagged:
//   1. Which per-chain v3 subgraph deployment IDs actually resolve.
//   2. The `pool.ticks` field names + realistic tick density (to set the cap).
//   3. `poolDayDatas` tx-count semantics (per-day vs cumulative) -> swap_count_7d.
//   4. Whether `liquidityProviderCount` is 0 (confirms the unique_lp_count defer).
// Node 20 global fetch; no deps.

const KEY = process.env.GRAPH_API_KEY;
if (!KEY) {
  console.error("GRAPH_API_KEY not set");
  process.exit(1);
}

const GATEWAY = (id) => `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/${id}`;

// Candidate Uniswap-v3 deployment IDs per chain (from memory / public docs) --
// the probe's job is to CONFIRM or refute each. A known v3 pool per chain lets
// us actually pull ticks/dayData where the endpoint resolves.
const CHAINS = [
  { chain: "ethereum", id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, // USDC/WETH 0.05%
  { chain: "arbitrum", id: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM", pool: "0xc6962004f452be9203591991d15f6b388e09e8d0" }, // WETH/USDC 0.05%
  { chain: "polygon", id: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm", pool: "0x45dda9cb7c25131df268515131f647d726f50608" }, // USDC/WETH 0.05%
  { chain: "optimism", id: "Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj", pool: "0x85149247691df622eaf1a8bd0cafd40bc45154a9" }, // WETH/USDC 0.05%
  { chain: "base", id: "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG", pool: "0xd0b53d9277642d899df5c87a3966a349a798f224" }, // WETH/USDC 0.05%
  { chain: "bsc", id: "F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2", pool: "0x172fcd41e0913e95784454622d1c3724f546f849" }, // WETH/USDT 0.05% (BSC)
];

async function gql(url, query, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { httpStatus: res.status, raw: text.slice(0, 400) };
  }
  return { httpStatus: res.status, ...json };
}

const META = `{ _meta { block { number } deployment } }`;

// poolDayDatas is a TOP-LEVEL entity (filtered by pool), NOT a nested field on
// Pool -- the first probe proved `Type Pool has no field poolDayDatas`. Ticks
// and liquidityProviderCount ARE on Pool. One request, two roots.
const POOL_QUERY = `
query Pool($id: ID!, $addr: String!) {
  pool(id: $id) {
    id
    feeTier
    liquidity
    tick
    token0Price
    token1Price
    txCount
    liquidityProviderCount
    totalValueLockedUSD
    volumeUSD
    ticksNearby: ticks(first: 8, orderBy: liquidityGross, orderDirection: desc) {
      tickIdx
      liquidityGross
      liquidityNet
      price0
      price1
    }
  }
  poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: $addr }) {
    date
    txCount
    volumeUSD
  }
}`;

for (const { chain, id, pool } of CHAINS) {
  console.log(`\n===== ${chain}  (id ${id}) =====`);
  const url = GATEWAY(id);
  try {
    const meta = await gql(url, META);
    if (meta.errors || meta.httpStatus >= 400 || !meta.data?._meta) {
      console.log(`  _meta FAILED  http=${meta.httpStatus}  errors=${JSON.stringify(meta.errors) || meta.raw}`);
      continue;
    }
    console.log(`  _meta OK  block=${meta.data._meta.block.number}  deployment=${meta.data._meta.deployment}`);

    const r = await gql(url, POOL_QUERY, { id: pool, addr: pool });
    if (r.errors) {
      console.log(`  pool query errors: ${JSON.stringify(r.errors)}`);
      continue;
    }
    const p = r.data?.pool;
    if (!p) {
      console.log(`  pool ${pool} -> null (wrong address for this chain? endpoint still OK)`);
      continue;
    }
    console.log(`  pool ${p.id}  fee=${p.feeTier}  tick=${p.tick}  txCount(cumulative)=${p.txCount}`);
    console.log(`  liquidityProviderCount=${p.liquidityProviderCount}  (0 confirms unique_lp defer)`);
    const dd = r.data?.poolDayDatas || [];
    console.log(`  poolDayDatas[${dd.length}] (date / txCount / volUSD):`);
    for (const d of dd) {
      console.log(`    ${new Date(d.date * 1000).toISOString().slice(0, 10)}  txCount=${d.txCount}  vol=$${Math.round(Number(d.volumeUSD))}`);
    }
    console.log(`  ticks (top 8 by liquidityGross): tickIdx / liquidityGross / price0`);
    for (const t of p.ticksNearby || []) {
      console.log(`    ${t.tickIdx}  Lg=${t.liquidityGross}  price0=${t.price0}`);
    }
  } catch (e) {
    console.log(`  EXCEPTION ${e.message}`);
  }
}
console.log("\n===== probe complete =====");
