// Deterministic private-role fixture using the real server and client handlers.
// Run from the repository: node tests/browser/serve-doppelganger.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
const source=readFileSync('server.mjs','utf8').split('const server = createServer(')[0].replace(/^import .*;\r?$/gm,'');
const context=vm.createContext({Buffer,process,join,randomBytes,setTimeout,clearTimeout});
vm.runInContext(`${source}\nglobalThis.api={rooms,handle,beginNight,publicRoom,send,privateSend};`,context);
const api=context.api;let room,ws,messages=[];
const allowed=['seer','robber','troublemaker','drunk','werewolf','minion','mason','insomniac','villager','tanner','hunter'];
function setup(role){
  if(!allowed.includes(role))throw Error('Unknown role');
  if(room)clearTimeout(room.timer);
  messages=[];
  ws={room:'TEST',playerId:'me',socket:{write(frame){const n=frame[1]&127;messages.push(JSON.parse(frame.subarray(n<126?2:n===126?4:10).toString()));},end(){}}};
  const assignments=[['me','도플갱어 테스트','doppelganger'],['target','복사 대상',role],['other','다른 참가자','villager']];
  const players=new Map(assignments.map(([id,name])=>[id,{id,name,token:`test-${id}`,connected:true,ready:true,socket:id==='me'?ws:null}]));
  const center=['werewolf','seer','robber'].map((role,i)=>({id:`c${i}`,role,ownerId:null}));
  room={code:'TEST',hostId:'me',players,phase:'role_reveal',cards:[...assignments.map(([id,,role])=>({id,role,ownerId:id,copyRole:null})),...center],
    center,roles:[...assignments.map(x=>x[2]),...center.map(c=>c.role)],startRoles:new Map(assignments.map(([id,,role])=>[id,role])),
    copyRoles:new Map(),votes:new Map(),chat:[],extensionUsed:new Set(),discussionSeconds:600,votingSeconds:20,
    result:null,timer:null,timerEndsAt:null,remainingMs:0,hasTestBots:false};
  api.rooms.set(room.code,room);
  api.send(ws,'room:joined',{room:api.publicRoom(room),playerId:'me',token:'test-me',isHost:true});
  api.privateSend(room,'me','role:private',{role:'doppelganger'});
  api.beginNight(room);
}
const html=`<!doctype html><meta charset="utf-8"><title>도플갱어 복사 행동 검증</title><link rel="stylesheet" href="/styles.css">
<div style="padding:12px">테스트 역할 <select id="test-role">${allowed.map(role=>`<option>${role}</option>`).join('')}</select> <button id="test-start">도플갱어 테스트 시작</button></div>
<main id="app"></main><div id="toast" class="toast"></div><script>localStorage.removeItem('one-night-session');</script><script src="/app.js"></script>
<script>
const accept=events=>events.forEach(message=>handleMessage(message.event,message.data));
send=(event,data={})=>{fetch('/action',{method:'POST',body:JSON.stringify({event,data})}).then(r=>r.json()).then(accept);return true;};
document.querySelector('#test-start').onclick=()=>fetch('/setup?role='+document.querySelector('#test-role').value).then(r=>r.json()).then(accept);
setInterval(()=>fetch('/events').then(r=>r.json()).then(accept),250);
</script>`;
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let body,type='application/json';
    if(url.pathname==='/'){body=html;type='text/html';}
    else if(url.pathname==='/app.js'||url.pathname==='/styles.css'){
      body=readFileSync(join('public',url.pathname.slice(1)),'utf8');type=url.pathname.endsWith('.js')?'text/javascript':'text/css';
    }else if(url.pathname==='/setup'){setup(url.searchParams.get('role'));body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/action'){
      let input='';for await(const chunk of req)input+=chunk;
      const {event,data}=JSON.parse(input);api.handle(ws,event,data);body=JSON.stringify(messages.splice(0));
    }else if(url.pathname==='/events')body=JSON.stringify(messages.splice(0));
    else {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(body);
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
}).listen(4189,'127.0.0.1',()=>console.log('Doppelganger test: http://localhost:4189'));
