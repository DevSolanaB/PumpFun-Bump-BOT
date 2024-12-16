import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SolanaTracker } from "solana-swap";
import { performSwap, SOL_ADDR } from "./lib.js";
import base58 from "bs58";

// RPC URLs
const RPC_URLS = [
    "https://mainnet.helius-rpc.com/?api-key=a46faf5f-772a-441b-ba18-2b109cc37ad8",
    "https://api.mainnet-beta.solana.com"
];

// Private key array
const PRIVKEY = "YOUR_PRIVATE_KEY";
const TOKEN_ADDR = "AmvA1EFj1KjRyauwaT5Y14b7tAZUj1X6etya7SKopump";
const SOL_BUY_AMOUNT = 0.005;
const FEES = 0.0003;
const SLIPPAGE = 5;
const RETRY_DELAY = 500;
const MAX_RETRIES = 0.1;

const swapWithRetry = async (swapFunction, ...args) => {
    let delay = RETRY_DELAY;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await swapFunction(...args);
            return result;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.warn(`Rate limit exceeded. Retrying after ${delay} ms... (Attempt ${attempt} of ${MAX_RETRIES})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw error;
            }
        }
    }

    throw new Error('Max retries exceeded. Unable to complete swap.');
};

const getTokenBalance = async (connection, owner, tokenAddr) => {
    const defaultResult = 350000;
    try {
        const response = await connection.getTokenAccountsByOwner(owner, { mint: new PublicKey(tokenAddr) });

        if (response.value.length === 0) {
            console.error(`No token accounts found for owner: ${owner.toBase58()} and token address: ${tokenAddr}`);
            throw new Error('No token accounts found');
        }

        const info = await connection.getTokenAccountBalance(response.value[0].pubkey);

        if (info.value.uiAmount == null) {
            console.error(`No balance found for account: ${response.value[0].pubkey.toBase58()}`);
            throw new Error('No balance found');
        }

        return info.value.uiAmount;
    } catch (e) {
        console.error("Error getting token balance:", e);
        return defaultResult; // Return default value in case of error
    }
};

async function swap(tokenIn, tokenOut, solanaTracker, keypair, connection, amount) {
    try {
        const swapResponse = await solanaTracker.getSwapInstructions(
            tokenIn, // From Token
            tokenOut, // To Token
            amount, // Amount to swap
            SLIPPAGE, // Slippage
            keypair.publicKey.toBase58(), // Payer public key
            FEES, // Priority fee (Recommended while network is congested) => you can adapt to increase / decrease the speed of your transactions
            false // Force legacy transaction for Jupiter
        );

        console.log("Send swap transaction...");

        const tx = await performSwap(swapResponse, keypair, connection, amount, tokenIn, {
            sendOptions: { skipPreflight: true },
            confirmationRetries: 30,
            confirmationRetryTimeout: 1000,
            lastValidBlockHeightBuffer: 150,
            resendInterval: 1000,
            confirmationCheckInterval: 1000,
            skipConfirmationCheck: true
        });

        console.log("Swap sent : " + tx);
        return tx;

    } catch (e) {
        console.log("Error when trying to swap");
        throw e;
    }
}

const main = async () => {
    const keypair = Keypair.fromSecretKey(new Uint8Array(PRIVKEY));
    const solanaTracker = new SolanaTracker(keypair, RPC_URLS[0]);
    let connection = new Connection(RPC_URLS[0]);

    let rpcIndex = 0;

    while (true) {
        try {
            // Buy
            const buyPromises = Array(4).fill(null).map(() => swapWithRetry(swap, SOL_ADDR, TOKEN_ADDR, solanaTracker, keypair, connection, SOL_BUY_AMOUNT));
            await Promise.all(buyPromises);

            // Sell
            const balance = Math.round(await getTokenBalance(connection, keypair.publicKey, TOKEN_ADDR));
            if (balance > 0) {
                await swapWithRetry(swap, TOKEN_ADDR, SOL_ADDR, solanaTracker, keypair, connection, balance);
            } else {
                console.warn("Skipping sell operation due to zero balance.");
            }

            // Pause
            await new Promise(r => setTimeout(r, 2000)); // Pause in milliseconds
        } catch (e) {
            console.error("Error in main loop:", e);

            // Switch to the next RPC URL on error
            rpcIndex = (rpcIndex + 1) % RPC_URLS.length;
            const newRpcUrl = RPC_URLS[rpcIndex];
            console.log(`Switching to RPC URL: ${newRpcUrl}`);
            connection = new Connection(newRpcUrl);
            solanaTracker.setRpcUrl(newRpcUrl);
        }
    }
};

main();
