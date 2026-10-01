// Run: node test/host.spec.mjs
import {chromium} from 'playwright';
import {readFileSync} from 'fs';
const html=readFileSync(new URL('../poker.html',import.meta.url),'utf8');
const mock=readFileSync(new URL('./mock.js',import.meta.url),'utf8');
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++};
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
async function open(opts,name='Host'){
  const p=await browser.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(`window.__MOCK=${JSON.stringify(opts)};localStorage.setItem('pn_name',${JSON.stringify(name)});`+mock);
  await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));await p.goto('http://poker.test/');return{p,errs}}
const state=async p=>p.evaluate(()=>window.__store.get('game/state'));

// 1. Fresh table (no saved state)
{const{p,errs}=await open({owner:true});
 await p.click('text=+ Bot');await p.click('text=+ Bot');await p.waitForTimeout(100);
 ok(Object.keys((await state(p)).players).length==2,'fresh table: + Bot adds bots');
 await p.click('text=Deal next hand');await p.waitForTimeout(100);
 ok(!!(await state(p)).hand,'fresh table: Deal starts a hand');ok(!errs.length,'fresh table: no page errors '+errs.join('|'));await p.close()}

// 2. Host reopens a table that already exists (the normal case after the first visit)
{const seed={'game/state':{players:{Alice:{chips:500}},seats:['Alice',...Array(11).fill('')],pend:{},leave:{},hand:0,btn:-1,sb:5,bb:10,game:'holdem',n:3,last:0}};
 const{p,errs}=await open({owner:true,seed});await p.waitForSelector('text=+ Bot');
 await p.click('text=+ Bot');await p.waitForTimeout(100);
 ok(Object.keys((await state(p)).players).length==2,'saved table: + Bot adds a bot');
 await p.click('text=Deal next hand');await p.waitForTimeout(100);
 ok(!!(await state(p)).hand,'saved table: Deal starts a hand');
 ok(!errs.length,'saved table: no page errors '+errs.join('|'));await p.close()}

// 3. Host panel shows before the host has typed a name
{const p=await browser.newPage();await p.addInitScript(`window.__MOCK={owner:true};`+mock);
 await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));await p.goto('http://poker.test/');
 ok(await p.waitForSelector('text=+ Bot',{timeout:1500}).then(()=>1,()=>0),'host panel renders before name entry');await p.close()}

// 4. Need-2-players message is visible without alert()
{const{p}=await open({owner:true});await p.waitForSelector('text=Deal next hand');await p.click('text=Deal next hand');
 ok(await p.isVisible('text=Need at least 2'),'need-2-players notice shown inline');await p.close()}

// 5. Ledger ± works without prompt()
{const{p}=await open({owner:true});await p.click('text=+ Bot');await p.waitForSelector('[data-a=adj]');
 await p.click('[data-a=adj]');const inp=await p.$('[data-adjin]');ok(!!inp,'± opens an inline input');
 if(inp){await inp.fill('250');await p.click('[data-a=adjok]');await p.waitForTimeout(100);ok((await state(p)).players['Bot 1'].chips==1250,'± applies amount')}
 await p.close()}

// 6. Bots play a full hand and a player can request to leave without confirm()
{const{p,errs}=await open({owner:true});await p.click('text=+ Bot');await p.click('text=+ Bot');await p.click('text=+ Bot');
 await p.click('text=Deal next hand');await p.waitForFunction(()=>window.__store.get('game/state').hand.done,null,{timeout:60000});
 ok(true,'bots finish a hand');ok(!errs.length,'bot hand: no page errors '+errs.join('|'));await p.close()}

// 7. Player view (not host): renders a live hand, peeks, and requests to leave without confirm()
{const{p:h}=await open({owner:true});await h.click('text=+ Bot');await h.click('text=+ Bot');await h.click('text=Deal next hand');
 const st=await state(h);await h.close();st.seats[st.seats.indexOf('Bot 2')]='Pat';st.players.Pat=st.players['Bot 2'];delete st.players['Bot 2'];
 const{p,errs}=await open({owner:false,seed:{'game/state':st}},'Pat');await p.waitForSelector('text=Peek');
 await p.click('text=Peek');ok(!(await p.$$('#main .c.lg.b')).length,'peek reveals own cards');
 await p.click('text=Request to leave');await p.click('text=Tap again');await p.waitForTimeout(100);
 ok([...(await p.evaluate(()=>[...window.__store.entries()]))].some(([k,v])=>k.startsWith('req/')&&v.type=='leave'),'leave request sent');
 ok(!errs.length,'player view: no page errors '+errs.join('|'));await p.close()}

await browser.close();console.log(fails?fails+' failing':'all passed');process.exit(fails?1:0);
