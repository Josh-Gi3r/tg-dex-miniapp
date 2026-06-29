/**
 * ─── useVenueWallet hook ──────────────────────────────────────────────────────
 *
 * Single source of truth for "what wallet does this user have, and how do I
 * sign with it." Abstracts over:
 *   - Privy embedded wallet (created automatically for users-without-wallets)
 *   - Privy external wallet connection (MetaMask, WalletConnect, etc.)
 *   - Legacy fallback (no Privy yet) — returns nulls so callers degrade
 *
 * All the venue signing flows (Order, Intent, Permit, WithdrawIntent, ManageApiKey)
 * call signTypedData here rather than touching Privy directly.
 */

import { useCallback, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { getPrivyAppId } from "./loginConfig";
import { useWallet } from "@/contexts/WalletContext";

// Captured once at module load — Privy is either configured for the entire
// page lifetime or it isn't. Lets us short-circuit the hook to a no-op
// without violating React's rules of hooks (the conditional path is
// constant per render).
const PRIVY_CONFIGURED = getPrivyAppId() !== null;

const DISCONNECTED_WALLET: VenueWalletInfo = {
  isReady: false,
  isAuthenticated: false,
  address: null,
  did: null,
  isExternalWallet: false,
  walletType: null,
  signTypedData: async () => {
    throw new Error("Wallet not connected");
  },
  signAndSendTransaction: async () => {
    throw new Error("Wallet not connected");
  },
  signRawTransaction: async () => {
    throw new Error("Wallet not connected");
  },
  getAccessToken: async () => null,
};

export interface VenueWalletInfo {
  /** Whether Privy is initialised and ready to sign. */
  isReady: boolean;
  /** Whether the user is logged into Privy at all. */
  isAuthenticated: boolean;
  /** Hex address of the active wallet, lowercased. */
  address: string | null;
  /** Privy DID — used to look up / create the user row server-side. */
  did: string | null;
  /** True when the active wallet is a user-controlled external wallet. */
  isExternalWallet: boolean;
  /** Wallet connector type, e.g. 'privy', 'metamask', 'walletconnect'. */
  walletType: string | null;
  /**
   * Sign EIP-712 typed data. Returns a 0x-prefixed hex signature.
   * Caller is responsible for assembling the {domain, types, primaryType,
   * message} payload. See client/src/lib/dex/signing.ts for builders.
   */
  signTypedData: (params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<string>;
  /**
   * Sign a raw Ethereum transaction (already populated by the venue /tx/build
   * or /swap/build endpoints). Returns the broadcasted tx hash on success.
   */
  signAndSendTransaction: (tx: {
    to: string;
    data: string;
    value?: string;
    chainId?: number;
  }) => Promise<string>;
  /**
   * Sign a tx and return the raw signed hex WITHOUT broadcasting. Lets the
   * caller route the broadcast through the venue's /tx/send (or /transfer/send
   * or /withdraw/send) for selector validation + per-wallet rate-limit
   * attribution. Throws when the wallet doesn't support eth_signTransaction
   * separately from eth_sendTransaction — caller should fall back to
   * `signAndSendTransaction`.
   */
  signRawTransaction: (tx: {
    to: string;
    data: string;
    value?: string;
    chainId?: number;
  }) => Promise<string>;
  /** Returns the current Privy access token for Authorization headers. */
  getAccessToken: () => Promise<string | null>;
}

export function useVenueWallet(): VenueWalletInfo {
  // Always read the external-wallet context — it's always mounted and gives
  // us a real Signer when the user has connected MetaMask. Privy is layered
  // on top when it's configured and authenticated.
  const externalWallet = useExternalWallet();

  if (!PRIVY_CONFIGURED) return externalWallet;

  const privy = usePrivyWallet();
  // Prefer Privy when the user is signed in via Privy, otherwise hand back
  // the MetaMask-backed signer. This is what lets the app run without Privy
  // configured at all — every consumer of useVenueWallet sees a real wallet
  // as long as one is connected by any means.
  if (privy.isAuthenticated && privy.address) return privy;
  if (externalWallet.isAuthenticated && externalWallet.address) return externalWallet;
  return privy.isReady ? privy : DISCONNECTED_WALLET;
}

function useExternalWallet(): VenueWalletInfo {
  const wallet = useWallet();
  const address = wallet.address?.toLowerCase() ?? null;
  const signer = wallet.signer;

  const signTypedData = useCallback(
    async (params: {
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
      types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<string> => {
      if (!signer) throw new Error("No external wallet connected");
      // ethers v6 derives primaryType from the types map. the venue's typed-data
      // builders only emit a single entry, so the derivation is unambiguous.
      const sig = await signer.signTypedData(params.domain, params.types as any, params.message);
      if (!sig.startsWith("0x")) throw new Error("Wallet returned a non-hex signature");
      return sig;
    },
    [signer],
  );

  const signAndSendTransaction = useCallback(
    async (tx: { to: string; data: string; value?: string; chainId?: number }): Promise<string> => {
      if (!signer) throw new Error("No external wallet connected");
      if (tx.chainId && wallet.chainId !== tx.chainId) {
        await wallet.switchToExpectedChain();
      }
      const sent = await signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
      });
      return sent.hash;
    },
    [signer, wallet],
  );

  const signRawTransaction = useCallback(async (): Promise<string> => {
    // MetaMask/BrowserProvider doesn't expose eth_signTransaction for end
    // users — the wallet broadcasts directly. Callers should use
    // signAndSendTransaction and let the user's RPC handle the submit.
    throw new Error(
      "Raw tx signing not supported with this wallet — broadcast via signAndSendTransaction instead",
    );
  }, []);

  return {
    isReady: true,
    isAuthenticated: !!address,
    address,
    did: null,
    isExternalWallet: true,
    walletType: address ? "external" : null,
    signTypedData,
    signAndSendTransaction,
    signRawTransaction,
    getAccessToken: async () => null,
  };
}

function usePrivyWallet(): VenueWalletInfo {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();

  // Prefer external wallet if linked; otherwise fall back to embedded
  const activeWallet = useMemo(() => {
    if (!wallets || wallets.length === 0) return null;
    const external = wallets.find((w) => w.walletClientType !== "privy");
    return external ?? wallets[0]!;
  }, [wallets]);

  const did = user?.id ?? null;
  const address = activeWallet?.address?.toLowerCase() ?? null;
  const walletType = activeWallet?.walletClientType ?? null;
  const isExternalWallet =
    activeWallet !== null && activeWallet.walletClientType !== "privy";

  const signTypedData = useCallback(
    async (params: {
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
      types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<string> => {
      if (!activeWallet) throw new Error("No wallet available to sign with");
      const provider = await activeWallet.getEthereumProvider();
      // EIP-712 v4 signing — supported by both Privy embedded and external wallets
      const rawSig: unknown = await provider.request({
        method: "eth_signTypedData_v4",
        params: [activeWallet.address, JSON.stringify(params)],
      });
      if (typeof rawSig !== "string" || !rawSig.startsWith("0x")) {
        throw new Error("Wallet returned a non-hex signature");
      }
      return rawSig;
    },
    [activeWallet],
  );

  const signAndSendTransaction = useCallback(
    async (tx: {
      to: string;
      data: string;
      value?: string;
      chainId?: number;
    }): Promise<string> => {
      if (!activeWallet) throw new Error("No wallet available to send tx with");
      if (tx.chainId) await activeWallet.switchChain(tx.chainId);
      const provider = await activeWallet.getEthereumProvider();
      const txHash: unknown = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: activeWallet.address,
            to: tx.to,
            data: tx.data,
            value: tx.value ?? "0x0",
          },
        ],
      });
      if (typeof txHash !== "string" || !txHash.startsWith("0x")) {
        throw new Error("Wallet returned a non-hex tx hash");
      }
      return txHash;
    },
    [activeWallet],
  );

  const signRawTransaction = useCallback(
    async (tx: {
      to: string;
      data: string;
      value?: string;
      chainId?: number;
    }): Promise<string> => {
      if (!activeWallet) throw new Error("No wallet available to sign tx with");
      if (tx.chainId) await activeWallet.switchChain(tx.chainId);
      const provider = await activeWallet.getEthereumProvider();
      // Privy embedded wallets and most external wallets support
      // eth_signTransaction. Some MetaMask configurations and certain mobile
      // wallet bridges block it for "security" reasons — caller should
      // catch and fall back to signAndSendTransaction.
      const signed: unknown = await provider.request({
        method: "eth_signTransaction",
        params: [
          {
            from: activeWallet.address,
            to: tx.to,
            data: tx.data,
            value: tx.value ?? "0x0",
          },
        ],
      });
      if (typeof signed !== "string" || !signed.startsWith("0x")) {
        throw new Error("Wallet returned a non-hex signed tx");
      }
      return signed;
    },
    [activeWallet],
  );

  return {
    isReady: ready,
    isAuthenticated: authenticated,
    address,
    did,
    isExternalWallet,
    walletType,
    signTypedData,
    signAndSendTransaction,
    signRawTransaction,
    getAccessToken: async () => {
      try {
        return await getAccessToken();
      } catch {
        return null;
      }
    },
  };
}
