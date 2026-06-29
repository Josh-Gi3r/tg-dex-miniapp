import { useEffect } from "react";
import { useWallet } from "@/contexts/WalletContext";
import { useTelegram } from "@/contexts/TelegramContext";
import { Button } from "@/components/ui/button";
import { Loader2, X, Wallet, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function WalletConnectSheet({ open, onClose }: Props) {
  const { connectMetaMask, isConnecting, isConnected, address, disconnect } = useWallet();
  const { haptic } = useTelegram();

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  // Auto-close when connected
  useEffect(() => {
    if (isConnected && open) {
      onClose();
    }
  }, [isConnected, open, onClose]);

  if (!open) return null;

  const handleConnect = async () => {
    haptic.impact("medium");
    if (typeof window.ethereum === "undefined") {
      toast.error("MetaMask not found. Please install MetaMask or open in a Web3 browser.");
      return;
    }
    await connectMetaMask();
  };

  const handleDisconnect = () => {
    haptic.impact("light");
    disconnect();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* Sheet sits above the 64px nav bar */}
      <div
        className="absolute bg-white border-t-2 border-black"
        style={{
          bottom: "var(--nav-height, 64px)",
          left: 0, right: 0,
          zIndex: 10,
          boxShadow: "0 -4px 0 #000",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-black/10">
          <h2 className="font-bold text-base">
            {isConnected ? "Wallet Connected" : "Connect Wallet"}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center border border-black/20 hover:bg-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {isConnected && address ? (
            <>
              {/* Connected state */}
              <div className="border border-black p-4 bg-primary/5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 border border-black bg-primary/10 flex items-center justify-center">
                    <Wallet className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">Connected</p>
                    <p className="font-mono text-sm font-bold truncate">
                      {address.slice(0, 8)}...{address.slice(-6)}
                    </p>
                  </div>
                  <a
                    href={`https://sepolia.etherscan.io/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 border border-black/20 hover:bg-secondary"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1 border-black"
                  onClick={onClose}
                >
                  Close
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1 border border-black"
                  style={{ boxShadow: "2px 2px 0 #000" }}
                  onClick={handleDisconnect}
                >
                  Disconnect
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Network info */}
              <div className="bg-secondary border border-black/10 p-3">
                <p className="text-xs text-muted-foreground text-center">
                  This app runs on <strong>Ethereum Sepolia Testnet</strong>.<br />
                  Make sure your wallet is set to Sepolia.
                </p>
              </div>

              {/* MetaMask button */}
              <Button
                onClick={handleConnect}
                disabled={isConnecting}
                className="w-full h-12 font-bold border border-black"
                style={{ boxShadow: "3px 3px 0 #000" }}
              >
                {isConnecting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Connecting...</>
                ) : (
                  <>
                    <img
                      src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg"
                      alt="MetaMask"
                      className="w-5 h-5 mr-2"
                    />
                    Connect MetaMask
                  </>
                )}
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Don't have MetaMask?{" "}
                <a
                  href="https://metamask.io/download/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  Install it here
                </a>
              </p>
            </>
          )}
        </div>
        <div className="h-safe pb-4" />
      </div>
    </div>
  );
}
