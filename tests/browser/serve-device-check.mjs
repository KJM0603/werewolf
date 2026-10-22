// Local-only UI fixture: synthetic devices, no camera/microphone permission required.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const port=Number(process.env.DEVICE_CHECK_PORT||4195);
const setup=`
localStorage.removeItem('one-night-session');
Object.defineProperty(navigator,'userAgent',{value:'KAKAOTALK UI fixture'});
let captureMode='success', pendingCapture, testStreams=[], testAudio=[];
const fakeCapture=async options=>{
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#564575';ctx.fillRect(0,0,640,360);
  ctx.fillStyle='#ffffff';ctx.font='32px sans-serif';ctx.fillText('LOCAL CAMERA PREVIEW',100,180);
  let stream;
  if(options.audio){
    const context=new AudioContext(), oscillator=context.createOscillator(), gain=context.createGain(), dest=context.createMediaStreamDestination();
    gain.gain.value=.12;oscillator.connect(gain);gain.connect(dest);oscillator.start();await context.resume();stream=dest.stream;
    const track=stream.getTracks()[0],stop=track.stop.bind(track);track.stop=()=>{stop();oscillator.stop();void context.close();};
  }else stream=canvas.captureStream(10);
  testStreams.push(stream);return stream;
};
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async options=>{
  if(captureMode==='denied')throw new DOMException('fixture denial','NotAllowedError');
  if(captureMode==='pending')await new Promise(resolve=>pendingCapture=resolve);
  return fakeCapture(options);
}});
`;
const controls=`<div style="position:relative;z-index:100;padding:10px;background:#17171d;display:flex;gap:8px;flex-wrap:wrap">
<label>장치 응답 <select id="fixture-mode"><option value="success">성공</option><option value="denied">권한 거부</option><option value="pending">응답 대기</option></select></label>
<button id="fixture-resolve">대기 응답 허용</button><button id="fixture-disconnect">장치 분리</button>
<label>화면 <select id="fixture-phase"><option>home</option><option>lobby</option><option>role_reveal</option><option>night</option><option>discussion</option><option>voting</option><option>vote_reveal</option><option>result</option></select></label>
<button id="fixture-inspect">연결 상태 확인</button><output id="fixture-output"></output></div>`;
const actions=`
document.querySelector('#fixture-mode').onchange=e=>captureMode=e.target.value;
document.querySelector('#fixture-resolve').onclick=()=>pendingCapture?.();
document.querySelector('#fixture-disconnect').onclick=()=>testStreams.forEach(stream=>stream.getTracks().forEach(track=>{if(track.readyState==='live'){track.stop();track.dispatchEvent(new Event('ended'));}}));
document.querySelector('#fixture-inspect').onclick=()=>document.querySelector('#fixture-output').textContent='활성 점검 트랙 '+testStreams.flatMap(stream=>stream.getTracks()).filter(track=>track.readyState==='live').length+'개 · 전송 스트림 '+Boolean(state.localStream)+' · 마이크 음량 '+(document.querySelector('#device-mic-level')?.value??0);
document.querySelector('#fixture-phase').onchange=e=>{
  const phase=e.target.value;
  state.playerId='me';state.privateRole='villager';state.resultSplashComplete=true;
  const players=['me','a','b'].map((id,i)=>({id,name:['달빛','고요한밤','별하늘'][i],connected:true,ready:true}));
  state.room=phase==='home'?null:{phase,code:'CHECK1',hostId:'me',players,roles:['werewolf','seer','robber','troublemaker','drunk','insomniac'],roleTarget:6,chat:[],nightTurn:'seer',extensionUsed:[],votesSubmitted:0,result:{finalRoles:players.map(p=>({...p,role:'villager',startRole:'villager',votes:1,killed:false})),winners:players.map(p=>({...p,win:true})),killed:[],center:['werewolf','seer','robber'],villageWin:true}};
  render();
};
`;
createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  let body,type;
  if(url.pathname==='/'){
    body=readFileSync('public/index.html','utf8').replace('<main id="app">',controls+'<main id="app">').replace('<script type="module" src="app.js"></script>',`<script>${setup}</script><script src="/app.js"></script><script>${actions}</script>`);type='text/html';
  }else if(url.pathname==='/mobile'){
    const width=url.searchParams.get('width')==='320'?320:390;
    body=`<!doctype html><title>장치 점검 모바일 ${width}px</title><body style="margin:0;background:#08090c"><iframe title="모바일 장치 점검" src="/" style="display:block;width:${width}px;height:1100px;border:0;margin:auto"></iframe>`;type='text/html';
  }else if(url.pathname==='/app.js'){body=readFileSync('public/app.js');type='text/javascript';}
  else if(url.pathname==='/styles.css'){body=readFileSync('public/styles.css');type='text/css';}
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(body);
}).listen(port,'127.0.0.1',()=>console.log('Device check fixture: http://127.0.0.1:'+port+'/'));
