// Local-only interactive fixture. Real rule handlers; extended time for visual inspection.
// node tests/browser/serve-night-table.mjs -> http://localhost:4190/
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import vm from 'node:vm';
const port=Number(process.env.NIGHT_TABLE_PORT||4190);
const source=readFileSync('server.mjs','utf8').split('const server = createServer(')[0].replace(/^import .*;\r?$/gm,'');
const context=vm.createContext({Buffer,process,join,randomBytes,setTimeout:(fn,ms)=>setTimeout(fn,Math.max(ms,120000)),clearTimeout});
vm.runInContext(`${source}\nglobalThis.api={rooms,handle,beginNight,applyNightAction,publicRoom,send,privateSend,timerExpired};`,context);
const api=context.api;let room,ws,messages=[];
const allowed=['seer','robber','troublemaker','drunk','werewolf','minion','mason','insomniac','doppelganger','villager'];
function setup(role,count,copy,companion,current){
  if(!allowed.includes(role)||![3,5,8,10].includes(count))throw Error('Invalid fixture');
  if(room)clearTimeout(room.timer);messages=[];
  ws={room:'TABLE',playerId:'me',socket:{write(frame){const n=frame[1]&127;messages.push(JSON.parse(frame.subarray(n<126?2:n===126?4:10).toString()));},end(){}}};
  const names=['달빛','고요한밤','별하늘','안개숲','새벽','은하수','보름달','산들바람','반딧불','긴이름참가자열여섯글자'];
  const assignments=Array.from({length:count},(_,i)=>[i===0?'me':`p${i}`,names[i],i===0?role:i===1&&role==='doppelganger'?copy:'villager']);
  if(['werewolf','mason'].includes(role)&&companion)assignments[1][2]=role;
  if(role==='minion'&&companion){assignments[1][2]='werewolf';assignments[2][2]='werewolf';}
  if(role==='insomniac'&&['werewolf','seer'].includes(current)){
    assignments[1][2]=current;assignments[2][2]='troublemaker';
  }
  const players=new Map(assignments.map(([id,name])=>[id,{id,name,token:`fixture-${id}`,connected:true,ready:true,socket:id==='me'?ws:null}]));
  const center=['werewolf','seer','robber'].map((role,i)=>({id:`c${i}`,role,ownerId:null}));
  room={code:'TABLE',hostId:'me',players,phase:'role_reveal',cards:[...assignments.map(([id,,role])=>({id,role,ownerId:id,copyRole:null})),...center],center,
    roles:[...assignments.map(x=>x[2]),...center.map(c=>c.role)],startRoles:new Map(assignments.map(([id,,role])=>[id,role])),copyRoles:new Map(),votes:new Map(),chat:[],extensionUsed:new Set(),discussionSeconds:600,votingSeconds:20,result:null,timer:null,timerEndsAt:null,remainingMs:0,hasTestBots:false};
  api.rooms.set(room.code,room);
  api.send(ws,'room:joined',{room:api.publicRoom(room),playerId:'me',token:'fixture-me',isHost:true});
  api.privateSend(room,'me','role:private',{role});api.beginNight(room);
  for(let i=0;i<20&&room.phase==='night'&&room.activeRole!==role&&role!=='villager';i++){
    if(role==='insomniac'&&room.activeRole==='troublemaker'&&room.actionPrompt?.playerId==='p2')api.applyNightAction(room,'p2',{targetId:'me',secondTargetId:'p1'});
    clearTimeout(room.timer);api.timerExpired(room);
  }
  room.timerEndsAt=Date.now()+120000;api.send(ws,'room:state',api.publicRoom(room));
}
const controls=`<div style="padding:12px;display:flex;gap:8px;flex-wrap:wrap"><label>역할 <select id="test-role">${allowed.map(role=>`<option>${role}</option>`).join('')}</select></label><label>인원 <select id="test-count">${[3,5,8,10].map(n=>`<option ${n===10?'selected':''}>${n}</option>`).join('')}</select></label><label>복사 역할 <select id="copy-role">${['seer','robber','troublemaker','drunk','werewolf','minion','mason','insomniac'].map(role=>`<option>${role}</option>`).join('')}</select></label><label>동료 <select id="test-companion"><option value="0">없음</option><option value="1">있음 (하수인은 늑대 2명)</option></select></label><label>불면증 확인 카드 <select id="test-current"><option value="insomniac">그대로</option><option value="werewolf">늑대인간으로 교환</option><option value="seer">예언자로 교환</option></select></label><button id="test-start">원탁 테스트 시작</button><button id="test-timeout">시간 종료</button><button id="test-error">다음 요청 오류</button><span>검증용 · 행동 시간 120초</span></div>`;
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>밤 원탁 검증</title><link rel="stylesheet" href="/styles.css">${controls}<main id="app"></main><div id="toast" class="toast"></div><script>localStorage.removeItem('one-night-session');</script><script src="/app.js"></script><script>
const accept=events=>events.forEach(message=>handleMessage(message.event,message.data));let rejectNext=false;
send=(event,data={})=>{if(rejectNext){rejectNext=false;setTimeout(()=>handleMessage('error',{message:'검증용 오류입니다. 다시 시도해 주세요.'}),200);return true;}fetch('/action',{method:'POST',body:JSON.stringify({event,data})}).then(r=>r.json()).then(accept);return true;};
document.querySelector('#test-start').onclick=()=>fetch('/setup?role='+document.querySelector('#test-role').value+'&count='+document.querySelector('#test-count').value+'&copy='+document.querySelector('#copy-role').value+'&companion='+document.querySelector('#test-companion').value+'&current='+document.querySelector('#test-current').value).then(r=>r.json()).then(accept);
document.querySelector('#test-timeout').onclick=()=>fetch('/timeout',{method:'POST'}).then(r=>r.json()).then(accept);
document.querySelector('#test-error').onclick=()=>{rejectNext=true;};
setInterval(()=>fetch('/events').then(r=>r.json()).then(accept),250);
</script></html>`;
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let body,type='application/json';
    if(url.pathname==='/'){body=html;type='text/html';}
    else if(url.pathname==='/mobile'){const width=Number(url.searchParams.get('width'))===320?320:390;body=`<!doctype html><meta charset="utf-8"><title>모바일 원탁 ${width}px</title><body style="margin:0;background:#08090c"><iframe title="모바일 게임" src="/" style="display:block;width:${width}px;height:950px;border:0;margin:0 auto"></iframe>`;type='text/html';}
    else if(url.pathname==='/app.js'||url.pathname==='/styles.css'){body=readFileSync(join('public',url.pathname.slice(1)),'utf8');type=url.pathname.endsWith('.js')?'text/javascript':'text/css';}
    else if(url.pathname==='/setup'){setup(url.searchParams.get('role'),Number(url.searchParams.get('count')),url.searchParams.get('copy'),url.searchParams.get('companion')==='1',url.searchParams.get('current'));body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/action'){let input='';for await(const chunk of req)input+=chunk;const {event,data}=JSON.parse(input);api.handle(ws,event,data);body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/timeout'){clearTimeout(room.timer);api.timerExpired(room);body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/events')body=JSON.stringify(messages.splice(0));
    else{res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(body);
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`Night table fixture: http://127.0.0.1:${port}/`));
