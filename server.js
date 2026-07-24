const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { ethers } = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const TronWeb = require('tronweb');
const { RippleAPI } = require('ripple-lib');
const bs58 = require('bs58');
const app = express();

const ECPair = ECPairFactory(ecc);

app.use(cors());
app.use(express.json());

// ============================================================
// 🔥 CONFIGURATION - ALL FROM ENVIRONMENT VARIABLES
// ============================================================
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET;
const FLUTTERWAVE_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://automatic-backend.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dubpaydub.netlify.app';

const INFURA_KEY = process.env.INFURA_KEY;

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const AVALANCHE_RPC = 'https://api.avax.network/ext/bc/C/rpc';
const TRON_RPC = 'https://api.trongrid.io';
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;

// ============================================================
// 🔥 TELEGRAM BOT - FROM ENVIRONMENT VARIABLES
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Check if Telegram variables are set
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ BOT_TOKEN and CHAT_ID not set in environment variables. Telegram features will be disabled.');
} else {
console.log('✅ Telegram bot configured');
}

// ============================================================
// 🔥 ORDER STORAGE (Use database in production)
// ============================================================
const orders = {};

// ============================================================
// 🔥 WALLET CONFIGURATION - ALL FROM ENVIRONMENT VARIABLES
// ============================================================
console.log('🔍 Checking environment variables...');

const WALLETS = {
BTC: {
address: process.env.BTC_ADDRESS || '',
privateKey: process.env.BTC_PRIVATE_KEY || '',
network: 'bitcoin'
},
ETH: {
address: process.env.ETH_ADDRESS || '',
privateKey: process.env.ETH_PRIVATE_KEY || '',
network: 'ethereum'
},
BNB: {
address: process.env.BNB_ADDRESS || '',
privateKey: process.env.BNB_PRIVATE_KEY || '',
network: 'bsc'
},
SOL: {
address: process.env.SOL_ADDRESS || '',
privateKey: process.env.SOL_PRIVATE_KEY || '',
network: 'solana'
},
TRX: {
address: process.env.TRX_ADDRESS || '',
privateKey: process.env.TRX_PRIVATE_KEY || '',
network: 'tron'
},
XRP: {
address: process.env.XRP_ADDRESS || '',
privateKey: process.env.XRP_PRIVATE_KEY || '',
network: 'ripple'
},
LTC: {
address: process.env.LTC_ADDRESS || '',
privateKey: process.env.LTC_PRIVATE_KEY || '',
network: 'litecoin'
},
AVAX: {
address: process.env.AVAX_ADDRESS || '',
privateKey: process.env.AVAX_PRIVATE_KEY || '',
network: 'avalanche'
},
LINK: {
address: process.env.LINK_ADDRESS || '',
privateKey: process.env.LINK_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
network: 'ethereum'
}
};

// Log which wallets are configured
Object.keys(WALLETS).forEach(coin => {
const wallet = WALLETS[coin];
if (wallet.privateKey) {
console.log(`✅ ${coin} wallet configured`);
} else {
console.log(`⚠️ ${coin} wallet NOT configured (missing private key)`);
}
});

// ============================================================
// 🔥 COIN TO WALLET MAPPING
// ============================================================
const COIN_TO_WALLET = {
'BTC': 'BTC',
'ETH': 'ETH',
'USDC': {
'ERC20': 'ETH',
'SOL': 'SOL',
'BNB': 'BNB'
},
'USDT': {
'ERC20': 'ETH',
'SOL': 'SOL',
'BNB': 'BNB',
'TRC20': 'TRX'
},
'BNB': 'BNB',
'SOL': 'SOL',
'XRP': 'XRP',
'LTC': 'LTC',
'AVAX': 'AVAX',
'LINK': 'LINK'
};

// ============================================================
// 🛡️ SMART ADAPTIVE SYSTEM - AUTO-ADJUSTS TO YOUR WALLET
// ============================================================

// Track wallet balances and volumes for ALL coins
const dailyVolumes = {};
const priceCache = {};
const yesterdayPrices = {};

// ALL SUPPORTED COINS
const SUPPORTED_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'USDC', 'USDT', 'XRP', 'LTC', 'AVAX', 'LINK'];

// Emergency pause system
let EMERGENCY_PAUSED = false;
let PAUSE_REASON = '';
let lastPriceCheck = {};

// ============================================================
// 🧠 SMART FUNCTIONS - WORKS FOR ALL COINS
// ============================================================

// Get current price for any coin - WITH RATE LIMIT PROTECTION
async function getPrice(coinSymbol) {
try {
// For stablecoins - no API call needed
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
return 1.00;
}

// Add delay to avoid rate limiting (500ms between requests)
await new Promise(resolve => setTimeout(resolve, 500));

// Map coin symbols to CoinGecko IDs
const coinMap = {
'BTC': 'bitcoin',
'ETH': 'ethereum',
'BNB': 'binancecoin',
'SOL': 'solana',
'XRP': 'ripple',
'LTC': 'litecoin',
'AVAX': 'avalanche-2',
'LINK': 'chainlink'
};

const id = coinMap[coinSymbol];
if (!id) return 0;

const response = await axios.get(
`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
{ timeout: 10000 }
);

return response.data[id]?.usd || 0;

} catch (error) {
if (error.response?.status === 429) {
console.log(`⏳ Rate limited for ${coinSymbol}, using cached price`);
// Return cached price if available
if (priceCache[coinSymbol]) {
return priceCache[coinSymbol];
}
}
console.error(`❌ Error getting price for ${coinSymbol}:`, error.message);
return 0;
}
}

// Get wallet balance in USD for any coin
async function getWalletBalanceUSD(coinSymbol) {
try {
const balance = await getWalletBalance(coinSymbol);
const price = await getPrice(coinSymbol);
const usdValue = balance * price;
// Cache the price
if (price > 0) {
priceCache[coinSymbol] = price;
}
return usdValue;
} catch (error) {
console.error(`❌ Error getting balance USD for ${coinSymbol}:`, error.message);
return 0;
}
}

// Get daily volume for any coin
function getDailyVolume(coinSymbol) {
return dailyVolumes[coinSymbol] || 0;
}

// Track volume for any coin
function trackVolume(coinSymbol, amount) {
dailyVolumes[coinSymbol] = (dailyVolumes[coinSymbol] || 0) + amount;
}

// ==== SMART BUFFER - AUTO-ADJUSTS BASED ON BALANCE ====
async function getSmartBuffer(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

// Stablecoins (USDC, USDT) need less buffer
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (balanceUSD < 500) return 0.08;
if (balanceUSD < 2000) return 0.05;
if (balanceUSD < 10000) return 0.03;
return 0.02;
}

// BTC and ETH - more volatile
if (coinSymbol === 'BTC' || coinSymbol === 'ETH') {
if (balanceUSD < 500) return 0.18;
if (balanceUSD < 2000) return 0.15;
if (balanceUSD < 10000) return 0.12;
return 0.08;
}

// SOL, BNB, AVAX, LINK - medium volatility
if (balanceUSD < 500) return 0.15;
if (balanceUSD < 2000) return 0.12;
if (balanceUSD < 10000) return 0.08;
return 0.05;
}

// ==== SMART SELL LIMITS - AUTO-ADJUSTS BASED ON BALANCE ====
async function getSmartSellLimits(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

// Stablecoins - higher limits
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (balanceUSD < 500) return { perTx: 25, perDay: 50, perWeek: 250 };
if (balanceUSD < 2000) return { perTx: 50, perDay: 100, perWeek: 500 };
if (balanceUSD < 10000) return { perTx: 100, perDay: 250, perWeek: 1000 };
return { perTx: 500, perDay: 1000, perWeek: 5000 };
}

// Regular coins
if (balanceUSD < 500) return { perTx: 10, perDay: 20, perWeek: 100 };
if (balanceUSD < 2000) return { perTx: 25, perDay: 50, perWeek: 250 };
if (balanceUSD < 10000) return { perTx: 50, perDay: 100, perWeek: 500 };
return { perTx: 200, perDay: 500, perWeek: 2000 };
}

// ==== SMART STOP LOSS - AUTO-ADJUSTS BASED ON BALANCE ====
async function getSmartStopLoss(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

// BTC and ETH - tighter stop loss (more volatile)
if (coinSymbol === 'BTC' || coinSymbol === 'ETH') {
if (balanceUSD < 500) return 0.06;
if (balanceUSD < 2000) return 0.08;
if (balanceUSD < 10000) return 0.10;
return 0.15;
}

// Stablecoins - no stop loss needed
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
return 999; // Never trigger
}

// Regular coins
if (balanceUSD < 500) return 0.08;
if (balanceUSD < 2000) return 0.10;
if (balanceUSD < 10000) return 0.15;
return 0.20;
}

// ==== SMART MIN BALANCE - AUTO-ADJUSTS BASED ON BALANCE ====
async function getSmartMinBalance(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);
const dailyVolume = getDailyVolume(coinSymbol);

// Stablecoins - lower min balance needed
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (balanceUSD < 500) return dailyVolume * 2;
if (balanceUSD < 2000) return dailyVolume * 1.5;
if (balanceUSD < 10000) return dailyVolume * 1;
return dailyVolume * 0.5;
}

// Regular coins
if (balanceUSD < 500) return dailyVolume * 3;
if (balanceUSD < 2000) return dailyVolume * 2.5;
if (balanceUSD < 10000) return dailyVolume * 2;
return dailyVolume * 1.5;
}

// ==== CHECK IF SYSTEM IS SAFE ====
async function isSystemSafe(coinSymbol, amountNeeded) {
try {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);
const minBalance = await getSmartMinBalance(coinSymbol);
const price = await getPrice(coinSymbol);
const neededUSD = amountNeeded * price;

// Check if wallet can handle this transaction
if (balanceUSD < minBalance + neededUSD) {
return {
safe: false,
reason: `Insufficient balance. Have $${balanceUSD.toFixed(2)}, Need $${(minBalance + neededUSD).toFixed(2)}`,
action: 'Replenish wallet or reduce order size'
};
}

// Check stop loss
const stopLoss = await getSmartStopLoss(coinSymbol);
if (stopLoss < 100) { // Not a stablecoin
const yesterdayPrice = yesterdayPrices[coinSymbol] || price;
const dropPercent = (yesterdayPrice - price) / yesterdayPrice;

if (dropPercent > stopLoss) {
return {
safe: false,
reason: `${coinSymbol} dropped ${(dropPercent * 100).toFixed(1)}% (Stop loss: ${stopLoss * 100}%)`,
action: 'Pause orders or wait for recovery'
};
}
}

return { safe: true };
} catch (error) {
console.error(`❌ Error checking system safety for ${coinSymbol}:`, error.message);
return { safe: true };
}
}

// ==== CHECK EMERGENCY PAUSE ====
function checkEmergencyPause() {
if (EMERGENCY_PAUSED) {
throw new Error(`⛔ System is paused: ${PAUSE_REASON || 'Emergency maintenance'}`);
}
return true;
}

// ============================================================
// 🚨 TELEGRAM EMERGENCY PAUSE SYSTEM
// ============================================================

// Function to send pause control keyboard
async function sendPauseControlKeyboard() {
// Check if Telegram is configured
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured - skipping keyboard send');
return;
}

const status = EMERGENCY_PAUSED ? '⛔ PAUSED' : '✅ RUNNING';
const statusColor = EMERGENCY_PAUSED ? '🔴' : '🟢';

const message = `${statusColor} *SYSTEM STATUS: ${status}*\n\n` +
`📅 ${new Date().toLocaleString()}\n` +
(EMERGENCY_PAUSED ? `📝 Reason: ${PAUSE_REASON || 'Emergency pause'}\n` : '') +
`\nClick a button below to control the system:`;

const keyboard = {
inline_keyboard: [
[{ text: '⏸️ PAUSE ORDERS', callback_data: 'pause_orders' }],
[{ text: '▶️ RESUME ORDERS', callback_data: 'resume_orders' }],
[{ text: '📊 CHECK STATUS', callback_data: 'check_status' }],
[{ text: '💰 CHECK WALLETS', callback_data: 'check_wallets' }]
]
};

try {
const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: CHAT_ID,
text: message,
parse_mode: 'Markdown',
reply_markup: keyboard
})
});

if (!response.ok) {
const errorText = await response.text();
console.error(`❌ Telegram API error: ${response.status} - ${errorText}`);
}
} catch (error) {
console.error('❌ Failed to send pause control:', error.message);
}
}

// Function to send alert message
async function sendTelegramAlert(message) {
// Check if Telegram is configured
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured - skipping alert');
return;
}

try {
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: CHAT_ID,
text: message,
parse_mode: 'Markdown'
})
});
} catch (error) {
console.error('❌ Failed to send alert:', error.message);
}
}

// ============================================================
// 📌 TELEGRAM WEBHOOK - FIXED
// ============================================================
app.post('/api/telegram-webhook', async (req, res) => {
// Always respond with 200 OK to Telegram immediately
res.status(200).send('OK');

// Process the update in the background
try {
const update = req.body;
console.log('📥 Telegram webhook received');

// Handle callback queries (button clicks)
if (update.callback_query) {
const callbackData = update.callback_query.data;
const chatId = update.callback_query.message.chat.id;
const callbackQueryId = update.callback_query.id;

console.log(`🔘 Button clicked: ${callbackData} from chat ${chatId}`);

// Check if Telegram is configured
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured - cannot process callback');
return;
}

// Check if it's our chat
if (chatId.toString() === CHAT_ID) {
let responseText = '';
let showAlert = false;

if (callbackData === 'pause_orders') {
if (EMERGENCY_PAUSED) {
responseText = '⚠️ System is already paused!';
} else {
EMERGENCY_PAUSED = true;
PAUSE_REASON = 'Emergency pause via Telegram';
responseText = '⏸️ SYSTEM PAUSED! All orders stopped.';
showAlert = true;
console.log('🚨 Emergency pause activated via Telegram');
await sendTelegramAlert('🚨 *EMERGENCY PAUSE ACTIVATED*\n\nAll orders have been stopped.');
}
} else if (callbackData === 'resume_orders') {
if (!EMERGENCY_PAUSED) {
responseText = '⚠️ System is already running!';
} else {
EMERGENCY_PAUSED = false;
PAUSE_REASON = '';
responseText = '▶️ SYSTEM RESUMED! All orders active.';
showAlert = true;
console.log('✅ System resumed via Telegram');
await sendTelegramAlert('✅ *SYSTEM RESUMED*\n\nAll orders are now active.');
}
} else if (callbackData === 'check_status') {
const status = EMERGENCY_PAUSED ? '⛔ PAUSED' : '✅ RUNNING';
responseText = `${EMERGENCY_PAUSED ? '🔴' : '🟢'} *System Status: ${status}*\n\n📅 ${new Date().toLocaleString()}\n${EMERGENCY_PAUSED ? `📝 Reason: ${PAUSE_REASON}\n` : ''}\nAll systems ${EMERGENCY_PAUSED ? 'are stopped' : 'are operational'}.`;
} else if (callbackData === 'check_wallets') {
let walletInfo = '💰 *WALLET BALANCES*\n\n';
for (const coin of SUPPORTED_COINS) {
try {
const balance = await getWalletBalance(coin);
const price = await getPrice(coin);
const balanceUSD = balance * price;
walletInfo += `• ${coin}: ${balance.toFixed(6)} ($${balanceUSD.toFixed(2)})\n`;
} catch (error) {
walletInfo += `• ${coin}: ⚠️ Error fetching\n`;
}
}
walletInfo += `\n📅 ${new Date().toLocaleString()}`;
responseText = walletInfo;
}

// Answer the callback query - FIXED: Only use BOT_TOKEN if available
try {
const answerUrl = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
console.log(`📤 Answering callback with token: ${BOT_TOKEN ? 'present' : 'MISSING!'}`);

const answerResponse = await fetch(answerUrl, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
callback_query_id: callbackQueryId,
text: responseText.replace(/\*/g, '').substring(0, 200),
show_alert: showAlert
})
});

if (!answerResponse.ok) {
const errorText = await answerResponse.text();
console.error(`❌ Failed to answer callback: ${answerResponse.status} - ${errorText}`);
} else {
console.log('✅ Callback answered successfully');
}
} catch (error) {
console.error('❌ Failed to answer callback:', error.message);
}

// Send updated keyboard
await sendPauseControlKeyboard();
} else {
// Unauthorized chat - answer with error
try {
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
callback_query_id: callbackQueryId,
text: '❌ Unauthorized',
show_alert: true
})
});
} catch (error) {
console.error('❌ Failed to answer unauthorized callback:', error.message);
}
}
}
} catch (error) {
console.error('❌ Telegram webhook processing error:', error.message);
}
});

// ============================================================
// 🔄 AUTO-MONITOR SYSTEM - RUNS EVERY HOUR
// ============================================================
setInterval(async () => {
console.log('🔄 Running smart system check for ALL coins...');

for (const coin of SUPPORTED_COINS) {
try {
// Update price cache with delay to avoid rate limits
const price = await getPrice(coin);
if (!yesterdayPrices[coin]) {
yesterdayPrices[coin] = price;
}

const balanceUSD = await getWalletBalanceUSD(coin);
const buffer = await getSmartBuffer(coin);
const limits = await getSmartSellLimits(coin);
const stopLoss = await getSmartStopLoss(coin);
const minBalance = await getSmartMinBalance(coin);

console.log(`📊 ${coin}:`);
console.log(` Balance: $${balanceUSD.toFixed(2)}`);
console.log(` Buffer: ${(buffer * 100).toFixed(0)}%`);
console.log(` Sell Limit: $${limits.perTx}`);
console.log(` Stop Loss: ${(stopLoss * 100).toFixed(0)}%`);
console.log(` Min Balance: $${minBalance.toFixed(2)}`);

// Check if system is safe
const safety = await isSystemSafe(coin, 0);
if (!safety.safe) {
EMERGENCY_PAUSED = true;
PAUSE_REASON = `${coin}: ${safety.reason}`;
await sendTelegramAlert(`🚨 *AUTO-PAUSE ACTIVATED*\n\n${coin}: ${safety.reason}\nAction: ${safety.action}`);
}

} catch (error) {
console.error(`❌ Error checking ${coin}:`, error.message);
}
}

// Send daily report
if (new Date().getHours() === 0) {
await sendTelegramAlert(`📊 *DAILY SYSTEM REPORT*\n\n${new Date().toLocaleDateString()}\n\nAll systems monitored. ${EMERGENCY_PAUSED ? '⚠️ System is PAUSED' : '✅ System is RUNNING'}`);
}

}, 60 * 60 * 1000); // Every hour

// Send initial control keyboard on startup (only if Telegram is configured)
setTimeout(async () => {
if (BOT_TOKEN && CHAT_ID) {
await sendPauseControlKeyboard();
console.log('✅ Telegram control keyboard sent');
} else {
console.log('⚠️ Telegram not configured - keyboard not sent');
}
}, 5000);

// ============================================================
// 📌 GET WALLET FOR COIN
// ============================================================
function getWalletForCoin(coinSymbol, network) {
let walletKey;

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (!network) {
network = 'ERC20';
}
walletKey = COIN_TO_WALLET[coinSymbol][network];
if (!walletKey) {
throw new Error(`No wallet for ${coinSymbol} on network ${network}. Available: ${Object.keys(COIN_TO_WALLET[coinSymbol]).join(', ')}`);
}
} else {
walletKey = COIN_TO_WALLET[coinSymbol];
if (!walletKey) {
throw new Error(`No wallet mapping for ${coinSymbol}`);
}
}

const wallet = WALLETS[walletKey];
if (!wallet || !wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol} (wallet: ${walletKey}). Please check your environment variables.`);
}

return wallet;
}

// ============================================================
// 🔥 UNIVERSAL PRIVATE KEY PARSER - SUPPORTS ALL FORMATS
// ============================================================
function parsePrivateKey(privateKeyInput, coinName) {
console.log(`🔑 Parsing private key for ${coinName}...`);

if (!privateKeyInput) {
throw new Error(`No private key provided for ${coinName}`);
}

const input = privateKeyInput.trim();

// FORMAT 1: Base58 (Solana, some others)
if (input.length >= 80 && input.length <= 100) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 64 || decoded.length === 32) {
console.log(`✅ ${coinName}: Using Base58 format (${decoded.length} bytes)`);
return Uint8Array.from(decoded);
}
} catch (e) { /* Not Base58 */ }
}

// FORMAT 2: JSON array [123, 45, 67, ...]
try {
const array = JSON.parse(input);
if (Array.isArray(array) && (array.length === 64 || array.length === 32)) {
console.log(`✅ ${coinName}: Using JSON array format (${array.length} bytes)`);
return Uint8Array.from(array);
}
} catch (e) { /* Not JSON array */ }

// FORMAT 3: Base64 string
try {
const base64Buffer = Buffer.from(input, 'base64');
if (base64Buffer.length === 64 || base64Buffer.length === 32) {
console.log(`✅ ${coinName}: Using Base64 format (${base64Buffer.length} bytes)`);
return Uint8Array.from(base64Buffer);
}
} catch (e) { /* Not Base64 */ }

// FORMAT 4: Hex string (with or without 0x)
try {
const hexClean = input.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean) || /^[0-9a-f]{128}$/i.test(hexClean) || /^[0-9a-f]{32}$/i.test(hexClean)) {
console.log(`✅ ${coinName}: Using Hex format`);
const buffer = Buffer.from(hexClean, 'hex');
return Uint8Array.from(buffer);
}
} catch (e) { /* Not Hex */ }

// FORMAT 5: WIF (Bitcoin, Litecoin) - return as string
if (input.startsWith('5') || input.startsWith('K') || input.startsWith('L') || input.startsWith('T')) {
console.log(`✅ ${coinName}: Using WIF format`);
return input;
}

// FORMAT 6: Raw string (for TRON, XRP, etc.)
console.log(`✅ ${coinName}: Using raw string format`);
return input;
}

// ============================================================
// 🔥 REAL BALANCE CHECKS
// ============================================================
async function getWalletBalance(coinSymbol, network) {
console.log(`🔍 Checking balance for ${coinSymbol}...`);

try {
const wallet = getWalletForCoin(coinSymbol, network);
const address = wallet.address;

if (!address) {
console.log(`⚠️ No address configured for ${coinSymbol}`);
return 0;
}

if (coinSymbol === 'BTC') {
try {
const response = await axios.get(`https://mempool.space/api/address/${address}`);
const balance = response.data.chain_stats.funded_txo_sum / 100000000;
console.log(`💰 BTC Balance: ${balance} BTC`);
return balance;
} catch {
const response = await axios.get(`https://blockchain.info/q/addressbalance/${address}`);
const balance = response.data / 100000000;
console.log(`💰 BTC Balance: ${balance} BTC`);
return balance;
}
}

if (coinSymbol === 'LTC') {
const response = await axios.get(`https://api.blockchair.com/litecoin/dashboards/address/${address}`);
const data = response.data.data[address];
if (data && data.address && data.address.balance) {
return data.address.balance / 100000000;
}
return 0;
}

if (coinSymbol === 'XRP') {
const response = await axios.post('https://s1.ripple.com:51234/', {
method: 'account_info',
params: [{ account: address, strict: true, ledger_index: 'current', queue: true }]
});
if (response.data.result && response.data.result.account_data) {
return response.data.result.account_data.Balance / 1000000;
}
return 0;
}

if (coinSymbol === 'ETH') {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'LINK') {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const contractAddress = '0x514910771AF9Ca656af840dff83E8264EcF986CA';
const abi = ['function balanceOf(address) view returns (uint256)'];
const contract = new ethers.Contract(contractAddress, abi, provider);
const balance = await contract.balanceOf(address);
return parseFloat(ethers.formatUnits(balance, 18));
}

if (coinSymbol === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const balance = await connection.getBalance(publicKey);
return balance / LAMPORTS_PER_SOL;
}

if (coinSymbol === 'USDC' && network === 'SOL') {
const connection = new Connection(SOLANA_RPC);
const publicKey = new PublicKey(address);
const tokenAddress = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, { mint: tokenAddress });
if (tokenAccounts.value.length > 0) {
const accountInfo = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
return accountInfo.value.uiAmount || 0;
}
return 0;
}

if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const provider = new ethers.JsonRpcProvider(ETH_RPC);
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const abi = ['function balanceOf(address) view returns (uint256)'];
const contract = new ethers.Contract(contractAddress, abi, provider);
const balance = await contract.balanceOf(address);
return parseFloat(ethers.formatUnits(balance, 6));
}

if (coinSymbol === 'BNB') {
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'AVAX') {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
const balance = await provider.getBalance(address);
return parseFloat(ethers.formatEther(balance));
}

if (coinSymbol === 'USDT' && network === 'TRC20') {
try {
const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: wallet.privateKey
});
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const balance = await contract.balanceOf(address).call();
return balance / 1000000;
} catch {
return 0;
}
}

return 0;
} catch (error) {
console.error(`❌ Balance check error for ${coinSymbol}:`, error.message);
return 0;
}
}

// ============================================================
// 🔥 REAL SENDING FUNCTIONS - ALL WITH FLEXIBLE KEY PARSING
// ============================================================

// ============================================================
// 📌 SEND BTC (REAL) - IMPROVED WITH DYNAMIC FEES
// ============================================================
async function sendBTC(privateKeyInput, toAddress, amountBTC) {
try {
const wallet = getWalletForCoin('BTC');
console.log(`📤 Sending ${amountBTC} BTC from ${wallet.address} to ${toAddress}`);

let utxos;
try {
const response = await axios.get(`https://mempool.space/api/address/${wallet.address}/utxo`);
utxos = response.data || [];
} catch (error) {
console.log('⚠️ Mempool.space failed, trying blockchain.info...');
const response = await axios.get(`https://blockchain.info/unspent?active=${wallet.address}`);
utxos = response.data.unspent_outputs.map(utxo => ({
txid: utxo.tx_hash,
vout: utxo.tx_output_n,
value: utxo.value,
scriptpubkey: utxo.script
}));
}

if (!utxos || utxos.length === 0) {
throw new Error('No UTXOs found for this address. Please fund your BTC wallet.');
}

const satoshisNeeded = Math.round(amountBTC * 100000000);
const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
console.log(`💰 Total available: ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC)`);
console.log(`💰 Needed: ${satoshisNeeded} sats (${amountBTC} BTC)`);

const estimatedFee = Math.min(25000, Math.round(utxos.length * 2500 + 5000));
console.log(`💰 Estimated fee: ${estimatedFee} sats`);

const totalNeeded = satoshisNeeded + estimatedFee;

if (totalAvailable < totalNeeded) {
const shortage = totalNeeded - totalAvailable;
throw new Error(
`Insufficient funds! Have ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC), ` +
`Need ${totalNeeded} sats (${(totalNeeded/100000000).toFixed(8)} BTC) including fee. ` +
`Shortage: ${shortage} sats (${(shortage/100000000).toFixed(8)} BTC). ` +
`Please fund your wallet or try a smaller amount.`
);
}

let selectedUTXOs = [];
let totalSats = 0;

for (const utxo of utxos) {
if (totalSats < totalNeeded) {
selectedUTXOs.push(utxo);
totalSats += utxo.value;
}
}

console.log(`✅ Selected ${selectedUTXOs.length} UTXOs, total: ${totalSats} sats`);

let privateKeyWIF = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKeyWIF = Buffer.from(privateKeyInput).toString('hex');
}
if (Buffer.isBuffer(privateKeyInput)) {
privateKeyWIF = privateKeyInput.toString('hex');
}

const keyPair = ECPair.fromWIF(privateKeyWIF);
const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

for (const utxo of selectedUTXOs) {
let rawTx;
try {
const response = await axios.get(`https://mempool.space/api/tx/${utxo.txid}/hex`);
rawTx = response.data;
} catch (error) {
console.log('⚠️ Mempool.space tx fetch failed, trying blockchain.info...');
const response = await axios.get(`https://blockchain.info/rawtx/${utxo.txid}`);
rawTx = response.data;
}

psbt.addInput({
hash: utxo.txid,
index: utxo.vout,
nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
witnessUtxo: {
script: Buffer.from(utxo.scriptpubkey || utxo.script, 'hex'),
value: utxo.value
}
});
}

psbt.addOutput({
address: toAddress,
value: satoshisNeeded
});

const fee = Math.min(estimatedFee, totalSats - satoshisNeeded - 1000);
const change = totalSats - satoshisNeeded - fee;

if (change > 1000) {
psbt.addOutput({
address: wallet.address,
value: change
});
console.log(`💰 Change: ${change} sats sent back to wallet`);
} else {
console.log(`💰 No significant change (${change} sats)`);
}

console.log(`💰 Actual fee: ${fee} sats`);

for (let i = 0; i < selectedUTXOs.length; i++) {
psbt.signInput(i, keyPair);
}

psbt.finalizeAllInputs();
const tx = psbt.extractTransaction();
const txHex = tx.toHex();

let broadcastResponse;
try {
broadcastResponse = await axios.post('https://mempool.space/api/tx', txHex);
} catch (error) {
console.log('⚠️ Mempool.space broadcast failed, trying blockchain.info...');
broadcastResponse = await axios.post('https://blockchain.info/pushtx', `tx=${txHex}`);
}

console.log(`✅ BTC Transaction broadcasted: ${broadcastResponse.data}`);
return broadcastResponse.data;
} catch (error) {
console.error('❌ BTC send error:', error.message);
if (error.response) {
console.error('Response data:', error.response.data);
console.error('Response status:', error.response.status);
}
throw error;
}
}

// ============================================================
// 📌 SEND ETH (REAL) - ACCEPTS HEX, BASE64, JSON ARRAY
// ============================================================
async function sendETH(privateKeyInput, toAddress, amountETH) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);

let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();

const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountETH.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});

await tx.wait();
return tx.hash;
} catch (error) {
console.error('❌ ETH send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND ERC20 TOKEN (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendERC20(privateKeyInput, toAddress, amount, contractAddress, decimals = 6) {
try {
const provider = new ethers.JsonRpcProvider(ETH_RPC);

let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const wallet = new ethers.Wallet(privateKey, provider);
const abi = ['function transfer(address to, uint256 amount) returns (bool)'];
const contract = new ethers.Contract(contractAddress, abi, wallet);
const amountUnits = ethers.parseUnits(amount.toString(), decimals);
const feeData = await provider.getFeeData();

const tx = await contract.transfer(toAddress, amountUnits, {
gasLimit: 100000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});
await tx.wait();
return tx.hash;
} catch (error) {
console.error('❌ ERC20 send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND SOL (REAL) - ACCEPTS ALL FORMATS (Base58, JSON, Base64, Hex)
// ============================================================
async function sendSOL(privateKeyInput, toAddress, amountSOL) {
try {
console.log(`📤 Sending ${amountSOL} SOL to ${toAddress}`);

const connection = new Connection(SOLANA_RPC);

let secretKey = parsePrivateKey(privateKeyInput, 'SOL');

if (typeof secretKey === 'string') {
try {
const decoded = bs58.decode(secretKey);
if (decoded.length === 64) {
secretKey = Uint8Array.from(decoded);
console.log('✅ SOL: Using Base58 format');
}
} catch (e) { /* Not base58 */ }

if (typeof secretKey === 'string') {
try {
const buffer = Buffer.from(secretKey, 'base64');
if (buffer.length === 64) {
secretKey = Uint8Array.from(buffer);
console.log('✅ SOL: Using Base64 format');
}
} catch (e) { /* Not base64 */ }
}

if (typeof secretKey === 'string') {
try {
const hexClean = secretKey.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean)) {
secretKey = Uint8Array.from(Buffer.from(hexClean, 'hex'));
console.log('✅ SOL: Using Hex format');
}
} catch (e) { /* Not hex */ }
}
}

if (typeof secretKey === 'string') {
try {
const array = JSON.parse(secretKey);
if (Array.isArray(array) && array.length === 64) {
secretKey = Uint8Array.from(array);
console.log('✅ SOL: Using JSON array format');
}
} catch (e) { /* Not JSON */ }
}

if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}

const fromKeypair = Keypair.fromSecretKey(secretKey);
const toPublicKey = new PublicKey(toAddress);
const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);

console.log(`🔑 From: ${fromKeypair.publicKey.toString()}`);
console.log(`📬 To: ${toPublicKey.toString()}`);
console.log(`💰 Lamports: ${lamports}`);

const transaction = new Transaction().add(
SystemProgram.transfer({
fromPubkey: fromKeypair.publicKey,
toPubkey: toPublicKey,
lamports: lamports
})
);

const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) {
console.error('❌ SOL send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND USDC ON SOLANA (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendUSDCOnSolana(privateKeyInput, toAddress, amountUSDC) {
try {
const connection = new Connection(SOLANA_RPC);

let secretKey = parsePrivateKey(privateKeyInput, 'USDC-SOL');

if (typeof secretKey === 'string') {
try {
const decoded = bs58.decode(secretKey);
if (decoded.length === 64) {
secretKey = Uint8Array.from(decoded);
console.log('✅ USDC-SOL: Using Base58 format');
}
} catch (e) { /* Not base58 */ }

if (typeof secretKey === 'string') {
try {
const buffer = Buffer.from(secretKey, 'base64');
if (buffer.length === 64) {
secretKey = Uint8Array.from(buffer);
console.log('✅ USDC-SOL: Using Base64 format');
}
} catch (e) { /* Not base64 */ }
}

if (typeof secretKey === 'string') {
try {
const hexClean = secretKey.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean)) {
secretKey = Uint8Array.from(Buffer.from(hexClean, 'hex'));
console.log('✅ USDC-SOL: Using Hex format');
}
} catch (e) { /* Not hex */ }
}
}

if (typeof secretKey === 'string') {
try {
const array = JSON.parse(secretKey);
if (Array.isArray(array) && array.length === 64) {
secretKey = Uint8Array.from(array);
console.log('✅ USDC-SOL: Using JSON array format');
}
} catch (e) { /* Not JSON */ }
}

if (!secretKey || secretKey.length !== 64) {
throw new Error(`Invalid Solana private key. Length: ${secretKey ? secretKey.length : 'undefined'}, expected 64 bytes`);
}

const fromKeypair = Keypair.fromSecretKey(secretKey);
const TOKEN_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const toPublicKey = new PublicKey(toAddress);
const fromTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, fromKeypair.publicKey);
const toTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, toPublicKey);

const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
const transaction = new Transaction();

if (!toAccountInfo) {
transaction.add(
createAssociatedTokenAccountInstruction(
fromKeypair.publicKey,
toTokenAccount,
toPublicKey,
TOKEN_MINT
)
);
}

const amount = Math.round(amountUSDC * 1000000);
const transferIx = createTransferInstruction(
fromTokenAccount,
toTokenAccount,
fromKeypair.publicKey,
amount
);
transaction.add(transferIx);

const signature = await connection.sendTransaction(transaction, [fromKeypair]);
await connection.confirmTransaction(signature);
return signature;
} catch (error) {
console.error('❌ USDC Solana send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND BNB (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendBNB(privateKeyInput, toAddress, amountBNB) {
try {
const provider = new ethers.JsonRpcProvider(BSC_RPC);

let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();

const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountBNB.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});

await tx.wait();
return tx.hash;
} catch (error) {
console.error('❌ BNB send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND AVAX (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendAVAX(privateKeyInput, toAddress, amountAVAX) {
try {
const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);

let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = '0x' + Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = '0x' + privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (!privateKeyInput.startsWith('0x') && /^[0-9a-f]{64}$/i.test(privateKeyInput)) {
privateKey = '0x' + privateKeyInput;
}
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = '0x' + Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const wallet = new ethers.Wallet(privateKey, provider);
const feeData = await provider.getFeeData();

const tx = await wallet.sendTransaction({
to: toAddress,
value: ethers.parseEther(amountAVAX.toString()),
gasLimit: 21000,
gasPrice: feeData.gasPrice || feeData.gasPrice
});

await tx.wait();
return tx.hash;
} catch (error) {
console.error('❌ AVAX send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND USDT ON TRON (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendUSDTOnTron(privateKeyInput, toAddress, amountUSDT) {
try {
let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const tronWeb = new TronWeb({
fullHost: TRON_RPC,
privateKey: privateKey
});

const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const amount = amountUSDT * 1000000;

const result = await contract.transfer(toAddress, amount).send();
return result.transaction_id;
} catch (error) {
console.error('❌ USDT TRC20 send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND XRP (REAL) - ACCEPTS ALL FORMATS
// ============================================================
async function sendXRP(privateKeyInput, toAddress, amountXRP) {
try {
const api = new RippleAPI({ server: 'wss://s1.ripple.com' });
await api.connect();

let privateKey = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKey = Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKey = privateKeyInput.toString('hex');
} else if (typeof privateKeyInput === 'string') {
if (privateKeyInput.length >= 80 && privateKeyInput.length <= 100) {
try {
const decoded = bs58.decode(privateKeyInput);
if (decoded.length === 32) {
privateKey = Buffer.from(decoded).toString('hex');
}
} catch (e) { /* Not base58 */ }
}
}

const wallet = api.deriveWallet(privateKey);
const amountDrops = Math.round(amountXRP * 1000000);

const prepared = await api.prepareTransaction({
TransactionType: 'Payment',
Account: wallet.classicAddress,
Destination: toAddress,
Amount: amountDrops.toString()
});

const signed = api.sign(prepared.txJSON, wallet.privateKey);
const result = await api.submit(signed.signedTransaction);
await api.disconnect();

return result.result.tx_json.hash;
} catch (error) {
console.error('❌ XRP send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 SEND LTC (REAL) - ACCEPTS WIF AND OTHER FORMATS
// ============================================================
async function sendLTC(privateKeyInput, toAddress, amountLTC) {
try {
const wallet = getWalletForCoin('LTC');
const LITECOIN = {
messagePrefix: '\x19Litecoin Signed Message:\n',
bech32: 'ltc',
bip32: {
public: 0x019da462,
private: 0x019d9cfe
},
pubKeyHash: 0x30,
scriptHash: 0x32,
wif: 0xb0
};

let privateKeyWIF = privateKeyInput;
if (privateKeyInput instanceof Uint8Array) {
privateKeyWIF = Buffer.from(privateKeyInput).toString('hex');
} else if (Buffer.isBuffer(privateKeyInput)) {
privateKeyWIF = privateKeyInput.toString('hex');
}

const utxoResponse = await axios.get(`https://api.blockchair.com/litecoin/dashboards/address/${wallet.address}?transaction_details=true`);
const utxos = utxoResponse.data.data[wallet.address].utxo || [];

const litoshisNeeded = Math.round(amountLTC * 100000000);
let selectedUTXOs = [];
let totalSats = 0;

for (const utxo of utxos) {
if (totalSats < litoshisNeeded + 10000) {
selectedUTXOs.push(utxo);
totalSats += utxo.value;
}
}

if (totalSats < litoshisNeeded + 10000) {
throw new Error('Insufficient UTXOs to cover amount + fee');
}

const keyPair = ECPair.fromWIF(privateKeyWIF, LITECOIN);
const psbt = new bitcoin.Psbt({ network: LITECOIN });

for (const utxo of selectedUTXOs) {
psbt.addInput({
hash: utxo.transaction_hash,
index: utxo.index,
witnessUtxo: {
script: Buffer.from(utxo.script_hex, 'hex'),
value: utxo.value
}
});
}

psbt.addOutput({
address: toAddress,
value: litoshisNeeded
});

const change = totalSats - litoshisNeeded - 10000;
if (change > 0) {
psbt.addOutput({
address: wallet.address,
value: change
});
}

for (let i = 0; i < selectedUTXOs.length; i++) {
psbt.signInput(i, keyPair);
}

psbt.finalizeAllInputs();
const tx = psbt.extractTransaction();
const txHex = tx.toHex();

const broadcastResponse = await axios.post('https://litecoin.nownodes.io/api/v2/send_tx', { tx_hex: txHex });
return broadcastResponse.data.txid || broadcastResponse.data;
} catch (error) {
console.error('❌ LTC send error:', error.message);
throw error;
}
}

// ============================================================
// 📌 MAIN SEND FUNCTION WITH SMART BUFFER
// ============================================================
async function sendCryptoFromWallet(coinSymbol, toAddress, requestedAmount, network) {
console.log(`📤 Sending ${requestedAmount} ${coinSymbol} to ${toAddress}`);
console.log(`🌐 Network: ${network || 'Default'}`);

// 🔥 CHECK EMERGENCY PAUSE
checkEmergencyPause();

// 🔥 GET SMART BUFFER
const buffer = await getSmartBuffer(coinSymbol);
const actualAmount = requestedAmount * (1 - buffer);

console.log(`💰 Buffer: ${(buffer * 100).toFixed(0)}%`);
console.log(`💰 Sending: ${actualAmount} ${coinSymbol}`);

const wallet = getWalletForCoin(coinSymbol, network);

if (!wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol}`);
}

// 🔥 CHECK WALLET HEALTH
const safety = await isSystemSafe(coinSymbol, actualAmount);
if (!safety.safe) {
throw new Error(`System not safe: ${safety.reason}. ${safety.action}`);
}

const balance = await getWalletBalance(coinSymbol, network);
if (balance < actualAmount) {
throw new Error(`Insufficient balance: Have ${balance}, Need ${actualAmount}`);
}

let txId;
let explorerUrl;

try {
if (coinSymbol === 'BTC') {
txId = await sendBTC(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://mempool.space/tx/${txId}`;
}
else if (coinSymbol === 'ETH') {
txId = await sendETH(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://etherscan.io/tx/${txId}`;
}
else if (coinSymbol === 'SOL') {
txId = await sendSOL(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://solscan.io/tx/${txId}`;
}
else if (coinSymbol === 'BNB') {
txId = await sendBNB(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://bscscan.com/tx/${txId}`;
}
else if (coinSymbol === 'AVAX') {
txId = await sendAVAX(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://snowtrace.io/tx/${txId}`;
}
else if (coinSymbol === 'XRP') {
txId = await sendXRP(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://xrpscan.com/tx/${txId}`;
}
else if (coinSymbol === 'LTC') {
txId = await sendLTC(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://blockchair.com/litecoin/transaction/${txId}`;
}
else if (coinSymbol === 'USDC' && network === 'SOL') {
txId = await sendUSDCOnSolana(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://solscan.io/tx/${txId}`;
}
else if (coinSymbol === 'USDT' && network === 'TRC20') {
txId = await sendUSDTOnTron(wallet.privateKey, toAddress, actualAmount);
explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
}
else if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
const contractAddress = coinSymbol === 'USDC'
? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
: '0xdAC17F958D2ee523a2206206994597C13D831ec7';
txId = await sendERC20(wallet.privateKey, toAddress, actualAmount, contractAddress, 6);
explorerUrl = `https://etherscan.io/tx/${txId}`;
}
else if (coinSymbol === 'LINK') {
const contractAddress = '0x514910771AF9Ca656af840dff83E8264EcF986CA';
txId = await sendERC20(wallet.privateKey, toAddress, actualAmount, contractAddress, 18);
explorerUrl = `https://etherscan.io/tx/${txId}`;
}
else {
throw new Error(`Sending not implemented for ${coinSymbol}`);
}

// Track volume
trackVolume(coinSymbol, actualAmount);

console.log(`✅ Transaction sent! TxID: ${txId}`);
console.log(`🔗 Explorer: ${explorerUrl}`);

return {
success: true,
txId: txId,
explorerUrl: explorerUrl,
amountSent: actualAmount,
fromAddress: wallet.address,
toAddress: toAddress,
buffer: buffer
};

} catch (error) {
console.error('❌ Send error:', error.message);
return {
success: false,
error: error.message
};
}
}

// ============================================================
// 📌 PROCESS SUCCESSFUL ORDER
// ============================================================
async function processSuccessfulOrder(order, paymentData) {
try {
console.log(`\n🚀 Processing order: ${order.tx_ref}`);

if (order.status === 'completed') {
console.log(`⚠️ Order already completed. Skipping.`);
return { success: true, alreadyProcessed: true };
}

// 🔥 CHECK EMERGENCY PAUSE
checkEmergencyPause();

// 🔥 CHECK SYSTEM SAFETY
const safety = await isSystemSafe(order.coinSymbol, order.cryptoAmount);
if (!safety.safe) {
order.status = 'failed';
order.failureReason = `System not safe: ${safety.reason}`;
console.log(`❌ Order failed: ${safety.reason}`);
await sendTelegramAlert(`🚨 *ORDER FAILED*\n\n${order.tx_ref}\n${safety.reason}\nAction: ${safety.action}`);
return { success: false, error: safety.reason };
}

const balance = await getWalletBalance(order.coinSymbol, order.network);
if (balance < order.cryptoAmount) {
order.status = 'failed';
order.failureReason = `Insufficient balance: Have ${balance}, Need ${order.cryptoAmount}`;
console.log(`❌ Insufficient balance for ${order.coinSymbol}`);
return { success: false, error: order.failureReason };
}

const txResult = await sendCryptoFromWallet(
order.coinSymbol,
order.walletAddress,
order.cryptoAmount,
order.network
);

if (txResult.success) {
order.status = 'completed';
order.txId = txResult.txId;
order.explorerUrl = txResult.explorerUrl;
order.completedAt = new Date().toISOString();
order.paymentData = paymentData;
order.bufferApplied = txResult.buffer;
console.log(`✅ Order completed! TxID: ${txResult.txId}`);
return { success: true, txId: txResult.txId };
} else {
order.status = 'failed';
order.failureReason = txResult.error;
order.completedAt = new Date().toISOString();
console.log(`❌ Failed to send crypto: ${txResult.error}`);
return { success: false, error: txResult.error };
}

} catch (error) {
console.error('❌ Process order error:', error.message);
order.status = 'failed';
order.failureReason = error.message;
return { success: false, error: error.message };
}
}

// ============================================================
// 📌 CHECK BALANCE
// ============================================================
app.post('/api/check-balance', async (req, res) => {
try {
// 🔥 CHECK EMERGENCY PAUSE
checkEmergencyPause();

const { coinSymbol, network, amount } = req.body;
const balance = await getWalletBalance(coinSymbol, network);
const hasBalance = balance >= amount;

res.json({
success: true,
hasBalance: hasBalance,
balance: balance,
requested: amount
});
} catch (error) {
if (error.message.includes('paused')) {
res.status(503).json({ success: false, error: 'System is currently paused. Please try again later.', paused: true });
} else {
res.status(500).json({ success: false, error: error.message });
}
}
});

// ============================================================
// 📌 CREATE PAYMENT WITH SMART BUFFER
// ============================================================
app.post('/api/create-payment', async (req, res) => {
try {
// 🔥 CHECK EMERGENCY PAUSE
checkEmergencyPause();

const {
coinSymbol,
cryptoAmount,
walletAddress,
network,
email,
name,
amountUSD,
nairaRate
} = req.body;

// 🔥 GET SMART BUFFER
const buffer = await getSmartBuffer(coinSymbol);
const actualAmount = cryptoAmount * (1 - buffer);

console.log(`📊 ${coinSymbol} - Buffer: ${(buffer * 100).toFixed(0)}%`);
console.log(`📊 Original: ${cryptoAmount}, Actual: ${actualAmount}`);

// 🔥 CHECK SYSTEM SAFETY
const safety = await isSystemSafe(coinSymbol, actualAmount);
if (!safety.safe) {
return res.status(400).json({
success: false,
error: `System not safe: ${safety.reason}. ${safety.action}`
});
}

const tx_ref = 'DP' + Date.now();
const amountNGN = Math.round(amountUSD * nairaRate);

const balance = await getWalletBalance(coinSymbol, network);
if (balance < actualAmount) {
return res.status(400).json({
success: false,
error: `Insufficient balance. Available: ${balance} ${coinSymbol}, Required: ${actualAmount} ${coinSymbol}`
});
}

orders[tx_ref] = {
tx_ref,
coinSymbol,
cryptoAmount: actualAmount,
walletAddress,
network: network || 'Default',
amountUSD: parseFloat(amountUSD),
amountNGN: amountNGN,
status: 'pending',
createdAt: new Date().toISOString(),
email: email || 'customer@dubpay.com',
name: name || 'DubPay Customer',
bufferApplied: buffer
};

console.log(`📝 Order created: ${tx_ref}`);
console.log(`📍 Buffer applied: ${(buffer * 100).toFixed(0)}%`);

const paymentData = {
tx_ref: tx_ref,
amount: amountNGN,
currency: "NGN",
redirect_url: `${FRONTEND_URL}/payment-status?tx_ref=${tx_ref}`,
payment_options: "card,banktransfer,ussd",
customer: {
email: email || 'customer@dubpay.com',
name: name || 'DubPay Customer'
},
customizations: {
title: "DubPay - Buy Crypto",
description: `${cryptoAmount} ${coinSymbol}`,
logo: "https://dubpay.com/logo.png"
},
meta: {
coinSymbol,
cryptoAmount,
walletAddress,
network: network || 'Default',
bufferApplied: buffer
}
};

const response = await fetch('https://api.flutterwave.com/v3/payments', {
method: 'POST',
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
},
body: JSON.stringify(paymentData)
});

const data = await response.json();

if (data.status === 'success') {
res.json({
success: true,
paymentLink: data.data.link,
tx_ref: tx_ref,
bufferApplied: buffer
});
} else {
res.status(400).json({
success: false,
error: data.message || 'Payment creation failed'
});
}
} catch (error) {
console.error('❌ Create payment error:', error.message);
if (error.message.includes('paused')) {
res.status(503).json({ success: false, error: 'System is currently paused. Please try again later.', paused: true });
} else {
res.status(500).json({ success: false, error: error.message });
}
}
});

// ============================================================
// 📌 VERIFY PAYMENT
// ============================================================
app.get('/api/verify-payment', async (req, res) => {
try {
const { tx_ref } = req.query;

console.log(`🔍 Verifying payment for: ${tx_ref}`);

if (!tx_ref) {
return res.status(400).json({ error: 'Missing transaction reference' });
}

const order = orders[tx_ref];
if (!order) {
console.log(`❌ Order not found: ${tx_ref}`);
return res.status(404).json({
error: 'Order not found. Please contact support.',
tx_ref: tx_ref
});
}

console.log(`✅ Order found: ${tx_ref}`);
console.log(`📊 Order status: ${order.status}`);

const response = await fetch(`https://api.flutterwave.com/v3/transactions/${tx_ref}/verify`, {
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`
}
});

const data = await response.json();

if (data.status === 'success' && data.data.status === 'successful') {
order.status = 'verified';
console.log(`✅ Payment verified for: ${tx_ref}`);
res.json({
success: true,
message: 'Payment verified! Your crypto is being sent...',
order: order
});
} else if (order.status === 'completed') {
res.json({
success: true,
message: 'Crypto has been sent to your wallet!',
order: order
});
} else {
console.log(`⏳ Payment not yet confirmed: ${tx_ref}`);
res.json({
success: false,
message: 'Payment not confirmed yet. Please check back later.',
order: order
});
}
} catch (error) {
console.error('❌ Verify payment error:', error.message);
res.status(500).json({ error: error.message });
}
});

// ============================================================
// 📌 GET ORDER STATUS
// ============================================================
app.get('/api/order-status/:tx_ref', (req, res) => {
const order = orders[req.params.tx_ref];

if (!order) {
return res.status(404).json({ error: 'Order not found' });
}

res.json({
success: true,
order: order
});
});

// ============================================================
// 📌 FLUTTERWAVE WEBHOOK
// ============================================================
app.post('/api/flutterwave-webhook', async (req, res) => {
try {
const signature = req.headers['verif-hash'];
if (signature !== FLUTTERWAVE_WEBHOOK_SECRET) {
console.log('❌ Invalid webhook signature');
return res.status(401).send('Invalid signature');
}

const event = req.body;
console.log(`📥 Webhook received: ${event.event}`);

if (event.event === 'charge.completed' && event.data.status === 'successful') {
const tx_ref = event.data.tx_ref;
console.log(`✅ Payment successful for TX: ${tx_ref}`);

const order = orders[tx_ref];

if (!order) {
console.log(`❌ Order not found: ${tx_ref}`);
return res.status(404).send('Order not found');
}

console.log(`📊 Processing order: ${tx_ref}`);

const result = await processSuccessfulOrder(order, event.data);

if (result.success) {
console.log(`✅ Order ${tx_ref} completed successfully!`);
} else {
console.log(`❌ Order ${tx_ref} failed: ${result.error}`);
}

return res.status(200).send('Webhook processed');
}

res.status(200).send('Webhook received');
} catch (error) {
console.error('❌ Webhook error:', error.message);
res.status(500).send('Webhook error');
}
});

// ============================================================
// 📌 ADMIN ENDPOINTS
// ============================================================

// Get system status
app.get('/api/admin/status', async (req, res) => {
try {
const status = {
paused: EMERGENCY_PAUSED,
reason: PAUSE_REASON,
timestamp: new Date().toISOString()
};
res.json(status);
} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Manual pause (API fallback)
app.post('/api/admin/pause', async (req, res) => {
try {
const { reason } = req.body;
EMERGENCY_PAUSED = true;
PAUSE_REASON = reason || 'Manual pause via API';
await sendTelegramAlert(`🚨 *EMERGENCY PAUSE ACTIVATED*\n\nReason: ${PAUSE_REASON}`);
res.json({ success: true, message: 'System paused', reason: PAUSE_REASON });
} catch (error) {
res.status(500).json({ error: error.message });
}
});

// Manual resume (API fallback)
app.post('/api/admin/resume', async (req, res) => {
try {
EMERGENCY_PAUSED = false;
PAUSE_REASON = '';
await sendTelegramAlert(`✅ *SYSTEM RESUMED*\n\nAll orders are now active.`);
res.json({ success: true, message: 'System resumed' });
} catch (error) {
res.status(500).json({ error: error.message });
}
});

// ============================================================
// 📌 OTHER ENDPOINTS
// ============================================================
app.get('/api/health', (req, res) => {
res.json({
status: 'ok',
message: 'DubPay Backend is running! 🚀',
paused: EMERGENCY_PAUSED,
timestamp: new Date().toISOString()
});
});

app.get('/api/banks', async (req, res) => {
try {
const response = await fetch('https://api.flutterwave.com/v3/banks/NG', {
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
}
});
const data = await response.json();
if (data.status === 'success' && data.data) {
const seen = new Set();
const uniqueBanks = data.data.filter(bank => {
const duplicate = seen.has(bank.code);
seen.add(bank.code);
return !duplicate;
});
res.json({ status: 'success', message: 'Banks fetched successfully', data: uniqueBanks });
} else {
res.status(400).json(data);
}
} catch (error) {
res.status(500).json({ error: error.message });
}
});

app.post('/api/resolve', async (req, res) => {
try {
const { accountNumber, bankCode } = req.body;
if (!accountNumber || !bankCode) {
return res.status(400).json({ status: 'error', message: 'Account number and bank code are required' });
}
const cleanAccount = accountNumber.toString().trim();
if (cleanAccount.length !== 10) {
return res.status(400).json({ status: 'error', message: 'Account number must be 10 digits' });
}
if (cleanAccount === '0000000000') {
return res.json({
status: 'success',
data: { account_name: 'Test User', account_number: '0000000000', bank_name: 'Test Bank' }
});
}
const response = await fetch('https://api.flutterwave.com/v3/accounts/resolve', {
method: 'POST',
headers: {
'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
'Content-Type': 'application/json'
},
body: JSON.stringify({ account_number: cleanAccount, account_bank: bankCode })
});
const data = await response.json();
if (data.status === 'success' && data.data) {
res.json(data);
} else {
res.status(400).json({ status: 'error', message: data.message || 'Invalid account number' });
}
} catch (error) {
res.status(500).json({ status: 'error', message: error.message });
}
});

// ============================================================
// 📌 START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`\n✅ DubPay Backend is running on port ${PORT}`);
console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
console.log(`📍 Banks endpoint: http://localhost:${PORT}/api/banks`);
console.log(`📍 Resolve endpoint: http://localhost:${PORT}/api/resolve`);
console.log(`📍 Create payment: http://localhost:${PORT}/api/create-payment`);
console.log(`📍 Check balance: http://localhost:${PORT}/api/check-balance`);
console.log(`📍 Verify payment: http://localhost:${PORT}/api/verify-payment`);
console.log(`📍 Webhook: http://localhost:${PORT}/api/flutterwave-webhook`);
console.log(`📍 Telegram Webhook: http://localhost:${PORT}/api/telegram-webhook`);
console.log(`📍 Admin Status: http://localhost:${PORT}/api/admin/status\n`);
});

module.exports = app;
