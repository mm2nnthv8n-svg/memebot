// Paper-trading bot for real Solana meme coins.
// Runs on a schedule via GitHub Actions (see .github/workflows/trade-bot.yml).
// Uses DexScreener's free public API — no key required.
//
// IMPORTANT: this trades nothing real. It reads live prices and simulates
// buys/sells against a fake cash balance stored in state.json.

import { readFileSync, writeFileSync, existsSync } from 'fs';

const STATE_FILE = 'state.json';
const STARTING_CASH = 100;
const TRADE_PERCENT = 0.10; // spend 10% of current cash per buy — scales up or down with the portfolio
const MIN_TRADE_USD = 1;    // skip buys smaller than this (avoids pointless dust trades)
const MAX_POSITIONS = 3;    // don't hold more than this many coins at once
const BUY_THRESHOLD = 6;    // buy if 1h price change >= this percent
const TAKE_PROFIT = 15;     // sell if up this percent since buy
const STOP_LOSS = -10;      // sell if down this percent since buy

function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return {
    cash: STARTING_CASH,
    holdings: {},   // tokenAddress -> { symbol, amount, buyPrice, spent, boughtAt }
    trades: [],     // most recent first
    history: [],    // portfolio value snapshots over time
    lastRun: null,
  };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchTrendingSolanaTokens() {
  // "Top boosted" tokens are a reasonable free proxy for "currently trending" —
  // projects pay to boost visibility, which correlates with meme coin hype cycles.
  const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
  if (!res.ok) throw new Error(`token-boosts request failed: ${res.status}`);
  const data = await res.json();
  return data
    .filter(t => t.chainId === 'solana')
    .slice(0, 15)
    .map(t => t.tokenAddress);
}

async function fetchTokenData(addresses) {
  if (addresses.length === 0) return [];
  const url = `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tokens request failed: ${res.status}`);
  const pairs = await res.json();

  // A token can have multiple pairs (different DEXs/pools) — keep the one
  // with the most liquidity as the most reliable price.
  const byToken = {};
  for (const p of pairs) {
    if (!p.baseToken?.address || !p.priceUsd) continue;
    const addr = p.baseToken.address;
    const liq = p.liquidity?.usd || 0;
    if (!byToken[addr] || liq > (byToken[addr].liquidity?.usd || 0)) {
      byToken[addr] = p;
    }
  }
  return Object.values(byToken);
}

function portfolioValue(state, priceByAddress) {
  let holdingsValue = 0;
  for (const [addr, h] of Object.entries(state.holdings)) {
    const price = priceByAddress[addr] ?? h.buyPrice;
    holdingsValue += h.amount * price;
  }
  return state.cash + holdingsValue;
}

async function run() {
  const state = loadState();
  const now = new Date().toISOString();

  let tokens = [];
  try {
    const addresses = await fetchTrendingSolanaTokens();
    tokens = await fetchTokenData(addresses);
  } catch (err) {
    console.error('Failed to fetch market data, skipping this run:', err.message);
    state.lastRun = now;
    state.lastError = err.message;
    saveState(state);
    return;
  }

  const priceByAddress = {};

  for (const t of tokens) {
    const addr = t.baseToken.address;
    const symbol = t.baseToken.symbol;
    const price = parseFloat(t.priceUsd);
    if (!price || Number.isNaN(price)) continue;
    priceByAddress[addr] = price;

    const change1h = t.priceChange?.h1 ?? 0;
    const holding = state.holdings[addr];

    if (!holding) {
      const positionsHeld = Object.keys(state.holdings).length;
      const tradeUsd = state.cash * TRADE_PERCENT;
      if (
        tradeUsd >= MIN_TRADE_USD &&
        positionsHeld < MAX_POSITIONS &&
        change1h >= BUY_THRESHOLD
      ) {
        const amount = tradeUsd / price;
        state.cash -= tradeUsd;
        state.holdings[addr] = { symbol, amount, buyPrice: price, spent: tradeUsd, boughtAt: now };
        state.trades.unshift({
          time: now, symbol, action: 'BUY', price, usd: tradeUsd,
          reason: `1h change +${change1h.toFixed(1)}%`,
        });
      }
    } else {
      const changeSinceBuy = ((price - holding.buyPrice) / holding.buyPrice) * 100;
      if (changeSinceBuy >= TAKE_PROFIT || changeSinceBuy <= STOP_LOSS) {
        const proceeds = holding.amount * price;
        state.cash += proceeds;
        state.trades.unshift({
          time: now, symbol,
          action: changeSinceBuy >= TAKE_PROFIT ? 'SELL (profit)' : 'SELL (stop loss)',
          price, usd: proceeds, pnl: proceeds - holding.spent,
          reason: `${changeSinceBuy >= 0 ? '+' : ''}${changeSinceBuy.toFixed(1)}% since buy`,
        });
        delete state.holdings[addr];
      }
    }
  }

  const value = portfolioValue(state, priceByAddress);
  state.history.push({ t: now, value });
  state.trades = state.trades.slice(0, 100);
  state.history = state.history.slice(-500);
  state.lastRun = now;
  delete state.lastError;

  saveState(state);
  console.log(`Run complete at ${now}. Portfolio value: $${value.toFixed(2)}`);
}

run();
