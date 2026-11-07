// Short labels for the networks stored in pools.chain, for the compact badges
// on ranked rows. Anything not listed falls back to its first four letters.
const SHORT: Record<string, string> = {
  ethereum: "ETH",
  solana: "SOL",
  bsc: "BSC",
  base: "BASE",
  arbitrum: "ARB",
  polygon: "POL",
  optimism: "OP",
  avalanche: "AVAX",
  cronos: "CRO",
  near: "NEAR",
  xrpl: "XRPL",
  tron: "TRX",
  pulsechain: "PLS",
  robinhood: "HOOD",
  zksync: "ZK",
  starknet: "STRK",
  fantom: "FTM",
  linea: "LINEA",
  scroll: "SCRL",
  sonic: "S",
  seiv2: "SEI",
  aptos: "APT",
  unichain: "UNI",
  opbnb: "OPBNB",
};

const FULL: Record<string, string> = {
  bsc: "BNB Chain",
  xrpl: "XRP Ledger",
  zksync: "zkSync",
  seiv2: "Sei",
  opbnb: "opBNB",
};

export function networkShort(network: string): string {
  return SHORT[network] ?? network.slice(0, 4).toUpperCase();
}

export function networkName(network: string): string {
  return FULL[network] ?? network.charAt(0).toUpperCase() + network.slice(1);
}
