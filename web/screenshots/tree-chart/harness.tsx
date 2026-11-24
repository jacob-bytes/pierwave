import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { ChainTemplateTopology } from "@/components/overview/ChainTemplateTopology";
import { ChainTemplateStaleNotice } from "@/components/overview/ChainTemplateStaleNotice";
import { setLocale } from "@/i18n";
import { detailFor } from "./fixtures";

const params = new URLSearchParams(window.location.search);
const fixture = params.get("fixture") ?? "multi";
const theme = params.get("theme") === "light" ? "light" : "dark";
const lang = params.get("lang") === "en" ? "en" : "zh-CN";

setLocale(lang);
const root = document.documentElement;
root.classList.toggle("dark", theme === "dark");
root.dataset.theme = theme;
root.style.colorScheme = theme;
root.lang = lang;

const detail = detailFor(fixture);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <div data-harness className="min-h-dvh bg-background p-3 text-foreground sm:p-4">
      <div className="mx-auto w-full max-w-[1040px] space-y-4">
        <ChainTemplateStaleNotice detail={detail} />
        <ChainTemplateTopology detail={detail} />
      </div>
    </div>
  </StrictMode>,
);
