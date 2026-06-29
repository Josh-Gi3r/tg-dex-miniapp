import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { TelegramProvider } from "./contexts/TelegramContext";
import { WalletProvider } from "./contexts/WalletContext";
import { DemoGateProvider } from "./contexts/DemoGate";
import { PrivyAuthBridge } from "./lib/privy/AuthBridge";
import { getPrivyAppId } from "./lib/privy/loginConfig";
import MiniApp from "./pages/MiniApp";

function App() {
  // Only mount the Privy bridge when an appId is configured. Without it,
  // <AppPrivyProvider> renders no <PrivyProvider>, and usePrivy() inside
  // the bridge would throw.
  const privyMounted = getPrivyAppId() !== null;

  return (
    <ErrorBoundary>
      <TelegramProvider>
        <WalletProvider>
          <ThemeProvider defaultTheme="light">
            <TooltipProvider>
              <DemoGateProvider>
                <Toaster position="top-center" />
                {privyMounted && <PrivyAuthBridge />}
                <MiniApp />
              </DemoGateProvider>
            </TooltipProvider>
          </ThemeProvider>
        </WalletProvider>
      </TelegramProvider>
    </ErrorBoundary>
  );
}

export default App;
