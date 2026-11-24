// Momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Buys only mature curves whose 50-slot tape shows real buy pressure: net SOL
// flowing in, several distinct buyers, buys dominating the tape, the price up
// and sitting near its window high, inflow accelerating into the second half,
// and no single buyer dominating (anti-bundle). Small first buy, one pyramid
// into a 10% rise, hard exits on stop loss, trailing stop, fading tape, or age.
// Fully deterministic: no clock, no randomness, insertion-ordered maps only.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;
const WINDOW = 50;
const MIN_NET_SOL = 1.0;
const MIN_BUYERS = 4;
const MIN_BUY_SHARE = 0.65;
const MIN_PRICE_UP = 0.06;
const NEAR_HIGH = 0.96;
const MAX_BUYER_SHARE = 0.6;
const MIN_AGE = 240;
const FIRST_BUY_SOL = 0.05;
const ADD_BUY_SOL = 0.05;
const MAX_PER_COIN_SOL = 0.1;
const ADD_STEP = 0.1;
const STOP_LOSS = 0.15;
const TRAIL_DROP = 0.2;
const TRAIL_ARM = 0.1;
const MAX_HOLD = 1000;
const COOLDOWN = 200;
const MAX_POSITIONS = 5;
const CURVE_FEE = 0.0125;
const BUY_SLIP_BPS = 500;
const SELL_SLIP_BPS = 10_000;
const KEEP = WINDOW + 5;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number;
  invested: number;
  pyramided: boolean;
  lastBuyPrice: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

function priceOf(vq: bigint, vt: bigint): number {
  const q = Number(vq);
  const t = Number(vt);
  if (t <= 0) return 0;
  return q / t;
}

/** SOL received for selling `tokens` against these reserves, curve fee and tx fee off. */
function sellValueSol(tokens: number, vq: number, vt: number, txSol: number): number {
  if (vt + tokens <= 0) return 0;
  return ((tokens * vq) / (vt + tokens) / SOL) * (1 - CURVE_FEE) - txSol;
}

/** Net SOL (buys minus sells) recorded on the tape over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function entrySignal(t: Tape, now: number): boolean {
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (byUser.size < MIN_BUYERS) return false;
  const net = buySol - sellSol;
  if (net < MIN_NET_SOL) return false;
  if (buySol + sellSol <= 0) return false;
  if (buySol / (buySol + sellSol) < MIN_BUY_SHARE) return false;
  if (startPrice <= 0 || last <= 0) return false;
  if (last / startPrice - 1 < MIN_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  if (netNew <= 0 || netNew < netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > MAX_BUYER_SHARE * buySol) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txSol = Number(state.txFeeLamports()) / SOL;
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / SOL,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - KEEP) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;

    // Exits first.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const vq = Number(curve.virtual_quote_reserves);
      const vt = Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const cost = Number(pos.cost_lamports) / SOL;
      const value = sellValueSol(tokens, vq, vt, txSol);
      if (value > h.peak) h.peak = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peak >= cost * (1 + TRAIL_ARM) && value < h.peak * (1 - TRAIL_DROP)) exit = true;
      if (!exit && flow(t, now, WINDOW) < 0) exit = true;
      if (!exit && now - h.opened >= MAX_HOLD) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    }

    // Entries and the single pyramid add.
    let freeLamports = state.freeCashLamports();
    const firstLamports = BigInt(Math.floor(FIRST_BUY_SOL * SOL));
    const addLamports = BigInt(Math.floor(ADD_BUY_SOL * SOL));
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (h === undefined) {
        if (state.committedPositionCount() >= MAX_POSITIONS) continue;
        if (now - t.lastExit < COOLDOWN) continue;
        if (!entrySignal(t, now)) continue;
        if (state.maxBuyLamports(mint) < firstLamports) continue;
        if (freeLamports < firstLamports + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: firstLamports, max_slippage_bps: BUY_SLIP_BPS });
        freeLamports -= firstLamports + state.txFeeLamports();
        held.set(mint, {
          opened: now,
          peak: 0,
          invested: FIRST_BUY_SOL,
          pyramided: false,
          lastBuyPrice: price,
          exiting: false,
          filled: false,
        });
      } else {
        if (h.exiting || !h.filled || h.pyramided) continue;
        if (h.invested + ADD_BUY_SOL > MAX_PER_COIN_SOL + 1e-9) continue;
        if (price < h.lastBuyPrice * (1 + ADD_STEP)) continue;
        if (state.maxBuyLamports(mint) < addLamports) continue;
        if (freeLamports < addLamports + state.txFeeLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: addLamports, max_slippage_bps: BUY_SLIP_BPS });
        freeLamports -= addLamports + state.txFeeLamports();
        h.invested += ADD_BUY_SOL;
        h.pyramided = true;
        h.lastBuyPrice = price;
      }
    }
    return orders;
  },
});
