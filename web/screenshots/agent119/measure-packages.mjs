// /me/packages geometry + screenshots. Usage: node ... <label> [nopkg|onepkg]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";
const BASE=process.env.BASE??"http://localhost:5173"; const OUT="web/screenshots/agent119"; const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const label=process.argv[2]??"before"; const mode=process.argv[3]??"nopkg"; mkdirSync(OUT,{recursive:true});
const login=await fetch(`${BASE}/api/v1/auth/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"admin",password:"devpass"})});
if(!login.ok) throw new Error(`login ${login.status}`);
const cookie=login.headers.getSetCookie().map(v=>v.split(";")[0]).find(v=>v.startsWith("pierwave_session=")); const [cookieName,cookieValue]=cookie.split("=");
const NOW=Math.floor(Date.now()/1000);
const summary={
 user:{id:"u1",username:"admin",email:null,role:"admin",short_code:"admin",used_bytes:0,quota_bytes:null,quota_exceeded:false},
 package: mode==="onepkg" ? {name:"标准版",traffic_limit:107374182400,expires_at:NOW+30*86400} : null,
 usage:{used_bytes:0,remaining_bytes:null,days_left:null,status: mode==="onepkg"?"active":"none"},
 nodes:[], nodes_unavailable:0,
 subscription:{url:"https://sub.example.com/x",updated_at:NOW},
 forward_limit:0, forward_servers:[], forward_servers_reason:"package.forward_limit_zero",
 packages: mode==="onepkg" ? [{id:"up1",package_id:"p1",package_name:"标准版",quota_override:null,quota_bytes:107374182400,used_bytes:12345678,expires_at:NOW+30*86400,reset_day:1,status:"active",direction:"both",node_ratio:1}] : [],
 traffic:{today_bytes:0,month_bytes:0}, subscription_url:"https://sub.example.com/x",
};
const events={items:[]};
const browser=await chromium.launch({executablePath:CHROME,headless:true}); const report={};
for(const theme of ["light","dark"]){
 for(const {width,height} of [{width:1440,height:1000},{width:390,height:844}]){
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme});
  await context.addInitScript(({theme})=>{localStorage.setItem("pierwave.theme",theme);localStorage.setItem("pierwave.locale","zh-CN")},{theme});
  await context.addCookies([{name:cookieName,value:cookieValue,url:BASE,httpOnly:true,sameSite:"Lax"}]);
  // Real admin data is always empty; mock only when one package is requested.
  if(mode==="onepkg"){
    await context.route("**/api/v1/me/summary",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(summary)}));
    await context.route("**/api/v1/me/events**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(events)}));
  }
  const page=await context.newPage();
  await page.goto(`${BASE}/me/packages`,{waitUntil:"networkidle"});
  await page.waitForTimeout(500);
  await page.evaluate(()=>document.fonts.ready);
  const metrics=await page.evaluate(()=>{
   const main=document.querySelector("main");
   const content=main?.querySelector(":scope > div");
   const empty=document.querySelector('[data-slot="empty-state"]');
   const cards=[...document.querySelectorAll('main [data-slot="card"]')].filter(el=>el.getBoundingClientRect().height>0).map(el=>({title:el.querySelector('[data-slot="card-title"]')?.textContent?.replace(/\s+/g," ").trim()??null,h:Math.round(el.getBoundingClientRect().height),y:Math.round(el.getBoundingClientRect().y)}));
   const ev=document.querySelector('main [data-slot="empty-state"]');
   return {mainScroll:main?.scrollHeight,mainClient:main?.clientHeight,contentH:content?Math.round(content.getBoundingClientRect().height):null,emptyH:empty?Math.round(empty.getBoundingClientRect().height):null,cards,emptyText:ev?.textContent?.replace(/\s+/g," ").trim()??null,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
  });
  console.log(`\n== ${label} ${mode} ${theme} ${width} ==`); console.log(JSON.stringify(metrics,null,1));
  // Expand the inner scroll container so fullPage captures the whole page.
  await page.evaluate(()=>{const main=document.querySelector("main"); if(main){main.style.overflow="visible";main.style.height="auto";} document.documentElement.style.overflow="visible"; document.body.style.overflow="visible";});
  const file=`${OUT}/${label}-packages-${mode}-${theme}-${width}.png`;
  await page.screenshot({path:file,fullPage:true,animations:"disabled"}); console.log(`saved ${file}`);
  report[`${mode}-${theme}-${width}`]=metrics; await context.close();
 }
}
await browser.close(); writeFileSync(`${OUT}/${label}-packages-report.json`,JSON.stringify(report,null,2));
