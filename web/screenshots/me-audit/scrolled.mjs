// 内部滚动容器的下半页截图（page.screenshot 的 fullPage 只能截到视口，因为 main 自己滚）。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";
const BASE = process.env.MEAUDIT_BASE ?? "http://127.0.0.1:8795";
const TOKEN = process.env.MEAUDIT_TOKEN;
if (!TOKEN) throw new Error("missing MEAUDIT_TOKEN");
const OUT = "web/screenshots/me-audit/scrolled";
mkdirSync(OUT, { recursive: true });
const PAGES = [["overview","/me"],["subscription","/me/subscription"],["forwards","/me/forwards"],["packages","/me/packages"]];
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
for (const [id,path] of PAGES) {
  for (const {width,height,theme} of [
    {width:1440,height:900,theme:"dark"},
    {width:1440,height:900,theme:"light"},
    {width:390,height:844,theme:"dark"},
    {width:390,height:844,theme:"light"},
  ]) {
    const c = await b.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme});
    await c.addInitScript(({theme})=>{localStorage.setItem("pierwave.theme",theme);localStorage.setItem("pierwave.locale","zh-CN");},{theme});
    await c.addCookies([{name:"pierwave_session",value:TOKEN,url:BASE,httpOnly:true,sameSite:"Lax"}]);
    const p = await c.newPage();
    await p.goto(BASE+path,{waitUntil:"networkidle"});
    await p.evaluate(()=>document.fonts.ready);
    const h = await p.evaluate(()=>{const m=document.querySelector("main");return m?m.scrollHeight:document.documentElement.scrollHeight;});
    const client = height;
    const positions = [0.5,0.95];
    let i=0;
    for (const f of positions) {
      i++;
      await p.evaluate(({f,h,ch})=>{const m=document.querySelector("main");if(m)m.scrollTop=(h-ch)*f;else window.scrollTo(0,(h-ch)*f);},{f,h:h,ch:client});
      await p.waitForTimeout(250);
      const file=`${OUT}/${id}__${width}__${theme}__s${i}.png`;
      await p.screenshot({path:file});
      console.log("saved",file);
    }
    await c.close();
  }
}
await b.close();
