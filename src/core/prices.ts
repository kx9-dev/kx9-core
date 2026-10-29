import { ethers } from "ethers";
import { coreConfig } from "./config";
import { ABI, provider, requireMainnet } from "./chain";
import { ASSETS, type Asset } from "./types";

type Price = {price: number | null; open: number | null; source: "chainlink" | null; stale: boolean; updatedAt: string | null; history: {at: string; value: number}[]};
type Market = {until: number; prices: Record<Asset, Price>; sequencerUp: boolean | null};
let cache: Market | null = null;
let pending: Promise<Market> | null = null;
export async function prices(): Promise<Market> {
  if (cache && cache.until > Date.now()) return cache;
  if (pending) return pending;
  pending = (async () => {
    const c = coreConfig();
    const data = Object.fromEntries(ASSETS.map(a => [a, {price: null, open: null, source: null, stale: true, updatedAt: null, history: cache?.prices[a].history || []}])) as Record<Asset, Price>;
    let sequencerUp: boolean | null = null;
    if (Object.keys(c.feeds).length) {
      await requireMainnet();
      if (c.sequencerFeed) {
        try {
          const [, answer, startedAt] = await new ethers.Contract(c.sequencerFeed, ABI.feed, provider()).latestRoundData();
          sequencerUp = answer === 0n && Date.now() / 1000 - Number(startedAt) > 3600;
        } catch { sequencerUp = false; }
      }
      await Promise.all(ASSETS.map(async a => {
        if (!c.feeds[a]) return;
        try {
          const f = new ethers.Contract(c.feeds[a]!, ABI.feed, provider());
          const [[round, answer, , updated, answeredRound], dec] = await Promise.all([f.latestRoundData(), f.decimals()]);
          const age = Date.now() / 1000 - Number(updated), value = Number(answer) / 10 ** Number(dec);
          // Fail closed; never extend stock-feed freshness just to make a
          // paused market look tradable. Every accepted price is timestamped.
          if (answer <= 0n || answeredRound < round || age < -30 || age > 3600 || !Number.isFinite(value) || sequencerUp !== true) return;
          const at = new Date(Number(updated) * 1000).toISOString();
          const observations = [...data[a].history];
          if (observations.at(-1)?.at !== at) observations.push({at, value});
          const today = new Date().toISOString().slice(0, 10);
          const opening = observations.find(h => h.at.startsWith(today))?.value ?? value;
          data[a] = {price: value, open: opening, source: "chainlink", stale: false, updatedAt: at, history: observations.slice(-400)};
        } catch { /* A failed feed remains explicitly unavailable. */ }
      }));
    }
    cache = {until: Date.now() + 15000, prices: data, sequencerUp};
    return cache;
  })().finally(() => {pending = null;});
  return pending;
}
