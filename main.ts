// Tiny bars-replay bot: buy brief dips only while the short trend still points up.
// It speaks agent-fun/bars-replay/v1 directly: hello in, one reply per batch out, done ends it.
// Orders decided on a bar fill at the next open, so entries wait for a dip to stop falling and
// exits bank small gains quickly instead of riding every hourly swing to the end.

import { createInterface } from 'node:readline';

type U64 = string;
type Side = 'buy' | 'sell';

interface HelloSymbol { symbol: string; mint: string; price_scale: number; qty_scale: number }
interface Capital { quote: 'USDC'; quote_scale: number; quote_units: U64 }
interface Caps { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number; shorts: false; leverage: false }
interface Fees { fee_bps: number; slippage_bps: number; min_notional_quote_units: U64 }
interface Hello {
  type: 'hello'; protocol: string; seed: U64; symbols: HelloSymbol[]; capital: Capital;
  bar_interval: string; first_close_ms: number; caps: Caps; fees: Fees; latency_bars: number;
  warmup_bars?: number;
}
interface Bar { symbol: string; t: number; o: U64; h: U64; l: U64; c: U64; v: U64 | null; o_depth: U64[]; c_depth: U64[] }
interface Position { symbol: string; qty: U64; cost_quote_units: U64 }
interface Account { cash_quote_units: U64; positions: Position[]; equity_quote_units: U64 }
interface Fill {
  client_id: string; symbol: string; side: Side; status: 'filled' | 'rejected'; reason: string | null;
  decided_bar: number; fill_bar: number; price: U64; qty: U64; notional_quote_units: U64; fee_quote_units: U64;
}
interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account }
interface Done { type: 'done'; seq: number; reason: string; account: Account }
interface BuyOrder { side: 'buy'; client_id: string; symbol: string; notional_quote_units: U64; max_slippage_bps: number }
interface SellOrder { side: 'sell'; client_id: string; symbol: string; qty: U64; max_slippage_bps: number }
type Order = BuyOrder | SellOrder;

const BPS = 10_000n;
const BUY_SLIPPAGE_BPS = 180;
const SELL_SLIPPAGE_BPS = 240;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

function ema(values: number[], span: number): number | null {
  if (values.length < span) return null;
  let e = mean(values.slice(0, span));
  const k = 2 / (span + 1);
  for (let i = span; i < values.length; i++) e += k * (values[i] - e);
  return e;
}

function ret(values: number[], n: number): number | null {
  if (values.length <= n) return null;
  const a = values[values.length - 1 - n];
  const b = values[values.length - 1];
  return a > 0 ? b / a - 1 : null;
}

class BotState {
  hello: Hello | null = null;
  seq = -1;
  cash = 0n;
  equity = 0n;
  positions = new Map<string, { qty: bigint; cost: bigint }>();
  latest = new Map<string, Bar>();
  symbols = new Map<string, HelloSymbol>();
  closes = new Map<string, number[]>();
  fresh = new Set<string>();
  peakValue = new Map<string, bigint>();
  entrySeq = new Map<string, number>();
  filledTrades = 0;
  nextId = 1;

  get warmupBars(): number {
    return this.hello?.warmup_bars ?? 0;
  }

  get warmingUp(): boolean {
    return this.warmupBars > 0 && this.seq < this.warmupBars;
  }

  setHello(hello: Hello): void {
    this.hello = hello;
    this.cash = BigInt(hello.capital.quote_units);
    this.equity = this.cash;
    for (const s of hello.symbols) {
      this.symbols.set(s.symbol, s);
      this.closes.set(s.symbol, []);
    }
  }

  priceFloat(bar: Bar): number {
    const s = this.symbols.get(bar.symbol);
    const scale = s ? s.price_scale : 0;
    return Number(BigInt(bar.c)) / 10 ** scale;
  }

  closeBig(symbol: string): bigint | null {
    const b = this.latest.get(symbol);
    return b === undefined ? null : BigInt(b.c);
  }

  value(symbol: string, qty: bigint): bigint {
    const s = this.symbols.get(symbol);
    const p = this.closeBig(symbol);
    if (s === undefined || p === null || this.hello === null) return 0n;
    const num = qty * p * 10n ** BigInt(this.hello.capital.quote_scale);
    const den = 10n ** BigInt(s.qty_scale + s.price_scale);
    return num / den;
  }

  weightRoom(symbol: string): bigint {
    if (this.hello === null) return 0n;
    const held = this.positions.get(symbol);
    const room = (BigInt(this.hello.caps.max_weight_bps) * this.equity) / BPS - this.value(symbol, held?.qty ?? 0n);
    return room > 0n ? room : 0n;
  }

  impactBps(symbol: string, amount: bigint): number | null {
    const b = this.latest.get(symbol);
    if (b === undefined || this.hello === null) return null;
    const raw = Number(amount) * 10 ** (6 - this.hello.capital.quote_scale);
    let inv = 0;
    for (const d of b.c_depth) {
      const depth = Number(BigInt(d));
      if (depth > 0) inv += 1 / depth;
    }
    return raw * inv * 10_000;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.fresh.clear();
    for (const bar of batch.bars) {
      if (!this.symbols.has(bar.symbol)) continue;
      this.latest.set(bar.symbol, bar);
      this.fresh.add(bar.symbol);
      const arr = this.closes.get(bar.symbol);
      if (arr !== undefined) arr.push(this.priceFloat(bar));
    }
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      this.filledTrades++;
      if (f.side === 'buy') this.entrySeq.set(f.symbol, batch.seq);
    }
    this.cash = BigInt(batch.account.cash_quote_units);
    this.equity = BigInt(batch.account.equity_quote_units);
    this.positions.clear();
    for (const p of batch.account.positions) {
      this.positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
    }
    for (const symbol of [...this.peakValue.keys()]) {
      if (!this.positions.has(symbol)) this.peakValue.delete(symbol);
    }
    for (const symbol of [...this.entrySeq.keys()]) {
      if (!this.positions.has(symbol)) this.entrySeq.delete(symbol);
    }
    for (const [symbol, held] of this.positions) {
      const v = this.value(symbol, held.qty);
      const old = this.peakValue.get(symbol);
      if (old === undefined || v > old) this.peakValue.set(symbol, v);
      if (!this.entrySeq.has(symbol)) this.entrySeq.set(symbol, batch.seq);
    }
  }

  clientId(): string {
    return `o${this.nextId++}`;
  }
}

interface Metrics {
  symbol: string;
  score: number;
  z: number;
  ret3: number;
  ret6: number;
  ret12: number;
  ret24: number;
  trendUp: boolean;
  trendBroken: boolean;
  dip: boolean;
  stabilized: boolean;
  drawdown: number;
  breadthUp: boolean;
}

function metrics(state: BotState, symbol: string): Metrics | null {
  const values = state.closes.get(symbol);
  if (values === undefined || values.length < 16) return null;
  const close = values[values.length - 1];
  const prev = values[values.length - 2];
  const fast = ema(values, 5);
  const slow = ema(values, 15);
  const long = ema(values, 27) ?? slow;
  const micro = ema(values, 3);
  if (fast === null || slow === null || long === null || micro === null || slow <= 0) return null;
  const window = values.slice(values.length - 15);
  const m = mean(window);
  const sd = stdev(window);
  const z = sd > 0 ? (close - m) / sd : 0;
  const r3 = ret(values, 3) ?? 0;
  const r6 = ret(values, 6) ?? r3;
  const r12 = ret(values, 12) ?? r6;
  const r24 = ret(values, 24) ?? r12;
  const logs: number[] = [];
  for (let i = Math.max(1, values.length - 24); i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) logs.push(Math.log(values[i] / values[i - 1]));
  }
  const vol = Math.max(stdev(logs), 0.003);
  const look = values.slice(Math.max(0, values.length - 36));
  const dd = close / Math.max(...look) - 1;
  const trendUp = fast > slow && close > slow * 0.995 && close > long * 0.99;
  const trendBroken = fast < slow || close < slow * 0.995;
  const dip = z <= -1.05 && r3 < 0;
  const stabilized = close >= prev || close > micro;
  const score = (fast / slow - 1) / vol + (-z) * 0.45 + (r12 / (vol * Math.sqrt(12))) * 0.25;
  return {
    symbol,
    score,
    z,
    ret3: r3,
    ret6: r6,
    ret12: r12,
    ret24: r24,
    trendUp,
    trendBroken,
    dip,
    stabilized,
    drawdown: dd,
    breadthUp: fast > slow && r12 > 0,
  };
}

function decide(state: BotState): Order[] {
  if (state.hello === null || state.warmingUp) return [];
  const { caps, fees } = state.hello;
  const minNotional = BigInt(fees.min_notional_quote_units);
  const all: Metrics[] = [];
  for (const s of state.hello.symbols) {
    const x = metrics(state, s.symbol);
    if (x !== null) all.push(x);
  }
  if (all.length === 0) return [];
  const bySymbol = new Map(all.map((x) => [x.symbol, x]));
  const indexRet24 = mean(all.map((x) => x.ret24));
  const indexRet6 = mean(all.map((x) => x.ret6));
  const breadth = all.filter((x) => x.breadthUp).length / all.length;
  const riskOn = indexRet24 > 0.01 && breadth >= 0.71 && indexRet6 > 0.002;
  const riskOff = indexRet24 < -0.01 || breadth < 0.34;
  const maxPositions = riskOn ? 4 : riskOff ? 2 : 3;
  const baseStake = riskOn ? 0.2 : riskOff ? 0.08 : 0.14;

  const orders: Order[] = [];
  const sold = new Set<string>();
  const pushSell = (symbol: string, qty: bigint): void => {
    if (qty <= 0n || orders.length >= caps.max_orders_per_bar) return;
    orders.push({ side: 'sell', client_id: state.clientId(), symbol, qty: qty.toString(), max_slippage_bps: SELL_SLIPPAGE_BPS });
    sold.add(symbol);
  };

  for (const [symbol, held] of state.positions) {
    if (!state.fresh.has(symbol)) continue;
    const value = state.value(symbol, held.qty);
    const peak = state.peakValue.get(symbol) ?? value;
    const age = state.seq - (state.entrySeq.get(symbol) ?? state.seq);
    const x = bySymbol.get(symbol);
    const takeProfit = value * 1000n >= held.cost * 1018n;
    const stop = value * 1000n <= held.cost * 965n;
    const trailing = peak * 100n >= held.cost * 103n && value * 1000n <= peak * 985n;
    const trendExit = x !== undefined && x.trendBroken && value * 100n < held.cost * 101n;
    const timeStop = age >= 18 && value * 1000n <= held.cost * 1005n;
    if (takeProfit || stop || trailing || trendExit || timeStop) pushSell(symbol, held.qty);
  }

  const safeguard = state.seq >= 42 && state.seq < 68 && state.filledTrades < 8;
  const zNeed = riskOn ? -0.95 : riskOff ? -1.55 : -1.15;
  const entries = all
    .filter((x) => state.fresh.has(x.symbol) && !state.positions.has(x.symbol) && !sold.has(x.symbol))
    .filter((x) => x.trendUp && x.dip && x.stabilized && x.z <= zNeed && x.drawdown > -0.09)
    .filter((x) => !riskOff || (indexRet6 > -0.02 && x.ret24 > -0.06))
    .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));

  if (riskOn) {
    const core = all
      .filter((x) => state.fresh.has(x.symbol) && !state.positions.has(x.symbol) && !sold.has(x.symbol))
      .filter((x) => x.trendUp && x.ret12 > 0.005 && x.ret24 > 0.01 && x.drawdown > -0.04 && x.z < 0.8)
      .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));
    for (const x of core) {
      if (!entries.some((e) => e.symbol === x.symbol)) entries.push(x);
    }
  }

  if (safeguard && entries.length === 0) {
    const relaxed = all
      .filter((x) => state.fresh.has(x.symbol) && !state.positions.has(x.symbol) && !sold.has(x.symbol))
      .filter((x) => x.drawdown > -0.1 && x.ret12 > -0.02)
      .sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1))
      .slice(0, 2);
    entries.push(...relaxed);
  }

  let cash = state.cash;
  let openCount = state.positions.size - sold.size;
  for (const x of entries) {
    if (orders.length >= caps.max_orders_per_bar) break;
    if (openCount >= Math.min(maxPositions, caps.max_open_positions)) break;
    const stakePct = Math.min((x.dip ? baseStake : 0.18) + (x.score > 1.2 ? 0.04 : 0), 0.24);
    let amount = BigInt(Math.floor(Number(state.equity) * stakePct));
    const room = state.weightRoom(x.symbol);
    if (amount > room) amount = room;
    if (amount > cash) amount = cash;
    const minBuy = minNotional > state.equity / 100n ? minNotional : state.equity / 100n;
    if (amount < minNotional || amount < minBuy) continue;
    const impact = state.impactBps(x.symbol, amount);
    if (impact !== null && impact > 200) continue;
    orders.push({ side: 'buy', client_id: state.clientId(), symbol: x.symbol, notional_quote_units: amount.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS });
    cash -= amount;
    openCount++;
  }

  return orders;
}

async function main(): Promise<void> {
  const state = new BotState();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as { type?: string };
    if (msg.type === 'hello') {
      state.setHello(msg as Hello);
    } else if (msg.type === 'batch') {
      const batch = msg as Batch;
      state.applyBatch(batch);
      const orders = decide(state);
      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
    } else if (msg.type === 'done') {
      return;
    }
  }
}

await main();
