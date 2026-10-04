(function(){
"use strict";

/* ============================== BACKEND STORAGE (Vercel API route) ============================== */
async function loadRoom(code){
  try{
    const res = await fetch(`/api/room?code=${encodeURIComponent(code)}`);
    if(!res.ok){
      if(res.status !== 404){
        const errBody = await res.json().catch(()=>({}));
        console.error('loadRoom failed', res.status, errBody);
        local.lastError = errBody.detail || errBody.error || `HTTP ${res.status}`;
      }
      return null;
    }
    const data = await res.json();
    return data.state || null;
  }catch(e){
    console.error('loadRoom network error', e);
    local.lastError = (e && e.message) || 'network error';
    return null;
  }
}
async function saveRoom(code, state){
  try{
    const res = await fetch('/api/room', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({code, state}),
    });
    if(!res.ok){
      const errBody = await res.json().catch(()=>({}));
      console.error('saveRoom failed', res.status, errBody);
      local.lastError = errBody.detail || errBody.error || `HTTP ${res.status}`;
      return false;
    }
    return true;
  }catch(e){
    console.error('saveRoom network error', e);
    local.lastError = (e && e.message) || 'network error';
    return false;
  }
}
async function updateRoom(code, mutator){
  for(let attempt=0; attempt<3; attempt++){
    const current = await loadRoom(code);
    if(!current) return null;
    const next = mutator(JSON.parse(JSON.stringify(current)));
    if(next === false) return current;
    next.rev = (current.rev||0) + 1;
    next.updatedAt = Date.now();
    const ok = await saveRoom(code, next);
    if(ok) return next;
  }
  return null;
}

/* ============================== LOCAL SESSION STATE ============================== */
let local = {
  view: 'home',
  myId: null,
  myName: '',
  roomCode: null,
  room: null,
  toast: null,
  toastTimer: null,
  bidDraft: null,
  trumpDraft: null,
  friendDraft: [],
  friendPickSuit: null,
  friendPickOcc: 1,
  polling: false,
};

function uid(){ return Math.random().toString(36).slice(2,10); }
function roomCodeGen(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c=''; for(let i=0;i<4;i++) c += chars[Math.floor(Math.random()*chars.length)];
  return c;
}
function showToast(msg, ms=2600){
  local.toast = msg;
  render();
  clearTimeout(local.toastTimer);
  local.toastTimer = setTimeout(()=>{ local.toast=null; render(); }, ms);
}

const PLAYER_COLORS = ['#DB2777','#D97706','#2563EB','#0891B2','#CA8A04','#9333EA','#EA580C','#65A30D'];
function playerColor(state, id){
  const idx = state.players.findIndex(p=>p.id===id);
  return PLAYER_COLORS[idx % PLAYER_COLORS.length];
}
function avatarInitials(p){
  if(p.isBot){
    const m = /^Bot (\d+)$/.exec(p.name);
    return 'B' + (m ? m[1] : '?');
  }
  return p.name.slice(0,2).toUpperCase();
}

function esc(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function cardHtml(card, opts){
  opts = opts||{};
  const r = cardRank(card), s = cardSuit(card);
  const red = isRed(card);
  const classes = ['card'];
  if(red) classes.push('red');
  if(opts.mini) classes.push('mini-pick');
  if(opts.playable) classes.push('playable');
  if(opts.disabled) classes.push('disabled');
  if(opts.selected) classes.push('selected');
  const clickAttr = opts.onclick ? `data-action="${opts.onclick}" data-card="${card}"` : '';
  return `<div class="${classes.join(' ')}" ${clickAttr}>
    <div class="corner"><div class="rk">${r}</div><div class="sy">${SUIT_SYMBOL[s]}</div></div>
    <div class="watermark">${SUIT_SYMBOL[s]}</div>
  </div>`;
}
function miniCardHtml(card){
  const red = isRed(card);
  return `<div class="mini-card ${red?'red':''}"><div>${cardRank(card)}</div><div>${SUIT_SYMBOL[cardSuit(card)]}</div></div>`;
}

function seatPositions(n){
  const pts = [];
  for(let i=0;i<n;i++){
    const angle = (90 + 360*i/n) * Math.PI/180;
    const rx = 40, ry = 35;
    pts.push({ x: 50 + rx*Math.cos(angle), y: 50 + ry*Math.sin(angle) });
  }
  return pts;
}

function seatStatusText(state, playerId){
  const ph = state.phase;
  if(ph==='bidding'){
    const b = state.bidding;
    if(b.passed.includes(playerId)) return {text:'PASS', on:false};
    if(b.highestBid && b.highestBid.playerId===playerId) return {text:String(b.highestBid.amount), on:true};
    return {text:'', on:false};
  }
  if(ph==='trump'){
    if(playerId===state.bidWinnerId) return {text:'PICK', on:true};
    return {text:'', on:false};
  }
  if(ph==='playing' || ph==='scoring'){
    const pts = (state.piles[playerId]||[]).reduce((s,c)=>s+pointValue(c),0);
    return {text:String(pts), on:false};
  }
  return {text:'', on:false};
}

function renderSeats(state){
  const n = state.players.length;
  const myIdx = state.players.findIndex(p=>p.id===local.myId);
  const order = myIdx>=0 ? [...state.players.slice(myIdx), ...state.players.slice(0,myIdx)] : state.players;
  const pts = seatPositions(n);
  const turnId = state.phase==='bidding' ? state.players[state.bidding.turnSeat].id
               : (state.phase==='playing' && state.play) ? state.players[state.play.turnSeat].id
               : null;
  const revealedFriendIds = new Set((state.friendCalls||[]).filter(f=>f.revealed).map(f=>f.ownerId));
  return order.map((p,i)=>{
    const pos = pts[i];
    const isMe = p.id===local.myId;
    const isTurn = p.id===turnId;
    const isBidder = p.id===state.bidWinnerId;
    const isFriend = revealedFriendIds.has(p.id);
    const passed = state.phase==='bidding' && state.bidding.passed.includes(p.id);
    const st = seatStatusText(state, p.id);
    const classes = ['seat'];
    if(isMe) classes.push('me');
    if(isTurn) classes.push('turn');
    if(isBidder) classes.push('bidder');
    if(isFriend) classes.push('friend');
    if(passed) classes.push('seat-passed');
    const color = playerColor(state, p.id);
    return `<div class="${classes.join(' ')}" style="left:${pos.x}%;top:${pos.y}%;">
      <div class="seat-status ${st.on?'on':''}">${esc(st.text)}</div>
      <div class="seat-avatar-wrap"><div class="seat-avatar" style="background:${color};">${esc(avatarInitials(p))}</div></div>
      <div class="seat-name">${esc(p.name)}</div>
    </div>`;
  }).join('');
}

function renderCenter(state){
  if(state.phase!=='playing' || !state.play) return '';
  const pl = state.play;
  if(pl.currentTrick.length){
    return `<div class="center-area"><div class="trick-cards">${pl.currentTrick.map(p=>miniCardHtml(p.card)).join('')}</div></div>`;
  }
  if(pl.lastTrick){
    return `<div class="center-area"><div class="trick-cards">${pl.lastTrick.cards.map(p=>miniCardHtml(p.card)).join('')}</div></div>`;
  }
  return '';
}

function shellHtml(state, sideHtml, handHtml){
  return `
    <div class="shell">
      <div class="topbar">
        <span class="code">${state.roomCode}</span>
        <span class="rnd">R${state.round||0} \u00b7 ${state.players.length}p${state.decks===2?' \u00b7 2 decks':''}</span>
        <button class="btn btn-ghost btn-sm" id="leaveBtn">Leave</button>
      </div>
      <div class="main-row">
        <div class="table-pane">
          ${renderSeats(state)}
          ${renderCenter(state)}
        </div>
        <div class="side-pane">${sideHtml}</div>
      </div>
      ${handHtml || ''}
    </div>
  `;
}

function handDockHtml(state, isMyPlayTurn, legal){
  const hand = sortHand(state.hands[local.myId]||[]);
  const cardsHtml = hand.map(c=>{
    const playable = !!isMyPlayTurn && legal && legal.includes(c);
    const disabled = !!isMyPlayTurn && legal && !legal.includes(c);
    return cardHtml(c, {playable, disabled, onclick: playable?'playCard':''});
  }).join('');
  return `
    <div class="hand-dock ${isMyPlayTurn?'myturn':''}">
      ${isMyPlayTurn?'<div class="turn-banner">Your turn</div>':''}
      <div class="hand-strip">${cardsHtml}</div>
    </div>
  `;
}

function doExit(){
  stopPolling();
  local.view='home';
  local.room=null;
  render();
}
function bindLeave(){
  const b = document.getElementById('leaveBtn');
  if(b) b.onclick = doExit;
}

/* ============================== RENDER: HOME / LOBBY ============================== */
function render(){
  if(local.view==='home') return renderHome();
  if(local.room) return renderRoom(local.room);
  root.innerHTML = `<div class="home"><div class="tiny muted">Loading\u2026</div></div>`;
}
function renderRoom(state){
  if(state.phase==='lobby') return renderLobby(state);
  if(state.phase==='bidding') return renderBidding(state);
  if(state.phase==='trump') return renderTrump(state);
  if(state.phase==='playing') return renderPlaying(state);
  if(state.phase==='scoring') return renderScoring(state);
}

function renderHome(){
  root.innerHTML = `
    <div class="home">
      <div class="home-title"><div class="logo">3\u2660</div><h1>3 of Spades</h1></div>
      <div class="home-field" style="max-width:260px;width:100%;">
        <label>Name</label>
        <input type="text" id="nameInput" maxlength="18" placeholder="Your name">
      </div>
      <div class="home-grid">
        <div class="home-panel">
          <h3>Create</h3>
          <div class="stepper">
            <button type="button" class="stepper-btn" id="sizeMinus">\u2212</button>
            <div class="stepper-value" id="sizeValue">4 players</div>
            <button type="button" class="stepper-btn" id="sizePlus">+</button>
          </div>
          <div class="mode-seg" id="decksSeg">
            <button type="button" data-decks="1" class="active">1 deck</button>
            <button type="button" data-decks="2">2 decks</button>
          </div>
          <button class="btn btn-primary btn-block" id="createBtn">Create</button>
        </div>
        <div class="home-panel accent-b">
          <h3>Join</h3>
          <div class="home-field">
            <input type="text" id="joinCode" maxlength="4" placeholder="Code" style="text-transform:uppercase;text-align:center;letter-spacing:.12em;">
          </div>
          <button class="btn btn-primary btn-block" id="joinBtn">Join</button>
        </div>
      </div>
    </div>
  `;

  let chosenSize = 4;
  let chosenDecks = 1;
  const sizeValueEl = document.getElementById('sizeValue');
  const sizeMinusBtn = document.getElementById('sizeMinus');
  const sizePlusBtn = document.getElementById('sizePlus');
  function refreshSizeUI(){
    sizeValueEl.textContent = `${chosenSize} players`;
    sizeMinusBtn.disabled = chosenSize<=4;
    sizePlusBtn.disabled = chosenSize>=8;
  }
  sizeMinusBtn.onclick = ()=>{ chosenSize = Math.max(4, chosenSize-1); refreshSizeUI(); };
  sizePlusBtn.onclick = ()=>{ chosenSize = Math.min(8, chosenSize+1); refreshSizeUI(); };
  refreshSizeUI();

  document.querySelectorAll('#decksSeg button').forEach(btn=>{
    btn.onclick = ()=>{
      chosenDecks = parseInt(btn.dataset.decks,10);
      document.querySelectorAll('#decksSeg button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  document.getElementById('createBtn').onclick = async ()=>{
    const name = document.getElementById('nameInput').value.trim();
    if(!name){ showToast('Enter your name'); return; }
    const myId = uid();
    const code = roomCodeGen();
    const state = freshRoomState(code, chosenSize, myId, name, chosenDecks);
    const ok = await saveRoom(code, state);
    if(!ok){ showToast(local.lastError ? `Error: ${local.lastError}` : 'Could not create table'); return; }
    local.myId = myId; local.myName = name; local.roomCode = code; local.view='room';
    startPolling();
    applyRoomUpdate(state);
  };

  document.getElementById('joinBtn').onclick = async ()=>{
    const name = document.getElementById('nameInput').value.trim();
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if(!name || code.length!==4){ showToast('Enter name & code'); return; }
    const existing = await loadRoom(code);
    if(!existing){ showToast(local.lastError ? `Error: ${local.lastError}` : 'Table not found'); return; }
    const already = existing.players.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(already){
      local.myId = already.id; local.myName = already.name; local.roomCode = code; local.view='room';
      startPolling(); applyRoomUpdate(existing); return;
    }
    if(existing.phase!=='lobby'){ showToast('Already started'); return; }
    if(existing.players.length >= existing.tableSize){ showToast('Table full'); return; }
    const myId = uid();
    const next = await updateRoom(code, s=>{
      if(s.phase!=='lobby' || s.players.length>=s.tableSize) return false;
      s.players.push({id:myId, name});
      pushLog(s, `${name} joined.`);
      return s;
    });
    if(!next){ showToast('Could not join'); return; }
    local.myId = myId; local.myName = name; local.roomCode = code; local.view='room';
    startPolling();
    applyRoomUpdate(next);
  };
}

function renderLobby(state){
  const isHost = state.players[0] && state.players[0].id===local.myId;
  const full = state.players.length >= state.tableSize;
  const chips = state.players.map((p,i)=>`
    <div style="display:flex;align-items:center;gap:6px;background:var(--felt);border:1px solid var(--border);border-radius:20px;padding:4px 8px 4px 4px;">
      <div class="seat-avatar" style="background:${playerColor(state,p.id)};width:22px;height:22px;font-size:9px;">${esc(avatarInitials(p))}</div>
      <span class="tiny" style="font-weight:700;">${esc(p.name)}</span>
      ${i===0?'<span class="tiny muted">host</span>':''}
      ${(isHost && p.isBot) ? `<button data-remove-bot="${p.id}" style="color:var(--dim);font-size:14px;line-height:1;">\u00d7</button>` : ''}
    </div>`).join('');

  root.innerHTML = `
    <div class="home" style="justify-content:flex-start;padding-top:22px;gap:12px;">
      <button class="btn btn-ghost btn-sm" id="leaveBtn" style="position:fixed;top:10px;right:10px;">Leave</button>
      <div class="home-title"><div class="logo">3\u2660</div><h1>${state.roomCode}</h1></div>
      <div class="tiny muted">${state.players.length}/${state.tableSize}${state.decks===2?' \u00b7 2 decks \u00b7 500 pts':''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:640px;">${chips}</div>
      ${(isHost && !full) ? `<button class="btn btn-ghost btn-sm" id="addBotBtn">+ Add Bot</button>` : ''}
      ${isHost
        ? `<button class="btn btn-primary" id="startBtn" ${full?'':'disabled'}>${full?'Deal':'Waiting\u2026'}</button>`
        : `<div class="tiny muted">Waiting for host\u2026</div>`}
    </div>
  `;
  bindLeave();
  const abb = document.getElementById('addBotBtn');
  if(abb) abb.onclick = async ()=>{
    const next = await updateRoom(state.roomCode, s=> addBot(s));
    if(next) applyRoomUpdate(next);
  };
  root.querySelectorAll('[data-remove-bot]').forEach(btn=>{
    btn.onclick = async ()=>{
      const botId = btn.dataset.removeBot;
      const next = await updateRoom(state.roomCode, s=> removeBot(s, botId));
      if(next) applyRoomUpdate(next);
    };
  });
  const sb = document.getElementById('startBtn');
  if(sb) sb.onclick = async ()=>{
    const next = await updateRoom(state.roomCode, s=>{
      if(s.players.length < s.tableSize || s.phase!=='lobby') return false;
      return startRound(s);
    });
    if(next) applyRoomUpdate(next);
  };
}

/* ============================== RENDER: BIDDING ============================== */
function renderBidding(state){
  const b = state.bidding;
  const myTurn = state.players[b.turnSeat].id===local.myId;
  const floor = b.highestBid ? b.highestBid.amount+5 : b.minOpen;
  if(local.bidDraft==null || local.bidDraft<floor) local.bidDraft = floor;

  const sideHtml = `
    <div class="panel">
      <div class="bid-figure">${b.highestBid ? b.highestBid.amount : '\u2014'}</div>
      ${myTurn ? `
        <div class="bid-controls">
          <div class="bid-row">
            <input type="number" id="bidInput" class="bid-input" step="5" min="${floor}" max="${state.maxPoints}" value="${local.bidDraft}">
            <button class="btn btn-ghost btn-sm" data-bump="5">+5</button>
            <button class="btn btn-ghost btn-sm" data-bump="10">+10</button>
          </div>
          <div class="bid-row">
            <button class="btn btn-primary" id="placeBidBtn" style="flex:1;">Bid</button>
            <button class="btn btn-danger" id="passBtn" style="flex:1;">Pass</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  root.innerHTML = shellHtml(state, sideHtml, handDockHtml(state, false));
  bindLeave();

  root.querySelectorAll('[data-bump]').forEach(btn=>{
    btn.onclick = ()=>{
      local.bidDraft = Math.min(state.maxPoints, (local.bidDraft||floor) + parseInt(btn.dataset.bump,10));
      const el = document.getElementById('bidInput');
      if(el) el.value = local.bidDraft;
    };
  });
  const bi = document.getElementById('bidInput');
  if(bi) bi.oninput = ()=>{ local.bidDraft = parseInt(bi.value||floor,10); };
  const pbb = document.getElementById('placeBidBtn');
  if(pbb) pbb.onclick = async ()=>{
    const amt = parseInt((document.getElementById('bidInput')||{}).value || local.bidDraft, 10);
    if(isNaN(amt) || amt % 5 !== 0){ showToast('Multiples of 5 only'); return; }
    if(amt < floor || amt > state.maxPoints){ showToast(`Between ${floor} and ${state.maxPoints}`); return; }
    const next = await updateRoom(state.roomCode, s=> doBid(s, local.myId, amt));
    if(next===false || !next){ showToast('Bid no longer valid'); }
    else { local.bidDraft=null; applyRoomUpdate(next); }
  };
  const passBtn = document.getElementById('passBtn');
  if(passBtn) passBtn.onclick = async ()=>{
    const next = await updateRoom(state.roomCode, s=> doPass(s, local.myId));
    if(next) applyRoomUpdate(next);
  };
}

/* ============================== RENDER: TRUMP + FRIENDS ============================== */
function renderTrump(state){
  const isBidder = state.bidWinnerId===local.myId;
  const need = friendsCount(state.players.length);
  const doubleDeck = state.decks===2;

  let sideHtml = `<div class="panel"><div class="info-row"><span class="info-key">Bid</span><span class="info-val">${state.bidding.highestBid.amount}</span></div></div>`;

  if(isBidder){
    const suitBtns = SUITS.map(s=>`<button class="suit-btn ${local.trumpDraft===s?'active':''}" data-suit="${s}" style="color:${local.trumpDraft===s?'#fff':(RED_SUITS.includes(s)?'var(--red)':'var(--ink)')};">${SUIT_SYMBOL[s]}</button>`).join('');
    if(!local.friendPickSuit) local.friendPickSuit = 'S';
    const suitPick = SUITS.map(s=>`<button class="suit-btn ${local.friendPickSuit===s?'active':''}" data-fsuit="${s}" style="color:${local.friendPickSuit===s?'#fff':(RED_SUITS.includes(s)?'var(--red)':'var(--ink)')};">${SUIT_SYMBOL[s]}</button>`).join('');
    const rankOptions = RANKS.map(r=>`<option value="${r}">${r}</option>`).join('');
    const chips = local.friendDraft.map((f,idx)=>{
      const label = `${f.rank}${SUIT_SYMBOL[f.suit]}${doubleDeck? (f.occurrence===1?' \u00b91':' \u00b92') : ''}`;
      return `<div class="friend-chip">${label}<button data-remove-idx="${idx}">\u00d7</button></div>`;
    }).join('');
    const canAdd = local.friendDraft.length < need;
    const occSeg = doubleDeck ? `
      <div class="occ-seg" id="fOccSeg">
        <button type="button" data-focc="1" class="${local.friendPickOcc===1?'active':''}">1st</button>
        <button type="button" data-focc="2" class="${local.friendPickOcc===2?'active':''}">2nd</button>
      </div>` : '';

    sideHtml += `
      <div class="panel">
        <div class="panel-label">Trump</div>
        <div class="suit-seg">${suitBtns}</div>
      </div>
      <div class="panel">
        <div class="panel-label">Friends ${local.friendDraft.length}/${need}</div>
        <div class="friend-chip-row">${chips}</div>
        ${canAdd ? `
          <div class="friend-add-row">
            <select id="fRank">${rankOptions}</select>
          </div>
          <div class="suit-seg" style="margin-top:5px;" id="fSuitSeg">${suitPick}</div>
          ${occSeg}
          <button class="btn btn-ghost btn-block btn-sm" id="addFriendBtn" style="margin-top:6px;">Add</button>
        ` : ''}
      </div>
      <button class="btn btn-primary btn-block" id="confirmTrumpBtn" ${(local.trumpDraft && local.friendDraft.length===need)?'':'disabled'}>Confirm</button>
    `;
  }

  root.innerHTML = shellHtml(state, sideHtml, handDockHtml(state, false));
  bindLeave();

  if(isBidder){
    root.querySelectorAll('.suit-seg [data-suit]').forEach(btn=>{
      btn.onclick = ()=>{ local.trumpDraft = btn.dataset.suit; render(); };
    });
    const fSuitSeg = document.getElementById('fSuitSeg');
    if(fSuitSeg) fSuitSeg.querySelectorAll('[data-fsuit]').forEach(btn=>{
      btn.onclick = ()=>{ local.friendPickSuit = btn.dataset.fsuit; render(); };
    });
    const fOccSeg = document.getElementById('fOccSeg');
    if(fOccSeg) fOccSeg.querySelectorAll('[data-focc]').forEach(btn=>{
      btn.onclick = ()=>{ local.friendPickOcc = parseInt(btn.dataset.focc,10); render(); };
    });
    const addBtn = document.getElementById('addFriendBtn');
    if(addBtn) addBtn.onclick = ()=>{
      const rankEl = document.getElementById('fRank');
      const rank = rankEl.value;
      const suit = local.friendPickSuit;
      const occurrence = doubleDeck ? local.friendPickOcc : 1;
      const card = rank+suit;
      const countsInPlay = {};
      Object.values(state.dealSnapshot).flat().forEach(c=> countsInPlay[c]=(countsInPlay[c]||0)+1);
      const total = countsInPlay[card]||0;
      if(total===0){ showToast('Not in this deck'); return; }
      if(occurrence>total){ showToast(`Only ${total} in play`); return; }
      const myCount = state.hands[local.myId].filter(c=>c===card).length;
      if(myCount>=total){ showToast('You hold every copy'); return; }
      if(local.friendDraft.some(f=>f.rank===rank && f.suit===suit && f.occurrence===occurrence)){ showToast('Already called'); return; }
      local.friendDraft.push({rank, suit, occurrence});
      render();
    };
    root.querySelectorAll('[data-remove-idx]').forEach(btn=>{
      btn.onclick = ()=>{ local.friendDraft.splice(parseInt(btn.dataset.removeIdx,10),1); render(); };
    });
    const cbtn = document.getElementById('confirmTrumpBtn');
    if(cbtn) cbtn.onclick = async ()=>{
      if(!local.trumpDraft || local.friendDraft.length!==need) return;
      const trumpChoice = local.trumpDraft, friendChoice = local.friendDraft.slice();
      const next = await updateRoom(state.roomCode, s=> doChooseTrumpAndFriends(s, local.myId, trumpChoice, friendChoice));
      if(next===false || !next){ showToast('No longer valid'); }
      else { applyRoomUpdate(next); }
    };
  }
}

/* ============================== RENDER: PLAYING ============================== */
function renderPlaying(state){
  const pl = state.play;
  const myTurn = state.players[pl.turnSeat].id===local.myId;
  const ledSuit = pl.currentTrick.length ? cardSuit(pl.currentTrick[0].card) : null;
  const myHand = sortHand(state.hands[local.myId]||[]);
  const legal = legalMoves(myHand, ledSuit);
  const doubleDeck = state.decks===2;

  const friendChips = state.friendCalls.map(f=>{
    const occTag = doubleDeck ? (f.occurrence===1?' \u00b91':' \u00b92') : '';
    const label = f.revealed ? esc(playerName(state, f.ownerId)) : `${f.rank}${SUIT_SYMBOL[f.suit]}${occTag}`;
    return `<div class="friend-chip ${f.revealed?'revealed':''}">${label}</div>`;
  }).join('');

  const sideHtml = `
    <div class="panel">
      <div class="info-row"><span class="info-key">Bid</span><span class="info-val">${state.bidding.highestBid.amount}</span></div>
      <div class="info-row"><span class="info-key">Trump</span><span class="info-val ${RED_SUITS.includes(state.trumpSuit)?'red':''}">${SUIT_SYMBOL[state.trumpSuit]}</span></div>
    </div>
    <div class="panel">
      <div class="panel-label">Friends</div>
      <div class="friend-chip-row">${friendChips}</div>
    </div>
  `;

  root.innerHTML = shellHtml(state, sideHtml, handDockHtml(state, myTurn, legal));
  bindLeave();

  if(myTurn){
    root.querySelectorAll('[data-action="playCard"]').forEach(el=>{
      el.onclick = async ()=>{
        const c = el.dataset.card;
        const next = await updateRoom(state.roomCode, s=> doPlayCard(s, local.myId, c));
        if(next===false || !next){ showToast('Must follow suit'); }
        else { applyRoomUpdate(next); }
      };
    });
  }
}

/* ============================== RENDER: SCORING ============================== */
function renderScoring(state){
  const rh = state.roundHistory[state.roundHistory.length-1];
  const isHost = state.players[0] && state.players[0].id===local.myId;

  const actionsHtml = isHost
    ? `
      <div class="row" style="gap:8px;">
        <button class="btn btn-primary" id="rematchBtn" style="flex:1;">Rematch</button>
        <button class="btn btn-ghost" id="newGameBtn" style="flex:1;">New Game</button>
      </div>
      <button class="btn btn-danger btn-block" id="exitBtn" style="margin-top:8px;">Exit</button>
    `
    : `
      <button class="btn btn-danger btn-block" id="exitBtn">Exit</button>
      <div class="tiny muted center" style="margin-top:6px;">Waiting for host to continue\u2026</div>
    `;

  const sideHtml = `
    <div class="panel">
      <div class="result-banner ${rh.success?'win':'lose'}">${rh.success?'Bid made':'Bid defended'}</div>
      <div class="info-row"><span class="info-key">${esc(rh.bidWinner)}'s side</span><span class="info-val">${rh.pointsA}</span></div>
      <div class="info-row"><span class="info-key">Defenders</span><span class="info-val">${rh.pointsB}</span></div>
    </div>
    ${actionsHtml}
  `;

  root.innerHTML = shellHtml(state, sideHtml, '');
  bindLeave();

  const rb = document.getElementById('rematchBtn');
  if(rb) rb.onclick = async ()=>{
    const next = await updateRoom(state.roomCode, s=>{
      if(s.phase!=='scoring') return false;
      s.dealerSeat = (s.dealerSeat+1)%s.players.length;
      return startRound(s);
    });
    if(next) applyRoomUpdate(next);
  };
  const ngb = document.getElementById('newGameBtn');
  if(ngb) ngb.onclick = async ()=>{
    const next = await updateRoom(state.roomCode, s=> newGame(s));
    if(next) applyRoomUpdate(next);
  };
  const eb = document.getElementById('exitBtn');
  if(eb) eb.onclick = doExit;
}

/* ============================== STATE APPLY / POLLING ============================== */
function applyRoomUpdate(newState){
  if(!newState) return;
  const prev = local.room;
  const trickJustWon = prev && prev.roomCode===newState.roomCode && prev.phase==='playing' && newState.phase==='playing'
    && prev.play && newState.play && newState.play.tricksCompleted > prev.play.tricksCompleted && newState.play.lastTrick;
  const phaseChanged = !prev || prev.phase!==newState.phase;
  local.room = newState;
  if(phaseChanged){
    local.bidDraft=null; local.trumpDraft=null; local.friendDraft=[]; local.friendPickSuit=null; local.friendPickOcc=1;
  }
  render();
  if(trickJustWon){
    const winnerId = newState.play.lastTrick.winnerId;
    const isMe = winnerId === local.myId;
    showToast(isMe ? `You win the hand \u2014 your move` : `${playerName(newState, winnerId)} wins the hand`, isMe ? 2200 : 1600);
  }
  scheduleBotTurn(newState);
}

/* Any connected client can drive a bot's move -- there's no persistent server
   process to do it, so whichever open tab notices first (after a short,
   randomized "thinking" delay) applies it. updateRoom() re-validates against
   fresh state before acting, so redundant attempts from other tabs are safe
   no-ops. */
let botTimer = null;
function scheduleBotTurn(state){
  clearTimeout(botTimer);
  if(!state || local.view!=='room') return;
  const botId = pendingBotTurnId(state);
  if(!botId) return;
  const roomCode = state.roomCode;
  const delay = 700 + Math.random()*900;
  botTimer = setTimeout(async ()=>{
    if(local.roomCode !== roomCode) return; // left this room since scheduling
    const next = await updateRoom(roomCode, s => runBotTurn(s, botId));
    if(next) applyRoomUpdate(next);
  }, delay);
}
function stopBotTimer(){
  clearTimeout(botTimer);
  botTimer = null;
}

let pollTimer = null;
function startPolling(){
  if(local.polling) return;
  local.polling = true;
  pollTimer = setInterval(async ()=>{
    if(!local.roomCode) return;
    const fresh = await loadRoom(local.roomCode);
    if(fresh && (!local.room || fresh.rev !== local.room.rev)){
      applyRoomUpdate(fresh);
    }
  }, 2500);
}
function stopPolling(){
  local.polling = false;
  if(pollTimer) clearInterval(pollTimer);
  stopBotTimer();
}

const root = document.getElementById('app');
const _render = render;
render = function(){
  _render();
  const existing = document.querySelector('.toast');
  if(existing) existing.remove();
  if(local.toast){
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = local.toast;
    document.body.appendChild(t);
  }
};

render();
})();
