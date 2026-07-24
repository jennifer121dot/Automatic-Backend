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

// ============================================================
// 🔥 ORDER STORAGE (Use database in production)
// ============================================================
const orders = {};

// ============================================================
// 🔥 WALLET CONFIGURATION - CHECK ALL KEYS
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
                // Try mempool.space first
                const response = await axios.get(`https://mempool.space/api/address/${address}`);
                const balance = response.data.chain_stats.funded_txo_sum / 100000000;
                console.log(`💰 BTC Balance: ${balance} BTC`);
                return balance;
            } catch {
                // Fallback to blockchain.info
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
        
        // Get UTXOs from mempool.space
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
        
        // Calculate total available
        const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
        console.log(`💰 Total available: ${totalAvailable} sats (${(totalAvailable/100000000).toFixed(8)} BTC)`);
        console.log(`💰 Needed: ${satoshisNeeded} sats (${amountBTC} BTC)`);
        
        // Estimate fee (dynamic based on UTXO count)
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
        
        // Select UTXOs
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
        
        // Calculate actual fee and change
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
        
        // Broadcast using mempool.space
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
        else if (coinSymbol === 'XRP') {
            txId = await sendXRP(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://xrpscan.com/tx/${txId}`;
        }
        else if (coinSymbol === 'LTC') {
            txId = await sendLTC(wallet.privateKey, toAddress, amount);
            explorerUrl = `https://blockchair.com/litecoin/transaction/${txId}`;
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
        else if (coinSymbol === 'LINK') {
            const contractAddress = '0x514910771AF9Ca656af840dff83E8264EcF986CA';
            txId = await sendERC20(wallet.privateKey, toAddress, amount, contractAddress, 18);
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
