import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { ChainLatencyDetail } from "@/components/overview/ChainLatencyDetail";
import { setLocale } from "@/i18n";
import type { ChainLatencyRange } from "@/lib/chainHealth";
import { detailFor } from "./fixtures";

const params = new URLSearchParams(window.location.search);
const fixture = params.get("fixture") ?? "failover";
const theme = params.get("theme") === "light" ? "light" : "dark";
const lang = params.get("lang") === "en" ? "en" : "zh-CN";

setLocale(lang);
const root = document.documentElement;
root.classList.toggle("dark", theme === "dark");
root.dataset.theme = theme;
root.style.colorScheme = theme;
root.lang = lang;

const range: ChainLatencyRange = "24h";
const { chain, snapshot } = detailFor(fixture);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <div
      data-harness
      className="min-h-dvh bg-background p-3 text-foreground sm:p-4"
    >
      <div className="mx-auto w-full max-w-[1040px]">
        <ChainLatencyDetail
          chain={chain}
          config={null}
          snapshot={snapshot}
          range={range}
          onRangeChange={() => {}}
          trends={new Map()}
          trendPending={false}
        />
      </div>
    </div>
  </StrictMode>,
);
