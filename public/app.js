const ROLE_INFO = {
  werewolf:{name:'늑대인간',emoji:'🐺'}, seer:{name:'예언자',emoji:'🔮'}, robber:{name:'강도',emoji:'🦝'},
  troublemaker:{name:'말썽쟁이',emoji:'🃏'}, drunk:{name:'주정뱅이',emoji:'🍺'}, insomniac:{name:'불면증 환자',emoji:'🌙'},
  villager:{name:'주민',emoji:'🧑‍🌾'}, doppelganger:{name:'도플갱어',emoji:'👥'}, tanner:{name:'무두장이',emoji:'🪓'}, minion:{name:'하수인',emoji:'🕴️'},
  mason:{name:'프리메이슨',emoji:'🤝'}, hunter:{name:'사냥꾼',emoji:'🏹'}
};
const ROLE_MAX = {werewolf:2, seer:1, robber:1, troublemaker:1, drunk:1, insomniac:1, villager:3, doppelganger:1, tanner:1, minion:1, mason:2, hunter:1};
const ROLE_STEP = {mason:2};
const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const state = { ws:null, room:null, playerId:null, sessionToken:null, isHost:false, privateRole:null, privateVisible:true, prompt:null, privateResults:[], selectedTarget:null, selectedSecond:null, selectedCenter:[], micOn:false, cameraOn:false, cameraPending:false, cameraController:null, cameraPipeline:null, localStream:null, audioStream:null, videoStream:null, peers:new Map(), remoteStreams:new Map(), chat:[], error:'', timerNow:Date.now(), rolesPending:false, resultSplashComplete:true, resultSplashId:0 };
let toastTimer;
let reconnecting = false;

function esc(v='') { return String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function notify(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),3000); }
function saveSession() { if (state.room?.code && state.sessionToken) localStorage.setItem('one-night-session', JSON.stringify({code:state.room.code,token:state.sessionToken})); }
function connect(onReady) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return onReady?.();
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/signal`); state.ws=ws;
  ws.addEventListener('open',()=>{onReady?.();});
  ws.addEventListener('message',(e)=>{try { const msg=JSON.parse(e.data); handleMessage(msg.event,msg.data||{}); } catch { notify('서버 응답을 읽지 못했습니다.'); }});
  ws.addEventListener('close',()=>{stopCamera();for(const pc of state.peers.values())pc.close();state.peers.clear(); if(state.room){setTimeout(()=>{if(!state.ws||state.ws.readyState===WebSocket.CLOSED){connect(()=>rejoin());}},1500);}});
  ws.addEventListener('error',()=>notify('서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.'));
}
function send(event,data={}) { if (!state.ws || state.ws.readyState!==WebSocket.OPEN) { notify('서버와 연결이 끊겼습니다. 잠시 후 다시 시도해 주세요.'); return false; } state.ws.send(JSON.stringify({event,data})); return true; }
function rejoin() { const saved=JSON.parse(localStorage.getItem('one-night-session')||'null'); if(saved){reconnecting=true;send('room:reconnect',saved);} }
function handleMessage(event,data) {
  if(event==='error'){state.rolesPending=false;if(state.room)render();notify(data.message||'요청을 처리하지 못했습니다.');return;}
  if(event==='room:joined') { state.room=data.room;state.chat=data.room.chat||[];state.playerId=data.playerId;state.sessionToken=data.token;state.isHost=data.isHost;state.privateResults=[];state.privateRole=null;state.prompt=null;saveSession();state.error='';syncPeers();render();return; }
  if(event==='room:state'||event==='game:phase'||event==='game:resumed'||event==='game:paused') {
    const previous=state.room?.phase;const previousNightTurn=state.room?.nightTurn;state.room=data;state.rolesPending=false;state.isHost=state.playerId===data.hostId;saveSession();syncPeers();
    // Night prompts are private and may otherwise remain visible after their
    // owner's turn times out. Keep controls only while their role is active.
    if(data.phase!=='paused'&&(data.phase!=='night'||data.nightTurn!==previousNightTurn&&state.prompt&&(state.prompt.role==='doppelganger-copy'&&data.nightTurn==='doppelganger'?'doppelganger':state.prompt.targetRole||state.prompt.role)!==data.nightTurn))state.prompt=null;
    if(previous==='role_reveal'&&data.phase==='night')state.privateVisible=false;
    if(previous!==data.phase && data.phase==='discussion')notify('토론을 시작합니다.');
    if(previous!==data.phase && data.phase==='voting')notify('투표해 주세요.');
    syncMediaToPhase();
    render();return;
  }
  if(event==='role:private'){state.privateRole=data.role;state.privateVisible=true;render();return;}
  if(event==='night:prompt'){state.prompt=data;state.selectedTarget=null;state.selectedSecond=null;state.selectedCenter=[];render();return;}
  if(event==='night:turn-ended'){state.prompt=null;state.selectedTarget=null;state.selectedSecond=null;state.selectedCenter=[];render();return;}
  if(event==='night:info'){if(data.currentRole){state.privateRole=data.currentRole;state.privateVisible=true;}state.privateResults.push({title:ROLE_INFO[data.role]?.name||'밤 정보',currentRole:data.currentRole,text:data.loneWolf?'혼자 깨어났습니다. 중앙 카드 한 장을 직접 선택해 확인하세요.':data.role==='mason'?`함께 깨어난 프리메이슨: ${data.others?.length?data.others.join(', '):'없음'}`:data.others?.length?`함께 깨어난 늑대: ${data.others.join(', ')}`:data.wolves?`늑대인간: ${data.wolves.length?data.wolves.join(', '):'없음'}`:data.currentRole?`현재 역할: ${ROLE_INFO[data.currentRole]?.name||data.currentRole}`:'확인할 정보가 없습니다.'});render();return;}
  if(event==='night:result'){if(data.currentRole){state.privateRole=data.currentRole;state.privateVisible=true;}state.privateResults.push(data);state.prompt=null;render();if(!data.replay)notify(data.text||data.roles?.join(' · ')||data.title);return;}
  if(event==='discussion:skip-state'){if(state.room){state.room.discussionSkip=data;updateDiscussionSkipControls();}return;}
  if(event==='chat:message'){state.chat.push(data);state.chat=state.chat.slice(-40);if(state.room)state.room.chat=state.chat;appendChatMessage(data);return;}
  if(event==='game:result'){state.room.result=data;state.room.phase='result';state.prompt=null;state.resultSplashComplete=false;syncMediaToPhase();const splashId=++state.resultSplashId;render();setTimeout(()=>{if(state.resultSplashId===splashId){state.resultSplashComplete=true;render();}},3000);return;}
  if(event.startsWith('webrtc:')){handleSignal(event,data);return;}
  if(event==='game:pause-availability'){if(state.room)state.room.pauseAvailable=data.available;render();}
}

function roleCounts(roles=[]) { const counts={};for(const id of roles)counts[id]=(counts[id]||0)+1;return counts; }
function selectedCount() { return state.room?.roles?.length||0; }
function hostView() { return state.playerId===state.room?.hostId; }
function playerName(id) { return state.room?.players?.find(p=>p.id===id)?.name||'플레이어'; }
function copyCode() { navigator.clipboard?.writeText(state.room.code).then(()=>notify('초대 코드를 복사했습니다.')).catch(()=>notify(`방 코드: ${state.room.code}`)); }

function landing() {
  const saved=JSON.parse(localStorage.getItem('one-night-session')||'null');
  if(saved&&!state.room&&!reconnecting){reconnecting=true;connect(()=>send('room:reconnect',saved));}
  app.innerHTML=`<div class="shell"><header class="topbar"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="guide-header"><span class="top-note">A SOCIAL DEDUCTION PARTY GAME</span><a class="btn ghost small guide-link" href="guide/" target="_blank" rel="noopener noreferrer" title="새 탭에서 설명서 열기">설명서 보기</a></div></header><section class="hero"><div class="eyebrow">One night. One village. One secret.</div><h1>한밤의<br>늑대인간</h1><p>누가 늑대인간일까요? 친구들과 밤의 비밀을 나누고, 낮이 오기 전에 서로의 진짜 역할을 찾아보세요.</p></section><section class="landing-grid"><form class="panel" id="create-form"><h2>새로운 방 만들기</h2><div class="muted">친구들을 초대하고 게임을 시작하세요.</div><label class="field-label" for="create-name">내 닉네임</label><input class="input" id="create-name" maxlength="16" placeholder="예: 달빛" required><button class="btn full" type="submit">방 만들기 <span aria-hidden="true">↗</span></button></form><form class="panel" id="join-form"><h2>초대 코드로 참가</h2><div class="muted">친구에게 받은 6자리 코드를 입력하세요.</div><label class="field-label" for="join-name">내 닉네임</label><input class="input" id="join-name" maxlength="16" placeholder="예: 고요한밤" required><label class="field-label" for="join-code">방 코드</label><input class="input" id="join-code" maxlength="6" placeholder="A1B2C3" required style="text-transform:uppercase;letter-spacing:.14em"><button class="btn ghost full" type="submit">게임 참가</button></form></section><div class="landing-foot">3–10명 · 음성 또는 채팅으로 플레이 · 한 판 약 12분 (연장 제외)</div></div>`;
  document.querySelector('#create-form').addEventListener('submit',(e)=>{e.preventDefault();const name=document.querySelector('#create-name').value.trim();connect(()=>send('room:create',{name}));});
  document.querySelector('#join-form').addEventListener('submit',(e)=>{e.preventDefault();const name=document.querySelector('#join-name').value.trim();const code=document.querySelector('#join-code').value.trim().toUpperCase();connect(()=>send('room:join',{name,code}));});
}

function roleEditor() {
  const room=state.room;const counts=roleCounts(room.roles);const target=room.roleTarget;const isHost=hostView();
  return `<section class="panel"><div class="section-kicker">GAME SETUP</div><h2 class="section-title" style="font-size:18px">역할 카드</h2><p class="muted">참가자 ${room.players.length}명 + 중앙 카드 3장</p><div class="role-list">${Object.entries(ROLE_INFO).map(([id,r])=>{const count=counts[id]||0;const step=ROLE_STEP[id]||1;const noCards=count<step;const full=selectedCount()+step>target;const roleMaxed=count+step>ROLE_MAX[id];const pending=state.rolesPending;const unit=step===1?'한 장':'두 장';return `<div class="role-row"><span class="role-label"><span>${r.emoji}</span>${r.name}</span><span class="role-count">${isHost?`<button type="button" class="count-btn" data-role="${id}" data-role-step="-${step}" aria-label="${r.name} ${unit} 줄이기" title="${noCards?'선택된 카드가 부족합니다':`${unit} 줄이기`}" ${noCards||pending?'disabled':''}>−</button>`:''}<b>${count}</b>${isHost?`<button type="button" class="count-btn" data-role="${id}" data-role-step="${step}" aria-label="${r.name} ${unit} 늘리기" title="${pending?'변경을 적용하고 있습니다':full?`${unit} 자리를 먼저 만들어 주세요`:roleMaxed?'이 역할은 더 추가할 수 없습니다':`${unit} 늘리기`}" ${full||roleMaxed||pending?'disabled':''}>+</button>`:''}</span></div>`;}).join('')}</div><div class="role-total"><span>선택 카드</span><strong>${selectedCount()} / ${target}</strong></div>${isHost?`<button class="btn ghost small" id="auto-roles" style="margin-top:12px;width:100%">권장 역할로 다시 구성</button>`:`<p class="role-help">방장이 인원에 맞는 역할을 정하고 있습니다.</p>`}<p class="role-help">게임 시작 시 카드를 무작위로 섞어 한 장씩 나눠 드립니다. 남은 세 장은 중앙에 놓입니다.</p></section>`;
}

function playersCard() {
  const room=state.room;
  const canAddBots=hostView()&&room.players.length<10;
  const available=10-room.players.length;
  const botControls=canAddBots?`<div class="room-actions"><label for="bot-count">추가할 AI 인원</label><select class="input" id="bot-count">${Array.from({length:available},(_,i)=>`<option value="${i+1}" ${i+1===Math.min(3,available)?'selected':''}>${i+1}명</option>`).join('')}</select><button class="btn ghost" id="add-ai">AI 추가</button></div>`:'';
  return `<section class="panel"><div class="section-kicker">LOBBY · ${room.players.length}/10</div><h2 class="section-title" style="font-size:18px">플레이어</h2><div class="player-list">${room.players.map((p)=>`<div class="player-row"><div class="player-name"><span class="avatar">${esc(p.name.slice(0,1))}</span><span>${esc(p.name)} ${p.id===room.hostId?'<span class="player-badge">방장</span>':''} ${p.isBot?'<span class="player-badge bot-badge">AI</span>':''}</span></div><span class="player-badge ${!p.connected?'offline':p.ready?'ready':''}">${!p.connected?'연결 끊김':p.isBot?'자동 플레이':p.id===room.hostId?'준비 완료':p.ready?'준비 완료':'대기 중'}</span></div>`).join('')}</div>${botControls}<div class="room-actions">${!hostView()?`<button class="btn ${room.players.find(p=>p.id===state.playerId)?.ready?'ghost':''}" id="ready-toggle">${room.players.find(p=>p.id===state.playerId)?.ready?'준비 취소':'준비하기'}</button>`:`<button class="btn" id="start-game" ${room.players.length<3||room.players.some(p=>p.id!==room.hostId&&!p.ready)||room.roles.length!==room.roleTarget?'disabled':''}>게임 시작하기</button>`}</div>${room.players.length<3?'<p class="role-help">게임을 시작하려면 최소 3명이 필요합니다.</p>':''}${room.hasTestBots?'<p class="role-help">총 10명까지 AI를 여러 번 추가할 수 있습니다. 밤 건너뛰기는 AI 행동을 완료한 뒤 토론으로 이동합니다. 미제출한 사람의 행동·투표는 건너뜁니다.</p>':''}</section>`;
}

function timerMarkup() {
  const room=state.room;const ms=room.phase==='paused'?room.remainingMs:room.timerEndsAt?Math.max(0,room.timerEndsAt-state.timerNow):0;const seconds=Math.ceil(ms/1000);const label={role_reveal:'역할 확인',night:'밤 행동',discussion:'토론',voting:'투표',vote_reveal:'결과 공개'}[room.phase]||'진행 중';
  return `<div class="timer" id="timer">${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</div><div class="timer-label">${label} · 남은 시간</div>`;
}
function videoGrid(room) {return `<div class="video-grid discussion-video-grid players-${Math.min(room.players.length,10)}">${room.players.map(p=>`<div class="video-tile ${p.id===state.playerId?'local-tile':''}" id="tile-${esc(p.id)}"><video id="video-${esc(p.id)}" autoplay playsinline ${p.id===state.playerId?'muted':''}></video><div class="video-placeholder" id="video-placeholder-${esc(p.id)}"><span>${esc(p.name.slice(0,1))}</span><small>${p.isBot?'AI 플레이어':'카메라 꺼짐'}</small></div><div class="video-label">${esc(p.name)}${p.id===state.playerId?' · 나':''}</div></div>`).join('')}</div>`;}

function roleCard() {
  if(!state.privateRole)return `<div class="role-card"><div class="role-secret">서버가 비공개 역할을 배정하고 있습니다.</div></div>`;
  const role=ROLE_INFO[state.privateRole]||{name:state.privateRole,emoji:'🎭'};
  return `<div class="role-card ${state.privateVisible?'':'secret-back'}" id="role-card">${state.privateVisible?`<div class="role-emoji">${role.emoji}</div><div class="role-name">${role.name}</div><div class="role-secret">이 역할은 나에게만 보여요.</div>`:`<div class="role-emoji">🎴</div><div class="role-name">역할 가림</div><div class="role-secret">탭해서 내 역할 확인</div>`}</div><div class="inline-actions" style="justify-content:center"><button class="btn ghost small" id="hide-role">${state.privateVisible?'역할 가리기':'역할 확인'}</button></div>`;
}

function nightPanel() {
  const prompt=state.prompt;
  const latest=state.privateResults.at(-1);
  const turn=ROLE_INFO[state.room?.nightTurn]||{name:'밤 행동',emoji:'🌘'};
  const resultRole=latest?.currentRole?ROLE_INFO[latest.currentRole]:null;
  const privateResult=latest?`<div class="night-result" role="status" aria-live="polite"><div class="section-kicker">나만 볼 수 있는 결과</div><div class="night-result-title">${esc(latest.title||'밤 정보')}</div>${resultRole?`<div class="night-result-role"><span>${resultRole.emoji}</span><strong>현재 내 역할: ${esc(resultRole.name)}</strong></div>`:latest.roles?.length?`<div class="night-result-cards">${latest.roles.map(name=>{const role=Object.values(ROLE_INFO).find(info=>info.name===name);return `<div><span>${role?.emoji||'🎭'}</span><strong>${esc(name)}</strong></div>`;}).join('')}</div>`:''}<div class="night-result-copy">${esc(latest.text||(!latest.roles?.length?'확인할 정보가 없습니다.':''))}</div></div>`:'';
  let control='';
  if(prompt){
    const targetRole=prompt.targetRole||prompt.role;
    const players=prompt.players||[];
    const targetSelect=`<label class="field-label">플레이어 선택</label><select class="input" id="night-target"><option value="">선택해 주세요</option>${players.map(p=>`<option value="${p.id}" ${state.selectedTarget===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>`;
    if(prompt.role==='doppelganger')control=`<div class="night-actions"><p class="muted">한 명의 역할 카드를 확인하고 그 역할을 복사합니다.</p>${targetSelect}<button class="btn" id="submit-night">역할 확인</button></div>`;
    else if(targetRole==='werewolf')control=`<div class="night-actions"><p class="muted">혼자 깨어난 늑대인간입니다. 중앙 카드 한 장만 선택해 확인하세요.</p><div class="choice-grid">${Array.from({length:prompt.centerCount},(_,i)=>`<button class="choice ${state.selectedCenter.includes(i)?'selected':''}" data-center="${i}">중앙 카드 ${i+1}</button>`).join('')}</div><button class="btn" id="submit-night" ${state.selectedCenter.length!==1?'disabled':''}>선택한 카드 확인</button></div>`;
    else if(targetRole==='seer')control=`<div class="night-actions"><p class="muted">플레이어 한 명 또는 중앙 카드 두 장을 확인하세요.</p>${targetSelect}<div class="section-kicker" style="margin:8px 0">또는 중앙 카드 두 장</div><div class="choice-grid">${[0,1,2].map(i=>`<button class="choice ${state.selectedCenter.includes(i)?'selected':''}" data-center="${i}">중앙 카드 ${i+1}</button>`).join('')}</div><button class="btn" id="submit-night">확인</button></div>`;
    else if(targetRole==='robber')control=`<div class="night-actions"><p class="muted">한 명과 역할 카드를 바꾸고 새 역할을 확인합니다.</p>${targetSelect}<button class="btn" id="submit-night">역할 바꾸기</button></div>`;
    else if(targetRole==='troublemaker')control=`<div class="night-actions"><p class="muted">서로 다른 두 명을 선택해 역할을 바꿉니다.</p><label class="field-label">첫 번째 플레이어</label><select class="input" id="night-target"><option value="">선택</option>${players.map(p=>`<option value="${p.id}" ${state.selectedTarget===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><label class="field-label">두 번째 플레이어</label><select class="input" id="night-target-2"><option value="">선택</option>${players.map(p=>`<option value="${p.id}" ${state.selectedSecond===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select><button class="btn" id="submit-night">두 역할 바꾸기</button></div>`;
    else if(targetRole==='drunk')control=`<div class="night-actions"><p class="muted">중앙 카드 한 장과 역할을 바꿉니다. 바꾼 카드는 볼 수 없습니다.</p><div class="choice-grid">${[0,1,2].map(i=>`<button class="choice ${state.selectedCenter.includes(i)?'selected':''}" data-center="${i}">중앙 카드 ${i+1}</button>`).join('')}</div><button class="btn" id="submit-night">역할 바꾸기</button></div>`;
  } else control=`<div class="role-card"><div class="role-emoji">🌘</div><div class="role-name" style="font-size:18px">밤이 진행 중입니다</div><div class="role-secret">내 차례가 오면 행동 안내가 표시됩니다.</div></div>`;
  return `<div class="section-kicker">NIGHT PHASE</div><h2 class="section-title">밤이 깊었습니다</h2><p class="section-copy">화면을 다른 사람에게 보여주지 마세요. 밤 행동은 정해진 순서로 진행됩니다.</p>${timerMarkup()}<div class="night-turn" role="status"><span>지금 차례</span><strong>${turn.emoji} ${turn.name}</strong></div>${roleCard()}${privateResult}${control}`;
}

function privateNotes() {
  const entries=state.privateResults.map(result=>`<p><strong>${esc(result.title||'밤 정보')}</strong><br>${esc(result.text||result.roles?.join(' · ')||'')}</p>`).join('');
  return `<details id="private-notes"><summary>내 밤 정보 · 나만 보기</summary><p>마지막으로 확인한 역할: ${esc(ROLE_INFO[state.privateRole]?.name||'없음')}</p>${entries||'<p>추가로 확인한 밤 정보가 없습니다.</p>'}</details>`;
}

function chatPanel() {
  const chat=state.chat.length?state.chat:state.room.chat||[];
  return `<section class="panel chat-panel"><div class="section-kicker">TABLE TALK</div><h2 class="section-title" style="font-size:18px">채팅</h2><div class="chat-box" id="chat-box">${privateNotes()}${chat.map(m=>`<div class="chat-msg"><strong>${esc(m.name)}</strong>${esc(m.text)}</div>`).join('')||'<div class="muted" id="chat-empty">아직 대화가 없습니다.</div>'}</div><form class="chat-form" id="chat-form"><input class="input" id="chat-input" maxlength="300" placeholder="메시지 입력 · Enter로 전송" autocomplete="off"><button class="btn" aria-label="보내기">↗</button></form></section>`;
}

function appendChatMessage(message) {
  const box=document.querySelector('#chat-box');if(!box)return;
  const follow=box.scrollHeight-box.scrollTop-box.clientHeight<48||message.playerId===state.playerId;
  document.querySelector('#chat-empty')?.remove();
  const row=document.createElement('div');row.className='chat-msg';
  const name=document.createElement('strong');name.textContent=message.name;
  row.append(name,document.createTextNode(message.text));box.append(row);
  const rows=box.querySelectorAll('.chat-msg');
  for(let i=0;i<rows.length-40;i++)rows[i].remove();
  if(follow)box.scrollTop=box.scrollHeight;
}

function resultSummary(result) {
  const winnerIds=new Set(result.winners.filter(w=>w.win).map(w=>w.id));
  const winningRoles=result.finalRoles.filter(p=>winnerIds.has(p.id)).map(p=>p.role);
  const teams=[];
  if(winningRoles.some(role=>!['werewolf','minion','tanner'].includes(role)))teams.push('마을 팀');
  if(winningRoles.includes('werewolf'))teams.push('늑대인간 팀');
  else if(winningRoles.includes('minion'))teams.push('하수인');
  if(winningRoles.includes('tanner'))teams.push('무두장이');
  const headline=teams.length?`${teams.join(' · ')} 승리!`:'승리한 사람이 없습니다';
  const noWolves=!result.finalRoles.some(p=>p.role==='werewolf');
  const reason=noWolves&&result.killed.length>0&&!result.villageWin
    ?'최종 늑대인간이 없는 상태에서 참가자가 처치되어 마을 팀이 패배했습니다.'
    :noWolves&&result.killed.length===0?'최종 늑대인간이 없고 아무도 처치되지 않아 마을 팀이 승리했습니다.'
    :'밤이 끝난 뒤의 최종 역할과 처치 결과로 승패를 판정했습니다.';
  const icon=!teams.length?'🌘':winningRoles.includes('tanner')?'🪓':winningRoles.includes('werewolf')?'🐺':winningRoles.includes('minion')?'🕴️':'🧑‍🌾';
  return {headline,reason,icon};
}

function resultPanel() {
  const result=state.room.result;if(!result)return '';
  const {headline,reason,icon}=resultSummary(result);
  if(!state.resultSplashComplete){
    return `<div class="result-splash"><div class="result-splash-icon">${icon}</div><h2>${headline}</h2><p class="section-copy">${reason}</p></div>`;
  }
  return `<div class="section-kicker">THE REVEAL</div><h2 class="section-title">${headline}</h2><p class="section-copy">${reason}<br>중앙 카드: ${result.center.join(' · ')}</p><div class="player-list">${result.finalRoles.map(p=>{const win=result.winners.find(w=>w.id===p.id)?.win;return `<div class="winner"><span>${esc(p.name)} ${p.killed?'🪦':''}<small>시작: ${esc(ROLE_INFO[p.startRole]?.name||p.startRole)} · ${p.votes}표</small></span><span>${ROLE_INFO[p.role]?.emoji||'🎭'} ${ROLE_INFO[p.role]?.name||p.role} · ${win?'<span class="win-label">승리</span>':'<span class="lose-label">패배</span>'}</span></div>`;}).join('')}</div><div class="room-actions" style="margin-top:20px"><button class="btn ghost" id="leave-room">새 게임</button></div>`;
}

function discussionView(room) {
  const hasExtension=!(room.extensionUsed||[]).includes(state.playerId);
  const seconds=Math.ceil(Math.max(0,(room.timerEndsAt||state.timerNow)-state.timerNow)/1000);
  app.innerHTML=`<div class="game-shell discussion-shell"><header class="game-top discussion-topbar"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="discussion-clock"><strong id="timer">${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</strong><span>남은 토론 시간</span></div><div class="discussion-top-actions">${discussionSkipMarkup(room)}${room.pauseAvailable&&hostView()?'<button class="btn danger small" id="pause-game">게임 중지</button>':''}<div class="room-code">방 ${room.code} · ${room.players.length}명</div></div></header><main class="discussion-main"><div class="discussion-video-wrap">${videoGrid(room)}</div><footer class="discussion-dock"><div class="discussion-chat">${chatPanel()}</div><div class="discussion-tools"><button class="btn ghost" id="mic-toggle">${state.micOn?'마이크 끄기':'마이크 켜기'}</button><button class="btn ghost" id="camera-toggle">${state.cameraPending?'카메라 준비 취소':state.cameraOn?'카메라 끄기':'카메라 켜기 · 배경 가림'}</button><button class="btn extend-btn" id="extend-time" ${!hasExtension?'disabled':''}>${hasExtension?'토론 1분 연장':'연장권 사용 완료'}</button><small>${state.micOn?'마이크 켜짐':'마이크 꺼짐'} · ${state.cameraPending?'배경 가림 준비 중…':state.cameraOn?'카메라 켜짐 · 배경 가림 적용':'카메라 꺼짐 · 켜면 배경 자동 가림'}</small></div></footer></main></div>`;
  bindGameEvents();bindAudio();bindVideo();bindMediaElements();scrollChat();
}

function discussionSkipMarkup(room) {
  const progress = room.discussionSkip || { votes: [], eligibleCount: 0, required: 1 };
  const agreed = progress.votes.includes(state.playerId);
  return `<div class="discussion-skip"><button class="btn ghost small" id="discussion-skip-vote" aria-pressed="${agreed}">${agreed?'토론 종료 동의 취소':'토론 종료 동의'}</button><small id="discussion-skip-count" role="status" aria-live="polite">동의 ${progress.votes.length}/${progress.eligibleCount}명 · ${progress.required}명 필요</small></div>`;
}
function updateDiscussionSkipControls() {
  const button = document.querySelector('#discussion-skip-vote');
  const count = document.querySelector('#discussion-skip-count');
  const progress = state.room?.discussionSkip;
  if (!button || !count || !progress) return;
  const agreed = progress.votes.includes(state.playerId);
  button.disabled = false;
  button.setAttribute('aria-pressed', String(agreed));
  button.textContent = agreed ? '토론 종료 동의 취소' : '토론 종료 동의';
  count.textContent = `동의 ${progress.votes.length}/${progress.eligibleCount}명 · ${progress.required}명 필요`;
}

function gameView() {
  const room=state.room;if(!room)return landing();
  if(room.phase==='lobby'){
    app.innerHTML=`<div class="game-shell"><header class="game-top"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="room-code">초대 코드 <strong>${room.code}</strong><button class="count-btn" id="copy-code" aria-label="코드 복사">⧉</button></div></header><div class="layout"><section class="panel main-panel"><div class="section-kicker">WAITING ROOM</div><h1 class="section-title">모두 모였나요?</h1><p class="section-copy">방 코드를 친구에게 공유하고, 준비가 끝나면 게임을 시작하세요.</p><div class="guide-actions"><a class="btn ghost small guide-link" href="guide/" target="_blank" rel="noopener noreferrer" title="새 탭에서 설명서 열기">설명서 보기</a></div>${playersCard()}</section><aside class="side-stack">${roleEditor()}<section class="panel audio-card"><div><div class="section-kicker">VOICE CHAT</div><div class="audio-state">토론 단계에서 음성을 켤 수 있습니다</div></div><span>🎙️</span></section></aside></div></div>`;
    bindRoomEvents();bindRoleEvents();return;
  }
  const phase=room.phase;const title={role_reveal:'내 역할을 확인하세요',night:'모두 눈을 감으세요',discussion:'마을이 깨어났습니다',voting:'누구를 지목할까요?',vote_reveal:'결과 공개 준비',paused:'게임이 잠시 멈췄습니다',result:'게임 결과'}[phase]||'게임 진행 중';
  const hunterRule=room.roles.includes('hunter')?' 사냥꾼이 최다 득표로 사망하면, 사냥꾼이 지목한 사람도 함께 사망합니다.':'';
  if(phase==='discussion'){discussionView(room);return;}
  let content='';
  if(phase==='role_reveal')content=`<div class="section-kicker">YOUR ROLE</div><h2 class="section-title">내 역할을 확인하세요</h2><p class="section-copy">카드를 확인한 뒤 화면을 가려 주세요. 밤이 곧 시작됩니다.</p>${timerMarkup()}${roleCard()}<div class="center-cards">중앙 카드 3장은 게임 종료 전까지 공개되지 않습니다.</div>`;
  else if(phase==='night')content=nightPanel();
  else if(phase==='voting')content=`<div class="section-kicker">SECRET VOTE</div><h2 class="section-title">누구를 지목할까요?</h2><p class="section-copy">투표는 모두 제출할 때까지 비공개입니다. 최다 득표가 동률이면 모두 사망하고, 아무도 2표 이상 받지 않으면 사망자는 없습니다. 늑대가 없다고 합의했다면 서로 다른 사람을 지목해 투표를 피할 수 있습니다.${hunterRule}</p>${timerMarkup()}<div class="choice-grid">${room.players.filter(p=>p.id!==state.playerId).map(p=>`<button class="choice ${state.selectedTarget===p.id?'selected':''}" data-vote="${p.id}">${esc(p.name)}</button>`).join('')}</div><div class="room-actions"><button class="btn" id="submit-vote" ${!state.selectedTarget||room.votesSubmitted&&room.votesSubmitted>=room.players.length?'disabled':''}>비밀 투표 제출</button></div><div class="submissions">투표 제출 ${room.votesSubmitted}/${room.players.length}</div>`;
  else if(phase==='vote_reveal')content=`<div class="section-kicker">VOTE COMPLETE</div><h2 class="section-title">5초 뒤 결과를 공개합니다</h2><p class="section-copy">${esc(room.voteRevealReason||'잠시 후 결과를 공개합니다.')}</p>${timerMarkup()}`;
  else if(phase==='paused')content=`<div class="section-kicker">PAUSED BY HOST</div><h2 class="section-title">모두 잠시 멈췄습니다</h2><p class="section-copy">타이머와 음성이 멈췄습니다. 준비가 되면 방장이 재개할 수 있습니다.</p><div class="timer">${String(Math.floor(room.remainingMs/60000)).padStart(2,'0')}:${String(Math.floor(room.remainingMs/1000)%60).padStart(2,'0')}</div>${hostView()?'<button class="btn" id="resume-game">게임 재개</button>':''}`;
  else if(phase==='result')content=resultPanel();
  app.innerHTML=`<div class="game-shell"><header class="game-top"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="inline-actions">${room.pauseAvailable&&hostView()&&phase!=='paused'?'<button class="btn danger small" id="pause-game">게임 중지</button>':''}<div class="room-code">${esc(title)}</div><button class="btn ghost small" id="copy-code">${room.code}</button></div></header><div class="layout"><section class="panel main-panel">${content}</section><aside class="side-stack"><section class="panel"><div class="section-kicker">PLAYERS · ${room.players.length}</div><div class="player-list" style="margin-top:12px">${room.players.map(p=>`<div class="player-row"><span class="player-name"><span class="avatar">${esc(p.name.slice(0,1))}</span>${esc(p.name)}</span><span class="player-badge ${p.connected?'ready':'offline'}">${p.connected?'●':'○'}</span></div>`).join('')}</div></section><section class="panel audio-card"><div><div class="section-kicker">VOICE & VIDEO</div><div class="audio-state">${phase==='discussion'?(state.micOn?'마이크 켜짐':'마이크 끔')+' · '+(state.cameraOn?'카메라 켜짐':'카메라 끔'):'토론 단계에서 사용할 수 있습니다'}</div></div><span>🎙️📹</span></section>${['discussion','voting'].includes(phase)?chatPanel():''}</aside></div>${phase==='paused'?`<div class="pause-overlay"><div class="pause-card"><div class="pause-icon">⏸</div><h2>게임이 멈췄습니다</h2><p>모든 참가자의 화면과 음성이 일시정지되었습니다.<br>${esc(room.pauseReason||'방장이 게임을 멈췄습니다.')}</p>${hostView()?'<button class="btn" id="resume-game-overlay">게임 재개</button>':''}</div></div>`:''}</div>`;
  bindGameEvents();bindAudio();bindVideo();bindMediaElements();scrollChat();
}

function render() {
  const oldInput=document.querySelector('#chat-input');
  const draft=oldInput?.value||'', start=oldInput?.selectionStart, end=oldInput?.selectionEnd;
  const keepChatFocus=document.activeElement?.id==='chat-input';
  const notesOpen=document.querySelector('#private-notes')?.open;
  if(!state.room)landing();else gameView();
  const input=document.querySelector('#chat-input');
  if(input&&oldInput){input.value=draft;if(keepChatFocus){input.focus({preventScroll:true});input.setSelectionRange(start??draft.length,end??draft.length);}}
  const notes=document.querySelector('#private-notes');if(notes&&notesOpen)notes.open=true;
}
function bindRoomEvents() {
  document.querySelector('#copy-code')?.addEventListener('click',copyCode);
  document.querySelector('#ready-toggle')?.addEventListener('click',()=>{const p=state.room.players.find(p=>p.id===state.playerId);send('player:ready',{ready:!p.ready});});
  document.querySelector('#add-ai')?.addEventListener('click',(e)=>{const count=Number(document.querySelector('#bot-count').value);e.currentTarget.disabled=true;e.currentTarget.textContent='AI 추가 중…';if(!send('room:bots:add',{count})){e.currentTarget.disabled=false;e.currentTarget.textContent='AI 추가';}});
  document.querySelector('#start-game')?.addEventListener('click',()=>send('game:start'));
}
function bindRoleEvents() {
  document.querySelector('#auto-roles')?.addEventListener('click',()=>send('roles:auto'));
  document.querySelectorAll('button[data-role-step]').forEach((button)=>button.addEventListener('click',(event)=>{
    event.preventDefault();
    if(button.disabled)return;
    changeRole(button.dataset.role,Number(button.dataset.roleStep));
  }));
}
function changeRole(role,delta) {
  if(state.rolesPending)return;
  state.rolesPending=true;render();
  if(!send('roles:adjust',{role,delta})){state.rolesPending=false;render();}
}
function bindGameEvents() {
  const room=state.room;const phase=room?.phase;const skipLabels={role_reveal:'역할 확인 마치기',night:'밤 전체 건너뛰기',voting:'AI 투표 완료하고 결과 보기',vote_reveal:'결과 바로 보기'};
  if(room?.hasTestBots&&hostView()&&skipLabels[phase]&&!document.querySelector('#skip-phase')){const button=document.createElement('button');button.type='button';button.id='skip-phase';button.className='btn ghost small';button.textContent=skipLabels[phase];document.querySelector('.discussion-top-actions,.game-top .inline-actions')?.prepend(button);}
  document.querySelector('#copy-code')?.addEventListener('click',copyCode);
  document.querySelector('#hide-role')?.addEventListener('click',()=>{state.privateVisible=!state.privateVisible;render();});
  document.querySelector('#role-card')?.addEventListener('click',()=>{if(!state.privateVisible){state.privateVisible=true;render();}});
  document.querySelector('#pause-game')?.addEventListener('click',()=>send('game:pause'));
  document.querySelector('#skip-phase')?.addEventListener('click',(event)=>{event.currentTarget.disabled=true;event.currentTarget.textContent='다음 단계로 이동 중…';if(!send('game:skip-phase',{phase,nightTurn:room.nightTurn})){event.currentTarget.disabled=false;event.currentTarget.textContent=skipLabels[phase];}});
  document.querySelector('#resume-game')?.addEventListener('click',()=>send('game:resume'));
  document.querySelector('#resume-game-overlay')?.addEventListener('click',()=>send('game:resume'));
  document.querySelector('#discussion-skip-vote')?.addEventListener('click',(event)=>{event.currentTarget.disabled=true;const agree=!(state.room?.discussionSkip?.votes||[]).includes(state.playerId);if(!send('discussion:skip-vote',{agree}))updateDiscussionSkipControls();});
  document.querySelector('#extend-time')?.addEventListener('click',()=>send('discussion:extend'));
  document.querySelectorAll('[data-center]').forEach(btn=>btn.addEventListener('click',()=>{const i=Number(btn.dataset.center);if(state.selectedCenter.includes(i))state.selectedCenter=state.selectedCenter.filter(x=>x!==i);else if((state.prompt?.targetRole||state.prompt?.role)==='seer'){if(state.selectedCenter.length<2)state.selectedCenter.push(i);}else state.selectedCenter=[i];render();}));
  document.querySelector('#night-target')?.addEventListener('change',(e)=>state.selectedTarget=e.target.value||null);
  document.querySelector('#night-target-2')?.addEventListener('change',(e)=>state.selectedSecond=e.target.value||null);
  document.querySelector('#submit-night')?.addEventListener('click',submitNight);
  document.querySelectorAll('[data-vote]').forEach(btn=>btn.addEventListener('click',()=>{state.selectedTarget=btn.dataset.vote;render();}));
  document.querySelector('#submit-vote')?.addEventListener('click',()=>{send('vote:cast',{targetId:state.selectedTarget});state.selectedTarget=null;notify('투표를 제출했습니다.');render();});
  document.querySelector('#chat-form')?.addEventListener('submit',(e)=>{e.preventDefault();const input=document.querySelector('#chat-input');const text=input.value.trim();if(text&&send('chat:send',{text}))input.value='';input.focus();});
  document.querySelector('#leave-room')?.addEventListener('click',()=>{localStorage.removeItem('one-night-session');location.reload();});
}
function submitNight() {
  if(!state.prompt)return;
  const prompt=state.prompt;const targetRole=prompt.targetRole||prompt.role;const data={};
  if(prompt.role==='doppelganger'||targetRole==='seer'||targetRole==='robber'){data.targetId=state.selectedTarget;if(!data.targetId&&!(targetRole==='seer'&&state.selectedCenter.length===2))return notify('대상 또는 중앙 카드 두 장을 선택해 주세요.');}
  if(targetRole==='seer'&&state.selectedCenter.length===2)data.centerIndexes=state.selectedCenter;
  if(targetRole==='troublemaker'){data.targetId=state.selectedTarget;data.secondTargetId=state.selectedSecond;if(!data.targetId||!data.secondTargetId||data.targetId===data.secondTargetId)return notify('서로 다른 두 플레이어를 선택해 주세요.');}
  if(targetRole==='drunk'||targetRole==='werewolf'){if(state.selectedCenter.length!==1)return notify('중앙 카드 한 장을 선택해 주세요.');data.centerIndex=state.selectedCenter[0];}
  send('night:action',data);state.prompt=null;render();
}
function bindAudio() {document.querySelectorAll('#mic-toggle').forEach(btn=>btn.addEventListener('click',toggleMic));}
function bindVideo() {document.querySelectorAll('#camera-toggle').forEach(btn=>btn.addEventListener('click',toggleCamera));}
function makeLocalStream() {const tracks=[...(state.audioStream?.getAudioTracks()||[]),...(state.videoStream?.getVideoTracks()||[])];state.localStream=new MediaStream(tracks);}
async function toggleMic() {
  if(state.room?.phase!=='discussion')return notify('음성은 토론 단계에서만 사용할 수 있습니다.');
  if(state.micOn){state.micOn=false;for(const track of state.audioStream?.getAudioTracks()||[])track.enabled=false;await syncLocalMediaToPeers();render();return;}
  try {if(!state.audioStream)state.audioStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});state.micOn=true;for(const track of state.audioStream.getAudioTracks())track.enabled=true;makeLocalStream();syncPeers(true);await syncLocalMediaToPeers();render();notify('마이크를 켰습니다.');}
  catch {notify('마이크 권한을 사용할 수 없습니다. 채팅으로 계속 참여하실 수 있습니다.');}
}
async function loadPrivateCamera() {return import('./camera-privacy.js');}
function stopCamera() {
  state.cameraController?.abort();state.cameraController=null;
  state.cameraPipeline?.stop();state.cameraPipeline=null;
  for(const track of state.videoStream?.getTracks()||[])track.stop();
  state.videoStream=null;state.cameraOn=false;state.cameraPending=false;makeLocalStream();
}
async function toggleCamera() {
  if(state.room?.phase!=='discussion')return notify('카메라는 토론 단계에서만 사용할 수 있습니다.');
  if(state.cameraOn||state.cameraPending){stopCamera();await syncLocalMediaToPeers();render();notify('카메라를 껐습니다.');return;}
  const controller=new AbortController();state.cameraController=controller;state.cameraPending=true;render();
  try {
    const {createPrivateCamera}=await loadPrivateCamera();
    if(controller.signal.aborted)return;
    const pipeline=await createPrivateCamera({signal:controller.signal,onError:()=>{
      if(state.cameraController!==controller)return;
      stopCamera();void syncLocalMediaToPeers();render();notify('배경 가림이 중단되어 카메라를 껐습니다. 다시 켜 주세요.');
    }});
    if(controller.signal.aborted||state.cameraController!==controller||state.room?.phase!=='discussion'){pipeline.stop();return;}
    state.cameraPipeline=pipeline;state.videoStream=pipeline.stream;state.cameraPending=false;state.cameraOn=true;
    makeLocalStream();syncPeers(true);await syncLocalMediaToPeers();render();notify('배경을 가린 카메라를 켰습니다.');
  } catch(error) {
    if(state.cameraController!==controller)return;
    stopCamera();void syncLocalMediaToPeers();render();
    notify(error.name==='NotAllowedError'?'카메라 권한을 허용해 주세요.':'배경 가림을 준비하지 못해 카메라를 켜지 않았습니다. 최신 Chrome 또는 Edge와 HTTPS 연결을 확인해 주세요.');
  }
}
function syncMediaToPhase() {
  const active=state.room?.phase==='discussion';
  for(const track of state.audioStream?.getAudioTracks()||[])track.enabled=active&&state.micOn;
  if(!active&&(state.videoStream||state.cameraPending))stopCamera();
  for(const video of document.querySelectorAll('.remote-video'))video.muted=!active;
  void syncLocalMediaToPeers();
}
function setPeerSenders(pc) {const senders={};for(const transceiver of pc.getTransceivers()){const kind=transceiver.receiver?.track?.kind;if(kind)senders[kind]=transceiver.sender;}pc.mediaSenders=senders;}
async function syncLocalMediaToPeer(pc) {
  setPeerSenders(pc);
  const audio=state.room?.phase==='discussion'&&state.micOn?state.audioStream?.getAudioTracks()[0]||null:null;
  const video=state.room?.phase==='discussion'&&state.cameraOn?state.videoStream?.getVideoTracks()[0]||null:null;
  for(const [kind,track] of [['audio',audio],['video',video]]){const sender=pc.mediaSenders[kind];if(sender&&sender.track!==track)await sender.replaceTrack(track);}
}
async function syncLocalMediaToPeers() {await Promise.all([...state.peers.values()].map(syncLocalMediaToPeer));}
function bindMediaElements() {
  const local=document.querySelector('#video-'+CSS.escape(state.playerId||''));
  if(local){local.srcObject=state.localStream;local.classList.add('local-video');local.play().catch(()=>{});}
  for(const [id,stream] of state.remoteStreams){const video=document.querySelector('#video-'+CSS.escape(id));if(video){video.srcObject=stream;video.classList.add('remote-video');video.muted=state.room?.phase!=='discussion';video.play().catch(()=>{});}}
  for(const tile of document.querySelectorAll('.video-tile')){const id=tile.id.slice(5);const stream=id===state.playerId?state.localStream:state.remoteStreams.get(id);const hasVideo=(stream?.getVideoTracks()||[]).some(track=>track.readyState==='live'&&track.enabled&&!track.muted);tile.classList.toggle('has-video',Boolean(hasVideo));}
}

function syncPeers(force=false) {
  if(!state.room||!state.playerId)return;
  const others=state.room.players.filter(p=>p.id!==state.playerId&&p.connected&&!p.isBot);
  for(const [id,pc] of state.peers)if(!others.some(p=>p.id===id)){pc.close();state.peers.delete(id);state.remoteStreams.delete(id);}
  if(state.micOn||state.cameraOn||force)for(const peer of others){const pc=state.peers.get(peer.id)||createPeer(peer.id,true);void syncLocalMediaToPeer(pc);}
}
function createPeer(id,initiator=false) {
  if(state.peers.has(id))return state.peers.get(id);
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});pc.polite=state.playerId>id;pc.makingOffer=false;pc.ignoreOffer=false;state.peers.set(id,pc);
  if(initiator){pc.addTransceiver('audio',{direction:'sendrecv'});pc.addTransceiver('video',{direction:'sendrecv'});setPeerSenders(pc);}
  pc.onicecandidate=(e)=>{if(e.candidate)send('webrtc:ice-candidate',{to:id,payload:e.candidate});};
  pc.ontrack=(e)=>{let stream=state.remoteStreams.get(id);if(!stream){stream=e.streams?.[0]||new MediaStream();state.remoteStreams.set(id,stream);}if(!stream.getTracks().some(track=>track.id===e.track.id)&&!e.streams?.[0])stream.addTrack(e.track);setPeerSenders(pc);const video=document.querySelector('#video-'+CSS.escape(id));if(video){video.srcObject=stream;video.classList.add('remote-video');video.muted=state.room?.phase!=='discussion';video.play().catch(()=>{});}const tile=document.querySelector(`#tile-${CSS.escape(id)}`);const updateVideo=()=>tile?.classList.toggle('has-video',stream.getVideoTracks().some(track=>track.readyState==='live'&&track.enabled&&!track.muted));e.track.addEventListener('mute',updateVideo);e.track.addEventListener('unmute',updateVideo);updateVideo();};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'||pc.connectionState==='disconnected')notify(`${playerName(id)}님과 미디어 연결이 끊겼습니다.`);};
  pc.onnegotiationneeded=async()=>{try{pc.makingOffer=true;await pc.setLocalDescription();if(pc.localDescription?.type==='offer')send('webrtc:offer',{to:id,payload:pc.localDescription});}catch{notify('음성·영상 연결 협상이 실패했습니다.');}finally{pc.makingOffer=false;}};
  return pc;
}
async function handleSignal(event,data) {
  let pc=state.peers.get(data.from);if(!pc)pc=createPeer(data.from,false);
  try {
    if(event==='webrtc:offer') {const collision=pc.makingOffer||pc.signalingState!=='stable';pc.ignoreOffer=!pc.polite&&collision;if(pc.ignoreOffer)return;if(collision)await pc.setLocalDescription({type:'rollback'});await pc.setRemoteDescription(data.payload);setPeerSenders(pc);await syncLocalMediaToPeer(pc);await pc.setLocalDescription();send('webrtc:answer',{to:data.from,payload:pc.localDescription});}
    else if(event==='webrtc:answer') {if(pc.signalingState==='have-local-offer')await pc.setRemoteDescription(data.payload);setPeerSenders(pc);await syncLocalMediaToPeer(pc);}
    else if(event==='webrtc:ice-candidate'&&data.payload&&!pc.ignoreOffer)await pc.addIceCandidate(data.payload);
  } catch {notify('음성·영상 연결에 문제가 있습니다. 마이크나 카메라를 껐다 다시 켜 주세요.');}
}
globalThis.addEventListener?.('pagehide',stopCamera);
function scrollChat() {const box=document.querySelector('#chat-box');if(box)box.scrollTop=box.scrollHeight;}
setInterval(()=>{state.timerNow=Date.now();const room=state.room;if(room?.timerEndsAt){const ms=Math.max(0,room.timerEndsAt-state.timerNow);const s=Math.ceil(ms/1000);const node=document.querySelector('#timer');if(node)node.textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}},500);
render();
