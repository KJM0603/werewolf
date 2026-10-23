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
let leavingRoom = false;
let restartingRoom = false;
let roomRequestTimer = null;
let chatHeight = 280;
let micPending = false;
let playbackBlocked = false;
let nightActionPending = false;
let rtcConfig = null;
let rtcPending = null;
let rtcError = '';
let reconnectAttempt = 0;
let lastServerMessage = 0;
let connectingSince = 0;

function loadIceConfig() {
  if (rtcConfig && rtcConfig.expiresAt > Date.now() + 120000) return Promise.resolve(rtcConfig);
  if (rtcPending) return rtcPending.promise;
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => finishIceConfig(null, '음성 중계 설정 응답이 지연되고 있습니다. 미디어 연결 재시도를 눌러 주세요.'), 10000);
  rtcPending = { promise, resolve, reject, timer };
  if (!send('rtc:config')) finishIceConfig(null, '서버 연결 후 미디어 연결 재시도를 눌러 주세요.');
  return promise;
}
function finishIceConfig(config, error = '') {
  const pending = rtcPending;
  if (!pending) return;
  clearTimeout(pending.timer); rtcPending = null;
  rtcError = error;
  if (error) { pending.reject(new Error(error)); return; }
  rtcConfig = config;
  for (const pc of state.peers.values()) {
    if (pc.connectionState !== 'closed') {
      try { pc.setConfiguration({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy }); }
      catch { rtcError = '미디어 설정 갱신에 실패했습니다. 미디어 연결 재시도를 눌러 주세요.'; }
    }
  }
  pending.resolve(config);
}
function browserNotice() {
  if (state.room && state.room.phase !== 'lobby') return '';
  if (!/KAKAOTALK/i.test(navigator.userAgent || '')) return '';
  return '<aside class="connection-notice" role="note"><strong>Safari 또는 Chrome에서 열어 주세요.</strong><p>카카오톡 안에서는 마이크·카메라가 제한될 수 있습니다. 메뉴에서 외부 브라우저로 열거나 주소를 복사해 Safari·Chrome에 붙여 넣어 주세요. 브라우저를 바꾸실 경우 방에 들어가기 전에 이동해 주세요.</p></aside>';
}
function connectionNotice() {
  if (state.room?.phase !== 'lobby') return '';
  return `<aside class="connection-notice" role="status"><p>${esc(rtcError || '음성 사용 중에는 화면을 켜고 이 페이지를 유지해 주세요. 앱을 전환한 뒤 소리가 끊겼다면 연결을 다시 시도해 주세요.')}</p><button class="btn ghost small" id="retry-media">미디어 연결 재시도</button></aside>`;
}
async function retryMedia() {
  try {
    rtcConfig = null;
    await loadIceConfig();
    for (const pc of state.peers.values()) if (pc.connectionState !== 'closed') pc.restartIce();
    await syncPeers();
    render();
    notify('미디어 연결을 다시 시도합니다.');
  } catch (error) { rtcError = error.message; render(); notify(rtcError); }
}

function checkConnection() {
  if (!state.room || document.visibilityState === 'hidden') return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED) { connect(() => rejoin()); return; }
  if ((ws.readyState === WebSocket.OPEN && Date.now() - lastServerMessage > 45000) ||
      (ws.readyState === WebSocket.CONNECTING && Date.now() - connectingSince > 12000)) { ws.close(); return; }
  if (ws.readyState === WebSocket.OPEN) {
    send('connection:ping');
    if (state.room.phase === 'discussion') void syncPeers();
  }
}
let nightTableFeedback = null;
let insomniacApproachAt = 0;
let mobileDiscussionView = 'video';
let mobileChatUnread = 0;
let mobileChatScroll = null;

function isMobileDiscussion() { return Boolean(globalThis.matchMedia?.('(max-width: 760px)').matches); }
function resetMobileDiscussion() { mobileDiscussionView='video';mobileChatUnread=0;mobileChatScroll=null; }
function updateMobileDiscussionControls() {
  const shell=document.querySelector('.discussion-shell');
  if(!shell)return;
  shell.dataset.mobileView=mobileDiscussionView;
  const button=document.querySelector('#mobile-chat-toggle');
  if(button){
    const chatting=mobileDiscussionView==='chat';
    button.textContent=chatting?'영상으로':`채팅${mobileChatUnread?` (${mobileChatUnread>99?'99+':mobileChatUnread})`:''}`;
    button.setAttribute('aria-pressed',String(chatting));
    button.setAttribute('aria-label',chatting?'참가자 영상으로 돌아가기':`전체 화면 채팅 열기${mobileChatUnread?`, 읽지 않은 메시지 ${mobileChatUnread}개`:''}`);
  }
}
function toggleMobileDiscussion() {
  if(state.room?.phase!=='discussion'||!isMobileDiscussion())return;
  const box=document.querySelector('#chat-box');
  if(mobileDiscussionView==='chat'){
    mobileChatScroll=box?{top:box.scrollTop,follow:box.scrollHeight-box.scrollTop-box.clientHeight<48}:null;
    document.querySelector('#chat-input')?.blur();
    mobileDiscussionView='video';
  }else{mobileDiscussionView='chat';mobileChatUnread=0;}
  // Change only the layout, retaining the input, history and playing media nodes.
  updateMobileDiscussionControls();
  if(mobileDiscussionView==='chat'&&box){
    if(mobileChatScroll&&!mobileChatScroll.follow)box.scrollTop=mobileChatScroll.top;
    else scrollChat();
  }
}
function syncDiscussionViewport() {
  syncChatViewport();
  const shell=document.querySelector('.discussion-shell');
  if(!shell)return;
  const box=document.querySelector('#chat-box');
  const follow=mobileDiscussionView==='chat'&&box&&box.scrollHeight-box.scrollTop-box.clientHeight<48;
  const viewport=globalThis.visualViewport;
  if(viewport){
    shell.style.setProperty('--discussion-viewport-height',`${viewport.height}px`);
    shell.style.setProperty('--discussion-viewport-top',`${viewport.offsetTop}px`);
  }
  if(!isMobileDiscussion())mobileChatUnread=0;
  updateMobileDiscussionControls();
  if(follow)scrollChat();
}

function syncChatViewport() {
  const panel=document.querySelector('.chat-panel');
  if(!panel)return;
  const focused=isMobileDiscussion()&&document.activeElement?.id==='chat-input';
  const box=document.querySelector('#chat-box');
  const follow=box&&box.scrollHeight-box.scrollTop-box.clientHeight<48;
  // Visual viewport excludes the software keyboard, including browsers which pan the page.
  const viewport=globalThis.visualViewport;
  panel.style.setProperty('--chat-viewport-height',`${viewport?.height??globalThis.innerHeight}px`);
  panel.style.setProperty('--chat-viewport-top',`${viewport?.offsetTop??0}px`);
  panel.classList.toggle('mobile-chat-focused',focused&&state.room?.phase!=='discussion');
  if(follow)scrollChat();
}

function esc(v='') { return String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function notify(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toastEl.classList.remove('show'),3000); }
function saveSession() { if (state.room?.code && state.sessionToken) localStorage.setItem('one-night-session', JSON.stringify({code:state.room.code,token:state.sessionToken})); }
function connect(onReady) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return onReady?.();
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) { state.ws.addEventListener('open', () => onReady?.(), { once: true }); return; }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}${(location.pathname || '/').replace(/[^/]*$/, '')}signal`); state.ws=ws;connectingSince=Date.now();
  ws.addEventListener('open',()=>{if(state.ws===ws){lastServerMessage=Date.now();onReady?.();}});
  ws.addEventListener('message',(e)=>{if(state.ws!==ws)return;lastServerMessage=Date.now();try { const msg=JSON.parse(e.data); handleMessage(msg.event,msg.data||{}); } catch { notify('서버 응답을 읽지 못했습니다.'); }});
  ws.addEventListener('close',()=>{if(state.ws!==ws)return;if(leavingRoom)return returnToHome();finishIceConfig(null,'서버와 연결이 끊겼습니다.');stopCamera();for(const pc of state.peers.values())pc.close();state.peers.clear();state.remoteStreams.clear(); if(state.room){const delay=Math.min(30000,1500*2**Math.min(reconnectAttempt++,5))+Math.random()*500;setTimeout(()=>{if(state.room&&state.ws===ws&&ws.readyState===WebSocket.CLOSED){connect(()=>rejoin());}},delay);}});
  ws.addEventListener('error',()=>{if(state.ws===ws)notify('서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.');});
}
function send(event,data={}) { if (!state.ws || state.ws.readyState!==WebSocket.OPEN) { notify('서버와 연결이 끊겼습니다. 잠시 후 다시 시도해 주세요.'); return false; } state.ws.send(JSON.stringify({event,data})); return true; }
function rejoin() { const saved=JSON.parse(localStorage.getItem('one-night-session')||'null'); if(saved){reconnecting=true;send('room:reconnect',saved);} }
function clearRoomRequestTimer() { clearTimeout(roomRequestTimer);roomRequestTimer=null; }
function waitForRoomRequest(kind) {
  clearRoomRequestTimer();
  roomRequestTimer=setTimeout(()=>{
    roomRequestTimer=null;
    if(kind==='leave'&&leavingRoom)return returnToHome();
    if(kind==='restart'&&restartingRoom){
      restartingRoom=false;render();
      notify('서버 응답이 없어 대기실 이동을 완료하지 못했습니다. 다시 시도하거나 메인으로 나가 주세요.');
    }
  },8000);
}
function returnToHome() {
  finishIceConfig(null, '방에서 나갔습니다.');rtcConfig=null;rtcError='';reconnectAttempt=0;
  clearRoomRequestTimer();
  localStorage.removeItem('one-night-session');
  const ws=state.ws;state.ws=null;
  ws?.close();
  stopCamera();
  for(const track of state.audioStream?.getTracks()||[])track.stop();
  for(const pc of state.peers.values())pc.close();
  state.peers.clear();state.remoteStreams.clear();
  Object.assign(state,{room:null,playerId:null,sessionToken:null,isHost:false,
    privateRole:null,privateVisible:true,prompt:null,privateResults:[],selectedTarget:null,
    selectedSecond:null,selectedCenter:[],micOn:false,audioStream:null,localStream:null,
    chat:[],error:'',rolesPending:false,resultSplashComplete:true,resultSplashId:state.resultSplashId+1});
  reconnecting=false;leavingRoom=false;restartingRoom=false;playbackBlocked=false;
  nightActionPending=false;nightTableFeedback=null;
  resetMobileDiscussion();
  render();
}
function leaveRoom() {
  if(!['lobby','result'].includes(state.room?.phase)||leavingRoom)return;
  if(!state.ws||state.ws.readyState!==WebSocket.OPEN)return returnToHome();
  restartingRoom=false;
  leavingRoom=true;
  waitForRoomRequest('leave');
  for(const id of ['#leave-lobby','#leave-room','#home-button']) {
    const button=document.querySelector(id);
    if(button)button.disabled=true;
  }
  render();
  if(!send('room:leave'))returnToHome();
}
function restartGame() {
  if(state.room?.phase!=='result'||!hostView()||restartingRoom||leavingRoom)return;
  restartingRoom=true;
  waitForRoomRequest('restart');
  if(!send('game:restart')){restartingRoom=false;clearRoomRequestTimer();}
  render();
}
function homeBrand(enabled=false) {
  const content='<span class="brand-mark">☾</span> ONE NIGHT';
  return enabled?`<button type="button" class="brand brand-home" id="home-button" aria-label="방을 나가 메인으로" title="방을 나가 메인으로" ${leavingRoom?'disabled':''}>${content}</button>`:`<div class="brand">${content}</div>`;
}
function resultActions() {
  return `<div class="room-actions result-actions">${hostView()?`<button type="button" class="btn" id="restart-game" ${restartingRoom||leavingRoom?'disabled':''}>${restartingRoom?'대기실로 이동 중…':'다시 하기'}</button>`:''}<button type="button" class="btn ghost" id="leave-room" ${leavingRoom?'disabled':''}>${leavingRoom?'나가는 중…':'메인으로 나가기'}</button></div><p class="muted">${hostView()?'같은 방 코드로 대기실에 돌아가 다음 판을 준비합니다.':'방장이 다시 하기를 누르면 같은 방의 대기실로 함께 이동합니다.'}</p>`;
}
function handleMessage(event,data) {
  if(event==='connection:pong')return;
  if(event==='rtc:config'){finishIceConfig(data);return;}
  if(event==='rtc:config-error'){finishIceConfig(null,data.message);return;}
  if(event==='error'&&reconnecting&&data.message==='재접속 정보를 찾을 수 없습니다.'){returnToHome();notify('이전 방이 종료되어 첫 화면으로 돌아왔습니다. 새 방을 만들어 주세요.');return;}
  if(event==='room:joined')reconnecting=false;
  if(event==='room:left'){returnToHome();return;}
  if(event==='room:notice'){notify(data.message);return;}
  if(event==='error'&&leavingRoom){returnToHome();return;}
  if(event==='error'){clearRoomRequestTimer();leavingRoom=false;restartingRoom=false;nightActionPending=false;state.rolesPending=false;if(state.room)render();notify(data.message||'요청을 처리하지 못했습니다.');return;}
  if(event==='room:joined') { reconnectAttempt=0;clearRoomRequestTimer();restartingRoom=false;resetMobileDiscussion();nightActionPending=false;nightTableFeedback=null;state.room=data.room;state.chat=data.room.chat||[];state.playerId=data.playerId;state.sessionToken=data.token;state.isHost=data.isHost;state.privateResults=[];state.privateRole=null;state.prompt=null;saveSession();state.error='';syncMediaToPhase();syncPeers();render();return; }
  if(event==='room:state'||event==='game:phase'||event==='game:resumed'||event==='game:paused') {
    const votingProgressOnly=event==='room:state'&&isVotingProgressUpdate(state.room,data)&&document.querySelector('#vote-submissions');
    const previous=state.room?.phase;const previousNightTurn=state.room?.nightTurn;state.room=data;if(Array.isArray(data.chat))state.chat=data.chat;state.rolesPending=false;state.isHost=state.playerId===data.hostId;saveSession();syncPeers();
    if(data.phase==='lobby') {
      clearRoomRequestTimer();
      restartingRoom=false;nightActionPending=false;nightTableFeedback=null;
      Object.assign(state,{privateRole:null,privateResults:[],privateVisible:true,prompt:null,
        selectedTarget:null,selectedSecond:null,selectedCenter:[],resultSplashComplete:true,resultSplashId:state.resultSplashId+1});
    }
    // Private wake-up information can arrive before its public phase update.
    // Retain that snapshot for its own turn, then hide it on the next turn.
    if(data.phase!=='paused'&&(data.phase!=='night'||data.nightTurn!==previousNightTurn&&nightTableFeedback?.nightTurn!==data.nightTurn))nightTableFeedback=null;
    if(!['discussion','paused'].includes(data.phase))resetMobileDiscussion();
    // Night prompts are private and may otherwise remain visible after their
    // owner's turn times out. Keep controls only while their role is active.
    if(data.phase!=='paused'&&(data.phase!=='night'||data.nightTurn!==previousNightTurn&&state.prompt&&(state.prompt.nightTurn||(state.prompt.role==='doppelganger-copy'&&data.nightTurn==='doppelganger'?'doppelganger':state.prompt.targetRole||state.prompt.role))!==data.nightTurn))state.prompt=null;
    if(previous==='role_reveal'&&data.phase==='night')state.privateVisible=false;
    if(previous!==data.phase && data.phase==='discussion')notify('토론을 시작합니다.');
    if(previous!==data.phase && data.phase==='voting')notify('투표해 주세요.');
    syncMediaToPhase();
    if(votingProgressOnly){updateVotingControls();return;}
    render();return;
  }
  if(event==='role:private'){state.privateRole=data.role;state.privateVisible=true;render();return;}
  if(event==='night:prompt'){
    const ownCard=(data.targetRole||data.role)==='insomniac';
    if(ownCard&&(state.prompt?.targetRole||state.prompt?.role)!=='insomniac')insomniacApproachAt=Date.now();
    nightActionPending=false;
    if(nightTableFeedback?.nightTurn!==(data.nightTurn||data.targetRole||data.role))nightTableFeedback=null;
    state.prompt=data;state.selectedTarget=null;state.selectedSecond=null;state.selectedCenter=[];
    render();
    const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Scroll the stable table, not the card whose bounds change during its approach.
    document.querySelector(ownCard?'.night-table':'.night-action-area')?.scrollIntoView?.({block:ownCard?'center':'nearest',behavior:ownCard&&!reducedMotion?'smooth':'instant'});
    return;
  }
  if(event==='night:turn-ended'){nightActionPending=false;state.prompt=null;state.selectedTarget=null;state.selectedSecond=null;state.selectedCenter=[];render();if(data.reason==='timeout')notify('밤 행동 시간이 종료되었습니다. 제출하지 않은 행동은 적용되지 않았습니다.');return;}
  if(event==='night:info'){if(data.replay)nightTableFeedback=null;else if(data.table||data.currentRole)nightTableFeedback={...(data.table||{revealed:[{playerId:state.playerId,role:data.currentRole}]}),nightTurn:data.nightTurn||data.role};if(data.currentRole){state.privateRole=data.currentRole;state.privateVisible=true;}state.privateResults.push({title:ROLE_INFO[data.role]?.name||'밤 정보',currentRole:data.currentRole,text:data.loneWolf?'혼자 깨어났습니다. 중앙 카드 한 장을 직접 선택해 확인하세요.':data.role==='mason'?`함께 깨어난 프리메이슨: ${data.others?.length?data.others.join(', '):'없음'}`:data.others?.length?`함께 깨어난 늑대: ${data.others.join(', ')}`:data.wolves?`늑대인간: ${data.wolves.length?data.wolves.join(', '):'없음'}`:data.currentRole?`현재 역할: ${ROLE_INFO[data.currentRole]?.name||data.currentRole}`:'확인할 정보가 없습니다.'});render();return;}
  if(event==='night:result'){nightActionPending=false;nightTableFeedback=data.replay?null:data.table||null;if(data.currentRole){state.privateRole=data.currentRole;state.privateVisible=true;}state.privateResults.push(data);state.prompt=null;state.selectedTarget=null;state.selectedSecond=null;state.selectedCenter=[];render();if(!data.replay)notify(data.text||data.roles?.join(' · ')||data.title);return;}
  if(event==='discussion:skip-state'){if(state.room){state.room.discussionSkip=data;updateDiscussionSkipControls();}return;}
  if(event==='chat:message'){state.chat.push(data);state.chat=state.chat.slice(-200);if(state.room)state.room.chat=state.chat;appendChatMessage(data);if(state.room?.phase==='discussion'&&isMobileDiscussion()&&mobileDiscussionView==='video'&&data.playerId!==state.playerId){mobileChatUnread+=1;updateMobileDiscussionControls();}return;}
  if(event==='game:result'){state.room.result=data;state.room.phase='result';state.prompt=null;state.resultSplashComplete=false;syncMediaToPhase();const splashId=++state.resultSplashId;render();setTimeout(()=>{if(state.resultSplashId===splashId){state.resultSplashComplete=true;render();}},3000);return;}
  if(event.startsWith('webrtc:')){handleSignal(event,data);return;}
  if(event==='game:pause-availability'){if(state.room)state.room.pauseAvailable=data.available;render();}
}

function roleCounts(roles=[]) { const counts={};for(const id of roles)counts[id]=(counts[id]||0)+1;return counts; }
function selectedCount() { return state.room?.roles?.length||0; }
function hostView() { return state.playerId===state.room?.hostId; }
function playerName(id) { return state.room?.players?.find(p=>p.id===id)?.name||'플레이어'; }
function copyCode() { navigator.clipboard?.writeText(state.room.code).then(()=>notify('초대 코드를 복사했습니다.')).catch(()=>notify(`방 코드: ${state.room.code}`)); }

// Preview streams are local to the home screen and never enter WebRTC senders.
const deviceChecks = Object.fromEntries(['audio','video'].map(kind=>[kind,{stream:null,pending:false,error:'',request:0,timer:null}]));
let micMeterContext = null;
let micMeterTimer = null;
function deviceCheckConnected(kind) {
  return Boolean(deviceChecks[kind].stream?.getTracks().some(track=>track.readyState==='live'&&track.enabled&&!track.muted));
}
function stopDeviceCheck(kind) {
  const check=deviceChecks[kind];
  check.request+=1;check.pending=false;
  clearTimeout(check.timer);check.timer=null;
  for(const track of check.stream?.getTracks()||[])track.stop();
  check.stream=null;
  if(kind==='audio'){
    clearTimeout(micMeterTimer);micMeterTimer=null;
    void micMeterContext?.close().catch(()=>{});micMeterContext=null;
  }
}
function stopDeviceChecks() {
  for(const kind of ['audio','video'])stopDeviceCheck(kind);
}
function deviceCheckMarkup(kind) {
  const check=deviceChecks[kind], connected=deviceCheckConnected(kind), name=kind==='audio'?'마이크':'카메라';
  const status=check.pending?'연결 중…':connected?'연결됨':check.stream?'입력 중단':'연결 안 됨';
  return `<div class="device-check-item"><div class="device-check-row"><button type="button" class="btn ghost" id="check-${kind}" aria-describedby="check-${kind}-status">${name} ${check.pending?'연결 취소':check.stream?'연결 해제':'연결'}</button><span id="check-${kind}-status" class="device-check-status ${check.pending?'pending':connected?'connected':'disconnected'}" role="status"><span aria-hidden="true">${check.pending?'…':connected?'✓':'✕'}</span> ${status}</span></div>${check.error?`<p class="device-check-error" role="alert">${esc(check.error)}</p>`:''}${kind==='video'&&check.stream?'<video id="device-camera-preview" autoplay muted playsinline aria-label="내 카메라 미리보기"></video><p class="muted">내 화면에서만 보이는 미리보기입니다.</p>':''}${kind==='audio'&&check.stream?'<label class="device-meter-label" for="device-mic-level">말씀하시면서 음량 막대가 움직이는지 확인해 주세요.</label><meter id="device-mic-level" min="0" max="100" value="0">마이크 입력 음량</meter>':''}</div>`;
}
function updateDeviceChecks() {
  const panel=document.querySelector('#device-checks');
  if(!panel)return;
  const focused=document.activeElement?.id;
  panel.innerHTML=`<h2>카메라·마이크 연결 점검</h2><p class="muted">입장 전에 버튼을 눌러 확인해 주세요. 방에 입장하면 점검이 종료되며, 토론 중에 다시 켤 수 있습니다.</p><div class="device-check-grid">${deviceCheckMarkup('video')}${deviceCheckMarkup('audio')}</div>`;
  for(const kind of ['audio','video'])document.querySelector(`#check-${kind}`)?.addEventListener('click',()=>toggleDeviceCheck(kind));
  const preview=document.querySelector('#device-camera-preview');
  if(preview){preview.srcObject=deviceChecks.video.stream;preview.muted=true;void preview.play().catch(()=>{});}
  if(focused==='check-audio'||focused==='check-video')document.querySelector(`#${focused}`)?.focus({preventScroll:true});
}
function startMicMeter(stream) {
  const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!AudioContext)return;
  try {
    const context=new AudioContext();micMeterContext=context;
    void context.resume().catch(()=>{});
    const analyser=context.createAnalyser();analyser.fftSize=256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples=new Uint8Array(analyser.fftSize);
    const measure=()=>{
      if(micMeterContext!==context||deviceChecks.audio.stream!==stream)return;
      analyser.getByteTimeDomainData(samples);
      const rms=Math.sqrt(samples.reduce((sum,value)=>sum+((value-128)/128)**2,0)/samples.length);
      const meter=document.querySelector('#device-mic-level');
      if(meter)meter.value=Math.min(100,Math.round(rms*300));
      micMeterTimer=setTimeout(measure,100);
    };
    measure();
  }catch{deviceChecks.audio.error='마이크는 연결되었으나 음량 표시를 시작하지 못했습니다. 연결을 해제한 뒤 다시 점검해 주세요.';}
}
async function toggleDeviceCheck(kind) {
  if(state.room)return;
  const check=deviceChecks[kind],name=kind==='audio'?'마이크':'카메라';
  if(check.pending||check.stream){stopDeviceCheck(kind);check.error='';updateDeviceChecks();return;}
  check.error='';
  if(!navigator.mediaDevices?.getUserMedia){check.error=`${name}에 접근할 수 없습니다. HTTPS 주소를 Safari 또는 Chrome에서 직접 열어 주세요.`;updateDeviceChecks();return;}
  const request=++check.request;
  check.pending=true;updateDeviceChecks();
  check.timer=setTimeout(()=>{
    if(check.request!==request)return;
    stopDeviceCheck(kind);check.error='연결 응답이 없습니다. 브라우저의 권한 요청을 확인한 뒤 다시 눌러 주세요.';updateDeviceChecks();
  },20000);
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:kind==='audio',video:kind==='video'?{facingMode:'user',width:{ideal:640},height:{ideal:360}}:false});
    if(check.request!==request||state.room){for(const track of stream.getTracks())track.stop();return;}
    clearTimeout(check.timer);check.timer=null;check.pending=false;check.stream=stream;
    if(!stream.getTracks().some(track=>track.kind===kind&&track.readyState==='live'))throw Object.assign(new Error(),{name:'NotFoundError'});
    for(const track of stream.getTracks()){
      track.addEventListener('ended',()=>{
        if(check.stream!==stream)return;
        stopDeviceCheck(kind);check.error=`${name} 연결이 끊겼습니다. 장치를 확인하고 다시 연결해 주세요.`;updateDeviceChecks();
      });
      for(const event of ['mute','unmute'])track.addEventListener(event,()=>{if(check.stream===stream)updateDeviceChecks();});
    }
    if(kind==='audio')startMicMeter(stream);
    updateDeviceChecks();
  }catch(error){
    if(check.request!==request)return;
    stopDeviceCheck(kind);check.error=mediaInputError(error,name);updateDeviceChecks();
  }
}

function landing() {
  const saved=JSON.parse(localStorage.getItem('one-night-session')||'null');
  if(saved&&!state.room&&!reconnecting){reconnecting=true;connect(()=>send('room:reconnect',saved));}
  app.innerHTML=`<div class="shell"><header class="topbar"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="guide-header"><span class="top-note">A SOCIAL DEDUCTION PARTY GAME</span><a class="btn ghost small guide-link" href="guide/" target="_blank" rel="noopener noreferrer" title="새 탭에서 설명서 열기">설명서 보기</a></div></header><section class="hero"><div class="eyebrow">One night. One village. One secret.</div><h1>한밤의<br>늑대인간</h1><p>누가 늑대인간일까요? 친구들과 밤의 비밀을 나누고, 낮이 오기 전에 서로의 진짜 역할을 찾아보세요.</p></section><section class="landing-grid"><form class="panel" id="create-form"><h2>새로운 방 만들기</h2><div class="muted">친구들을 초대하고 게임을 시작하세요.</div><label class="field-label" for="create-name">내 닉네임</label><input class="input" id="create-name" maxlength="16" placeholder="예: 달빛" required><button class="btn full" type="submit">방 만들기 <span aria-hidden="true">↗</span></button></form><form class="panel" id="join-form"><h2>초대 코드로 참가</h2><div class="muted">친구에게 받은 6자리 코드를 입력하세요.</div><label class="field-label" for="join-name">내 닉네임</label><input class="input" id="join-name" maxlength="16" placeholder="예: 고요한밤" required><label class="field-label" for="join-code">방 코드</label><input class="input" id="join-code" maxlength="6" placeholder="A1B2C3" required style="text-transform:uppercase;letter-spacing:.14em"><button class="btn ghost full" type="submit">게임 참가</button></form></section><section class="panel device-checks" id="device-checks" aria-label="카메라와 마이크 점검"></section><div class="landing-foot">3–10명 · 음성 또는 채팅으로 플레이 · 한 판 약 12분 (연장 제외)</div></div>`;
  updateDeviceChecks();
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

function timerMarkup(id='timer') {
  const room=state.room;const ms=room.phase==='paused'?room.remainingMs:room.timerEndsAt?Math.max(0,room.timerEndsAt-state.timerNow):0;const seconds=Math.ceil(ms/1000);const label={role_reveal:'역할 확인',night:'밤 행동',discussion:'토론',voting:'투표',vote_reveal:'결과 공개'}[room.phase]||'진행 중';
  return `<div class="timer" id="${esc(id)}">${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</div><div class="timer-label">${label} · 남은 시간</div>`;
}
function videoGrid(room) {return `<div class="video-grid discussion-video-grid players-${Math.min(room.players.length,10)}">${room.players.map(p=>`<div class="video-tile ${p.id===state.playerId?'local-tile':''}" id="tile-${esc(p.id)}"><video id="video-${esc(p.id)}" autoplay playsinline ${p.id===state.playerId?'muted':''}></video><div class="video-placeholder" id="video-placeholder-${esc(p.id)}"><span>${esc(p.name.slice(0,1))}</span><small>${p.isBot?'AI 플레이어':'카메라 꺼짐'}</small></div><div class="video-label">${esc(p.name)}${p.id===state.playerId?' · 나':''}</div></div>`).join('')}</div>`;}

function roleCard() {
  if(!state.privateRole)return `<div class="role-card"><div class="role-secret">서버가 비공개 역할을 배정하고 있습니다.</div></div>`;
  const role=ROLE_INFO[state.privateRole]||{name:state.privateRole,emoji:'🎭'};
  const guide=state.privateRole==='hunter'?'최종 역할이 사냥꾼이면, 최다 득표로 사망할 때 내가 투표한 대상도 자동으로 사망합니다. 투표 단계에서 대상을 선택하고 비밀 투표를 제출해 주세요. 밤에는 행동하지 않습니다.':'';
  return `<div class="role-card ${state.privateVisible?'':'secret-back'}" id="role-card">${state.privateVisible?`<div class="role-emoji">${role.emoji}</div><div class="role-name">${role.name}</div><div class="role-secret">이 역할은 나에게만 보여요.${guide?`<br>${guide}`:''}</div>`:`<div class="role-emoji">🎴</div><div class="role-name">역할 가림</div><div class="role-secret">탭해서 내 역할 확인</div>`}</div><div class="inline-actions" style="justify-content:center"><button class="btn ghost small" id="hide-role">${state.privateVisible?'역할 가리기':'역할 확인'}</button></div>`;
}

function nightActionSpec() {
  const prompt=state.room?.phase==='night'?state.prompt:null;
  const role=prompt?.role==='doppelganger'?'doppelganger':prompt?.targetRole||prompt?.role;
  const specs={
    doppelganger:{players:1,center:0,guide:'역할을 복사할 사람의 카드를 선택하세요.',button:'역할 확인'},
    werewolf:{players:0,center:1,guide:'혼자 깨어났습니다. 중앙 카드 한 장을 선택하세요.',button:'선택한 카드 확인'},
    insomniac:{players:0,center:0,own:true,guide:'다가온 내 카드를 눌러 현재 역할을 확인하세요.'},
    seer:{players:1,center:2,guide:'상대 카드 한 장 또는 중앙 카드 두 장을 선택하세요.',button:'선택한 카드 확인'},
    robber:{players:1,center:0,guide:'나와 역할을 바꿀 사람의 카드를 선택하세요.',button:'역할 바꾸기'},
    troublemaker:{players:2,center:0,guide:'역할을 서로 바꿀 두 사람의 카드를 선택하세요.',button:'두 역할 바꾸기'},
    drunk:{players:0,center:1,guide:'나와 바꿀 중앙 카드 한 장을 선택하세요. 앞면은 볼 수 없습니다.',button:'역할 바꾸기'}
  };
  return specs[role]||null;
}
function nightSelectionReady() {
  const spec=nightActionSpec();if(!spec||nightActionPending)return false;
  if(spec.own)return true;
  const ids=[state.selectedTarget,state.selectedSecond].filter(Boolean);
  const validPlayers=ids.length===spec.players&&new Set(ids).size===ids.length&&ids.every(id=>state.prompt.players?.some(p=>p.id===id));
  const validCenter=state.selectedCenter.length===spec.center&&new Set(state.selectedCenter).size===spec.center&&state.selectedCenter.every(i=>Number.isInteger(i)&&i>=0&&i<(state.prompt.centerCount??3));
  return (spec.players>0&&validPlayers&&state.selectedCenter.length===0)||(spec.center>0&&validCenter&&ids.length===0);
}
function selectNightCard(kind,value) {
  const spec=nightActionSpec();if(!spec||nightActionPending)return;
  if(spec.own){if(kind==='player'&&value===state.playerId)submitNight();return;}
  if(kind==='player'){
    if(!spec.players||!state.prompt.players?.some(p=>p.id===value)||value===state.playerId)return;
    state.selectedCenter=[];
    if(spec.players===1)state.selectedTarget=state.selectedTarget===value?null:value;
    else {
      let ids=[state.selectedTarget,state.selectedSecond].filter(Boolean);
      if(ids.includes(value))ids=ids.filter(id=>id!==value);
      else if(ids.length<2)ids.push(value);
      else ids=[ids[0],value];
      [state.selectedTarget,state.selectedSecond]=[ids[0]||null,ids[1]||null];
    }
  }else{
    if(!spec.center||!Number.isInteger(value)||value<0||value>=(state.prompt.centerCount??3))return;
    state.selectedTarget=null;state.selectedSecond=null;
    if(state.selectedCenter.includes(value))state.selectedCenter=state.selectedCenter.filter(i=>i!==value);
    else if(spec.center===1)state.selectedCenter=[value];
    else state.selectedCenter=[...state.selectedCenter.slice(-(spec.center-1)),value];
  }
  render();
  const buttons=Array.from(document.querySelectorAll?.(kind==='player'?'[data-night-player]':'[data-center]')||[]);
  buttons.find(button=>kind==='player'?button.dataset.nightPlayer===value:Number(button.dataset.center)===value)?.focus?.({preventScroll:true});
}
function nightTable() {
  const spec=nightActionSpec();
  const players=state.room.players||[];
  // Keep my seat at the bottom and preserve everyone else's circular order.
  const me=players.findIndex(p=>p.id===state.playerId);
  const seated=me<0?players:[...players.slice(me),...players.slice(0,me)];
  const positions=new Map(seated.map((p,i)=>{const angle=Math.PI/2+i*2*Math.PI/seated.length;return [p.id,{x:50+40*Math.cos(angle),y:50+39*Math.sin(angle)}];}));
  const centerPosition=i=>({x:50+(i-1)*17,y:44});
  const face=(role,caption='확인 당시')=>`<span class="table-card-face"><span>${ROLE_INFO[role]?.emoji||'🎭'}</span><strong>${esc(ROLE_INFO[role]?.name||role)}</strong><small>${caption}</small></span>`;
  const back='<span class="table-card-back" aria-hidden="true"><span>☾</span><small>ONE NIGHT</small></span>';
  const revealed=nightTableFeedback?.revealed||[];
  const closeup=Boolean(spec?.own||nightTableFeedback?.closeup);
  const playerCards=seated.map(p=>{
    const own=p.id===state.playerId;const pos=positions.get(p.id);
    const selected=Boolean(state.prompt)&&[state.selectedTarget,state.selectedSecond].includes(p.id);
    const enabled=Boolean(!nightActionPending&&(spec?.own?own:spec?.players&&state.prompt.players?.some(target=>target.id===p.id)&&!own));
    const card=revealed.find(card=>card.playerId===p.id);const role=card?.role;
    const caption=card?.awakening?'깨어난 역할':'확인 당시';
    return `<div class="table-seat ${own?'my-seat':''} ${own&&closeup?'insomniac-seat':''}" style="left:${pos.x}%;top:${pos.y}%"><div class="seat-name" title="${esc(p.name)}"><span class="seat-avatar">${esc(p.name.slice(0,1))}</span><span>${esc(p.name)}</span>${own?'<b>나</b>':''}</div><button type="button" class="table-card ${selected?'selected':''} ${role?'revealed':''} ${card?.awakening?'awakened':''}" data-night-player="${esc(p.id)}" aria-label="${esc(p.name)} 카드${own?' · 내 자리':''}${own&&spec?.own?' · 눌러서 현재 역할 확인':''}${role?' · '+caption+' '+esc(ROLE_INFO[role]?.name||role):''}" aria-pressed="${selected}" ${enabled?'':'disabled'}>${role?face(role,caption):back}${selected?`<span class="card-check">${spec.players===2?(state.selectedTarget===p.id?'1':'2'):'✓'}</span>`:''}</button>${own&&closeup?`<div class="insomniac-timer">${timerMarkup('insomniac-timer')}</div><span class="insomniac-caption" role="status">${role?'확인한 내 카드':nightActionPending?'카드를 확인하고 있습니다…':'내 카드를 눌러 확인하세요'}</span>`:''}</div>`;
  }).join('');
  const centers=[0,1,2].map(i=>{
    const pos=centerPosition(i);const selected=Boolean(state.prompt)&&state.selectedCenter.includes(i);
    const role=revealed.find(card=>card.centerIndex===i)?.role;
    return `<div class="table-center-slot" style="left:${pos.x}%;top:${pos.y}%"><button type="button" class="table-card center-card ${selected?'selected':''} ${role?'revealed':''}" data-center="${i}" aria-label="중앙 카드 ${i+1}${role?' · 확인 당시 '+esc(ROLE_INFO[role]?.name||role):''}" aria-pressed="${selected}" ${spec?.center&&!nightActionPending?'':'disabled'}>${role?face(role):back}${selected?'<span class="card-check">✓</span>':''}</button><span class="center-card-label">중앙 ${i+1}</span></div>`;
  }).join('');
  const swaps=nightTableFeedback?.swapped||[];
  const swapPositions=swaps.map(card=>card.playerId?positions.get(card.playerId):centerPosition(card.centerIndex));
  const animation=swapPositions.length===2&&swapPositions.every(Boolean)?swapPositions.map((pos,i)=>`<div class="table-card flying-card" aria-hidden="true" style="--from-x:${pos.x}%;--from-y:${pos.y}%;--to-x:${swapPositions[1-i].x}%;--to-y:${swapPositions[1-i].y}%">${back}</div>`).join(''):'';
  return `<div class="night-table ${spec?'my-turn':''} ${closeup?'insomniac-closeup':''} ${spec?.own&&!nightActionPending&&Date.now()-insomniacApproachAt<800?'insomniac-approaching':''}" role="group" aria-label="밤의 원탁 · 참가자 ${players.length}명과 중앙 카드 3장"><div class="table-felt"></div><div class="table-inscription">ONE NIGHT<span>비밀이 머무는 원탁</span></div>${playerCards}${centers}${closeup?'':`<div class="table-countdown">${timerMarkup()}</div>`}${animation}</div>`;
}

function nightPanel() {
  const prompt=state.prompt;
  const latest=state.privateResults.at(-1);
  const turn=state.room?.nightTurn==='doppelganger-insomniac'?{name:'도플갱어 · 불면증 환자',emoji:'🌙'}:ROLE_INFO[state.room?.nightTurn]||{name:'밤 행동',emoji:'🌘'};
  const resultRole=latest?.currentRole?ROLE_INFO[latest.currentRole]:null;
  const privateResult=latest?`<div class="night-result" role="status" aria-live="polite"><div class="section-kicker">나만 볼 수 있는 결과</div><div class="night-result-title">${esc(latest.title||'밤 정보')}</div>${resultRole?`<div class="night-result-role"><span>${resultRole.emoji}</span><strong>확인한 내 역할: ${esc(resultRole.name)}</strong></div>`:latest.roles?.length?`<div class="night-result-cards">${latest.roles.map(name=>{const role=Object.values(ROLE_INFO).find(info=>info.name===name);return `<div><span>${role?.emoji||'🎭'}</span><strong>${esc(name)}</strong></div>`;}).join('')}</div>`:''}<div class="night-result-copy">${esc(latest.text||(!latest.roles?.length?'확인할 정보가 없습니다.':''))}</div></div>`:'';
  const spec=nightActionSpec();
  const selection=[state.selectedTarget,state.selectedSecond].filter(Boolean).map(playerName).concat(state.selectedCenter.map(i=>'중앙 '+(i+1))).join(' · ');
  const control=spec?.own?`<div class="table-waiting insomniac-instruction" role="status">${spec.guide}</div>`:spec?`<div class="night-actions table-actions"><p class="night-instruction">${spec.guide}</p><div class="table-selection" role="status" aria-live="polite">${selection?esc(selection):'빛나는 카드를 눌러 선택해 주세요.'}</div><button class="btn" id="submit-night" ${nightSelectionReady()?'':'disabled'}>${nightActionPending?'처리 중…':spec.button}</button><p class="table-hint">다시 누르면 선택 취소 · 확인 버튼을 누르면 적용됩니다.</p></div>`:`<div class="table-waiting" role="status">☾ ${nightTableFeedback?'행동을 완료했습니다. 다음 차례를 기다려 주세요.':'다른 참가자의 밤이 진행 중입니다. 내 차례가 되면 카드가 빛납니다.'}</div>`;
  const copiedAction=prompt?.role==='doppelganger-copy'&&state.room.nightTurn==='doppelganger';
  const actionGuide=copiedAction?`<div class="night-action-guide" role="status"><strong>복사 완료 · ${esc(ROLE_INFO[prompt.targetRole]?.name||prompt.targetRole)} 능력을 지금 사용하세요</strong><p>도플갱어의 남은 시간 안에 대상을 선택하고 아래 버튼을 눌러 주세요.</p></div>`:'';
  return `<div class="section-kicker">NIGHT PHASE</div><h2 class="section-title">밤이 깊었습니다</h2><p class="section-copy">화면을 다른 사람에게 보여주지 마세요. 밤 행동은 정해진 순서로 진행됩니다.</p><div class="night-action-area"><div class="night-controls"><div class="night-status"><div class="night-turn" role="status"><span>지금 차례</span><strong>${turn.emoji} ${turn.name}</strong></div></div>${actionGuide}${control}</div>${nightTable()}</div>${privateResult}<details class="night-memory"><summary>내가 마지막으로 확인한 역할 · 나만 보기</summary><p>확인 이후 다른 사람의 행동으로 바뀌었을 수 있습니다.</p>${roleCard()}</details>`;
}

function privateNotes() {
  const entries=state.privateResults.map(result=>`<p><strong>${esc(result.title||'밤 정보')}</strong><br>${esc(result.text||result.roles?.join(' · ')||'')}</p>`).join('');
  return `<details id="private-notes"><summary>내 밤 정보 · 나만 보기</summary><p>마지막으로 확인한 역할: ${esc(ROLE_INFO[state.privateRole]?.name||'없음')}</p>${entries||'<p>추가로 확인한 밤 정보가 없습니다.</p>'}</details>`;
}

function chatPanel() {
  const chat=state.chat.length?state.chat:state.room.chat||[];
  return `<section class="panel chat-panel" style="--chat-height:${chatHeight}px"><div class="chat-heading"><h2>채팅</h2><label class="chat-size" for="chat-height"><span>크기</span><input id="chat-height" type="range" min="180" max="600" step="20" value="${chatHeight}" aria-label="채팅창 크기" title="오른쪽으로 움직이면 채팅창이 커집니다"></label></div><div class="chat-box" id="chat-box">${state.room.phase==='lobby'?'':privateNotes()}${chat.map(m=>`<div class="chat-msg"><strong>${esc(m.name)}</strong>${esc(m.text)}</div>`).join('')||'<div class="muted" id="chat-empty">아직 대화가 없습니다.</div>'}</div><form class="chat-form" id="chat-form"><input class="input" id="chat-input" maxlength="300" aria-label="채팅 메시지" placeholder="메시지 입력 · Enter로 전송" autocomplete="off"><button class="btn" aria-label="보내기">↗</button></form></section>`;
}

function bindChatEvents() {
  const input=document.querySelector('#chat-input');
  input?.addEventListener('focus',()=>{syncDiscussionViewport();scrollChat();});
  input?.addEventListener('blur',syncDiscussionViewport);
  // Keep the keyboard and Korean composition focus while tapping Send.
  document.querySelector('#chat-form button')?.addEventListener('pointerdown',e=>e.preventDefault());
  document.querySelector('#chat-form')?.addEventListener('submit',(e)=>{e.preventDefault();const input=document.querySelector('#chat-input');const text=input.value.trim();if(text&&send('chat:send',{text}))input.value='';input.focus({preventScroll:true});});
  document.querySelector('#chat-height')?.addEventListener('input',(e)=>{
    const height=Number(e.target.value);if(!Number.isFinite(height))return;
    chatHeight=Math.max(180,Math.min(600,height));
    const box=document.querySelector('#chat-box');
    const follow=box&&box.scrollHeight-box.scrollTop-box.clientHeight<48;
    for(const selector of ['.chat-panel','.discussion-dock'])document.querySelector(selector)?.style.setProperty('--chat-height',`${chatHeight}px`);
    if(follow)scrollChat();
  });
}

function appendChatMessage(message) {
  const box=document.querySelector('#chat-box');if(!box)return;
  const follow=box.scrollHeight-box.scrollTop-box.clientHeight<48||message.playerId===state.playerId;
  document.querySelector('#chat-empty')?.remove();
  const row=document.createElement('div');row.className='chat-msg';
  const name=document.createElement('strong');name.textContent=message.name;
  row.append(name,document.createTextNode(message.text));box.append(row);
  const rows=box.querySelectorAll('.chat-msg');
  const oldHeight=box.scrollHeight,oldTop=box.scrollTop;
  for(let i=0;i<rows.length-200;i++)rows[i].remove();
  if(follow)box.scrollTop=box.scrollHeight;
  else box.scrollTop=oldTop-(oldHeight-box.scrollHeight);
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
    return `<div class="result-splash"><div class="result-splash-icon">${icon}</div><h2>${headline}</h2><p class="section-copy">${reason}</p></div>${resultActions()}`;
  }
  const hunterDetails=(result.hunterActions||[]).map(action=>{
    const name=id=>esc(result.finalRoles.find(p=>p.id===id)?.name||'플레이어');
    return `<p class="section-copy">🏹 ${name(action.hunterId)}님의 사냥꾼 능력: ${action.targetId?`${name(action.targetId)}님에게 자동 발동 · 함께 사망`:'투표 미제출로 추가 사망 대상이 없습니다.'}</p>`;
  }).join('');
  return `<div class="section-kicker">THE REVEAL</div><h2 class="section-title">${headline}</h2><p class="section-copy">${reason}<br>중앙 카드: ${result.center.join(' · ')}</p>${hunterDetails}<div class="player-list">${result.finalRoles.map(p=>{const win=result.winners.find(w=>w.id===p.id)?.win;return `<div class="winner"><span>${esc(p.name)} ${p.killed?'🪦':''}<small>시작: ${esc(ROLE_INFO[p.startRole]?.name||p.startRole)} · ${p.votes}표 · <span class="${p.killed?'lose-label':'win-label'}">${p.killed?(p.deathReason==='vote'?'최다 득표로 사망':p.deathReason==='hunter'?'사냥꾼의 지목으로 사망':'사망'):'생존'}</span></small></span><span>${ROLE_INFO[p.role]?.emoji||'🎭'} ${ROLE_INFO[p.role]?.name||p.role} · ${win?'<span class="win-label">승리</span>':'<span class="lose-label">패배</span>'}</span></div>`;}).join('')}</div>${resultActions()}`;
}

function discussionView(room) {
  const hasExtension=!(room.extensionUsed||[]).includes(state.playerId);
  const seconds=Math.ceil(Math.max(0,(room.timerEndsAt||state.timerNow)-state.timerNow)/1000);
  const moreActions=`<details class="discussion-more"><summary class="btn ghost small" aria-label="토론 더보기">더보기</summary><div class="discussion-more-menu"><button type="button" class="btn ghost small" id="retry-media">미디어 연결 재시도</button>${rtcError?`<span class="discussion-connection-error" role="status">${esc(rtcError)}</span>`:''}${room.pauseAvailable&&hostView()?'<button class="btn danger small" id="pause-game">게임 중지</button>':''}<div class="room-code">방 ${room.code} · ${room.players.length}명</div></div></details>`;
  app.innerHTML=`<div class="game-shell discussion-shell" data-mobile-view="${mobileDiscussionView}"><header class="game-top discussion-topbar"><div class="brand"><span class="brand-mark">☾</span> ONE NIGHT</div><div class="discussion-clock"><strong id="timer">${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}</strong><span>남은 토론 시간</span></div><div class="discussion-top-actions"><button type="button" class="btn ghost mobile-chat-toggle" id="mobile-chat-toggle" aria-controls="discussion-chat" aria-pressed="false">채팅</button>${discussionSkipMarkup(room)}${moreActions}</div></header><main class="discussion-main"><div class="discussion-video-wrap">${videoGrid(room)}</div><footer class="discussion-dock" style="--chat-height:${chatHeight}px"><div class="discussion-chat" id="discussion-chat">${chatPanel()}</div><div class="discussion-tools"><button type="button" class="btn ghost ${playbackBlocked?'':'hidden'}" id="play-remote-audio">상대 소리 재생</button><button class="btn ghost" id="mic-toggle">${state.micOn?'마이크 끄기':'마이크 켜기'}</button><button class="btn ghost" id="camera-toggle">${state.cameraPending?'카메라 준비 취소':state.cameraOn?'카메라 끄기':'카메라 켜기 · 배경 가림'}</button><button class="btn extend-btn" id="extend-time" ${!hasExtension?'disabled':''}>${hasExtension?'토론 1분 연장':'연장권 사용 완료'}</button><small>${state.micOn?'마이크 켜짐':'마이크 꺼짐'} · ${state.cameraPending?'배경 가림 준비 중…':state.cameraOn?'카메라 켜짐 · 배경 가림 적용':'카메라 꺼짐 · 켜면 배경 자동 가림'}</small></div></footer></main></div>`;
  bindGameEvents();bindAudio();bindVideo();bindMediaElements();scrollChat();syncDiscussionViewport();
}

function discussionSkipMarkup(room) {
  const progress = room.discussionSkip || { votes: [], eligibleCount: 0, required: 1 };
  const agreed = progress.votes.includes(state.playerId);
  return `<div class="discussion-skip"><button class="btn ghost small" id="discussion-skip-vote" aria-pressed="${agreed}" aria-describedby="discussion-skip-count">${discussionSkipLabel(agreed)}</button><small id="discussion-skip-count" role="status" aria-live="polite">동의 ${progress.votes.length}/${progress.eligibleCount}명 · ${progress.required}명 필요</small></div>`;
}
function discussionSkipLabel(agreed) {
  return isMobileDiscussion()?(agreed?'동의 취소':'종료 동의'):(agreed?'토론 종료 동의 취소':'토론 종료 동의');
}

function isVotingProgressUpdate(previous,next) {
  if(previous?.phase!=='voting'||next.phase!=='voting')return false;
  // Keep the mounted ballot when only the public submission count changes.
  // Roster, host, timer and phase changes still take the normal render path.
  const {votesSubmitted:oldCount,...oldRoom}=previous;
  const {votesSubmitted:newCount,...newRoom}=next;
  return JSON.stringify(oldRoom)===JSON.stringify(newRoom);
}
function updateVotingControls() {
  const room=state.room;if(room?.phase!=='voting')return;
  const total=room.players?.length||0;
  const count=document.querySelector('#vote-submissions');
  if(count)count.textContent=`투표 제출 ${room.votesSubmitted}/${total}`;
  for(const button of document.querySelectorAll('[data-vote]')){
    const selected=button.dataset.vote===state.selectedTarget;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  }
  const submit=document.querySelector('#submit-vote');
  if(submit)submit.disabled=!state.selectedTarget||room.votesSubmitted>=total;
}
function updateDiscussionSkipControls() {
  const button = document.querySelector('#discussion-skip-vote');
  const count = document.querySelector('#discussion-skip-count');
  const progress = state.room?.discussionSkip;
  if (!button || !count || !progress) return;
  const agreed = progress.votes.includes(state.playerId);
  button.disabled = false;
  button.setAttribute('aria-pressed', String(agreed));
  button.textContent = discussionSkipLabel(agreed);
  count.textContent = `동의 ${progress.votes.length}/${progress.eligibleCount}명 · ${progress.required}명 필요`;
}

function gameView() {
  const room=state.room;if(!room)return landing();
  if(room.phase==='lobby'){
    app.innerHTML=`<div class="game-shell"><header class="game-top">${homeBrand(true)}<div class="room-code">초대 코드 <strong>${room.code}</strong><button class="count-btn" id="copy-code" aria-label="코드 복사">⧉</button></div></header><div class="layout"><section class="panel main-panel"><div class="section-kicker">WAITING ROOM</div><h1 class="section-title">모두 모였나요?</h1><p class="section-copy">방 코드를 친구에게 공유하고, 준비가 끝나면 게임을 시작하세요.</p><div class="guide-actions"><button type="button" class="btn ghost small" id="leave-lobby" ${leavingRoom?'disabled':''}>${leavingRoom?'나가는 중…':'← 메인으로 나가기'}</button> <a class="btn ghost small guide-link" href="guide/" target="_blank" rel="noopener noreferrer" title="새 탭에서 설명서 열기">설명서 보기</a></div>${playersCard()}<div class="lobby-chat">${chatPanel()}</div></section><aside class="side-stack">${roleEditor()}<section class="panel audio-card"><div><div class="section-kicker">VOICE CHAT</div><div class="audio-state">토론 단계에서 음성을 켤 수 있습니다</div></div><span>🎙️</span></section></aside></div></div>`;
    bindRoomEvents();bindRoleEvents();bindChatEvents();return;
  }
  const phase=room.phase;const title={role_reveal:'내 역할을 확인하세요',night:'모두 눈을 감으세요',discussion:'마을이 깨어났습니다',voting:'누구를 지목할까요?',vote_reveal:'결과 공개 준비',paused:'게임이 잠시 멈췄습니다',result:'게임 결과'}[phase]||'게임 진행 중';
  const hunterRule=room.roles.includes('hunter')?' 최종 역할이 사냥꾼인 사람이 최다 득표(동점 포함, 2표 이상)로 사망하면, 투표한 대상도 자동으로 함께 사망합니다. 별도의 능력 버튼은 없으며, 투표를 제출하지 않으면 추가 사망 대상이 없습니다.':'';
  if(phase==='discussion'){discussionView(room);return;}
  let content='';
  if(phase==='role_reveal')content=`<div class="section-kicker">YOUR ROLE</div><h2 class="section-title">내 역할을 확인하세요</h2><p class="section-copy">카드를 확인한 뒤 화면을 가려 주세요. 밤이 곧 시작됩니다.</p>${timerMarkup()}${roleCard()}<div class="center-cards">중앙 카드 3장은 게임 종료 전까지 공개되지 않습니다.</div>`;
  else if(phase==='night')content=nightPanel();
  else if(phase==='voting')content=`<div class="section-kicker">SECRET VOTE</div><h2 class="section-title">누구를 지목할까요?</h2><p class="section-copy">투표는 모두 제출할 때까지 비공개입니다. 2표 이상 받은 사람 중 최다 득표자만 사망합니다. 최다 득표가 동점이면 그 동점자들만 모두 사망하고, 전원이 1표 이하이면 아무도 사망하지 않습니다. 늑대가 없다고 합의했다면 서로 다른 사람을 지목해 투표를 피할 수 있습니다.${hunterRule}</p>${timerMarkup()}<div class="choice-grid">${room.players.filter(p=>p.id!==state.playerId).map(p=>`<button class="choice ${state.selectedTarget===p.id?'selected':''}" data-vote="${p.id}" aria-pressed="${state.selectedTarget===p.id}">${esc(p.name)}</button>`).join('')}</div><div class="room-actions"><button class="btn" id="submit-vote" ${!state.selectedTarget||room.votesSubmitted&&room.votesSubmitted>=room.players.length?'disabled':''}>비밀 투표 제출</button></div><div class="submissions" id="vote-submissions" role="status" aria-live="polite">투표 제출 ${room.votesSubmitted}/${room.players.length}</div>`;
  else if(phase==='vote_reveal')content=`<div class="section-kicker">VOTE COMPLETE</div><h2 class="section-title">5초 뒤 결과를 공개합니다</h2><p class="section-copy">${esc(room.voteRevealReason||'잠시 후 결과를 공개합니다.')}</p>${timerMarkup()}`;
  else if(phase==='paused')content=`<div class="section-kicker">PAUSED BY HOST</div><h2 class="section-title">모두 잠시 멈췄습니다</h2><p class="section-copy">타이머와 음성이 멈췄습니다. 준비가 되면 방장이 재개할 수 있습니다.</p><div class="timer">${String(Math.floor(room.remainingMs/60000)).padStart(2,'0')}:${String(Math.floor(room.remainingMs/1000)%60).padStart(2,'0')}</div>${hostView()?'<button class="btn" id="resume-game">게임 재개</button>':''}`;
  else if(phase==='result')content=resultPanel();
  app.innerHTML=`<div class="game-shell ${phase==='night'?'night-shell':''}"><header class="game-top">${homeBrand(phase==='result')}<div class="inline-actions">${room.pauseAvailable&&hostView()&&phase!=='paused'?'<button class="btn danger small" id="pause-game">게임 중지</button>':''}<div class="room-code">${esc(title)}</div><button class="btn ghost small" id="copy-code">${room.code}</button></div></header><div class="layout"><section class="panel main-panel">${content}</section><aside class="side-stack"><section class="panel"><div class="section-kicker">PLAYERS · ${room.players.length}</div><div class="player-list" style="margin-top:12px">${room.players.map(p=>`<div class="player-row"><span class="player-name"><span class="avatar">${esc(p.name.slice(0,1))}</span>${esc(p.name)}</span><span class="player-badge ${p.connected?'ready':'offline'}">${p.connected?'●':'○'}</span></div>`).join('')}</div></section><section class="panel audio-card"><div><div class="section-kicker">VOICE & VIDEO</div><div class="audio-state">${phase==='discussion'?(state.micOn?'마이크 켜짐':'마이크 끔')+' · '+(state.cameraOn?'카메라 켜짐':'카메라 끔'):'토론 단계에서 사용할 수 있습니다'}</div></div><span>🎙️📹</span></section>${['discussion','voting'].includes(phase)?chatPanel():''}</aside></div>${phase==='paused'?`<div class="pause-overlay"><div class="pause-card"><div class="pause-icon">⏸</div><h2>게임이 멈췄습니다</h2><p>모든 참가자의 화면과 음성이 일시정지되었습니다.<br>${esc(room.pauseReason||'방장이 게임을 멈췄습니다.')}</p>${hostView()?'<button class="btn" id="resume-game-overlay">게임 재개</button>':''}</div></div>`:''}</div>`;
  bindGameEvents();bindAudio();bindVideo();bindMediaElements();scrollChat();
}

function render() {
  if(state.room)stopDeviceChecks();
  const oldInput=document.querySelector('#chat-input');
  const draft=oldInput?.value||'', start=oldInput?.selectionStart, end=oldInput?.selectionEnd;
  const keepChatFocus=document.activeElement?.id==='chat-input';
  const notesOpen=document.querySelector('#private-notes')?.open;
  const nightMemoryOpen=document.querySelector('.night-memory')?.open;
  const oldBox=document.querySelector('#chat-box');
  const oldScroll=oldBox?.scrollTop||0;
  const follow=oldBox&&oldBox.scrollHeight-oldScroll-oldBox.clientHeight<48;
  if(!state.room)landing();else gameView();
  app?.insertAdjacentHTML('afterbegin', browserNotice() + connectionNotice());
  document.querySelector('#retry-media')?.addEventListener('click', retryMedia);
  const input=document.querySelector('#chat-input');
  if(input&&oldInput){input.value=draft;if(keepChatFocus){input.focus({preventScroll:true});input.setSelectionRange(start??draft.length,end??draft.length);}}
  const notes=document.querySelector('#private-notes');if(notes&&notesOpen)notes.open=true;
  const nightMemory=document.querySelector('.night-memory');if(nightMemory&&nightMemoryOpen)nightMemory.open=true;
  const box=document.querySelector('#chat-box');
  if(box){if(oldBox&&!follow)box.scrollTop=oldScroll;else scrollChat();}
  syncDiscussionViewport();
}
function bindRoomEvents() {
  document.querySelector('#leave-lobby')?.addEventListener('click',leaveRoom);
  document.querySelector('#home-button')?.addEventListener('click',leaveRoom);
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
  bindChatEvents();
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
  document.querySelector('#mobile-chat-toggle')?.addEventListener('click',toggleMobileDiscussion);
  document.querySelector('#extend-time')?.addEventListener('click',()=>send('discussion:extend'));
  document.querySelectorAll('[data-center]').forEach(btn=>btn.addEventListener('click',()=>selectNightCard('center',Number(btn.dataset.center))));
  document.querySelectorAll('[data-night-player]').forEach(btn=>btn.addEventListener('click',()=>selectNightCard('player',btn.dataset.nightPlayer)));
  document.querySelector('#submit-night')?.addEventListener('click',submitNight);
  document.querySelectorAll('[data-vote]').forEach(btn=>btn.addEventListener('click',()=>{state.selectedTarget=btn.dataset.vote;updateVotingControls();}));
  document.querySelector('#submit-vote')?.addEventListener('click',()=>{if(!send('vote:cast',{targetId:state.selectedTarget}))return;state.selectedTarget=null;notify('투표를 전송했습니다.');updateVotingControls();});
  document.querySelector('#leave-room')?.addEventListener('click',leaveRoom);
  document.querySelector('#home-button')?.addEventListener('click',leaveRoom);
  document.querySelector('#restart-game')?.addEventListener('click',restartGame);
}
function submitNight() {
  if(!state.prompt||state.room?.phase!=='night'||nightActionPending||!nightSelectionReady())return;
  const prompt=state.prompt;const targetRole=prompt.targetRole||prompt.role;const data={};
  if(prompt.role==='doppelganger'||targetRole==='seer'||targetRole==='robber'){data.targetId=state.selectedTarget;if(!data.targetId&&!(targetRole==='seer'&&state.selectedCenter.length===2))return notify('대상 또는 중앙 카드 두 장을 선택해 주세요.');}
  if(targetRole==='seer'&&state.selectedCenter.length===2)data.centerIndexes=state.selectedCenter;
  if(targetRole==='troublemaker'){data.targetId=state.selectedTarget;data.secondTargetId=state.selectedSecond;if(!data.targetId||!data.secondTargetId||data.targetId===data.secondTargetId)return notify('서로 다른 두 플레이어를 선택해 주세요.');}
  if(targetRole==='drunk'||targetRole==='werewolf'){if(state.selectedCenter.length!==1)return notify('중앙 카드 한 장을 선택해 주세요.');data.centerIndex=state.selectedCenter[0];}
  nightActionPending=true;render();
  if(!send('night:action',data)){nightActionPending=false;render();}
}
function bindAudio() {
  document.querySelectorAll('#mic-toggle').forEach(btn=>btn.addEventListener('click',toggleMic));
  document.querySelector('#play-remote-audio')?.addEventListener('click',async()=>{
    const videos=[...document.querySelectorAll('.remote-video')];
    const results=await Promise.allSettled(videos.map(video=>video.play()));
    playbackBlocked=results.some(result=>result.status==='rejected');
    document.querySelector('#play-remote-audio')?.classList.toggle('hidden',!playbackBlocked);
    if(playbackBlocked)notify('소리 재생이 차단되었습니다. 브라우저의 사이트 소리 설정을 확인해 주세요.');
  });
}
function bindVideo() {document.querySelectorAll('#camera-toggle').forEach(btn=>btn.addEventListener('click',toggleCamera));}
function makeLocalStream() {const tracks=[...(state.audioStream?.getAudioTracks()||[]),...(state.videoStream?.getVideoTracks()||[])];state.localStream=new MediaStream(tracks);}
async function toggleMic() {
  if(micPending)return;
  if(state.room?.phase!=='discussion')return notify('음성은 토론 단계에서만 사용할 수 있습니다.');
  if(state.micOn){state.micOn=false;for(const track of state.audioStream?.getAudioTracks()||[])track.enabled=false;await syncLocalMediaToPeers();render();return;}
  if(!navigator.mediaDevices?.getUserMedia)return notify('이 브라우저에서는 마이크에 접근할 수 없습니다. HTTPS 주소를 Chrome 또는 Edge에서 직접 열어 주세요.');
  const playerId=state.playerId;
  micPending=true;
  try {
    if(!state.audioStream?.getAudioTracks().some(track=>track.readyState==='live')){
      const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      if(state.playerId!==playerId||state.room?.phase!=='discussion'){for(const track of stream.getTracks())track.stop();return;}
      state.audioStream=stream;
    }
  } catch(error) {notify(mediaInputError(error,'마이크'));return;}
  finally {micPending=false;}
  state.micOn=true;for(const track of state.audioStream.getAudioTracks())track.enabled=true;
  makeLocalStream();syncPeers(true);const connected=await syncLocalMediaToPeers();render();if(connected)notify('마이크를 켰습니다.');
}
function mediaInputError(error,device) {
  if(error.name==='NotAllowedError'||error.name==='SecurityError')return `${device} 접근이 차단되었습니다. 주소창의 사이트 설정과 운영체제 개인정보 설정에서 ${device} 권한을 허용해 주세요.`;
  if(error.name==='NotFoundError')return `사용 가능한 ${device} 장치를 찾지 못했습니다. 장치 연결과 브라우저 입력 장치 설정을 확인해 주세요.`;
  if(error.name==='NotReadableError'||error.name==='AbortError')return `${device} 장치를 열지 못했습니다. 다른 앱의 장치 사용을 종료한 뒤 다시 시도해 주세요.`;
  return `${device}를 켜지 못했습니다 (${error.name||'알 수 없는 오류'}). 장치와 브라우저 설정을 확인해 주세요.`;
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
    makeLocalStream();syncPeers(true);const connected=await syncLocalMediaToPeers();render();if(connected)notify('배경을 가린 카메라를 켰습니다.');
  } catch(error) {
    if(state.cameraController!==controller)return;
    stopCamera();void syncLocalMediaToPeers();render();
    notify(['NotAllowedError','NotFoundError','NotReadableError','SecurityError'].includes(error.name)?mediaInputError(error,'카메라'):'배경 가림을 준비하지 못해 카메라를 켜지 않았습니다. 최신 Chrome 또는 Edge와 HTTPS 연결을 확인해 주세요.');
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
  // Remote-created transceivers default to recvonly. Reserve both directions
  // before answering, even when this participant has not enabled a device yet.
  for(const transceiver of pc.getTransceivers())if(!transceiver.stopped)transceiver.direction='sendrecv';
  setPeerSenders(pc);
  const audio=state.room?.phase==='discussion'&&state.micOn?state.audioStream?.getAudioTracks()[0]||null:null;
  const video=state.room?.phase==='discussion'&&state.cameraOn?state.videoStream?.getVideoTracks()[0]||null:null;
  for(const [kind,track] of [['audio',audio],['video',video]]){const sender=pc.mediaSenders[kind];if(sender&&sender.track!==track)await sender.replaceTrack(track);}
}
async function syncLocalMediaToPeers() {
  const results=await Promise.allSettled([...state.peers.values()].map(syncLocalMediaToPeer));
  const connected=results.every(result=>result.status==='fulfilled');
  if(!connected)notify('장치는 켜졌지만 일부 참가자에게 전달하지 못했습니다. 미디어 연결을 확인해 주세요.');
  return connected;
}
function bindMediaElements() {
  const local=document.querySelector('#video-'+CSS.escape(state.playerId||''));
  if(local){local.srcObject=state.localStream;local.classList.add('local-video');local.play().catch(()=>{});}
  for(const [id,stream] of state.remoteStreams){const video=document.querySelector('#video-'+CSS.escape(id));if(video){if(video.srcObject!==stream)video.srcObject=stream;video.classList.add('remote-video');video.muted=state.room?.phase!=='discussion';video.play().catch(error=>{if(error.name==='NotAllowedError'&&state.room?.phase==='discussion'){playbackBlocked=true;document.querySelector('#play-remote-audio')?.classList.remove('hidden');}});}}
  for(const tile of document.querySelectorAll('.video-tile')){const id=tile.id.slice(5);const stream=id===state.playerId?state.localStream:state.remoteStreams.get(id);const hasVideo=(stream?.getVideoTracks()||[]).some(track=>track.readyState==='live'&&track.enabled&&!track.muted);tile.classList.toggle('has-video',Boolean(hasVideo));}
}

async function syncPeers(force=false) {
  if(!state.room||!state.playerId)return;
  const others=state.room.players.filter(p=>p.id!==state.playerId&&p.connected&&!p.isBot);
  for(const [id,pc] of state.peers)if(!others.some(p=>p.id===id)){pc.close();state.peers.delete(id);state.remoteStreams.delete(id);}
  if(!(state.room.phase==='discussion'||state.micOn||state.cameraOn||force))return;
  const room=state.room;
  try { await loadIceConfig(); } catch(error) { if(state.room===room){rtcError=error.message;render();notify(rtcError);}return; }
  if(state.room?.code!==room.code||!state.room||!(state.room.phase==='discussion'||state.micOn||state.cameraOn||force))return;
  for(const peer of others){
    if(!state.room.players.some(p=>p.id===peer.id&&p.connected&&!p.isBot))continue;
    // One offerer per pair avoids simultaneous startup creating duplicate tracks.
    const pc=state.peers.get(peer.id)||createPeer(peer.id,state.playerId<peer.id);
    void syncLocalMediaToPeer(pc).catch(()=>notify('참가자에게 음성·영상을 연결하지 못했습니다.'));
  }
}
function createPeer(id,initiator=false) {
  if(state.peers.has(id))return state.peers.get(id);
  const pc=new RTCPeerConnection({iceServers:rtcConfig.iceServers,iceTransportPolicy:rtcConfig.iceTransportPolicy});pc.polite=state.playerId>id;pc.makingOffer=false;pc.ignoreOffer=false;pc.settingRemoteAnswer=false;pc.pendingCandidates=[];state.peers.set(id,pc);
  if(initiator){pc.addTransceiver('audio',{direction:'sendrecv'});pc.addTransceiver('video',{direction:'sendrecv'});setPeerSenders(pc);}
  pc.onicecandidate=(e)=>{if(e.candidate)send('webrtc:ice-candidate',{to:id,payload:e.candidate});};
  pc.ontrack=(e)=>{let stream=state.remoteStreams.get(id);if(!stream){stream=new MediaStream();state.remoteStreams.set(id,stream);}if(!stream.getTracks().some(track=>track.id===e.track.id))stream.addTrack(e.track);setPeerSenders(pc);const updateVideo=()=>bindMediaElements();e.track.addEventListener('mute',updateVideo);e.track.addEventListener('unmute',updateVideo);e.track.addEventListener('ended',updateVideo);updateVideo();};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'){notify(`${playerName(id)}님과 미디어 연결을 다시 시도합니다.`);if(!pc.recoveryAt||Date.now()-pc.recoveryAt>15000){pc.recoveryAt=Date.now();void loadIceConfig().then(()=>{if(state.peers.get(id)===pc)pc.restartIce();}).catch(error=>{rtcError=error.message;render();});}}else if(pc.connectionState==='disconnected')notify(`${playerName(id)}님과 미디어 연결이 끊겼습니다. 연결이 돌아오지 않으면 미디어 연결 재시도를 눌러 주세요.`);};
  pc.onnegotiationneeded=async()=>{try{pc.makingOffer=true;await syncLocalMediaToPeer(pc);await pc.setLocalDescription();if(pc.localDescription?.type==='offer')send('webrtc:offer',{to:id,payload:pc.localDescription});}catch{if(pc.connectionState!=='closed')notify('음성·영상 연결 협상이 실패했습니다.');}finally{pc.makingOffer=false;}};
  return pc;
}
async function handleSignal(event,data) {
  if(!state.room?.players.some(p=>p.id===data.from&&!p.isBot))return;
  let pc=state.peers.get(data.from);if(!pc){
    const room=state.room;
    try{await loadIceConfig();}catch(error){rtcError=error.message;render();return;}
    if(!state.room||state.room.code!==room.code||!state.room.players.some(p=>p.id===data.from&&p.connected&&!p.isBot))return;
    pc=createPeer(data.from,false);
  }
  // WebSocket messages arrive in order, but their async SDP work must finish in
  // order too. Keep early ICE until a remote description has been installed.
  pc.signalQueue=(pc.signalQueue||Promise.resolve()).then(async()=>{
    if(state.peers.get(data.from)!==pc||pc.connectionState==='closed')return;
    try {
      if(event==='webrtc:offer'||event==='webrtc:answer'){
        const offer=event==='webrtc:offer';
        const ready=!pc.makingOffer&&(pc.signalingState==='stable'||pc.settingRemoteAnswer);
        pc.ignoreOffer=offer&&!pc.polite&&!ready;
        if(pc.ignoreOffer)return;
        pc.settingRemoteAnswer=!offer;
        await pc.setRemoteDescription(data.payload);pc.settingRemoteAnswer=false;
        await syncLocalMediaToPeer(pc);
        for(const candidate of pc.pendingCandidates.splice(0))await pc.addIceCandidate(candidate);
        if(offer){await pc.setLocalDescription();send('webrtc:answer',{to:data.from,payload:pc.localDescription});}
      }else if(event==='webrtc:ice-candidate'&&data.payload&&!pc.ignoreOffer){
        if(pc.remoteDescription)await pc.addIceCandidate(data.payload);
        else pc.pendingCandidates.push(data.payload);
      }
    }catch{if(pc.connectionState!=='closed')notify('음성·영상 연결 협상에 실패했습니다. 사이트 권한과 별개로 네트워크 연결을 확인해 주세요.');}
    finally{pc.settingRemoteAnswer=false;}
  });
  return pc.signalQueue;
}
globalThis.addEventListener?.('pagehide',stopCamera);
globalThis.addEventListener?.('pagehide',stopDeviceChecks);
document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='hidden'){stopDeviceChecks();updateDeviceChecks();}});
globalThis.addEventListener?.('resize',syncDiscussionViewport);
globalThis.visualViewport?.addEventListener('resize',syncDiscussionViewport);
globalThis.visualViewport?.addEventListener('scroll',syncDiscussionViewport);
function scrollChat() {const box=document.querySelector('#chat-box');if(box)box.scrollTop=box.scrollHeight;}
setInterval(()=>{state.timerNow=Date.now();const room=state.room;if(room?.timerEndsAt){const ms=Math.max(0,room.timerEndsAt-state.timerNow);const s=Math.ceil(ms/1000);for(const node of document.querySelectorAll('#timer, #insomniac-timer'))node.textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}},500);
render();
globalThis.addEventListener?.('online',checkConnection);
globalThis.addEventListener?.('pageshow',checkConnection);
document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState==='visible'){checkConnection();bindMediaElements();}});
setInterval(checkConnection,15000);
