// Local-only layout fixture. Software keyboard geometry is simulated, not a device test.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const port=Number(process.env.MOBILE_CHAT_PORT||4196);
const controls=`<!doctype html><meta charset="utf-8"><title>모바일 채팅 검증</title><style>body{background:#08090c;color:white;font:14px sans-serif}button,select{font:inherit;margin:5px;padding:8px}iframe{display:block;border:1px solid #555;margin:12px auto}output{display:block;white-space:pre-wrap}</style>
<label>단계 <select id="phase"><option value="lobby">대기실</option><option value="discussion">토론</option><option value="voting">투표</option></select></label>
<label>너비 <select id="width"><option>390</option><option>320</option><option>360</option><option>760</option><option>1200</option></select></label>
<label>키보드 <select id="keyboard"><option value="700">닫힘</option><option value="320">열림 320px</option><option value="260">열림 260px</option><option value="220">열림 220px</option></select></label>
<label>화면 밀림 <select id="pan"><option>0</option><option>64</option></select></label>
<button id="apply">화면 적용</button><button id="check">배치 확인</button><button id="matrix">전체 배치 검사</button><output id="report" style="max-height:160px;overflow:auto"></output><iframe title="모바일 게임" id="phone" style="width:390px;height:700px"></iframe>
<script>
const phone=document.querySelector('#phone'),report=document.querySelector('#report');
function apply(){phone.style.width=document.querySelector('#width').value+'px';phone.src='/frame?phase='+document.querySelector('#phase').value+'&height='+document.querySelector('#keyboard').value+'&pan='+document.querySelector('#pan').value;}
function measure(){
 const w=phone.contentWindow,d=w.document,box=d.querySelector('#chat-box'),input=d.querySelector('#chat-input'),bar=d.querySelector('.discussion-topbar');
 const rect=input.getBoundingClientRect(),history=box.getBoundingClientRect(),end=w.visualViewport.offsetTop+w.visualViewport.height;
 const visible=[...box.querySelectorAll('.chat-msg')].filter(el=>{const r=el.getBoundingClientRect();return r.top>=history.top-1&&r.bottom<=history.bottom+1;}).length;
 const controls=bar?[d.querySelector('.discussion-clock'),d.querySelector('#mobile-chat-toggle'),d.querySelector('#discussion-skip-vote'),d.querySelector('.discussion-more summary')].map(el=>el.getBoundingClientRect()):[];
 const oneRow=controls.every(r=>Math.abs((r.top+r.bottom)/2-(controls[0].top+controls[0].bottom)/2)<2&&r.right<=w.innerWidth);
 return {phase:new URL(w.location).searchParams.get('phase'),width:w.innerWidth,viewport:w.visualViewport.height,pan:w.visualViewport.offsetTop,inputBottom:Math.round(rect.bottom),bottomGap:Math.round(end-rect.bottom),historyHeight:Math.round(history.height),visibleMessages:visible,oneRow,pass:visible>=2&&rect.bottom<=end&&end-rect.bottom<=24&&history.height>=60&&oneRow};
}
document.querySelector('#apply').onclick=apply;
document.querySelector('#check').onclick=()=>report.textContent=JSON.stringify(measure(),null,2);
document.querySelector('#matrix').onclick=async()=>{
 const rows=[];
 for(const phase of ['lobby','discussion','voting'])for(const width of [320,360,390])for(const height of [220,260,320])for(const pan of [0,64]){
  phone.style.width=width+'px';await new Promise(resolve=>{phone.onload=()=>setTimeout(resolve,50);phone.src='/frame?phase='+phase+'&height='+height+'&pan='+pan;});rows.push(measure());report.textContent='검사 중 '+rows.length+'/54';
 }
 report.textContent=JSON.stringify({cases:rows.length,passed:rows.filter(r=>r.pass).length,failures:rows.filter(r=>!r.pass)},null,2);apply();
};apply();
</script>`;
const setup=`localStorage.removeItem('one-night-session');
const params=new URLSearchParams(location.search),fixtureViewport=new EventTarget();
Object.assign(fixtureViewport,{height:Number(params.get('height')||700),offsetTop:Number(params.get('pan')||0)});
Object.defineProperty(window,'visualViewport',{value:fixtureViewport});`;
const actions=`
checkConnection=()=>{}; // The fixture has no signaling server or device permissions.
const phase=params.get('phase')||'lobby';state.playerId='me';state.privateRole='seer';
const players=['me','a','b'].map((id,i)=>({id,name:['달빛','고요한밤','별하늘'][i],connected:true,ready:true}));
state.chat=Array.from({length:18},(_,i)=>({id:'m'+i,playerId:players[i%3].id,name:players[i%3].name,text:'의견 '+(i+1)+' · 저는 예언자입니다.'}));
state.room={phase,code:'CHAT01',hostId:'me',players,roles:['werewolf','seer','robber','troublemaker','drunk','insomniac'],roleTarget:6,chat:state.chat,extensionUsed:[],pauseAvailable:true,timerEndsAt:Date.now()+600000,discussionSkip:{votes:[],eligibleCount:3,required:2}};
send=(event,data)=>{if(event==='chat:send')handleMessage('chat:message',{playerId:'me',name:'달빛',text:data.text});return true;};
render();if(phase==='discussion')toggleMobileDiscussion();
document.querySelector('#chat-input').focus();fixtureViewport.dispatchEvent(new Event('resize'));
`;
createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');let body,type='text/html';
 if(url.pathname==='/')body=controls;
 else if(url.pathname==='/frame')body=readFileSync('public/index.html','utf8').replace('<script type="module" src="app.js"></script>',`<script>${setup}</script><script src="/app.js"></script><script>${actions}</script>`);
 else if(['/styles.css','/app.js'].includes(url.pathname)){body=readFileSync('public'+url.pathname);type=url.pathname.endsWith('.js')?'text/javascript':'text/css';}
 else {res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(body);
}).listen(port,'127.0.0.1',()=>console.log('Mobile chat fixture: http://127.0.0.1:'+port+'/'));
