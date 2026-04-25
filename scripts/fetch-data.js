#!/usr/bin/env node
/**
 * SmartTrader Data Fetcher
 * - 台股: TWSE 官方 API (無需 token, server-side 無 CORS)
 * - 美股: Yahoo Finance v8 chart API (direct, no library)
 * 執行: node scripts/fetch-data.js (從 repo 根目錄)
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

// -------------------- 股票清單 --------------------
const TW_STOCKS = {
  '2330': { name: '台積電', englishName: 'TSMC' },
  '2317': { name: '鴻海', englishName: 'Hon Hai' },
  '2454': { name: '聯發科', englishName: 'MediaTek' },
}

const US_STOCKS = {
  TSLA: { name: 'Tesla, Inc.', englishName: 'Tesla' },
  AAPL: { name: 'Apple Inc.', englishName: 'Apple' },
  NVDA: { name: 'NVIDIA Corp.', englishName: 'NVIDIA' },
}

// 基本面維持硬編碼（免費 API 不提供）
const FUNDAMENTALS = {
  '2330': { marketCap: '26.45兆', pe: 28.4, pb: 7.2, dividendYield: 1.45, roe: 26.8, eps: 42.15, bookValue: 141.5, beta: 1.08, high52w: 1120, low52w: 780 },
  '2317': { marketCap: '2.98兆', pe: 18.2, pb: 1.85, dividendYield: 2.32, roe: 10.4, eps: 11.82, bookValue: 116.2, beta: 1.15, high52w: 234, low52w: 155 },
  '2454': { marketCap: '2.21兆', pe: 24.6, pb: 5.1, dividendYield: 3.12, roe: 21.5, eps: 56.28, bookValue: 271.5, beta: 1.22, high52w: 1515, low52w: 980 },
  TSLA: { marketCap: '$790B', pe: 62.8, pb: 9.5, dividendYield: 0, roe: 15.2, eps: 3.95, bookValue: 26.1, beta: 2.15, high52w: 299, low52w: 138 },
  AAPL: { marketCap: '$3.42T', pe: 34.1, pb: 58.2, dividendYield: 0.45, roe: 160.8, eps: 6.62, bookValue: 3.87, beta: 1.24, high52w: 237, low52w: 164 },
  NVDA: { marketCap: '$3.38T', pe: 68.2, pb: 54.8, dividendYield: 0.03, roe: 119.2, eps: 2.02, bookValue: 2.52, beta: 1.68, high52w: 152, low52w: 46 },
}

// -------------------- 工具函式 --------------------
const sleep = ms => new Promise(r => setTimeout(r, ms))

const parseNum = s => parseFloat(String(s).replace(/,/g, '')) || 0

const parseChange = s => {
  const str = String(s)
    .replace(/,/g, '')
    .replace('＋', '')
    .replace('－', '-')
  return parseFloat(str) || 0
}

const rocToISO = rocDate => {
  const [rocYear, mm, dd] = rocDate.split('/')
  const year = parseInt(rocYear) + 1911
  return `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

// -------------------- 台股 (TWSE) --------------------
async function fetchTWSEMonth(symbol, dateStr) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateStr}&stockNo=${symbol}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (json.stat !== 'OK' || !Array.isArray(json.data) || json.data.length === 0) return []

  return json.data
    .map(row => {
      const [rocDate, vol, , open, high, low, close, change] = row
      return {
        time: rocToISO(rocDate),
        open: parseNum(open),
        high: parseNum(high),
        low: parseNum(low),
        close: parseNum(close),
        volume: parseNum(vol),
        _change: parseChange(change),
      }
    })
    .filter(c => c.close > 0)
}

async function fetchTWStock(symbol) {
  console.log(`  Fetching TW/${symbol}...`)
  const allCandles = []
  const today = new Date()

  for (let i = 12; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`
    try {
      const monthly = await fetchTWSEMonth(symbol, dateStr)
      allCandles.push(...monthly)
      await sleep(350)
    } catch (e) {
      console.warn(`    Skipped ${dateStr}: ${e.message}`)
    }
  }

  if (allCandles.length === 0) throw new Error(`No candle data for ${symbol}`)

  const last250 = allCandles.slice(-250)
  const latest = last250[last250.length - 1]
  const change = latest._change
  const prevClose = latest.close - change
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0

  const candles = last250.map(({ _change, ...c }) => c)

  return {
    symbol,
    name: TW_STOCKS[symbol].name,
    englishName: TW_STOCKS[symbol].englishName,
    market: 'TW',
    currency: 'TWD',
    price: latest.close,
    change: +change.toFixed(2),
    changePct: +changePct.toFixed(2),
    open: latest.open,
    high: latest.high,
    low: latest.low,
    volume: latest.volume,
    candles,
    fundamentals: FUNDAMENTALS[symbol],
    updatedAt: new Date().toISOString(),
  }
}

// -------------------- 美股 (Yahoo Finance v8 direct API) --------------------
function yahooFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: urlPath,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchUSStock(symbol) {
  console.log('  Fetching US/' + symbol + '...')

  const from = Math.floor((Date.now() - 400 * 86400 * 1000) / 1000);
  const to   = Math.floor(Date.now() / 1000);
  const json = await yahooFetch(
    '/v8/finance/chart/' + symbol + '?interval=1d&period1=' + from + '&period2=' + to
  );

  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error('No chart data for ' + symbol);

  const meta       = result.meta || {};
  const timestamps = result.timestamp || [];
  const q          = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const candles = timestamps
    .map(function(ts, i) {
      return {
        time:   new Date(ts * 1000).toISOString().split('T')[0],
        open:   q.open  && q.open[i]   != null ? +q.open[i].toFixed(2)   : null,
        high:   q.high  && q.high[i]   != null ? +q.high[i].toFixed(2)   : null,
        low:    q.low   && q.low[i]    != null ? +q.low[i].toFixed(2)    : null,
        close:  q.close && q.close[i]  != null ? +q.close[i].toFixed(2)  : null,
        volume: (q.volume && q.volume[i]) ? q.volume[i] : 0,
      };
    })
    .filter(function(c) { return c.open && c.close; })
    .sort(function(a, b) { return a.time.localeCompare(b.time); })
    .slice(-250);

  if (candles.length === 0) throw new Error('No candle data for ' + symbol);

  const latest    = candles[candles.length - 1];
  const prevClose = meta.chartPreviousClose || latest.close;
  const change    = +((latest.close - prevClose)).toFixed(2);
  const changePct = prevClose !== 0 ? +((change / prevClose) * 100).toFixed(2) : 0;

  return {
    symbol,
    name:        US_STOCKS[symbol].name,
    englishName: US_STOCKS[symbol].englishName,
    market:      'US',
    currency:    'USD',
    price:       +((meta.regularMarketPrice || latest.close)).toFixed(2),
    change,
    changePct,
    open:        +((meta.regularMarketOpen  || latest.open)).toFixed(2),
    high:        +((meta.regularMarketDayHigh || latest.high)).toFixed(2),
    low:         +((meta.regularMarketDayLow  || latest.low)).toFixed(2),
    volume:      meta.regularMarketVolume || latest.volume,
    candles,
    fundamentals: FUNDAMENTALS[symbol],
    updatedAt:   new Date().toISOString(),
  };
}

// -------------------- Main --------------------
async function main() {
  const repoRoot = path.join(__dirname, '..')
  const dataDir = path.join(repoRoot, 'data')
  fs.mkdirSync(path.join(dataDir, 'TW'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'US'), { recursive: true })

  let successCount = 0
  let failCount = 0

  console.log('\n=== Taiwan Stocks (TWSE) ===')
  for (const symbol of Object.keys(TW_STOCKS)) {
    try {
      const data = await fetchTWStock(symbol)
      const outPath = path.join(dataDir, 'TW', `${symbol}.json`)
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2))
      console.log(`  ✅ TW/${symbol}: NT$${data.price} (${data.change >= 0 ? '+' : ''}${data.change}), ${data.candles.length} candles`)
      successCount++
    } catch (e) {
      console.error(`  ❌ TW/${symbol}: ${e.message}`)
      failCount++
    }
  }

  console.log('\n=== US Stocks (Yahoo Finance) ===')
  for (const symbol of Object.keys(US_STOCKS)) {
    try {
      const data = await fetchUSStock(symbol)
      const outPath = path.join(dataDir, 'US', `${symbol}.json`)
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2))
      console.log(`  ✅ US/${symbol}: $${data.price} (${data.change >= 0 ? '+' : ''}${data.change}), ${data.candles.length} candles`)
      successCount++
    } catch (e) {
      console.error(`  ❌ US/${symbol}: ${e.message}`)
      failCount++
    }
  }

  console.log(`\nDone: ${successCount} succeeded, ${failCount} failed`)
  if (failCount > 0) process.exit(1)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
