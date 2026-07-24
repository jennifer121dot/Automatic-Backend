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

if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ BOT_TOKEN and CHAT_ID not set. Telegram features disabled.');
} else {
console.log('✅ Telegram bot configured');
}

// ============================================================
// 🔥 ORDER STORAGE
// ============================================================
const orders = {};

// ============================================================
// 🔥 WALLET CONFIGURATION
// ============================================================
console.log('🔍 Checking environment variables...');

const WALLETS = {
BTC: { address: process.env.BTC_ADDRESS || '', privateKey: process.env.BTC_PRIVATE_KEY || '', network: 'bitcoin' },
ETH: { address: process.env.ETH_ADDRESS || '', privateKey: process.env.ETH_PRIVATE_KEY || '', network: 'ethereum' },
BNB: { address: process.env.BNB_ADDRESS || '', privateKey: process.env.BNB_PRIVATE_KEY || '', network: 'bsc' },
SOL: { address: process.env.SOL_ADDRESS || '', privateKey: process.env.SOL_PRIVATE_KEY || '', network: 'solana' },
TRX: { address: process.env.TRX_ADDRESS || '', privateKey: process.env.TRX_PRIVATE_KEY || '', network: 'tron' },
XRP: { address: process.env.XRP_ADDRESS || '', privateKey: process.env.XRP_PRIVATE_KEY || '', network: 'ripple' },
LTC: { address: process.env.LTC_ADDRESS || '', privateKey: process.env.LTC_PRIVATE_KEY || '', network: 'litecoin' },
AVAX: { address: process.env.AVAX_ADDRESS || '', privateKey: process.env.AVAX_PRIVATE_KEY || '', network: 'avalanche' },
LINK: { address: process.env.LINK_ADDRESS || '', privateKey: process.env.LINK_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '', network: 'ethereum' }
};

Object.keys(WALLETS).forEach(coin => {
const wallet = WALLETS[coin];
if (wallet.privateKey) {
console.log(`✅ ${coin} wallet configured`);
} else {
console.log(`⚠️ ${coin} wallet NOT configured`);
}
});

// ============================================================
// 🔥 COIN TO WALLET MAPPING
// ============================================================
const COIN_TO_WALLET = {
'BTC': 'BTC',
'ETH': 'ETH',
'USDC': { 'ERC20': 'ETH', 'SOL': 'SOL', 'BNB': 'BNB' },
'USDT': { 'ERC20': 'ETH', 'SOL': 'SOL', 'BNB': 'BNB', 'TRC20': 'TRX' },
'BNB': 'BNB',
'SOL': 'SOL',
'XRP': 'XRP',
'LTC': 'LTC',
'AVAX': 'AVAX',
'LINK': 'LINK'
};

// ============================================================
// 🛡️ SMART SYSTEM - FIXED 429 ERRORS WITH BETTER CACHING
// ============================================================

const priceCache = {};
const yesterdayPrices = {};
let EMERGENCY_PAUSED = false;
let PAUSE_REASON = '';
const SUPPORTED_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'USDC', 'USDT', 'XRP', 'LTC', 'AVAX', 'LINK'];
const dailyVolumes = {};

// ============================================================
// 🔥 FIXED: BATCH PRICE FETCHING - NO MORE 429 ERRORS!
// ============================================================
async function getAllPrices() {
try {
const response = await axios.get(
'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana,ripple,litecoin,avalanche-2,chainlink&vs_currencies=usd',
{ timeout: 10000 }
);
return response.data;
} catch (error) {
console.error('❌ Error fetching prices:', error.message);
return null;
}
}

// Cached prices with 5-minute expiry
let cachedPrices = null;
let lastPriceFetch = 0;

async function getPrice(coinSymbol) {
try {
if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
return 1.00;
}

const now = Date.now();
if (cachedPrices && (now - lastPriceFetch < 300000)) {
const coinMap = {
'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin',
'SOL': 'solana', 'XRP': 'ripple', 'LTC': 'litecoin',
'AVAX': 'avalanche-2', 'LINK': 'chainlink'
};
const id = coinMap[coinSymbol];
if (id && cachedPrices[id]) {
return cachedPrices[id].usd;
}
}

const prices = await getAllPrices();
if (prices) {
cachedPrices = prices;
lastPriceFetch = now;
const coinMap = {
'BTC': 'bitcoin', 'ETH': 'ethereum', 'BNB': 'binancecoin',
'SOL': 'solana', 'XRP': 'ripple', 'LTC': 'litecoin',
'AVAX': 'avalanche-2', 'LINK': 'chainlink'
};
const id = coinMap[coinSymbol];
if (id && prices[id]) {
return prices[id].usd;
}
}

if (priceCache[coinSymbol]) {
return priceCache[coinSymbol];
}

return 0;
} catch (error) {
console.error(`❌ Error getting price for ${coinSymbol}:`, error.message);
return priceCache[coinSymbol] || 0;
}
}

// ============================================================
// 🔥 AUTO-BUFFER SYSTEM (20% → 15% → 10% → 7% → 5%)
// ============================================================
async function getSmartBuffer(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

if (balanceUSD < 10) return 0.20;

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (balanceUSD < 500) return 0.08;
if (balanceUSD < 2000) return 0.05;
if (balanceUSD < 10000) return 0.03;
return 0.02;
}

if (coinSymbol === 'BTC' || coinSymbol === 'ETH') {
if (balanceUSD < 500) return 0.18;
if (balanceUSD < 2000) return 0.15;
if (balanceUSD < 10000) return 0.12;
return 0.08;
}

if (balanceUSD < 500) return 0.15;
if (balanceUSD < 2000) return 0.10;
if (balanceUSD < 10000) return 0.07;
return 0.05;
}

// ============================================================
// 🔥 SMART SELL LIMITS
// ============================================================
async function getSmartSellLimits(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

if (balanceUSD < 10) return { perTx: 5, perDay: 10, perWeek: 50 };

if (balanceUSD < 500) return { perTx: 10, perDay: 20, perWeek: 100 };
if (balanceUSD < 2000) return { perTx: 25, perDay: 50, perWeek: 250 };
if (balanceUSD < 10000) return { perTx: 50, perDay: 100, perWeek: 500 };
return { perTx: 200, perDay: 500, perWeek: 2000 };
}

// ============================================================
// 🔥 SMART STOP LOSS
// ============================================================
async function getSmartStopLoss(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);

if (balanceUSD < 10) return 0.05;

if (coinSymbol === 'BTC' || coinSymbol === 'ETH') {
if (balanceUSD < 500) return 0.06;
if (balanceUSD < 2000) return 0.08;
if (balanceUSD < 10000) return 0.10;
return 0.15;
}

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
return 999;
}

if (balanceUSD < 500) return 0.08;
if (balanceUSD < 2000) return 0.10;
if (balanceUSD < 10000) return 0.15;
return 0.20;
}

// ============================================================
// 🔥 WALLET BALANCE USD
// ============================================================
async function getWalletBalanceUSD(coinSymbol) {
try {
const balance = await getWalletBalance(coinSymbol);
const price = await getPrice(coinSymbol);
const usdValue = balance * price;
if (price > 0) {
priceCache[coinSymbol] = price;
}
return usdValue;
} catch (error) {
console.error(`❌ Error getting balance USD for ${coinSymbol}:`, error.message);
return 0;
}
}

// ============================================================
// 🔥 SMART MIN BALANCE
// ============================================================
async function getSmartMinBalance(coinSymbol) {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);
const dailyVolume = dailyVolumes[coinSymbol] || 0;

if (balanceUSD < 10) return dailyVolume * 5;

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (balanceUSD < 500) return dailyVolume * 2;
if (balanceUSD < 2000) return dailyVolume * 1.5;
if (balanceUSD < 10000) return dailyVolume * 1;
return dailyVolume * 0.5;
}

if (balanceUSD < 500) return dailyVolume * 3;
if (balanceUSD < 2000) return dailyVolume * 2.5;
if (balanceUSD < 10000) return dailyVolume * 2;
return dailyVolume * 1.5;
}

// ============================================================
// 🔥 CHECK SYSTEM SAFE
// ============================================================
async function isSystemSafe(coinSymbol, amountNeeded) {
try {
const balanceUSD = await getWalletBalanceUSD(coinSymbol);
const minBalance = await getSmartMinBalance(coinSymbol);
const price = await getPrice(coinSymbol);
const neededUSD = amountNeeded * price;

if (balanceUSD < minBalance + neededUSD) {
return {
safe: false,
reason: `Insufficient balance. Have $${balanceUSD.toFixed(2)}, Need $${(minBalance + neededUSD).toFixed(2)}`,
action: 'Replenish wallet or reduce order size'
};
}

const stopLoss = await getSmartStopLoss(coinSymbol);
if (stopLoss < 100) {
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

// ============================================================
// 🚨 TELEGRAM NOTIFICATION WITH ACCEPT/DECLINE BUTTONS
// ============================================================
async function sendTelegramOrderNotification(order, transactionType) {
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured - skipping notification');
return;
}

try {
const coinSymbol = order.coinSymbol || 'BTC';
const cryptoAmount = order.cryptoAmount || 0;
const amountUSD = order.amountUSD || 0;
const bufferApplied = order.bufferApplied || 0.07;
const bufferPercent = (bufferApplied * 100).toFixed(0);

let message = '';
let keyboard = {};

if (transactionType === 'buy') {
message = `🧾 *New Purchase Order*\n\n` +
`💎 *Coin:* ${coinSymbol}\n` +
`💰 *Amount Received:* ${cryptoAmount.toFixed(8)} ${coinSymbol}\n` +
`💵 *USD Value:* $${amountUSD.toFixed(2)}\n` +
`🇳🇬 *NGN Paid:* ₦${(amountUSD * 1421).toFixed(2)}\n` +
`📉 *Buffer Applied:* ${bufferPercent}%\n` +
`📬 *Wallet:* \`${order.walletAddress || 'N/A'}\`\n` +
`🆔 *Ref:* #${order.tx_ref}\n` +
`📅 *Time:* ${new Date().toLocaleString()}`;

keyboard = {
inline_keyboard: [
[{ text: '✅ Approve & Send Crypto', callback_data: `approve_buy_${order.tx_ref}` }],
[{ text: '📊 Check Status', callback_data: `check_order_${order.tx_ref}` }]
]
};
} else {
message = `🧾 *New Sell Order*\n\n` +
`💎 *Coin:* ${coinSymbol}\n` +
`💰 *Amount:* ${cryptoAmount.toFixed(8)} ${coinSymbol}\n` +
`💵 *USD Value:* $${amountUSD.toFixed(2)}\n` +
`🇳🇬 *NGN Received:* ₦${(amountUSD * 1421 * 0.93).toFixed(2)}\n` +
`📉 *Buffer Applied:* ${bufferPercent}%\n` +
`🏦 *Bank:* ${order.selectedBankName || 'N/A'}\n` +
`📱 *Account:* ${order.accountNumber || 'N/A'}\n` +
`👤 *Name:* ${order.accountName || 'N/A'}\n` +
`🆔 *Ref:* #${order.tx_ref}\n` +
`📅 *Time:* ${new Date().toLocaleString()}`;

keyboard = {
inline_keyboard: [
[{ text: '✅ Accept Order', callback_data: `accept_${order.tx_ref}` }],
[{ text: '❌ Decline Order', callback_data: `decline_${order.tx_ref}` }]
]
};
}

await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: CHAT_ID,
text: message,
parse_mode: 'Markdown',
reply_markup: keyboard
})
});

console.log(`✅ Telegram notification sent for ${transactionType} order: ${order.tx_ref}`);
} catch (error) {
console.error('❌ Failed to send Telegram notification:', error.message);
}
}

// ============================================================
// 🔧 TELEGRAM WEBHOOK - WITH ACCEPT/DECLINE HANDLING
// ============================================================
app.post('/api/telegram-webhook', async (req, res) => {
res.status(200).send('OK');

try {
const update = req.body;
console.log('📥 Telegram webhook received');

if (update.callback_query) {
const callbackData = update.callback_query.data;
const chatId = update.callback_query.message.chat.id;
const callbackQueryId = update.callback_query.id;

console.log(`🔘 Button clicked: ${callbackData}`);

if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured');
return;
}

if (chatId.toString() !== CHAT_ID) {
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
callback_query_id: callbackQueryId,
text: '❌ Unauthorized',
show_alert: true
})
});
return;
}

let responseText = '';
let showAlert = false;

// ============================================================
// 🔥 HANDLE APPROVE BUY
// ============================================================
if (callbackData.startsWith('approve_buy_')) {
const tx_ref = callbackData.replace('approve_buy_', '');
const order = orders[tx_ref];

if (!order) {
responseText = '❌ Order not found!';
} else if (order.status === 'completed') {
responseText = '⚠️ Order already completed!';
} else if (order.status === 'failed') {
responseText = '❌ Order failed!';
} else {
// PROCESS THE BUY ORDER MANUALLY
responseText = `⏳ Processing order #${tx_ref}...`;
showAlert = true;

try {
const result = await processSuccessfulOrder(order, { manual: true });
if (result.success) {
responseText = `✅ *ORDER COMPLETED!*\n\nRef: #${tx_ref}\nCoin: ${order.coinSymbol}\nAmount: ${order.cryptoAmount} ${order.coinSymbol}\n\nCrypto has been sent to customer!`;
showAlert = true;
console.log(`✅ Order ${tx_ref} processed successfully via Telegram`);
} else {
responseText = `❌ *ORDER FAILED*\n\nRef: #${tx_ref}\nError: ${result.error}`;
showAlert = true;
console.log(`❌ Order ${tx_ref} failed: ${result.error}`);
}
} catch (error) {
responseText = `❌ Error processing order: ${error.message}`;
showAlert = true;
}
}
}

// ============================================================
// 🔥 HANDLE ACCEPT (SELL)
// ============================================================
else if (callbackData.startsWith('accept_')) {
const tx_ref = callbackData.replace('accept_', '');
const order = orders[tx_ref];

if (!order) {
responseText = '❌ Order not found!';
} else if (order.status === 'approved') {
responseText = '⚠️ Order already approved!';
} else if (order.status === 'declined') {
responseText = '❌ Order was declined!';
} else {
order.status = 'approved';
order.approvedAt = new Date().toISOString();
responseText = `✅ *ORDER ACCEPTED!*\n\nRef: #${tx_ref}\nCoin: ${order.coinSymbol}\nAmount: ${order.cryptoAmount} ${order.coinSymbol}\n\nPayment will be sent to customer's bank.`;
showAlert = true;
console.log(`✅ Order ${tx_ref} ACCEPTED via Telegram`);
await sendTelegramAlert(`✅ *ORDER ACCEPTED*\n\nRef: #${tx_ref}`);
}
}

// ============================================================
// 🔥 HANDLE DECLINE (SELL)
// ============================================================
else if (callbackData.startsWith('decline_')) {
const tx_ref = callbackData.replace('decline_', '');
const order = orders[tx_ref];

if (!order) {
responseText = '❌ Order not found!';
} else if (order.status === 'approved') {
responseText = '⚠️ Order already approved!';
} else if (order.status === 'declined') {
responseText = '⚠️ Order already declined!';
} else {
order.status = 'declined';
order.declinedAt = new Date().toISOString();
order.declineReason = 'Declined by admin via Telegram';
responseText = `❌ *ORDER DECLINED*\n\nRef: #${tx_ref}\nCoin: ${order.coinSymbol}\nAmount: ${order.cryptoAmount} ${order.coinSymbol}\n\nThe customer has been notified.`;
showAlert = true;
console.log(`❌ Order ${tx_ref} DECLINED via Telegram`);
await sendTelegramAlert(`❌ *ORDER DECLINED*\n\nRef: #${tx_ref}`);
}
}

// ============================================================
// 🔥 HANDLE CHECK ORDER
// ============================================================
else if (callbackData.startsWith('check_order_')) {
const tx_ref = callbackData.replace('check_order_', '');
const order = orders[tx_ref];

if (!order) {
responseText = '❌ Order not found!';
} else {
responseText = `📊 *Order Status*\n\n` +
`Ref: #${tx_ref}\n` +
`Coin: ${order.coinSymbol}\n` +
`Amount: ${order.cryptoAmount} ${order.coinSymbol}\n` +
`Status: ${order.status.toUpperCase()}\n` +
`Created: ${new Date(order.createdAt).toLocaleString()}` +
(order.approvedAt ? `\nApproved: ${new Date(order.approvedAt).toLocaleString()}` : '') +
(order.declinedAt ? `\nDeclined: ${new Date(order.declinedAt).toLocaleString()}` : '') +
(order.txId ? `\nTxID: ${order.txId}` : '');
}
}

// ============================================================
// 🔥 HANDLE PAUSE/RESUME/STATUS/WALLETS
// ============================================================
else if (callbackData === 'pause_orders') {
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

// Answer the callback
try {
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
callback_query_id: callbackQueryId,
text: responseText.replace(/\*/g, '').substring(0, 200),
show_alert: showAlert
})
});
console.log('✅ Callback answered successfully');
} catch (error) {
console.error('❌ Failed to answer callback:', error.message);
}

await sendPauseControlKeyboard();
}
} catch (error) {
console.error('❌ Telegram webhook processing error:', error.message);
}
});

// ============================================================
// 🔄 AUTO-MONITOR SYSTEM
// ============================================================
setInterval(async () => {
console.log('🔄 Running smart system check for ALL coins...');

for (const coin of SUPPORTED_COINS) {
try {
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

if (new Date().getHours() === 0) {
await sendTelegramAlert(`📊 *DAILY SYSTEM REPORT*\n\n${new Date().toLocaleDateString()}\n\nAll systems monitored. ${EMERGENCY_PAUSED ? '⚠️ System is PAUSED' : '✅ System is RUNNING'}`);
}

}, 60 * 60 * 1000);

// ============================================================
// 📌 SEND PAUSE CONTROL KEYBOARD
// ============================================================
async function sendPauseControlKeyboard() {
if (!BOT_TOKEN || !CHAT_ID) {
console.warn('⚠️ Telegram not configured');
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
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: CHAT_ID,
text: message,
parse_mode: 'Markdown',
reply_markup: keyboard
})
});
} catch (error) {
console.error('❌ Failed to send pause control:', error.message);
}
}

// ============================================================
// 📌 SEND TELEGRAM ALERT
// ============================================================
async function sendTelegramAlert(message) {
if (!BOT_TOKEN || !CHAT_ID) return;
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
// 🔥 GET WALLET FOR COIN
// ============================================================
function getWalletForCoin(coinSymbol, network) {
let walletKey;

if (coinSymbol === 'USDC' || coinSymbol === 'USDT') {
if (!network) network = 'ERC20';
walletKey = COIN_TO_WALLET[coinSymbol][network];
if (!walletKey) {
throw new Error(`No wallet for ${coinSymbol} on network ${network}`);
}
} else {
walletKey = COIN_TO_WALLET[coinSymbol];
if (!walletKey) {
throw new Error(`No wallet mapping for ${coinSymbol}`);
}
}

const wallet = WALLETS[walletKey];
if (!wallet || !wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol} (wallet: ${walletKey})`);
}

return wallet;
}

// ============================================================
// 🔥 CHECK EMERGENCY PAUSE
// ============================================================
function checkEmergencyPause() {
if (EMERGENCY_PAUSED) {
throw new Error(`⛔ System is paused: ${PAUSE_REASON || 'Emergency maintenance'}`);
}
return true;
}

// ============================================================
// 🔥 UNIVERSAL PRIVATE KEY PARSER
// ============================================================
function parsePrivateKey(privateKeyInput, coinName) {
console.log(`🔑 Parsing private key for ${coinName}...`);
if (!privateKeyInput) {
throw new Error(`No private key provided for ${coinName}`);
}
const input = privateKeyInput.trim();

if (input.length >= 80 && input.length <= 100) {
try {
const decoded = bs58.decode(input);
if (decoded.length === 64 || decoded.length === 32) {
return Uint8Array.from(decoded);
}
} catch (e) {}
}

try {
const array = JSON.parse(input);
if (Array.isArray(array) && (array.length === 64 || array.length === 32)) {
return Uint8Array.from(array);
}
} catch (e) {}

try {
const base64Buffer = Buffer.from(input, 'base64');
if (base64Buffer.length === 64 || base64Buffer.length === 32) {
return Uint8Array.from(base64Buffer);
}
} catch (e) {}

try {
const hexClean = input.replace('0x', '').trim();
if (/^[0-9a-f]{64}$/i.test(hexClean) || /^[0-9a-f]{128}$/i.test(hexClean) || /^[0-9a-f]{32}$/i.test(hexClean)) {
return Uint8Array.from(Buffer.from(hexClean, 'hex'));
}
} catch (e) {}

if (input.startsWith('5') || input.startsWith('K') || input.startsWith('L') || input.startsWith('T')) {
return input;
}

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
if (!address) return 0;

if (coinSymbol === 'BTC') {
try {
const response = await axios.get(`https://mempool.space/api/address/${address}`);
return response.data.chain_stats.funded_txo_sum / 100000000;
} catch {
const response = await axios.get(`https://blockchain.info/q/addressbalance/${address}`);
return response.data / 100000000;
}
}
if (coinSymbol === 'LTC') {
const response = await axios.get(`https://api.blockchair.com/litecoin/dashboards/address/${address}`);
return response.data.data[address]?.address?.balance / 100000000 || 0;
}
if (coinSymbol === 'XRP') {
const response = await axios.post('https://s1.ripple.com:51234/', {
method: 'account_info',
params: [{ account: address, strict: true, ledger_index: 'current', queue: true }]
});
return response.data.result?.account_data?.Balance / 1000000 || 0;
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
const tronWeb = new TronWeb({ fullHost: TRON_RPC, privateKey: wallet.privateKey });
const contractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const contract = await tronWeb.contract().at(contractAddress);
const balance = await contract.balanceOf(address).call();
return balance / 1000000;
} catch { return 0; }
}
return 0;
} catch (error) {
console.error(`❌ Balance check error for ${coinSymbol}:`, error.message);
return 0;
}
}

// ============================================================
// 📌 SEND BTC (REAL) - ACCEPTS WIF
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
console.log(`💰 Total available: ${totalAvailable} sats`);
console.log(`💰 Needed: ${satoshisNeeded} sats`);

const estimatedFee = Math.min(25000, Math.round(utxos.length * 2500 + 5000));
const totalNeeded = satoshisNeeded + estimatedFee;

if (totalAvailable < totalNeeded) {
throw new Error(`Insufficient funds! Have ${totalAvailable} sats, Need ${totalNeeded} sats including fee`);
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
throw error;
}
}

// ============================================================
// 📌 SEND SOL (REAL) - ACCEPTS ALL FORMATS
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
// 📌 SEND USDC ON SOLANA (REAL)
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
// 📌 SEND USDT ON TRON (REAL)
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
// 📌 SEND XRP (REAL)
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
// 📌 SEND LTC (REAL)
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
// 📌 SEND ERC20 TOKEN (REAL) - FOR USDC, USDT, LINK
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
// 📌 MAIN SEND FUNCTION WITH SMART BUFFER
// ============================================================
async function sendCryptoFromWallet(coinSymbol, toAddress, requestedAmount, network) {
console.log(`📤 Sending ${requestedAmount} ${coinSymbol} to ${toAddress}`);
console.log(`🌐 Network: ${network || 'Default'}`);

checkEmergencyPause();

const buffer = await getSmartBuffer(coinSymbol);
const actualAmount = requestedAmount * (1 - buffer);

console.log(`💰 Buffer: ${(buffer * 100).toFixed(0)}%`);
console.log(`💰 Sending: ${actualAmount} ${coinSymbol}`);

const wallet = getWalletForCoin(coinSymbol, network);
if (!wallet.privateKey) {
throw new Error(`Private key not configured for ${coinSymbol}`);
}

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
return { success: false, error: error.message };
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

checkEmergencyPause();

const safety = await isSystemSafe(order.coinSymbol, order.cryptoAmount);
if (!safety.safe) {
order.status = 'failed';
order.failureReason = `System not safe: ${safety.reason}`;
console.log(`❌ Order failed: ${safety.reason}`);
await sendTelegramAlert(`🚨 *ORDER FAILED*\n\n${order.tx_ref}\n${safety.reason}`);
return { success: false, error: safety.reason };
}

const balance = await getWalletBalance(order.coinSymbol, order.network);
if (balance < order.cryptoAmount) {
order.status = 'failed';
order.failureReason = `Insufficient balance: Have ${balance}, Need ${order.cryptoAmount}`;
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
checkEmergencyPause();
const { coinSymbol, network, amount } = req.body;
const balance = await getWalletBalance(coinSymbol, network);
const hasBalance = balance >= amount;
res.json({ success: true, hasBalance: hasBalance, balance: balance, requested: amount });
} catch (error) {
if (error.message.includes('paused')) {
res.status(503).json({ success: false, error: 'System paused', paused: true });
} else {
res.status(500).json({ success: false, error: error.message });
}
}
});

// ============================================================
// 📌 CREATE PAYMENT WITH SMART BUFFER + TELEGRAM NOTIFICATION
// ============================================================
app.post('/api/create-payment', async (req, res) => {
try {
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

const buffer = await getSmartBuffer(coinSymbol);
const actualAmount = cryptoAmount * (1 - buffer);

console.log(`📊 ${coinSymbol} - Buffer: ${(buffer * 100).toFixed(0)}%`);
console.log(`📊 Original: ${cryptoAmount}, Actual: ${actualAmount}`);

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
bufferApplied: buffer,
transactionType: 'buy'
};

console.log(`📝 Order created: ${tx_ref}`);

await sendTelegramOrderNotification(orders[tx_ref], 'buy');

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
res.status(503).json({ success: false, error: 'System paused', paused: true });
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
return res.status(404).json({ error: 'Order not found', tx_ref: tx_ref });
}

console.log(`✅ Order found: ${tx_ref}, Status: ${order.status}`);

const response = await fetch(`https://api.flutterwave.com/v3/transactions/${tx_ref}/verify`, {
headers: { 'Authorization': `Bearer ${FLUTTERWAVE_SECRET}` }
});

const data = await response.json();

if (data.status === 'success' && data.data.status === 'successful') {
// Process the order
const result = await processSuccessfulOrder(order, data.data);
if (result.success) {
res.json({ success: true, message: 'Payment verified! Crypto sent!', order: order });
} else {
res.json({ success: false, message: 'Payment verified but crypto send failed.', order: order });
}
} else if (order.status === 'completed') {
res.json({ success: true, message: 'Crypto has been sent!', order: order });
} else if (order.status === 'approved') {
res.json({ success: true, message: 'Order approved!', order: order });
} else if (order.status === 'declined') {
res.json({ success: false, message: 'Order declined.', order: order });
} else {
res.json({ success: false, message: 'Payment not confirmed yet.', order: order });
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
res.json({ success: true, order: order });
});

// ============================================================
// 📌 CREATE SELL ORDER (for customers selling crypto)
// ============================================================
app.post('/api/create-sell-order', async (req, res) => {
try {
checkEmergencyPause();

const {
coinSymbol,
cryptoAmount,
amountUSD,
selectedBank,
selectedBankName,
accountNumber,
accountName
} = req.body;

const buffer = await getSmartBuffer(coinSymbol);
const actualCryptoAmount = cryptoAmount;
const ngnAmount = amountUSD * 1421 * (1 - buffer);

const tx_ref = 'SELL' + Date.now();

orders[tx_ref] = {
tx_ref,
coinSymbol,
cryptoAmount: actualCryptoAmount,
amountUSD: parseFloat(amountUSD),
ngnAmount: ngnAmount,
selectedBank,
selectedBankName,
accountNumber,
accountName,
status: 'pending',
createdAt: new Date().toISOString(),
bufferApplied: buffer,
transactionType: 'sell'
};

console.log(`📝 SELL order created: ${tx_ref}`);

await sendTelegramOrderNotification(orders[tx_ref], 'sell');

res.json({
success: true,
tx_ref: tx_ref,
message: 'Sell order created! Admin will review and confirm.',
status: 'pending'
});

} catch (error) {
console.error('❌ Create sell order error:', error.message);
if (error.message.includes('paused')) {
res.status(503).json({ success: false, error: 'System paused', paused: true });
} else {
res.status(500).json({ success: false, error: error.message });
}
}
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
await sendTelegramAlert(`✅ *ORDER COMPLETED*\n\nRef: #${tx_ref}\nCoin: ${order.coinSymbol}\nAmount: ${order.cryptoAmount} ${order.coinSymbol}\n\nCrypto sent to customer!`);
} else {
console.log(`❌ Order ${tx_ref} failed: ${result.error}`);
await sendTelegramAlert(`❌ *ORDER FAILED*\n\nRef: #${tx_ref}\nError: ${result.error}`);
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
app.get('/api/admin/status', async (req, res) => {
try {
res.json({
paused: EMERGENCY_PAUSED,
reason: PAUSE_REASON,
timestamp: new Date().toISOString()
});
} catch (error) {
res.status(500).json({ error: error.message });
}
});

app.post('/api/admin/pause', async (req, res) => {
try {
EMERGENCY_PAUSED = true;
PAUSE_REASON = req.body.reason || 'Manual pause';
await sendTelegramAlert(`🚨 *EMERGENCY PAUSE ACTIVATED*\nReason: ${PAUSE_REASON}`);
res.json({ success: true, message: 'System paused' });
} catch (error) {
res.status(500).json({ error: error.message });
}
});

app.post('/api/admin/resume', async (req, res) => {
try {
EMERGENCY_PAUSED = false;
PAUSE_REASON = '';
await sendTelegramAlert(`✅ *SYSTEM RESUMED*`);
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
