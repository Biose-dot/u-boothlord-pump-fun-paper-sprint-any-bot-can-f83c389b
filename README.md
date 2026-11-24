# Surge Rider — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Biose-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Biose-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for the [make.fun](https://make.fun) bounty
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b).

## Strategy

A momentum paper-trading bot for the pump.fun bonding-curve replay
(`agent-fun/replay/v2`, Node 22, zero dependencies). Most fresh curves are
bundled launches that get dumped, so the bot waits until a curve is mature,
then buys only when its recent tape shows real, broad buy pressure: net SOL
flowing in, several distinct buyers, the price rising and sitting near its
window high. The first buy is small (0.1 SOL); one pyramid add follows only
if the price keeps climbing, up to 0.2 SOL per coin and 5 open positions.

Every position carries a stop loss (-25% vs cost), a trailing stop once it is
up 15% (exit on a 30% drawdown from peak), a fade exit when the tape turns
seller-dominated, and a 1500-slot time limit. Fully deterministic: no clock,
no environment, no randomness — two runs on the same window produce
byte-identical action logs.

Paper trading only: the replay uses market data, never real funds.

## Run

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`.
The SDK shim is vendored byte-identical from the kit at
`vendor/makefun-bot.ts`.

Check it locally with the kit's practice harness (no Docker needed):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
