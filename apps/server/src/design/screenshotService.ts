import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME_PATHS: Record<string, readonly string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findChromePath(): string {
  const envPath = process.env.CHROME_PATH ?? process.env.CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const candidates = CHROME_PATHS[process.platform] ?? [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Could not find Chrome or Chromium. Install Chrome or set CHROME_PATH environment variable.",
  );
}

export async function captureScreenshot(input: {
  htmlPath: string;
  outputPath: string;
  width?: number;
  height?: number;
}): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: findChromePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: input.width ?? 1280,
      height: input.height ?? 800,
    });
    await page.goto(`file://${input.htmlPath}`, {
      waitUntil: "networkidle0",
      timeout: 15_000,
    });
    await page.screenshot({
      path: input.outputPath,
      fullPage: true,
      type: "png",
    });
  } finally {
    await browser.close();
  }
}
