// Surge Rider — a momentum paper-trading bot for the pump.fun replay
// (agent-fun/replay/v2, Node 22, zero dependencies, stdlib only besides the
// vendored SDK shim in vendor/makefun-bot.ts).
//
// Idea: most fresh pump.fun curves are bundled launches that get dumped.
// Wait until a curve is mature, then buy only when its recent tape shows
// real, broad buy pressure — net SOL flowing in, several distinct buyers,
// the price rising and sitting near its window high. First buy is small;
// one pyramid add follows only if the price keeps climbing. Every position
// carries a stop loss, a trailing stop once it is up, a fade exit when the
// tape turns seller-dominated, and a hard time limit.
//
// v2 (after the dev-window grade): v1 lost -0.92 SOL with a 28.9% win
// rate — entries too indiscriminate, losers held too long. v2 requires
// accelerating inflow and caps any single buyer's share (anti-bundle),
// raises the net-inflow bar, halves size per coin, and exits faster
// (stop -15%, trail 20% once up 10%, 1000-slot hold limit).
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, so
// two runs on the same window produce byte-identical action logs.
//
// Paper trading only: the replay uses market data, never real funds.
//
// DRAFT v1 (transcript-authored rewrite): net-inflow bar temporarily 1.1
// SOL; v2 final restores it to 1.2 SOL.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL); // 1e9 lamports

// ---- strategy parameters (v2: selective entry, faster exits) ----
// v1 graded -0.92 SOL on the dev window (354 fills, 108 coins, win rate
// 28.9%) — entries were too indiscriminate and losers were held too long.
// v2 tightens the entry (acceleration + anti-bundle buyer cap + more net
// inflow) and cuts losers sooner (stop -15%, trail 20%, hold 1000 slots),
// with smaller size per coin.
const WINDOW_SLOTS = 50; // tape window, in slots
const MIN_AGE_SLOTS = 240; // curve must be this old before an entry
const MIN_TRADES = 6; // trades inside the window
const MIN_BUYERS = 4; // distinct buying wallets inside the window
const MIN_NET_SOL = 1.1; // net SOL inflow (buys minus sells) in the window — DRAFT, final is 1.2
const MIN_BUY_SHARE = 0.65; // buys' share of window volume
const MIN_PRICE_UP = 0.06; // price now vs first trade in the window
const MAX_PRICE_UP = 2.0; // skip curves that already ran too far
const NEAR_HIGH = 0.96; // price now vs window high
const MIN_ACCEL = 1.0; // newer-half net inflow must be >= older-half net inflow
const MAX_BUYER_SHARE = 0.6; // largest single buyer's share of window buy SOL
const MIN_REAL_SOL = 3; // real SOL reserves at entry
const MAX_REAL_SOL = 90;
const FIRST_BUY_SOL = 0.05;
const ADD_BUY_SOL = 0.05;
const MAX_PER_COIN_SOL = 0.1;
const MAX_ENTRIES_PER_COIN = 2;
const ADD_PRICE_UP = 0.1; // pyramid only once price is 10% above last buy
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10_000;
const STOP_LOSS = 0.15; // exit when value < 85% of cost
const TRAIL_ARM = 0.1; // trailing stop arms once value >= 110% of cost
const TRAIL_DROP = 0.2; // exit when value < 80% of peak
const FADE_WINDOW_SLOTS = 15; // exit when net SOL over this window is negative
const FADE_NET_SOL = -0.3;
const MAX_HOLD_SLOTS = 1000;
const COOLDOWN_SLOTS = 200; // wait after an exit before re-entering a curve
const MAX_POSITIONS = 5; // caps.max_open_positions on the dev window

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number; // SOL per token, post-trade virtual reserves
}

interface Tape {
  createdSlot: number | null;
  trades: Trade[];
  entries: number;
  lastExitSlot: number;
}

interface Held {
  openedSlot: number;
  peakValueLamports: bigint;
  lastBuyPrice: number;
  buys: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function valueLamports(tokens: bigint, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): bigint {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

interface WindowStats {
  trades: number;
  buySol: number;
  sellSol: number;
  buyers: Set<string>;
  firstPrice: number;
  high: number;
  netNewer: number; // net SOL inflow in the newer half of the window
  netOlder: number; // net SOL inflow in the older half of the window
  maxBuyerSol: number; // largest single buyer's SOL in the window
}

function windowStats(tape: Tape, slot: number, windowSlots: number): WindowStats {
  const stats: WindowStats = {
    trades: 0,
    buySol: 0,
    sellSol: 0,
    buyers: new Set(),
    firstPrice: 0,
    high: 0,
    netNewer: 0,
    netOlder: 0,
    maxBuyerSol: 0,
  };
  const buyerSol = new Map<string, number>();
  const mid = slot - windowSlots / 2;
  for (const t of tape.trades) {
    if (t.slot < slot - windowSlots) continue;
    if (stats.trades === 0) stats.firstPrice = t.price;
    stats.trades += 1;
    const net = t.buy ? t.sol : -t.sol;
    if (t.slot >= mid) stats.netNewer += net;
    else stats.netOlder += net;
    if (t.buy) {
      stats.buySol += t.sol;
      stats.buyers.add(t.user);
      const total = (buyerSol.get(t.user) ?? 0) + t.sol;
      buyerSol.set(t.user, total);
      if (total > stats.maxBuyerSol) stats.maxBuyerSol = total;
    } else {
      stats.sellSol += t.sol;
    }
    if (t.price > stats.high) stats.high = t.price;
  }
  return stats;
}

function entrySignal(state: BotState, mint: Pubkey, tape: Tape): boolean {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  if (curve.created_slot === null) return false;
  if (state.slot - curve.created_slot < MIN_AGE_SLOTS) return false;
  const realSol = Number(curve.real_quote_reserves) / SOL;
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  const priceNow = priceOf(curve);
  if (priceNow <= 0) return false;
  const w = windowStats(tape, state.slot, WINDOW_SLOTS);
  if (w.trades < MIN_TRADES) return false;
  if (w.buyers.size < MIN_BUYERS) return false;
  const netSol = w.buySol - w.sellSol;
  if (netSol < MIN_NET_SOL) return false;
  const volume = w.buySol + w.sellSol;
  if (volume <= 0 || w.buySol / volume < MIN_BUY_SHARE) return false;
  const priceUp = priceNow / w.firstPrice - 1;
  if (priceUp < MIN_PRICE_UP || priceUp > MAX_PRICE_UP) return false;
  if (priceNow < NEAR_HIGH * w.high) return false;
  // Acceleration: inflow must be speeding up, not fading.
  if (w.netNewer < MIN_ACCEL * Math.max(w.netOlder, 0)) return false;
  // Anti-bundle: no single wallet may dominate the window's buying.
  if (w.buySol > 0 && w.maxBuyerSol / w.buySol > MAX_BUYER_SHARE) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Fold this batch's trades into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, { createdSlot: e.slot, trades: [], entries: 0, lastExitSlot: -1e9 });
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(e.mint);
        if (tape === undefined) {
          tape = { createdSlot: null, trades: [], entries: 0, lastExitSlot: -1e9 };
          tapes.set(e.mint, tape);
        }
        const curve = state.curves.get(e.mint);
        tape.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / SOL,
          user: e.user,
          price: curve !== undefined ? priceOf(curve) : 0,
        });
        // Prune trades far outside any window we use.
        while (tape.trades.length > 0 && tape.trades[0].slot < state.slot - WINDOW_SLOTS - MAX_HOLD_SLOTS) {
          tape.trades.shift();
        }
      } else if (e.event === 'CompleteEvent') {
        tapes.delete(e.mint);
        held.delete(e.mint);
      }
    }
    // A position the harness closed (complete/flatten/writeoff) is gone
    // from state.positions; drop its bookkeeping too — but keep entries
    // whose buy is still in flight (fills land latency_slots later).
    const buysInFlight = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') buysInFlight.add(p.order.mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !buysInFlight.has(mint)) held.delete(mint);
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();

    // ---- exits first: sell whole positions on stop / trail / fade / time ----
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = valueLamports(pos.token_amount, curve);
      const cost = pos.cost_lamports;
      const h = held.get(mint);
      if (h !== undefined) {
        if (value > h.peakValueLamports) h.peakValueLamports = value;
      }
      const peak = h !== undefined ? h.peakValueLamports : value;
      let exit = false;
      if (value < (cost * BigInt(Math.round((1 - STOP_LOSS) * 100))) / 100n) exit = true; // stop loss vs cost
      else if (
        value >= (cost * BigInt(Math.round((1 + TRAIL_ARM) * 100))) / 100n &&
        value < (peak * BigInt(Math.round((1 - TRAIL_DROP) * 100))) / 100n
      ) {
        exit = true; // trailing stop
      } else if (h !== undefined && state.slot - h.openedSlot > MAX_HOLD_SLOTS) exit = true; // time limit
      else {
        const tape = tapes.get(mint);
        if (tape !== undefined) {
          const fade = windowStats(tape, state.slot, FADE_WINDOW_SLOTS);
          if (fade.buySol - fade.sellSol < FADE_NET_SOL) exit = true; // tape turned seller-dominated
        }
      }
      if (exit) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(sell);
        const tape = tapes.get(mint);
        if (tape !== undefined) tape.lastExitSlot = state.slot;
        held.delete(mint);
        free -= txFee;
      }
    }

    // ---- entries: momentum buys on curves not held ----
    const slots = MAX_POSITIONS - state.committedPositionCount();
    if (slots > 0) {
      for (const [mint, tape] of tapes) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (state.positions.has(mint)) {
          // Pyramid: one add while the price keeps climbing and the signal holds.
          const h = held.get(mint);
          const curve = state.curves.get(mint);
          if (h === undefined || curve === undefined || curve.complete) continue;
          if (h.buys >= MAX_ENTRIES_PER_COIN) continue;
          const invested = Number(state.positions.get(mint)!.cost_lamports) / SOL;
          if (invested >= MAX_PER_COIN_SOL) continue;
          if (state.slot - tape.lastExitSlot < COOLDOWN_SLOTS) continue;
          const priceNow = priceOf(curve);
          if (priceNow < h.lastBuyPrice * (1 + ADD_PRICE_UP)) continue;
          if (!entrySignal(state, mint, tape)) continue;
          const cap = state.maxBuyLamports(mint);
          const amount = BigInt(Math.floor(ADD_BUY_SOL * SOL));
          if (cap < amount || free < amount + txFee) continue;
          const buy: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
          orders.push(buy);
          h.buys += 1;
          h.lastBuyPrice = priceNow;
          free -= amount + txFee;
          continue;
        }
        if (tape.entries >= MAX_ENTRIES_PER_COIN) continue;
        if (state.slot - tape.lastExitSlot < COOLDOWN_SLOTS) continue;
        if (!entrySignal(state, mint, tape)) continue;
        const cap = state.maxBuyLamports(mint);
        const amount = BigInt(Math.floor(FIRST_BUY_SOL * SOL));
        if (cap < amount) continue;
        if (free < amount + txFee) continue;
        const buy: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
        orders.push(buy);
        tape.entries += 1;
        const curve = state.curves.get(mint)!;
        held.set(mint, {
          openedSlot: state.slot,
          peakValueLamports: 0n,
          lastBuyPrice: priceOf(curve),
          buys: 1,
        });
        free -= amount + txFee;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) break;
      }
    }

    return orders;
  },
});
