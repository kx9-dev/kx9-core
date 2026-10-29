import crypto from "node:crypto";
import { need, type Protocols, type Limits } from "./types";

export type ReplayInput = {protocol: keyof Protocols; asset: string; capital: number; history: {date: string; close: number}[]};
// Only caller-supplied dated market observations. No random walk or invented
// historical return is used, and results are never passed to live execution.
export function replay(input: ReplayInput, protocols: Protocols, limits?: Limits) {
  const {history, capital, protocol} = input;
  need(history.length >= 2 && history.length <= 366, 400, "VALIDATION_FAILED", "Upload between 2 and 366 daily prices.");
  const today = new Date().toISOString().slice(0, 10);
  history.forEach((h, i) => {
    need(/^\d{4}-\d{2}-\d{2}$/.test(h.date) && Number.isFinite(Date.parse(h.date)) && new Date(h.date).toISOString().slice(0, 10) === h.date && h.date <= today &&
      h.close > 0 && Number.isFinite(h.close) && (!i || h.date > history[i - 1]!.date), 400, "VALIDATION_FAILED", "Prices need unique, increasing UTC dates and positive closes, with no future dates.");
  });
  let cash = capital, quantity = 0, entry = 0, peak = capital, drawdown = 0, trades = 0, vetoes = 0;
  let lastBuy = -Infinity, dayUsed = 0, currentDay = "";
  const equity: number[] = [], hold = history.map(h => capital * h.close / history[0]!.close);
  for (let i = 0; i < history.length; i++) {
    const row = history[i]!, p = row.close, ms = Date.parse(row.date);
    if (row.date !== currentDay) {dayUsed = 0; currentDay = row.date;}
    let want = 0;
    const schedule = protocol === "physical" ? protocols.physical.every : protocols.accumulate.every;
    const period = schedule === "Daily" ? 86400000 : schedule === "Weekly" ? 7 * 86400000 : 30 * 86400000;
    if (protocol === "physical" || protocol === "accumulate") {
      if (ms - lastBuy >= period) want = protocol === "physical" ? protocols.physical.amount : protocols.accumulate.amount;
      if (protocol === "physical" && i && p / history[i - 1]!.close - 1 <= -protocols.physical.dip / 100) want += protocols.physical.dipAmount;
    }
    if (protocol === "balance") {
      const value = cash + quantity * p;
      const target = {"Growth 60/40": .6, "Balanced 40/60": .4, "Defensive 20/80": .2}[protocols.balance.target];
      if (Math.abs(quantity * p / value - target) * 100 > protocols.balance.drift) want = target * value - quantity * p;
    }
    if (protocol === "guard") {
      if (!i) want = capital * .7;
      if (quantity > 0 && (p / entry - 1 >= protocols.guard.tp / 100 || p / entry - 1 <= -protocols.guard.sl / 100)) want = -quantity * p;
    }
    if (protocol === "trend" && i >= protocols.trend.window - 1) {
      const average = history.slice(i - protocols.trend.window + 1, i + 1).reduce((sum, h) => sum + h.close, 0) / protocols.trend.window;
      if (p > average * 1.01 && quantity === 0) want = protocols.trend.size;
      if (p < average * .99 && quantity > 0) want = -quantity * p;
    }
    if (limits && (Math.abs(want) > limits.maxTrade || dayUsed + Math.abs(want) > limits.dailyCap || !limits.whitelist.includes(input.asset as never))) {if (want) vetoes++; want = 0;}
    if (want > 0) {
      const value = Math.min(want, cash);
      if (value > 0) {entry = (entry * quantity + value) / (quantity + value / p); quantity += value / p; cash -= value; trades++; dayUsed += value; lastBuy = ms;}
    } else if (want < 0) {
      const sell = Math.min(quantity, -want / p); if (sell > 0) {quantity -= sell; cash += sell * p; trades++; dayUsed += sell * p;}
    }
    const value = cash + quantity * p; peak = Math.max(peak, value); drawdown = Math.max(drawdown, (peak - value) / peak); equity.push(Math.round(value * 100) / 100);
  }
  return {id: crypto.randomUUID(), protocol, asset: protocol === "physical" ? "NVDA" : input.asset, capital,
    source: "operator-supplied historical prices", startDate: history[0]!.date, endDate: history.at(-1)!.date,
    returnPct: (equity.at(-1)! / capital - 1) * 100, holdReturnPct: (hold.at(-1)! / capital - 1) * 100,
    maxDrawdownPct: drawdown * 100, trades, vetoes, endingUsd: equity.at(-1), equity, hold,
    assumptions: "Daily closing prices; no fees, gas, liquidity, taxes or execution slippage. Historical testing is not a forecast or a live trade."};
}
