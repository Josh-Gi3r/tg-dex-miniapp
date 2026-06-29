import { createContext, useContext, useEffect, useState, ReactNode } from "react";

interface TelegramUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
}

interface TelegramContextType {
  user: TelegramUser | null;
  isReady: boolean;
  isTelegramApp: boolean;
  webApp: any | null;
  themeParams: Record<string, string>;
  mainButton: {
    setText: (text: string) => void;
    show: () => void;
    hide: () => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    enable: () => void;
    disable: () => void;
  };
  backButton: {
    show: () => void;
    hide: () => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
  };
  haptic: {
    impact: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notification: (type: "error" | "success" | "warning") => void;
    selectionChanged: () => void;
  };
  close: () => void;
  expand: () => void;
}

const TelegramContext = createContext<TelegramContextType | undefined>(undefined);

// No-op implementations for when running outside Telegram
const noopMainButton = {
  setText: () => {},
  show: () => {},
  hide: () => {},
  onClick: () => {},
  offClick: () => {},
  showProgress: () => {},
  hideProgress: () => {},
  enable: () => {},
  disable: () => {},
};

const noopBackButton = {
  show: () => {},
  hide: () => {},
  onClick: () => {},
  offClick: () => {},
};

const noopHaptic = {
  impact: () => {},
  notification: () => {},
  selectionChanged: () => {},
};

export function TelegramProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<TelegramUser | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isTelegramApp, setIsTelegramApp] = useState(false);
  const [webApp, setWebApp] = useState<any | null>(null);
  const [themeParams, setThemeParams] = useState<Record<string, string>>({});

  useEffect(() => {
    // Use the native Telegram WebApp object injected by telegram-web-app.js script
    // This is the most reliable approach and works without the SDK's launch param parsing
    const tgWebApp = window.Telegram?.WebApp;

    if (tgWebApp) {
      setIsTelegramApp(true);
      setWebApp(tgWebApp);

      // Tell Telegram the app is ready
      tgWebApp.ready();

      // Expand to full height
      tgWebApp.expand();

      // Apply Telegram theme colors
      if (tgWebApp.themeParams) {
        setThemeParams(tgWebApp.themeParams);
      }

      // Get user data from initDataUnsafe
      const userData = tgWebApp.initDataUnsafe?.user;
      if (userData) {
        setUser({
          id: userData.id,
          firstName: userData.first_name,
          lastName: userData.last_name,
          username: userData.username,
          languageCode: userData.language_code,
          isPremium: userData.is_premium,
        });
      }

      // Auto-login: send initData to server for HMAC validation and session creation.
      // This is the primary auth path for the Telegram Mini App.
      // We fire-and-forget; the tRPC auth.me query will pick up the new cookie
      // on its next refetch.
      const initData = tgWebApp.initData;
      if (initData) {
        fetch("/api/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
          credentials: "include",
        }).catch((err) => {
          console.warn("[TelegramAuth] Auto-login failed:", err);
        });
      }
    } else {
      // Running outside Telegram (browser preview, development)
      setIsTelegramApp(false);
      setWebApp(null);
    }

    setIsReady(true);
  }, []);

  // Wrap native WebApp buttons with safe accessors
  const mainButton = webApp?.MainButton
    ? {
        setText: (text: string) => webApp.MainButton.setText(text),
        show: () => webApp.MainButton.show(),
        hide: () => webApp.MainButton.hide(),
        onClick: (fn: () => void) => webApp.MainButton.onClick(fn),
        offClick: (fn: () => void) => webApp.MainButton.offClick(fn),
        showProgress: (leaveActive?: boolean) => webApp.MainButton.showProgress(leaveActive),
        hideProgress: () => webApp.MainButton.hideProgress(),
        enable: () => webApp.MainButton.enable(),
        disable: () => webApp.MainButton.disable(),
      }
    : noopMainButton;

  const backButton = webApp?.BackButton
    ? {
        show: () => webApp.BackButton.show(),
        hide: () => webApp.BackButton.hide(),
        onClick: (fn: () => void) => webApp.BackButton.onClick(fn),
        offClick: (fn: () => void) => webApp.BackButton.offClick(fn),
      }
    : noopBackButton;

  const haptic = webApp?.HapticFeedback
    ? {
        impact: (style: "light" | "medium" | "heavy" | "rigid" | "soft") =>
          webApp.HapticFeedback.impactOccurred(style),
        notification: (type: "error" | "success" | "warning") =>
          webApp.HapticFeedback.notificationOccurred(type),
        selectionChanged: () => webApp.HapticFeedback.selectionChanged(),
      }
    : noopHaptic;

  return (
    <TelegramContext.Provider
      value={{
        user,
        isReady,
        isTelegramApp,
        webApp,
        themeParams,
        mainButton,
        backButton,
        haptic,
        close: () => webApp?.close(),
        expand: () => webApp?.expand(),
      }}
    >
      {children}
    </TelegramContext.Provider>
  );
}

export function useTelegram() {
  const context = useContext(TelegramContext);
  if (context === undefined) {
    throw new Error("useTelegram must be used within a TelegramProvider");
  }
  return context;
}

// Extend Window interface for Telegram WebApp
declare global {
  interface Window {
    Telegram?: {
      WebApp?: any;
    };
  }
}
