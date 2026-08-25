/* ============================== GAME CONSTANTS ============================== */
const SUITS = ['S','H','D','C'];
const SUIT_SYMBOL = {S:'\u2660', H:'\u2665', D:'\u2666', C:'\u2663'};
const SUIT_NAME = {S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs'};
const RED_SUITS = ['H','D'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_ORDER = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const TWO_REMOVAL_ORDER = ['2C','2D','2H','2S','3C','3D','3H']; // trimmed first, in this order; 3S and all point cards are never touched

function cardRank(card){ return card.slice(0,-1); }
function cardSuit(card){ return card.slice(-1); }
function pointValue(card){
  const rank = cardRank(card), suit = cardSuit(card);
  if(rank==='3' && suit==='S') return 30;
  if(['A','K','Q','J'].includes(rank)) return 10;
  if(rank==='10') return 10;
  if(rank==='5') return 5;
  return 0;
}
function isRed(card){ return RED_SUITS.includes(cardSuit(card)); }

function buildDeck(numPlayers, decks){
  decks = decks || 1;
  let deck = [];
  for(let d=0; d<decks; d++){
    for(const s of SUITS) for(const r of RANKS) deck.push(r+s);
  }
  const per = Math.floor(deck.length/numPlayers);
  const target = per*numPlayers;
  const toRemove = deck.length - target;
  const removalPool = [];
  for(const card of TWO_REMOVAL_ORDER){
    for(let i=0;i<decks;i++) removalPool.push(card);
  }
  const toRemoveCards = removalPool.slice(0, toRemove);
  const deckCopy = deck.slice();
  for(const card of toRemoveCards){
    const idx = deckCopy.indexOf(card);
    if(idx>=0) deckCopy.splice(idx,1);
  }
  return deckCopy;
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function teamSize(numPlayers){
  return numPlayers % 2 === 0 ? numPlayers/2 : (numPlayers-1)/2;
}
function friendsCount(numPlayers){
  return teamSize(numPlayers) - 1;
}
function sortHand(hand){
  const order = {S:0,C:1,H:2,D:3};
  return hand.slice().sort((a,b)=>{
    const sa=cardSuit(a), sb=cardSuit(b);
    if(sa!==sb) return order[sa]-order[sb];
    return RANK_ORDER[cardRank(a)] - RANK_ORDER[cardRank(b)];
  });
}

/* ============================== STORAGE (backend-agnostic; wired to /api/room in app.js) ============================== */
/* loadRoom/saveRoom/updateRoom are defined in app.js so this file stays a pure, host-agnostic game engine. */

/* ============================== ROOM / ROUND LOGIC ============================== */
function freshRoomState(code, tableSize, hostId, hostName, decks){
  decks = decks===2 ? 2 : 1;
  return {
    roomCode: code,
    tableSize,
    decks,
    maxPoints: decks===2 ? 500 : 250,
    phase: 'lobby',
    players: [{id:hostId, name:hostName}],
    dealerSeat: 0,
    round: 0,
    hands: {},
    dealSnapshot: {},
    bidding: null,
    trumpSuit: null,
    bidWinnerId: null,
    friendCalls: [],
    play: null,
    piles: {},
    stats: {},
    roundHistory: [],
    log: [],
    rev: 0,
    updatedAt: Date.now(),
  };
}
function pushLog(state, msg, hi){
  state.log.push({msg, hi:!!hi, t:Date.now()});
  if(state.log.length>60) state.log = state.log.slice(-60);
}
function seatOf(state, playerId){ return state.players.findIndex(p=>p.id===playerId); }
function playerName(state, id){ const p = state.players.find(p=>p.id===id); return p? p.name : '???'; }

function startRound(state){
  const n = state.players.length;
  const deck = shuffle(buildDeck(n, state.decks));
  const per = deck.length/n;
  const hands = {}; const dealOrder = [];
  for(let i=0;i<n;i++){
    const seat = (state.dealerSeat+1+i)%n;
    dealOrder.push(state.players[seat].id);
  }
  dealOrder.forEach((pid, idx)=>{
    hands[pid] = sortHand(deck.slice(idx*per, idx*per+per));
  });
  state.hands = hands;
  state.dealSnapshot = JSON.parse(JSON.stringify(hands));
  state.round += 1;
  state.trumpSuit = null;
  state.bidWinnerId = null;
  state.friendCalls = [];
  state.play = null;
  state.piles = {};
  state.players.forEach(p=>{ state.piles[p.id] = []; if(!state.stats[p.id]) state.stats[p.id]={wins:0,rounds:0}; });
  const firstBidderSeat = (state.dealerSeat+1)%n;
  state.bidding = {
    turnSeat: firstBidderSeat,
    highestBid: null,
    passed: [],
    minOpen: state.decks===2 ? 255 : 130,
    history: [],
  };
  state.phase = 'bidding';
  pushLog(state, `Round ${state.round}: cards dealt \u2014 ${per} each.`, true);
  return state;
}

function nextActiveBidSeat(state, fromSeat){
  const n = state.players.length;
  for(let step=1; step<=n; step++){
    const s = (fromSeat+step)%n;
    const pid = state.players[s].id;
    if(!state.bidding.passed.includes(pid)) return s;
  }
  return fromSeat;
}

function doBid(state, playerId, amount){
  const b = state.bidding;
  if(!b || state.phase!=='bidding') return false;
  if(state.players[b.turnSeat].id !== playerId) return false;
  const floor = b.highestBid ? b.highestBid.amount+5 : b.minOpen;
  if(amount % 5 !== 0 || amount < floor || amount > state.maxPoints) return false;
  b.highestBid = {playerId, amount};
  b.history.push({playerId, amount});
  pushLog(state, `${playerName(state,playerId)} bids ${amount}.`);
  const activeCount = state.players.length - b.passed.length;
  if(activeCount <= 1){
    return endBidding(state);
  }
  b.turnSeat = nextActiveBidSeat(state, b.turnSeat);
  return state;
}

function doPass(state, playerId){
  const b = state.bidding;
  if(!b || state.phase!=='bidding') return false;
  if(state.players[b.turnSeat].id !== playerId) return false;
  if(!b.passed.includes(playerId)) b.passed.push(playerId);
  pushLog(state, `${playerName(state,playerId)} passes.`);
  const active = state.players.filter(p=>!b.passed.includes(p.id));
  if(active.length === 0){
    pushLog(state, `No bids were made \u2014 redealing.`, true);
    return startRound(state);
  }
  if(active.length === 1){
    if(b.highestBid && b.highestBid.playerId === active[0].id){
      return endBidding(state);
    }
    // otherwise exactly one player is left and nobody has bid yet -- give them
    // their turn to open the bidding instead of forcing a redeal.
  }
  b.turnSeat = nextActiveBidSeat(state, b.turnSeat);
  return state;
}

function endBidding(state){
  const b = state.bidding;
  state.bidWinnerId = b.highestBid.playerId;
  pushLog(state, `${playerName(state,state.bidWinnerId)} wins the bid at ${b.highestBid.amount}!`, true);
  state.phase = 'trump';
  return state;
}

/* friendCalls input shape: [{rank, suit, occurrence}], occurrence is 1 or 2 (2 only valid with decks===2) */
function doChooseTrumpAndFriends(state, playerId, trumpSuit, friendCallsInput){
  if(state.phase!=='trump' || state.bidWinnerId!==playerId) return false;
  const need = friendsCount(state.players.length);
  if(!SUITS.includes(trumpSuit)) return false;
  if(!Array.isArray(friendCallsInput) || friendCallsInput.length !== need) return false;

  const countsInPlay = {};
  Object.values(state.dealSnapshot).flat().forEach(c=> countsInPlay[c]=(countsInPlay[c]||0)+1);
  const myHand = state.hands[playerId];
  const seen = new Set();

  for(const f of friendCallsInput){
    if(!RANKS.includes(f.rank) || !SUITS.includes(f.suit)) return false;
    const occ = f.occurrence;
    if(occ!==1 && occ!==2) return false;
    if(state.decks===1 && occ!==1) return false;
    const card = f.rank+f.suit;
    const key = card+'#'+occ;
    if(seen.has(key)) return false;
    seen.add(key);
    const total = countsInPlay[card]||0;
    if(total===0) return false;              // not in this deck at all
    if(occ>total) return false;               // can't call a copy that doesn't exist
    const myCount = myHand.filter(c=>c===card).length;
    if(myCount>=total) return false;          // bidder holds every remaining copy -- guaranteed self
  }

  state.trumpSuit = trumpSuit;
  state.friendCalls = friendCallsInput.map(f=>({
    rank: f.rank, suit: f.suit, occurrence: f.occurrence,
    ownerId: null,
    revealed: false,
  }));
  const leaderSeat = seatOf(state, playerId);
  state.play = { leaderSeat, turnSeat: leaderSeat, currentTrick: [], tricksCompleted: 0, playCounts: {} };
  state.phase = 'playing';
  pushLog(state, `Trump is ${SUIT_SYMBOL[trumpSuit]} ${SUIT_NAME[trumpSuit]}. Friends called (holders hidden until played).`, true);
  return state;
}

function legalMoves(hand, ledSuit){
  if(!ledSuit) return hand.slice();
  const follow = hand.filter(c=>cardSuit(c)===ledSuit);
  return follow.length ? follow : hand.slice();
}

/* Ties (possible only with 2 decks, when the same card is thrown twice in one trick)
   are broken in favor of whichever copy was thrown LATER. */
function resolveTrick(plays, ledSuit, trumpSuit){
  const trumpPlays = plays.filter(p=>cardSuit(p.card)===trumpSuit);
  const pool = trumpPlays.length ? trumpPlays : plays.filter(p=>cardSuit(p.card)===ledSuit);
  let winner = pool[0];
  for(const p of pool){
    if(RANK_ORDER[cardRank(p.card)] >= RANK_ORDER[cardRank(winner.card)]) winner = p;
  }
  return winner.playerId;
}

function doPlayCard(state, playerId, card){
  const pl = state.play;
  if(!pl || state.phase!=='playing') return false;
  if(state.players[pl.turnSeat].id !== playerId) return false;
  const hand = state.hands[playerId];
  if(!hand.includes(card)) return false;
  const ledSuit = pl.currentTrick.length ? cardSuit(pl.currentTrick[0].card) : null;
  const legal = legalMoves(hand, ledSuit);
  if(!legal.includes(card)) return false;

  state.hands[playerId] = hand.filter((c,i)=> i!==hand.indexOf(card));
  pl.currentTrick.push({playerId, card});

  pl.playCounts = pl.playCounts || {};
  pl.playCounts[card] = (pl.playCounts[card]||0) + 1;
  const occ = pl.playCounts[card];
  const fc = state.friendCalls.find(f=>!f.revealed && f.rank===cardRank(card) && f.suit===cardSuit(card) && f.occurrence===occ);
  if(fc){
    fc.revealed = true;
    fc.ownerId = playerId;
    pushLog(state, `\uD83C\uDF89 ${playerName(state,playerId)} is revealed as ${playerName(state,state.bidWinnerId)}'s friend!`, true);
  }

  const n = state.players.length;
  if(pl.currentTrick.length === n){
    const led = cardSuit(pl.currentTrick[0].card);
    const winnerId = resolveTrick(pl.currentTrick, led, state.trumpSuit);
    state.piles[winnerId] = state.piles[winnerId].concat(pl.currentTrick.map(p=>p.card));
    pushLog(state, `${playerName(state,winnerId)} wins the trick (${pl.currentTrick.map(p=>p.card).join(', ')}).`);
    pl.lastTrick = { cards: pl.currentTrick.slice(), winnerId };
    pl.tricksCompleted += 1;
    pl.currentTrick = [];
    const winnerSeat = seatOf(state, winnerId);
    pl.leaderSeat = winnerSeat;
    pl.turnSeat = winnerSeat;

    const cardsPerPlayer = Object.values(state.dealSnapshot)[0].length;
    if(pl.tricksCompleted === cardsPerPlayer){
      return endRound(state);
    }
  } else {
    pl.turnSeat = (pl.turnSeat+1)%n;
  }
  return state;
}

function endRound(state){
  const friendOwners = Array.from(new Set(state.friendCalls.map(f=>f.ownerId).filter(Boolean)));
  const teamA = Array.from(new Set([state.bidWinnerId, ...friendOwners]));
  const teamB = state.players.map(p=>p.id).filter(id=>!teamA.includes(id));
  const sumPts = (ids)=> ids.reduce((s,id)=> s + (state.piles[id]||[]).reduce((s2,c)=>s2+pointValue(c),0), 0);
  const pointsA = sumPts(teamA);
  const pointsB = sumPts(teamB);
  const bidAmount = state.bidding.highestBid.amount;
  const success = pointsA >= bidAmount;
  const winners = success ? teamA : teamB;
  winners.forEach(id=>{ if(!state.stats[id]) state.stats[id]={wins:0,rounds:0}; state.stats[id].wins++; });
  state.players.forEach(p=>{ if(!state.stats[p.id]) state.stats[p.id]={wins:0,rounds:0}; state.stats[p.id].rounds++; });
  state.roundHistory.push({
    round: state.round,
    bidWinner: playerName(state, state.bidWinnerId),
    bidAmount,
    maxPoints: state.maxPoints,
    trumpSuit: state.trumpSuit,
    teamA: teamA.map(id=>playerName(state,id)),
    teamB: teamB.map(id=>playerName(state,id)),
    pointsA, pointsB, success,
  });
  state.phase = 'scoring';
  pushLog(state, success
    ? `${playerName(state,state.bidWinnerId)}'s side made the bid: ${pointsA} vs ${bidAmount} needed.`
    : `${playerName(state,state.bidWinnerId)}'s side fell short: ${pointsA} vs ${bidAmount} needed. Defenders win the round!`,
    true);
  return state;
}
