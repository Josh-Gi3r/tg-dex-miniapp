import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { BrowserProvider, JsonRpcSigner } from "ethers";
import { getActiveChainId, isMainnetActive } from "@shared/venue-config";

interface WalletContextType {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  provider: BrowserProvider | null;
  signer: JsonRpcSigner | null;
  chainId: number | null;
  /** The chain the app expects (mainnet or Sepolia, based on FEATURE_MAINNET). */
  expectedChainId: number;
  connectMetaMask: () => Promise<void>;
  switchToExpectedChain: () => Promise<void>;
  disconnect: () => void;
  error: string | null;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

function chainAddRpc(chainId: number): {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
} {
  if (chainId === 1) {
    return {
      chainId: "0x1",
      chainName: "Ethereum Mainnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://eth.llamarpc.com"],
      blockExplorerUrls: ["https://etherscan.io"],
    };
  }
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: "Sepolia Testnet",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.sepolia.org"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const expectedChainId = getActiveChainId();
  const networkLabel = isMainnetActive() ? "Ethereum Mainnet" : "Sepolia testnet";

  const [address, setAddress] = useState<string | null>(null);
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConnected = !!address && !!provider;

  useEffect(() => {
    checkConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window.ethereum === "undefined") return;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect();
      } else {
        setAddress(accounts[0] ?? null);
      }
    };

    const handleChainChanged = (chainIdHex: string) => {
      const newChainId = parseInt(chainIdHex, 16);
      setChainId(newChainId);
      if (newChainId !== expectedChainId) {
        setError(`Please switch to ${networkLabel}`);
      } else {
        setError(null);
      }
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedChainId]);

  async function checkConnection() {
    if (typeof window.ethereum === "undefined") return;
    try {
      const browserProvider = new BrowserProvider(window.ethereum);
      const accounts = await browserProvider.listAccounts();
      if (accounts.length === 0) return;

      const account = accounts[0]!;
      const network = await browserProvider.getNetwork();
      const accountSigner = await browserProvider.getSigner();

      setProvider(browserProvider);
      setSigner(accountSigner);
      setAddress(account.address);
      setChainId(Number(network.chainId));

      if (Number(network.chainId) !== expectedChainId) {
        setError(`Please switch to ${networkLabel}`);
      }
    } catch (err) {
      console.error("Error checking connection:", err);
    }
  }

  async function switchToExpectedChain(): Promise<void> {
    if (typeof window.ethereum === "undefined") {
      setError("MetaMask is not installed.");
      return;
    }
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${expectedChainId.toString(16)}` }],
      });
    } catch (switchError: any) {
      if (switchError?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [chainAddRpc(expectedChainId)],
          });
        } catch {
          setError(`Failed to add ${networkLabel} to MetaMask`);
        }
      } else {
        setError(`Please switch to ${networkLabel} in MetaMask`);
      }
    }
  }

  async function connectMetaMask() {
    if (typeof window.ethereum === "undefined") {
      setError("MetaMask is not installed. Install it or paste your address manually.");
      return;
    }
    setIsConnecting(true);
    setError(null);

    try {
      const browserProvider = new BrowserProvider(window.ethereum);
      await window.ethereum.request({ method: "eth_requestAccounts" });

      const network = await browserProvider.getNetwork();
      const currentChainId = Number(network.chainId);

      if (currentChainId !== expectedChainId) {
        await switchToExpectedChain();
      }

      const refreshedNetwork = await browserProvider.getNetwork();
      const finalChainId = Number(refreshedNetwork.chainId);

      const accountSigner = await browserProvider.getSigner();
      const accountAddress = await accountSigner.getAddress();

      setProvider(browserProvider);
      setSigner(accountSigner);
      setAddress(accountAddress);
      setChainId(finalChainId);

      if (finalChainId !== expectedChainId) {
        setError(`Connected on chain ${finalChainId} — switch to ${networkLabel} to trade.`);
      }
    } catch (err: any) {
      console.error("Error connecting to MetaMask:", err);
      setError(err?.message ?? "Failed to connect to MetaMask");
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect() {
    setAddress(null);
    setProvider(null);
    setSigner(null);
    setChainId(null);
    setError(null);
  }

  return (
    <WalletContext.Provider
      value={{
        address,
        isConnected,
        isConnecting,
        provider,
        signer,
        chainId,
        expectedChainId,
        connectMetaMask,
        switchToExpectedChain,
        disconnect,
        error,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}

declare global {
  interface Window {
    ethereum?: any;
  }
}
