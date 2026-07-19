const CACHE_NAME="salvatore-app-v27";
const APP_SHELL=["/","/cmv","/relatorio-cmv","/admin","/offline.html","/manifest.webmanifest","/icons/icon-192.png","/icons/icon-512.png","/icons/icon-maskable-512.png","/icons/apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE_NAME).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url);if(r.method!=="GET"||u.origin!==self.location.origin||u.pathname.startsWith("/api/"))return;
if(r.mode==="navigate"){e.respondWith(fetch(r).then(resp=>{const copy=resp.clone();caches.open(CACHE_NAME).then(c=>c.put(r,copy));return resp}).catch(async()=>await caches.match(r)||caches.match("/offline.html")));return}
e.respondWith(caches.match(r).then(cached=>cached||fetch(r).then(resp=>{if(resp&&resp.status===200){const copy=resp.clone();caches.open(CACHE_NAME).then(c=>c.put(r,copy))}return resp})))});
self.addEventListener("message",e=>{if(e.data?.type==="SKIP_WAITING")self.skipWaiting()});