// Local deterministic human-hunter fixture using the production vote handlers.
// Run from the project root: node tests/browser/serve-hunter.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';

const source=readFileSync('server.mjs','utf8').split('const server = createServer(')[0].replace(/^import .*;\r?$/gm,'');
const context=vm.createContext({Buffer,process,join,randomBytes,setTimeout,clearTimeout});
vm.runInContext(`${source}\nglobalThis.api={rooms,handle,publicRoom,send,enterVoting,timerExpired};`,context);
const api=context.api;let room,ws,messages=[];
function setup(){
  if(room)clearTimeout(room.timer);messages=[];
  ws={room:'HUNTER',playerId:'me',socket:{write(frame){const n=frame[1]&127;messages.push(JSON.parse(frame.subarray(n<126?2:n===126?4:10).toString()));},end(){}}};
  const assignments=[['me','사람 사냥꾼','hunter'],['wolf','늑대 대상','werewolf'],['other','다른 참가자','villager']];
  const players=new Map(assignments.map(([id,name])=>[id,{id,name,token:`test-${id}`,connected:true,ready:true,socket:id==='me'?ws:{room:'HUNTER',playerId:id,socket:{write(){},end(){}}}}]));
  const center=['seer','robber','troublemaker'].map((role,i)=>({id:`c${i}`,role,ownerId:null}));
  room={code:'HUNTER',hostId:'me',players,phase:'role_reveal',cards:[...assignments.map(([id,,role])=>({id,role,ownerId:id,copyRole:null})),...center],
    center,roles:[...assignments.map(x=>x[2]),...center.map(c=>c.role)],startRoles:new Map(assignments.map(([id,,role])=>[id,role])),
    copyRoles:new Map(),votes:new Map(),chat:[{id:'old',playerId:'other',name:'다른 참가자',text:'이전 판 대화',at:Date.now()}],extensionUsed:new Set(),discussionSeconds:600,votingSeconds:20,
    result:null,timer:null,timerEndsAt:null,remainingMs:0,hasTestBots:false};
  api.rooms.set(room.code,room);
  api.send(ws,'room:joined',{room:api.publicRoom(room),playerId:'me',token:'test-me',isHost:true});
  api.send(ws,'role:private',{role:'hunter'});
}
function otherVotes(){
  for(const id of ['wolf','other'])api.handle(room.players.get(id).socket,'vote:cast',{targetId:'me'});
}
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>사람 사냥꾼·새 판 채팅 검증</title><link rel="stylesheet" href="/styles.css">
<div style="padding:12px"><button id="fixture-start">사냥꾼 검증 시작</button> <button id="fixture-voting">투표 단계로</button> <button id="fixture-timeout">투표 시간 종료</button></div>
<main id="app"></main><div id="toast" class="toast"></div><script>localStorage.removeItem('one-night-session');</script><script src="/app.js"></script>
<script>
const accept=events=>events.forEach(message=>handleMessage(message.event,message.data));
const request=(path,data)=>fetch(path,{method:'POST',body:JSON.stringify(data||{})}).then(r=>r.json()).then(accept);
send=(event,data={})=>{request('/action',{event,data});return true;};
document.querySelector('#fixture-start').onclick=()=>request('/setup');
document.querySelector('#fixture-voting').onclick=()=>request('/voting');
document.querySelector('#fixture-timeout').onclick=()=>request('/timeout');
setInterval(()=>fetch('/events').then(r=>r.json()).then(accept),250);
</script></html>`;
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let body,type='application/json';
    if(url.pathname==='/'){body=html;type='text/html';}
    else if(['/app.js','/styles.css'].includes(url.pathname)){
      body=readFileSync(join('public',url.pathname.slice(1)),'utf8');type=url.pathname.endsWith('.js')?'text/javascript':'text/css';
    }else if(url.pathname==='/setup'){setup();body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/voting'){api.enterVoting(room);body=JSON.stringify(messages.splice(0));}
    else if(url.pathname==='/timeout'){
      if(room.phase==='voting'){otherVotes();clearTimeout(room.timer);api.timerExpired(room);}
      if(room.phase==='vote_reveal'){clearTimeout(room.timer);api.timerExpired(room);}
      body=JSON.stringify(messages.splice(0));
    }else if(url.pathname==='/action'){
      let input='';for await(const chunk of req)input+=chunk;
      const {event,data}=JSON.parse(input);api.handle(ws,event,data);
      if(event==='vote:cast'&&room.phase==='voting'){otherVotes();clearTimeout(room.timer);api.timerExpired(room);}
      body=JSON.stringify(messages.splice(0));
    }else if(url.pathname==='/events')body=JSON.stringify(messages.splice(0));
    else {res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(body);
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
}).listen(4191,'127.0.0.1',()=>console.log('Hunter test: http://127.0.0.1:4191/'));
