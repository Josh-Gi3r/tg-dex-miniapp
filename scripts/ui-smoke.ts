/**
 * Headless smoke test — boots a chrome, walks every tab, captures
 * screenshots + console errors. Run while `pnpm dev` is up on PORT.
 *
 * Usage:
 *   PORT=3001 SESSION=<jwt> pnpm tsx scripts/ui-smoke.ts
 */
import puppeteer, { type Browser, type Page } from "puppeteer";
import { writeFileSync } from "node:fs";

const PORT = process.env.PORT ?? "3000";
const BASE = `http://localhost:${PORT}`;
const SESSION = process.env.SESSION ?? "";

interface TabFinding {
  tab: string;
  ok: boolean;
  consoleErrors: string[];
  screenshot: string;
}

async function visit(browser: Browser, tab: string): Promise<TabFinding> {
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896 }); // iPhone-ish
  if (SESSION) {
    await page.setCookie({
      name: "app_session_id",
      value: SESSION,
      domain: "localhost",
      path: "/",
    });
  }
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  try {
    // The TG mini-app uses tab state, not URLs. Navigate root and click the tab.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 15_000 });
    // SplashScreen runs ~2.8s before the real shell mounts. Wait it out.
    await new Promise((r) => setTimeout(r, 3200));
    await page.waitForSelector("nav", { timeout: 8000 }).catch(() => {});
    if (tab !== "default") {
      await page.evaluate((label: string) => {
        const buttons = Array.from(document.querySelectorAll("nav button"));
        const target = buttons.find((b) =>
          (b as HTMLButtonElement).innerText.toLowerCase().includes(label.toLowerCase()),
        );
        (target as HTMLButtonElement | undefined)?.click();
      }, tab);
      await new Promise((r) => setTimeout(r, 800));
    }
    const screenshotPath = `/tmp/ui-${tab.toLowerCase()}.png`;
    await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: true });
    return {
      tab,
      ok: consoleErrors.length === 0,
      consoleErrors,
      screenshot: screenshotPath,
    };
  } catch (err) {
    return {
      tab,
      ok: false,
      consoleErrors: [`navigation: ${(err as Error).message}`, ...consoleErrors],
      screenshot: "",
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const tabs = ["default", "Swap", "Send", "P2P", "Signals", "Quests", "News", "Me"];
  const findings: TabFinding[] = [];
  for (const t of tabs) {
    process.stdout.write(`Visiting ${t}…`);
    const r = await visit(browser, t);
    findings.push(r);
    console.log(r.ok ? " OK" : ` ERR (${r.consoleErrors.length})`);
  }

  await browser.close();

  console.log("\n=== Summary ===");
  for (const f of findings) {
    console.log(
      `${f.ok ? "✓" : "✗"} ${f.tab.padEnd(10)} ${f.consoleErrors.length} console errors  →  ${f.screenshot}`,
    );
    for (const err of f.consoleErrors.slice(0, 3)) {
      console.log(`    • ${err.slice(0, 200)}`);
    }
  }
  writeFileSync("/tmp/ui-findings.json", JSON.stringify(findings, null, 2));
  console.log("\nFull findings: /tmp/ui-findings.json");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
