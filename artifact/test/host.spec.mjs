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

// 6. Bots play a full hand; Deal then waits 10s
{const{p,errs}=await open({owner:true});await p.click('text=+ Bot');await p.click('text=+ Bot');await p.click('text=+ Bot');
 await p.click('text=Deal next hand');await p.waitForFunction(()=>window.__store.get('game/state').hand.done,null,{timeout:60000});
 ok(true,'bots finish a hand');await p.waitForTimeout(400);
 ok(await p.isDisabled('[data-a=start]')&&/Deal in \d+s/.test(await p.textContent('[data-a=start]')),'Deal counts down after a hand');
 await p.waitForFunction(()=>!document.querySelector('[data-a=start]').disabled,null,{timeout:12000});ok(true,'Deal re-enables after the wait');
 ok(!errs.length,'bot hand: no page errors '+errs.join('|'));await p.close()}

// A table where Pat is all-in on the river with 7-2 against Host's aces; Host to call
const E=Array(12).fill('');
const river=()=>({players:{Host:{chips:900},Pat:{chips:0}},seats:['Host','Pat',...E.slice(2)],pend:{},leave:{},bust:{},buy:{},wait:0,btn:0,sb:5,bb:10,game:'holdem',n:1,last:1,
 hand:{ps:[1,0],btn:0,d:[],board:[0,20,35,50,15],h:{0:[12,25],1:[5,13]},bet:{0:0,1:100},tot:{0:100,1:200},fold:{},allin:{1:1},acted:{1:1},stage:3,cur:100,minR:10,turn:0,done:0,show:0,msg:''}});

// 7. Player view: Sit Down, Stand Up mid-hand folds at their turn
{const st=river();st.hand.allin={};st.players.Pat.chips=500;st.hand.turn=1;st.hand.acted={0:1};st.hand.bet={0:100,1:0};
 const{p,errs}=await open({owner:false,seed:{'game/state':st}},'Pat');await p.waitForSelector('text=Peek');
 await p.click('text=Peek');ok(!(await p.$$('#main .c.lg.b')).length,'peek reveals own cards');
 await p.click('text=Stand Up');await p.waitForTimeout(100);
 ok([...(await p.evaluate(()=>[...window.__store.entries()]))].some(([k,v])=>k.startsWith('req/')&&v.type=='stand'),'Stand Up sends a request');
 ok(!errs.length,'player view: no page errors '+errs.join('|'));await p.close()}
{const st=river();st.seats[1]='';st.hand=0;const{p}=await open({owner:false,seed:{'game/state':st}},'Pat');
 ok(await p.waitForSelector('button:text-is("Sit Down")',{timeout:1500}).then(()=>1,()=>0),'unseated player sees Sit Down');await p.close()}
{const st=river();st.hand.allin={};st.players.Pat.chips=500;st.hand.turn=1;st.hand.acted={0:1};st.hand.bet={0:100,1:0};
 const{p}=await open({owner:true,seed:{'game/state':st}});await p.waitForSelector('[data-a=start]');
 await p.evaluate(()=>window.__db.doc('req/x').set({name:'Pat',type:'stand'}));await p.waitForTimeout(200);const s2=await state(p);
 ok(s2.hand.fold[1]&&s2.hand.done&&!s2.seats.includes('Pat'),'Stand Up mid-hand folds and frees the seat at hand end');await p.close()}

// 8. Busting: Pat gets 30s to choose, Deal is held, then Pat is stood up automatically
{const{p,errs}=await open({owner:true,seed:{'game/state':river()}});await p.clock.install();await p.waitForSelector('text=Call 100');
 await p.click('text=Call 100');await p.waitForFunction(()=>window.__store.get('game/state').bust?.Pat,null,{timeout:3000});
 ok(true,'busted player gets a choice');await p.waitForTimeout(300);
 ok(await p.isDisabled('[data-a=start]')&&(await p.textContent('[data-a=start]')).includes('Waiting on Pat'),'Deal is held for the busted player');
 await p.click('[data-a=start]',{force:true});ok(!(await state(p)).hand.ps||(await state(p)).hand.done,'Deal does not start while held');
 await p.clock.fastForward(31000);await p.waitForTimeout(300);
 ok(!(await state(p)).seats.includes('Pat'),'busted player stands up after 30s');
 ok(!errs.length,'bust: no page errors '+errs.join('|'));await p.close()}

// 9. Busted player's prompt: Get more chips -> host gives chips -> Deal unblocks
{const st=river();st.hand.done=1;st.bust={Pat:Date.now()+30000};
 const{p}=await open({owner:false,seed:{'game/state':st}},'Pat');await p.waitForSelector("text=You're out of chips");
 ok(/\d+s/.test(await p.textContent('[data-cd]')),'prompt shows a countdown');
 await p.click('text=Get more chips');await p.waitForTimeout(100);
 ok([...(await p.evaluate(()=>[...window.__store.entries()]))].some(([k,v])=>k.startsWith('req/')&&v.type=='buy'),'Get more chips sends a request');await p.close()}
{const st=river();st.hand.done=1;st.buy={Pat:1};
 const{p}=await open({owner:true,seed:{'game/state':st}});await p.waitForSelector('text=Chip requests');
 ok((await p.textContent('[data-a=start]')).includes('Waiting on Pat'),'Deal held while chip request is open');
 await p.click('[data-a=give]');await p.waitForTimeout(400);const s2=await state(p);
 ok(s2.players.Pat.chips==1000&&!s2.buy.Pat,'host gives chips');ok(!(await p.isDisabled('[data-a=start]')),'Deal available once everyone has chips');await p.close()}

await browser.close();console.log(fails?fails+' failing':'all passed');process.exit(fails?1:0);
