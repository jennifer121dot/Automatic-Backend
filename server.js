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
const bs58 = require('bs58');
const app = express();

const ECPair = ECPairFactory(ecc);

app.use(cors());
app.use(express.json());

// ============================================================
// 🔥 CONFIGURATION
// ============================================================
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET;
const FLUTTERWAVE_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BACKEND_URL = process.env.BACKEND_URL || 'https://automatic-backend.onrender.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dubpaydub.netlify.app';

const INFURA_KEY = process.env.INFURA_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const AVALANCHE_RPC = 'https://api.avax.network/ext/bc/C/rpc';
const TRON_RPC = 'https://api.trongrid.io';
const ETH_RPC = `https://mainnet.infura.io/v3/${INFURA_KEY}`;
const POLYGON_RPC = 'https://polygon-rpc.com';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const OPTIMISM_RPC = 'https://mainnet.optimism.io';
const FANTOM_RPC = 'https://rpc.ftm.tools';

// ============================================================
// 🔥 ORDER STORAGE (Use database in production)
// ============================================================
const orders = {};

// ============================================================
// 🔥 WALLET CONFIGURATION - ALL WORKING COINS
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
    AVAX: {
        address: process.env.AVAX_ADDRESS || '',
        privateKey: process.env.AVAX_PRIVATE_KEY || '',
        network: 'avalanche'
    },
    MATIC: {
        address: process.env.MATIC_ADDRESS || process.env.ETH_ADDRESS || '',
        privateKey: process.env.MATIC_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
        network: 'polygon'
    },
    ARB: {
        address: process.env.ARB_ADDRESS || process.env.ETH_ADDRESS || '',
        privateKey: process.env.ARB_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
        network: 'arbitrum'
    },
    OP: {
        address: process.env.OP_ADDRESS || process.env.ETH_ADDRESS || '',
        privateKey: process.env.OP_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
        network: 'optimism'
    },
    FTM: {
        address: process.env.FTM_ADDRESS || process.env.ETH_ADDRESS || '',
        privateKey: process.env.FTM_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || '',
        network: 'fantom'
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
// 🔥 COIN TO WALLET MAPPING - REMOVED LTC, XRP, LINK
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
    'AVAX': 'AVAX',
    'MATIC': 'MATIC',
    'ARB': 'ARB',
    'OP': 'OP',
    'FTM': 'FTM'
};

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
    
    // FORMAT 5: WIF (Bitcoin) - return as string
    if (input.startsWith('5') || input.startsWith('K') || input.startsWith('L') || input.startsWith('T')) {
        console.log(`✅ ${coinName}: Using WIF format`);
        return input;
    }
    
    // FORMAT 6: Raw string (for TRON, etc.)
    console.log(`✅ ${coinName}: Using raw string format`);
    return input;
}

// ============================================================
// 🔥 REAL BALANCE CHECKS - ALL WORKING COINS
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
        
        // ============================================================
        // 🔥 BTC BALANCE CHECK - FIXED: Works without VPN, shows REAL balance
        // ============================================================
        if (coinSymbol === 'BTC') {
            // PRIMARY: blockchair.com - Works worldwide without VPN, shows REAL balance
            try {
                console.log(`📡 Checking BTC via blockchair.com for: ${address}`);
                const response = await axios.get(`https://api.blockchair.com/bitcoin/dashboards/address/${address}`, {
                    timeout: 10000
                });
                // Balance is in satoshis, convert to BTC
                const balance = response.data.data[address].address.balance / 100000000;
                console.log(`💰 BTC Balance (blockchair.com): ${balance} BTC`);
                return balance;
            } catch (error) {
                console.log(`⚠️ Blockchair.com failed: ${error.message}`);
            }
            
            // FALLBACK 1: blockchain.info
            try {
                console.log(`📡 Checking BTC via blockchain.info for: ${address}`);
                const response = await axios.get(`https://blockchain.info/q/addressbalance/${address}`, {
                    headers: { 'Cache-Control': 'no-cache' },
                    timeout: 8000
                });
                const balance = response.data / 100000000;
                console.log(`💰 BTC Balance (blockchain.info): ${balance} BTC`);
                return balance;
            } catch (error) {
                console.log(`⚠️ Blockchain.info failed: ${error.message}`);
            }
            
            // FALLBACK 2: mempool.space (might need VPN)
            try {
                console.log(`📡 Checking BTC via mempool.space for: ${address}`);
                const response = await axios.get(`https://mempool.space/api/address/${address}`, {
                    headers: { 'Cache-Control': 'no-cache' },
                    timeout: 8000
                });
                const balance = response.data.chain_stats.funded_txo_sum / 100000000;
                console.log(`💰 BTC Balance (mempool.space): ${balance} BTC`);
                return balance;
            } catch (error) {
                console.log(`⚠️ Mempool.space failed: ${error.message}`);
            }
            
            // ALL FAILED - return 0 to be safe
            console.error(`❌ All BTC balance checks failed. Returning 0.`);
            return 0;
        }
        
        if (coinSymbol === 'ETH') {
            const provider = new ethers.JsonRpcProvider(ETH_RPC);
            const balance = await provider.getBalance(address);
            return parseFloat(ethers.formatEther(balance));
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
        
        if (coinSymbol === 'MATIC') {
            const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
            const balance = await provider.getBalance(address);
            return parseFloat(ethers.formatEther(balance));
        }
        
        if (coinSymbol === 'ARB') {
            const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
            const balance = await provider.getBalance(address);
            return parseFloat(ethers.formatEther(balance));
        }
        
        if (coinSymbol === 'OP') {
            const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
            const balance = await provider.getBalance(address);
            return parseFloat(ethers.formatEther(balance));
        }
        
        if (coinSymbol === 'FTM') {
            const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
            const balance = await provider.getBalance(address);
            return parseFloat(ethers.formatEther(balance));
        }
        
        if (coinSymbol === 'TRX') {
            try {
                const tronWeb = new TronWeb({
                    fullHost: TRON_RPC,
                    privateKey: wallet.privateKey
                });
                const balance = await tronWeb.trx.getBalance(address);
                return balance / 1000000;
            } catch {
                return 0;
            }
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
// 🔥 SEND FUNCTIONS FOR NEW COINS (MATIC, ARB, OP, FTM, TRX)
// ============================================================

// 📌 SEND MATIC (Polygon)
async function sendMATIC(privateKeyInput, toAddress, amountMATIC) {
    try {
        const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
        const wallet = new ethers.Wallet(privateKey, provider);
        const feeData = await provider.getFeeData();
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: ethers.parseEther(amountMATIC.toString()),
            gasLimit: 21000,
            gasPrice: feeData.gasPrice || feeData.gasPrice
        });
        await tx.wait();
        return tx.hash;
    } catch (error) {
        console.error('❌ MATIC send error:', error.message);
        throw error;
    }
}

// 📌 SEND ARB (Arbitrum)
async function sendARB(privateKeyInput, toAddress, amountARB) {
    try {
        const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
        const wallet = new ethers.Wallet(privateKey, provider);
        const feeData = await provider.getFeeData();
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: ethers.parseEther(amountARB.toString()),
            gasLimit: 21000,
            gasPrice: feeData.gasPrice || feeData.gasPrice
        });
        await tx.wait();
        return tx.hash;
    } catch (error) {
        console.error('❌ ARB send error:', error.message);
        throw error;
    }
}

// 📌 SEND OP (Optimism)
async function sendOP(privateKeyInput, toAddress, amountOP) {
    try {
        const provider = new ethers.JsonRpcProvider(OPTIMISM_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
        const wallet = new ethers.Wallet(privateKey, provider);
        const feeData = await provider.getFeeData();
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: ethers.parseEther(amountOP.toString()),
            gasLimit: 21000,
            gasPrice: feeData.gasPrice || feeData.gasPrice
        });
        await tx.wait();
        return tx.hash;
    } catch (error) {
        console.error('❌ OP send error:', error.message);
        throw error;
    }
}

// 📌 SEND FTM (Fantom)
async function sendFTM(privateKeyInput, toAddress, amountFTM) {
    try {
        const provider = new ethers.JsonRpcProvider(FANTOM_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
        const wallet = new ethers.Wallet(privateKey, provider);
        const feeData = await provider.getFeeData();
        const tx = await wallet.sendTransaction({
            to: toAddress,
            value: ethers.parseEther(amountFTM.toString()),
            gasLimit: 21000,
            gasPrice: feeData.gasPrice || feeData.gasPrice
        });
        await tx.wait();
        return tx.hash;
    } catch (error) {
        console.error('❌ FTM send error:', error.message);
        throw error;
    }
}

// 📌 SEND TRX (Tron)
async function sendTRX(privateKeyInput, toAddress, amountTRX) {
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
        
        const amount = amountTRX * 1000000;
        const result = await tronWeb.trx.sendTransaction(toAddress, amount);
        if (result.result) {
            return result.transaction.txID;
        } else {
            throw new Error('TRX send failed');
        }
    } catch (error) {
        console.error('❌ TRX send error:', error.message);
        throw error;
    }
}

// Helper: Parse EVM private key
function parseEVMPrivateKey(privateKeyInput) {
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
    return privateKey;
}

// ============================================================
// 📌 SEND BTC (REAL)
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
        
        const estimatedFee = Math.min(25000, Math.round(utxos.length * 2500 + 5000));
        const totalNeeded = satoshisNeeded + estimatedFee;
        
        if (totalAvailable < totalNeeded) {
            const shortage = totalNeeded - totalAvailable;
            throw new Error(
                `Insufficient funds! Have ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC), ` +
                `Need ${totalNeeded} sats (${(totalNeeded/100000000).toFixed(8)} BTC) including fee. ` +
                `Shortage: ${shortage} sats (${(shortage/100000000).toFixed(8)} BTC).`
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
// 📌 SEND ETH (REAL)
// ============================================================
async function sendETH(privateKeyInput, toAddress, amountETH) {
    try {
        const provider = new ethers.JsonRpcProvider(ETH_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
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
// 📌 SEND SOL (REAL)
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
// 📌 SEND BNB (REAL)
// ============================================================
async function sendBNB(privateKeyInput, toAddress, amountBNB) {
    try {
        const provider = new ethers.JsonRpcProvider(BSC_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
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
// 📌 SEND AVAX (REAL)
// ============================================================
async function sendAVAX(privateKeyInput, toAddress, amountAVAX) {
    try {
        const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
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
// 📌 SEND ERC20 TOKEN (REAL)
// ============================================================
async function sendERC20(privateKeyInput, toAddress, amount, contractAddress, decimals = 6) {
    try {
        const provider = new ethers.JsonRpcProvider(ETH_RPC);
        let privateKey = parseEVMPrivateKey(privateKeyInput);
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
// 📌 MAIN SEND FUNCTION
// ============================================================
async function sendCryptoFromWallet(coinSymbol, toAddress, amount, network) {
    console.log(`📤 Sending ${amount} ${coinSymbol} to ${toAddress}`);
    console.log(`🌐 Network: ${network || 'Default'}`);
    
    const wallet = getWalletForCoin(coinSymbol, network);
    
    if (!wallet.privateKey) {
        throw new Error(`Private key not configured for ${coinSymbol}`);
    }
    
    const balance = await getWalletBalance(coinSymbol, network);
    if (balance < amount) {
        throw new Error(`Insufficient balance: Have ${balance}, Need ${amount}`);
    }
    
    let txId;
    let explorerUrl;
    
    try {
        if (coinSymbol === 'BTC') {
            txId = await sendBTC(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://mempool.space/tx/${txId}`;
        }
        else if (coinSymbol === 'ETH') {
            txId = await sendETH(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://etherscan.io/tx/${txId}`;
        }
        else if (coinSymbol === 'SOL') {
            txId = await sendSOL(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://solscan.io/tx/${txId}`;
        }
        else if (coinSymbol === 'BNB') {
            txId = await sendBNB(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://bscscan.com/tx/${txId}`;
        }
        else if (coinSymbol === 'AVAX') {
            txId = await sendAVAX(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://snowtrace.io/tx/${txId}`;
        }
        else if (coinSymbol === 'MATIC') {
            txId = await sendMATIC(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://polygonscan.com/tx/${txId}`;
        }
        else if (coinSymbol === 'ARB') {
            txId = await sendARB(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://arbiscan.io/tx/${txId}`;
        }
        else if (coinSymbol === 'OP') {
            txId = await sendOP(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://optimistic.etherscan.io/tx/${txId}`;
        }
        else if (coinSymbol === 'FTM') {
            txId = await sendFTM(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://ftmscan.com/tx/${txId}`;
        }
        else if (coinSymbol === 'TRX') {
            txId = await sendTRX(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
        }
        else if (coinSymbol === 'USDC' && network === 'SOL') {
            txId = await sendUSDCOnSolana(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://solscan.io/tx/${txId}`;
        }
        else if (coinSymbol === 'USDT' && network === 'TRC20') {
            txId = await sendUSDTOnTron(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://tronscan.org/#/transaction/${txId}`;
        }
        else if ((coinSymbol === 'USDC' && network === 'ERC20') || (coinSymbol === 'USDT' && network === 'ERC20')) {
            const contractAddress = coinSymbol === 'USDC' 
                ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
                : '0xdAC17F958D2ee523a2206206994597C13D831ec7';
            txId = await sendERC20(wallet.privateKey, toAddress, amount, contractAddress, 6);
            explorerUrl = `https://etherscan.io/tx/${txId}`;
        }
        else {
            throw new Error(`Sending not implemented for ${coinSymbol}`);
        }
        
        console.log(`✅ Transaction sent! TxID: ${txId}`);
        console.log(`🔗 Explorer: ${explorerUrl}`);
        
        return {
            success: true,
            txId: txId,
            explorerUrl: explorerUrl,
            amountSent: amount,
            fromAddress: wallet.address,
            toAddress: toAddress
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
        const { coinSymbol, network, amount } = req.body;
        // Block coming soon coins
        const comingSoon = ['LTC', 'XRP', 'LINK'];
        if (comingSoon.includes(coinSymbol)) {
            return res.status(400).json({
                success: false,
                error: `${coinSymbol} is coming soon! Please choose another coin.`
            });
        }
        const balance = await getWalletBalance(coinSymbol, network);
        const hasBalance = balance >= amount;
        
        res.json({
            success: true,
            hasBalance: hasBalance,
            balance: balance,
            requested: amount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 📌 CREATE PAYMENT
// ============================================================
app.post('/api/create-payment', async (req, res) => {
    try {
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
        
        // Block coming soon coins
        const comingSoon = ['LTC', 'XRP', 'LINK'];
        if (comingSoon.includes(coinSymbol)) {
            return res.status(400).json({
                success: false,
                error: `${coinSymbol} is coming soon! Please choose another coin.`
            });
        }
        
        const tx_ref = 'DP' + Date.now();
        const amountNGN = Math.round(amountUSD * nairaRate);
        
        const balance = await getWalletBalance(coinSymbol, network);
        if (balance < cryptoAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ${balance} ${coinSymbol}, Required: ${cryptoAmount} ${coinSymbol}`
            });
        }
        
        orders[tx_ref] = {
            tx_ref,
            coinSymbol,
            cryptoAmount: parseFloat(cryptoAmount),
            walletAddress,
            network: network || 'Default',
            amountUSD: parseFloat(amountUSD),
            amountNGN: amountNGN,
            status: 'pending',
            createdAt: new Date().toISOString(),
            email: email || 'customer@dubpay.com',
            name: name || 'DubPay Customer'
        };
        
        console.log(`📝 Order created: ${tx_ref}`);
        console.log(`📍 Order saved in memory`);
        
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
                network: network || 'Default'
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
                tx_ref: tx_ref
            });
        } else {
            res.status(400).json({
                success: false,
                error: data.message || 'Payment creation failed'
            });
        }
    } catch (error) {
        console.error('❌ Create payment error:', error.message);
        res.status(500).json({ success: false, error: error.message });
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
// 📌 OTHER ENDPOINTS
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'DubPay Backend is running! 🚀' });
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
    console.log(`📍 Webhook: http://localhost:${PORT}/api/flutterwave-webhook\n`);
});

module.exports = app;
