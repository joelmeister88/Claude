// Mock of the artifact runtime that mirrors the real contract where it matters:
// - claude.use() resolves asynchronously (never during the first script run)
// - snapshot data() is deep-frozen (as the real db delivers it)
// - alert/confirm/prompt are no-ops, as in a sandboxed iframe without allow-modals
// Options come from window.__MOCK = {owner, seed, freeze}
(()=>{
  const opt=window.__MOCK||{};const store=new Map(Object.entries(opt.seed||{}));const subs=new Set();
  const deepFreeze=o=>{if(o&&typeof o=='object'&&opt.freeze!==false){Object.values(o).forEach(deepFreeze);Object.freeze(o)}return o};
  const snapOf=(path)=>{const v=store.get(path);const d=v===undefined?undefined:deepFreeze(JSON.parse(JSON.stringify(v)));
    return{id:path.split('/').pop(),exists:v!==undefined,data:()=>d,metadata:{fromCache:false,hasPendingWrites:false}}};
  const notify=()=>setTimeout(()=>subs.forEach(f=>f()),5);
  const db={
    doc:path=>({id:path.split('/').pop(),path,
      get:async()=>snapOf(path),
      set:async d=>{store.set(path,JSON.parse(JSON.stringify(d)));window.__writes=(window.__writes||0)+1;notify()},
      delete:async()=>{store.delete(path);notify()},
      onSnapshot(next){let last={};const f=()=>{const j=JSON.stringify(store.get(path));if(j!==last){last=j;next(snapOf(path))}};subs.add(f);setTimeout(f,10);return()=>subs.delete(f)}}),
    collection:cp=>({onSnapshot(next){let seen=new Map();const f=()=>{const ch=[];const now=new Map();
      for(const k of store.keys())if(k.startsWith(cp+'/')&&k.split('/').length==2)now.set(k,store.get(k));
      for(const k of now.keys())if(!seen.has(k))ch.push({type:'added',doc:snapOf(k)});
      for(const k of seen.keys())if(!now.has(k))ch.push({type:'removed',doc:snapOf(k)});
      seen=now;if(ch.length)next({docChanges:()=>ch,docs:[],size:now.size,empty:!now.size})};subs.add(f);setTimeout(f,10);return()=>subs.delete(f)}})};
  const user={isOwner:async()=>!!opt.owner};
  window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;
  window.__store=store;window.__db=db;
  window.claude={use:n=>new Promise(r=>setTimeout(()=>r(n=='db'?db:n=='user'?user:null),20))};
})();
