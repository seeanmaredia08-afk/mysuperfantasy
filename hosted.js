/* =============================================================================
   League Room — leagues hosted on the site, and the league creation wizard.

   Loaded after the main script in index.html and shares its globals (session,
   rpc, sleeperCache, liveCache, render, the matchup cards and live refresh loop).

   How hosted scoring works
   ------------------------
   Scores are never stored. The database keeps an append-only history of every
   lineup a team has set, stamped with the database clock. Every browser replays
   that history against each NFL game's kickoff time and prices the week's public
   stats with the league's scoring rules, so everyone arrives at identical,
   tamper-proof results:

     * a player counts for the team that had him in its lineup at his kickoff;
     * once his game starts he can't be moved out, and a player whose game has
       started can't be moved in.
   ============================================================================= */

/* ============================ RULE PRESETS ============================ */

// Copied from a real Sleeper PPR league so stat keys match Sleeper's feed exactly.
const HOSTED_SCORING_BASE = {
  pass_yd:0.04, pass_td:4, pass_2pt:2, pass_int:-1,
  rush_yd:0.1, rush_td:6, rush_2pt:2,
  rec:1, rec_yd:0.1, rec_td:6, rec_2pt:2,
  fum:0, fum_lost:-2, fum_rec_td:6,
  fgm_0_19:3, fgm_20_29:3, fgm_30_39:3, fgm_40_49:4, fgm_50_59:5, fgm_60p:6,
  fgmiss:0, fgmiss_0_19:-1, fgmiss_20_29:-1, fgmiss_30_39:-1, xpm:1, xpmiss:-1,
  def_td:6, def_st_td:6, st_td:6, sack:1, int:2, ff:1, fum_rec:2, safe:2, blk_kick:2,
  def_st_ff:1, def_st_fum_rec:1, st_ff:1, st_fum_rec:1,
  pts_allow_0:10, pts_allow_1_6:7, pts_allow_7_13:4, pts_allow_14_20:1,
  pts_allow_21_27:0, pts_allow_28_34:-1, pts_allow_35p:-4
};
const SCORING_PRESETS = {
  ppr:  { label:'PPR',       note:'1 point per catch',     scoring:{ ...HOSTED_SCORING_BASE, rec:1 } },
  half: { label:'Half PPR',  note:'0.5 points per catch',  scoring:{ ...HOSTED_SCORING_BASE, rec:0.5 } },
  std:  { label:'Standard',  note:'No points for catches', scoring:{ ...HOSTED_SCORING_BASE, rec:0 } }
};

const BENCH6 = ['BN','BN','BN','BN','BN','BN'];
const ROSTER_PRESETS = {
  standard:  { label:'Standard',  slots:['QB','RB','RB','WR','WR','TE','FLEX','K','DEF', ...BENCH6] },
  two_flex:  { label:'Two Flex',  slots:['QB','RB','RB','WR','WR','TE','FLEX','FLEX','K','DEF', ...BENCH6] },
  superflex: { label:'Superflex', slots:['QB','RB','RB','WR','WR','TE','FLEX','SUPER_FLEX','K','DEF', ...BENCH6] },
  no_kicker: { label:'No Kicker or Defense', slots:['QB','RB','RB','WR','WR','TE','FLEX','FLEX', ...BENCH6] }
};

const SLOT_LABEL = { FLEX:'FLEX', SUPER_FLEX:'SFLX', WRRB_FLEX:'W/R', REC_FLEX:'W/T', BN:'BN' };
const SLOT_HINT  = { FLEX:'RB, WR or TE', SUPER_FLEX:'QB, RB, WR or TE', WRRB_FLEX:'RB or WR', REC_FLEX:'WR or TE' };

// Mirrors _slot_eligible() in the database.
function slotEligible(slot, pos){
  if(slot === 'BN') return true;
  if(!pos) return false;
  if(slot === 'FLEX') return pos==='RB' || pos==='WR' || pos==='TE';
  if(slot === 'SUPER_FLEX') return pos==='QB' || pos==='RB' || pos==='WR' || pos==='TE';
  if(slot === 'WRRB_FLEX') return pos==='RB' || pos==='WR';
  if(slot === 'REC_FLEX') return pos==='WR' || pos==='TE';
  return slot === pos;
}

function describeRoster(slots){
  const counts = {};
  slots.forEach(s=>{ counts[s] = (counts[s]||0) + 1; });
  const order = ['QB','RB','WR','TE','FLEX','SUPER_FLEX','WRRB_FLEX','REC_FLEX','K','DEF','BN'];
  return order.filter(s=>counts[s]).map(s=>`${counts[s]} ${SLOT_LABEL[s]||s}`).join(' · ');
}

/* ============================ SMALL HELPERS ============================ */

function isDefId(pid){ return /^[A-Z]{2,4}$/.test(pid || ''); }
function playerRecord(pid){ return (sleeperCache.players && sleeperCache.players[pid]) || null; }
function positionOf(pid){
  const p = playerRecord(pid);
  return (p && p.position) || (isDefId(pid) ? 'DEF' : '');
}
function nflTeamOf(pid){
  const p = playerRecord(pid);
  return (p && p.team) || (isDefId(pid) ? pid : null);
}
function playerNameOf(pid){ return playerDisplayName(playerRecord(pid), pid); }

function hPlayerChip(pid, extra){
  const p = playerRecord(pid) || {};
  const pos = positionOf(pid);
  return `<span class="hp-chip">
    <span class="rp-pos hp-pos-${escapeHtml(pos||'X')}">${escapeHtml(pos||'?')}</span>
    <span class="hp-name">${escapeHtml(playerNameOf(pid))}</span>
    <span class="hp-nfl">${escapeHtml(nflTeamOf(pid)||'FA')}</span>
    ${injuryTag(p.injury_status)}${extra||''}
  </span>`;
}

function round2(n){ return Math.round((n||0)*100)/100; }
function sum(arr){ return arr.reduce((s,x)=>s+(x||0), 0); }

function hashString(s){
  let h = 5381;
  for(let i=0;i<s.length;i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function kickoffText(ms){
  return new Date(ms).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' });
}
function countdownText(ms){
  if(ms <= 0) return '0:00';
  const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function timeUntilText(iso){
  const ms = Date.parse(iso) - Date.now();
  if(ms <= 0) return 'clearing now';
  const h = Math.floor(ms/3600000), m = Math.round((ms%3600000)/60000);
  return h >= 24 ? `clears in ${Math.round(h/24)}d` : h ? `clears in ${h}h ${m}m` : `clears in ${m}m`;
}

/* A message that survives the page re-render that follows an action. */
let hostedFlash = null;
function flashHtml(){
  if(!hostedFlash) return '';
  const html = `<div class="alert ${hostedFlash.kind}">${escapeHtml(hostedFlash.text)}</div>`;
  hostedFlash = null;
  return html;
}

/* Re-renders the current page after a change, keeping the scroll position. */
async function hostedRefresh(message){
  if(message) hostedFlash = { kind:'success', text: message };
  const y = window.scrollY;
  await render();
  window.scrollTo(0, y);
}

/* Runs a database action from a button: disables it, reports errors inline. */
async function hostedAction(btn, alertEl, fn, successMessage){
  if(btn){ btn.disabled = true; }
  try{
    await fn();
    await hostedRefresh(successMessage);
  }catch(err){
    if(alertEl) alertEl.innerHTML = `<div class="alert error">${escapeHtml(err.message)}</div>`;
    else alert(err.message);
    if(btn){ btn.disabled = false; }
  }
}

/* ============================ CREATE A LEAGUE (wizard) ============================ */

function currentSeasonInfo(nfl){
  if(!nfl) return { season: String(new Date().getFullYear()), week: 1, inSeason:false };
  const inSeason = nfl.season_type === 'regular';
  return {
    season: String((inSeason ? nfl.season : (nfl.league_season || nfl.season)) || new Date().getFullYear()),
    week: inSeason ? Math.max(1, Number(nfl.week) || 1) : 1,
    inSeason
  };
}

async function defaultStartWeek(nfl){
  const info = currentSeasonInfo(nfl);
  if(!info.inSeason) return 1;
  // If this week's games have already begun, the first full week is next week.
  try{
    const k = await ensureKickoffs(info.season, info.week);
    return Math.min(18, Date.now() >= k.first ? info.week + 1 : info.week);
  }catch(e){
    return Math.min(18, info.week + 1);
  }
}

async function renderCreate(app){
  const wiz = { step:'format', format:null, hosting:null };
  let nfl = null;
  try{ nfl = await ensureNflState(); }catch(e){ /* defaults still work */ }
  const seasonInfo = currentSeasonInfo(nfl);
  const startDefault = await defaultStartWeek(nfl);

  function choiceCard(attrs, kicker, title, body){
    return `<button type="button" class="choice-card" ${attrs}>
      <div class="choice-kicker">${kicker}</div>
      <div class="choice-title">${title}</div>
      <div class="choice-body">${body}</div>
    </button>`;
  }

  function paintFormat(){
    app.innerHTML = topbarHtml('#/') + `
      <div class="hero" style="margin:20px 0 20px;">
        <div class="wizard-steps"><span class="on">1. League type</span><span>2. Hosting</span><span>3. Details</span></div>
        <h1 style="font-size:28px;">Create a League</h1>
        <p>What kind of league are you running?</p>
      </div>
      <div class="choice-grid">
        ${choiceCard('data-format="super"', '2–16 divisions', 'Super League',
          'Several divisions under one roof, with combined standings and one playoff bracket across all of them.')}
        ${choiceCard('data-format="single"', 'One division', 'Single League',
          'A classic fantasy league run entirely on this site — draft, lineups, waivers, trades and live scoring.')}
      </div>`;
    app.querySelectorAll('[data-format]').forEach(b=> b.addEventListener('click', ()=>{
      wiz.format = b.dataset.format;
      if(wiz.format === 'single'){ wiz.hosting = 'hosted'; wiz.step = 'details'; }
      else { wiz.step = 'hosting'; }
      paint();
    }));
  }

  function paintHosting(){
    app.innerHTML = topbarHtml('#/') + `
      <div class="hero" style="margin:20px 0 20px;">
        <div class="wizard-steps"><span class="done">1. Super League</span><span class="on">2. Hosting</span><span>3. Details</span></div>
        <h1 style="font-size:28px;">Where Do the Divisions Play?</h1>
        <p>Run everything here, or tie together leagues that already exist in other fantasy apps.</p>
      </div>
      <div class="choice-grid">
        ${choiceCard('data-hosting="hosted"', 'Hosted on League Room', 'Host It Here',
          'Each division drafts, sets lineups, makes trades and runs waivers on this site. You can invite a separate commissioner for each division.')}
        ${choiceCard('data-hosting="external"', 'Sleeper · ESPN · Yahoo · NFL.com', 'Connect Existing Leagues',
          'Every division already lives in a fantasy app. Enter each league ID and this site combines them into one super league.')}
      </div>
      <button type="button" class="ghost-btn" id="wizBack" style="margin-top:14px;">&larr; Back</button>`;
    app.querySelectorAll('[data-hosting]').forEach(b=> b.addEventListener('click', ()=>{
      wiz.hosting = b.dataset.hosting; wiz.step = 'details'; paint();
    }));
    document.getElementById('wizBack').addEventListener('click', ()=>{ wiz.step = 'format'; paint(); });
  }

  function paintDetails(){
    const single = wiz.format === 'single';
    const hosted = wiz.hosting === 'hosted';
    const stepLabel = single ? 'Single League' : `Super League · ${hosted ? 'Hosted here' : 'Connected apps'}`;
    const playoffWeeksDefault = single ? 3 : 3;
    const weeksDefault = Math.max(1, Math.min(14, 18 - startDefault + 1 - playoffWeeksDefault));

    const sportHtml = `<div class="form-group">
      <label class="form-label">Sport</label>
      <div class="sport-picker" id="sportPicker">
        ${SPORTS.map((s,i)=>{
          const disabled = hosted && !s.live;
          return `<button type="button" class="sport-opt ${i===0?'active':''}" data-sport="${s.id}" ${disabled?'disabled title="Hosted leagues are football-only for now"':''}>
            <span class="sport-name">${escapeHtml(s.label)}</span>
            <span class="sport-sub">${escapeHtml(s.sub)}</span>
            ${s.live?'<span class="sport-live">Live sync</span>':''}
          </button>`;
        }).join('')}
      </div>
      <div class="form-hint" id="sportHint"></div>
    </div>`;

    const accountHtml = session
      ? `<div class="alert info">Creating as <b>${escapeHtml(session.email)}</b>. You'll be the commissioner. <button type="button" class="linklike" onclick="logOut()">Not you?</button></div>`
      : `<div class="section-label">Your Commissioner Account</div>
        <div class="form-hint" style="margin:-4px 0 10px;">Already have an account? Use the same email and password and we'll log you in.</div>
        <div class="form-row2">
          <div class="form-group"><label class="form-label">Display Name</label><input class="form-input" id="f_display" maxlength="30" placeholder="What leaguemates will see" autocomplete="nickname"></div>
          <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="f_email" type="email" placeholder="you@example.com" autocomplete="email"></div>
        </div>
        <div class="form-group"><label class="form-label">Password</label><input class="form-input" id="f_password" type="password" placeholder="At least 6 characters" autocomplete="new-password"></div>`;

    const optionList = (pairs, selected) => pairs.map(([v,l])=>`<option value="${v}" ${String(v)===String(selected)?'selected':''}>${escapeHtml(l)}</option>`).join('');

    const rulesHtml = hosted ? `
      <div class="section-label">League Rules</div>
      <div class="form-row2">
        <div class="form-group"><label class="form-label">Teams ${single?'in the League':'per Division'}</label>
          <select class="form-select" id="f_teams">${optionList([4,6,8,10,12,14,16,18,20].map(n=>[n, n+' teams']), 10)}</select></div>
        <div class="form-group"><label class="form-label">Scoring</label>
          <select class="form-select" id="f_scoring">${optionList(Object.entries(SCORING_PRESETS).map(([k,v])=>[k, `${v.label} — ${v.note}`]), 'ppr')}</select></div>
      </div>
      <div class="form-group"><label class="form-label">Roster</label>
        <select class="form-select" id="f_roster">${optionList(Object.entries(ROSTER_PRESETS).map(([k,v])=>[k, v.label]), 'standard')}</select>
        <div class="form-hint" id="rosterHint"></div></div>
      <div class="form-row2">
        <div class="form-group"><label class="form-label">First Week of the Season</label>
          <select class="form-select" id="f_start">${optionList(Array.from({length:18},(_,i)=>[i+1, `NFL Week ${i+1}`]), startDefault)}</select>
          <div class="form-hint">${seasonInfo.season} season${seasonInfo.inSeason ? ` · it's currently week ${seasonInfo.week}` : ''}</div></div>
        <div class="form-group"><label class="form-label">Regular Season Length</label>
          <select class="form-select" id="f_weeks">${optionList(Array.from({length:18},(_,i)=>[i+1, `${i+1} week${i?'s':''}`]), weeksDefault)}</select>
          <div class="form-hint" id="weeksHint"></div></div>
      </div>
      <div class="form-row2">
        <div class="form-group"><label class="form-label">Waiver Period After a Drop</label>
          <select class="form-select" id="f_waivers">${optionList([[0,'No waivers — instant pickups'],[24,'24 hours'],[48,'48 hours'],[72,'72 hours']], 48)}</select></div>
        <div class="form-group"><label class="form-label">Draft</label>
          <div class="form-row2 tight">
            <select class="form-select" id="f_draft_type">${optionList([['snake','Snake'],['linear','Linear']], 'snake')}</select>
            <select class="form-select" id="f_pick">${optionList([[30,'30s per pick'],[60,'60s per pick'],[90,'90s per pick'],[120,'2 min per pick'],[300,'5 min per pick'],[28800,'8 hours per pick'],[86400,'24 hours per pick']], 90)}</select>
          </div></div>
      </div>` : '';

    const playoffHtml = `
      <div class="form-row2">
        <div class="form-group"><label class="form-label">Playoff Length (weeks)</label>
          <input class="form-input" id="f_playoffweeks" type="number" min="1" max="6" value="${playoffWeeksDefault}"></div>
        <div class="form-group"><label class="form-label">Teams Making the Playoffs</label>
          <input class="form-input" id="f_advance" type="number" min="2" max="64" value="${single ? 4 : 8}">
          <div class="form-hint">${single ? 'Top teams by record.' : 'Across the whole super league — each division winner is guaranteed a spot.'}</div></div>
      </div>`;

    const structureHtml = single ? `
      <div class="section-label">Playoffs</div>
      ${playoffHtml}
      <label class="form-label check-row"><input type="checkbox" id="f_claim" checked> I'm also managing a team in this league</label>
    ` : `
      <div class="section-label">Divisions &amp; Playoffs</div>
      <div class="form-group"><label class="form-label">Number of Divisions (2–16)</label>
        <input class="form-input" id="f_numdiv" type="number" min="2" max="16" value="2"></div>
      ${playoffHtml}
      ${hosted ? `
        <label class="form-label check-row"><input type="checkbox" id="f_invite_commish"> Invite a separate commissioner for each division</label>
        <div class="form-hint" style="margin:-8px 0 12px 26px;">You'll get a one-time invite link per division after creating the league. You stay in charge of the whole league either way.</div>
        <label class="form-label check-row"><input type="checkbox" id="f_claim"> I'm managing a team in the first division</label>
      ` : ''}
      <div id="divisionFields"></div>
    `;

    app.innerHTML = topbarHtml('#/') + `
      <div class="hero" style="margin:20px 0 14px;">
        <div class="wizard-steps"><span class="done">1. ${escapeHtml(single ? 'Single League' : 'Super League')}</span>${single ? '' : `<span class="done">2. ${hosted?'Hosted here':'Connected apps'}</span>`}<span class="on">${single?'2':'3'}. Details</span></div>
        <h1 style="font-size:28px;">${single ? 'Set Up Your League' : 'Set Up Your Super League'}</h1>
        <p>${escapeHtml(stepLabel)} · <button type="button" class="linklike" id="wizRestart">change</button></p>
      </div>
      <div id="createAlert"></div>
      <form id="createForm" novalidate>
        <div class="section-label" style="margin-top:6px;">League</div>
        <div class="form-group"><label class="form-label">League Name</label>
          <input class="form-input" id="f_name" maxlength="60" placeholder="e.g. The Maredia Super League"></div>
        ${sportHtml}
        <label class="form-label check-row"><input type="checkbox" id="f_public"> Make this league publicly searchable</label>
        <div class="form-hint" style="margin:-8px 0 12px 26px;">${hosted ? 'Public leagues can be viewed by anyone, and anyone logged in can claim an open team. Private leagues need your invite link.' : 'Off by default — private leagues only appear via your invite link.'}</div>
        ${structureHtml}
        ${rulesHtml}
        ${accountHtml}
        <button type="submit" class="primary-btn" id="submitBtn" style="margin-top:14px;">Create League</button>
      </form>`;

    document.getElementById('wizRestart').addEventListener('click', ()=>{ wiz.step='format'; wiz.format=null; wiz.hosting=null; paint(); });

    // Sport
    let chosenSport = 'nfl';
    const sportHint = document.getElementById('sportHint');
    function paintSportHint(){
      const s = sportById(chosenSport);
      sportHint.textContent = hosted
        ? 'Hosted leagues are football-only for now, because live scoring comes from NFL stats.'
        : s.live ? 'Live scoring, projections and injury data sync automatically for this sport.'
                 : `${s.label} leagues are saved and organised here, but live sync isn't available for ${s.sub} yet.`;
    }
    app.querySelectorAll('.sport-opt').forEach(btn=> btn.addEventListener('click', ()=>{
      if(btn.disabled) return;
      app.querySelectorAll('.sport-opt').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); chosenSport = btn.dataset.sport; paintSportHint();
    }));
    paintSportHint();

    // Rules hints
    if(hosted){
      const rosterSel = document.getElementById('f_roster');
      const rosterHint = document.getElementById('rosterHint');
      const paintRoster = ()=>{
        const slots = ROSTER_PRESETS[rosterSel.value].slots;
        rosterHint.textContent = `${describeRoster(slots)} — ${slots.length} players, so a ${slots.length}-round draft.`;
      };
      rosterSel.addEventListener('change', paintRoster); paintRoster();

      const startSel = document.getElementById('f_start'), weeksSel = document.getElementById('f_weeks');
      const playoffInput = document.getElementById('f_playoffweeks'), weeksHint = document.getElementById('weeksHint');
      const paintWeeks = ()=>{
        const start = +startSel.value, weeks = +weeksSel.value, po = Math.max(1, +playoffInput.value || 1);
        const end = start + weeks - 1;
        if(end > 18){ weeksHint.innerHTML = `<span class="warn-text">Ends after week 18 — shorten the season or start earlier.</span>`; return; }
        const poEnd = end + po;
        weeksHint.innerHTML = poEnd > 18
          ? `Weeks ${start}–${end}. <span class="warn-text">Playoffs would run past week 18.</span>`
          : `Weeks ${start}–${end}, playoffs weeks ${end+1}–${poEnd}.`;
      };
      [startSel, weeksSel, playoffInput].forEach(el=> el.addEventListener('input', paintWeeks));
      [startSel, weeksSel].forEach(el=> el.addEventListener('change', paintWeeks));
      paintWeeks();
    }

    // Divisions
    const fieldsEl = document.getElementById('divisionFields');
    const numDivInput = document.getElementById('f_numdiv');
    function renderDivisionFields(){
      if(!fieldsEl) return;
      let n = parseInt(numDivInput.value, 10) || 2;
      n = Math.max(2, Math.min(16, n));
      numDivInput.value = n;
      const existing = [...fieldsEl.querySelectorAll('.division-fields')].map(card=>({
        name: card.querySelector('.dv-name').value,
        platform: card.querySelector('.dv-platform') ? card.querySelector('.dv-platform').value : null,
        id: card.querySelector('.dv-extid') ? card.querySelector('.dv-extid').value : ''
      }));
      let html = '';
      for(let i=0;i<n;i++){
        const prev = existing[i] || {};
        if(hosted){
          html += `<div class="division-fields compact" data-idx="${i}">
            <div class="form-group" style="margin:0;"><label class="form-label">Division ${i+1} Name</label>
            <input class="form-input dv-name" maxlength="60" placeholder="e.g. ${['North','South','East','West'][i%4]} Division" value="${escapeHtml(prev.name||'')}"></div>
          </div>`;
        }else{
          html += `<div class="division-fields" data-idx="${i}">
            <div class="division-fields-head">Division ${i+1}</div>
            <div class="form-row2">
              <div class="form-group"><label class="form-label">Division Name</label><input class="form-input dv-name" maxlength="60" placeholder="e.g. North Division" value="${escapeHtml(prev.name||'')}"></div>
              <div class="form-group"><label class="form-label">Platform</label>
                <select class="form-select dv-platform">
                  ${[['sleeper','Sleeper (live sync)'],['espn','ESPN Fantasy'],['yahoo','Yahoo Fantasy'],['nfl','NFL.com Fantasy'],['manual','Manual entry']]
                    .map(([v,l])=>`<option value="${v}" ${prev.platform===v?'selected':''}>${l}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group dv-idfield"><label class="form-label">League ID</label><input class="form-input dv-extid" placeholder="Sleeper League ID" value="${escapeHtml(prev.id||'')}"></div>
            <div class="form-group dv-espnfields" style="display:none;">
              <label class="form-label">ESPN Cookies (private leagues only)</label>
              <div class="form-row2">
                <input class="form-input dv-espn-s2" placeholder="espn_s2 value">
                <input class="form-input dv-swid" placeholder="SWID value">
              </div>
              <div class="form-hint">Only needed for private ESPN leagues. Stored securely — never shown to other visitors.</div>
            </div>
          </div>`;
        }
      }
      fieldsEl.innerHTML = html;
      if(!hosted){
        fieldsEl.querySelectorAll('.division-fields').forEach(card=>{
          const platformSel = card.querySelector('.dv-platform');
          const idField = card.querySelector('.dv-idfield');
          const espnFields = card.querySelector('.dv-espnfields');
          const idInput = card.querySelector('.dv-extid');
          const update = ()=>{
            const p = platformSel.value;
            idField.style.display = p==='manual' ? 'none' : '';
            espnFields.style.display = p==='espn' ? '' : 'none';
            idInput.placeholder = p==='sleeper' ? 'Sleeper League ID' : p==='espn' ? 'ESPN League ID' : p==='yahoo' ? 'Yahoo League ID (manual sync for now)' : 'NFL.com League ID (manual sync for now)';
          };
          platformSel.addEventListener('change', update); update();
        });
      }
    }
    if(numDivInput){ numDivInput.addEventListener('change', renderDivisionFields); renderDivisionFields(); }

    document.getElementById('createForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const alertEl = document.getElementById('createAlert');
      const submitBtn = document.getElementById('submitBtn');
      const fail = msg => { alertEl.innerHTML = `<div class="alert error">${escapeHtml(msg)}</div>`; alertEl.scrollIntoView({block:'nearest'}); };
      alertEl.innerHTML = '';

      const name = document.getElementById('f_name').value.trim();
      if(name.length < 2) return fail('Give your league a name of at least 2 characters.');
      if(slugify(name).length < 2) return fail('Use a league name with at least a couple of letters or numbers.');

      const playoffWeeks = parseInt(document.getElementById('f_playoffweeks').value, 10);
      const advance = parseInt(document.getElementById('f_advance').value, 10);
      if(!(playoffWeeks >= 1 && playoffWeeks <= 6)) return fail('Playoffs must last between 1 and 6 weeks.');
      if(!(advance >= 2 && advance <= 64)) return fail('Between 2 and 64 teams can make the playoffs.');

      const payload = {
        name, sport: chosenSport, is_public: document.getElementById('f_public').checked,
        format: wiz.format, hosting: hosted ? 'hosted' : 'external',
        playoff_length_weeks: playoffWeeks, playoff_advance_count: advance,
        claim_team: !!(document.getElementById('f_claim') && document.getElementById('f_claim').checked),
        invite_commissioners: !!(document.getElementById('f_invite_commish') && document.getElementById('f_invite_commish').checked)
      };

      if(single){
        payload.divisions = [{ name }];
      }else{
        const cards = [...fieldsEl.querySelectorAll('.division-fields')];
        payload.divisions = cards.map((card,i)=>{
          const d = { name: card.querySelector('.dv-name').value.trim() || `Division ${i+1}` };
          if(!hosted){
            d.platform = card.querySelector('.dv-platform').value;
            d.external_league_id = card.querySelector('.dv-extid').value.trim();
            d.espn_s2 = card.querySelector('.dv-espn-s2').value.trim();
            d.swid = card.querySelector('.dv-swid').value.trim();
          }
          return d;
        });
        if(!hosted){
          const missing = payload.divisions.findIndex(d=> d.platform==='sleeper' && !d.external_league_id);
          if(missing >= 0) return fail(`Division ${missing+1} needs its Sleeper league ID.`);
        }
      }

      if(hosted){
        const teams = parseInt(document.getElementById('f_teams').value, 10);
        const start = parseInt(document.getElementById('f_start').value, 10);
        const weeks = parseInt(document.getElementById('f_weeks').value, 10);
        if(start + weeks - 1 > 18) return fail('The regular season has to end by NFL week 18.');
        if(single && advance > teams) return fail(`Only ${teams} teams are in the league, so at most ${teams} can make the playoffs.`);
        if(!single && advance > teams * payload.divisions.length) return fail('More teams are set to make the playoffs than there are in the league.');
        const presetKey = document.getElementById('f_scoring').value;
        payload.hosted = {
          season: seasonInfo.season,
          team_count: teams,
          roster_slots: ROSTER_PRESETS[document.getElementById('f_roster').value].slots,
          scoring_preset: presetKey,
          scoring: SCORING_PRESETS[presetKey].scoring,
          start_week: start,
          regular_season_weeks: weeks,
          waiver_hours: parseInt(document.getElementById('f_waivers').value, 10),
          draft_type: document.getElementById('f_draft_type').value,
          pick_seconds: parseInt(document.getElementById('f_pick').value, 10)
        };
      }

      let account = null;
      if(!session){
        account = {
          displayName: document.getElementById('f_display').value.trim(),
          email: document.getElementById('f_email').value.trim(),
          password: document.getElementById('f_password').value
        };
        if(account.displayName.length < 2) return fail('Pick a display name of at least 2 characters.');
        if(!account.email.includes('@')) return fail('Enter a valid email address.');
        if(account.password.length < 6) return fail('Your password needs at least 6 characters.');
      }

      submitBtn.disabled = true; submitBtn.textContent = 'Creating…';
      try{
        if(account) await signUpOrLogIn(account.email, account.password, account.displayName);
        const res = await rpc('create_league', { p: payload });
        if(single) location.hash = `#/league/${res.slug}`;
        else location.hash = `#/league/${res.slug}/manage`;
      }catch(err){
        fail(err.message);
        submitBtn.disabled = false; submitBtn.textContent = 'Create League';
      }
    });
  }

  function paint(){
    if(wiz.step === 'format') paintFormat();
    else if(wiz.step === 'hosting') paintHosting();
    else paintDetails();
    window.scrollTo(0, 0);
  }
  paint();
}

/* ============================ NFL WEEK DATA ============================ */

const hostedCache = { kickoffs:{}, points:{}, pointsPromise:{}, seasonProj:{}, seasonProjPromise:{} };

/* Kickoff time for every team playing in a week, plus whether the week is over. */
async function ensureKickoffs(season, week, force){
  const key = season + '-' + week;
  const cached = hostedCache.kickoffs[key];
  if(cached && (cached.final || (!force && Date.now() - cached.at < 60000))) return cached;
  const games = await sleeperData(`/scores/nfl/regular/${season}/${week}`);
  const byTeam = {}, times = new Set();
  let first = Infinity, last = -Infinity, final = (games||[]).length > 0;
  (games||[]).forEach(g=>{
    const m = g.metadata || {};
    const t = Number(g.start_time) || Date.parse(m.date_time) || null;
    if(!t) return;
    if(m.home_team) byTeam[m.home_team] = t;
    if(m.away_team) byTeam[m.away_team] = t;
    times.add(t); first = Math.min(first, t); last = Math.max(last, t);
    if(!(m.is_over || g.status === 'complete' || m.canceled)) final = false;
  });
  const out = { byTeam, times:[...times].sort((a,b)=>a-b), first, last, final, at: Date.now() };
  hostedCache.kickoffs[key] = out;
  return out;
}

/* Fantasy points for every player in a week under one scoring system.
   Finished weeks never change, so they're kept in localStorage — a season of
   standings then costs one small read per week instead of ~750 KB of stats. */
async function ensureWeekPoints(season, week, scoring, final, force){
  const key = `${season}-${week}-${hashString(JSON.stringify(Object.keys(scoring).sort().map(k=>[k, scoring[k]])))}`;
  const mem = hostedCache.points[key];
  if(mem && (mem.final || !force)) return mem;
  if(!force && hostedCache.pointsPromise[key]) return hostedCache.pointsPromise[key];

  const storageKey = 'leagueroom.pts.v1.' + key;
  if(final && !force){
    try{
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if(stored){ const v = { ...stored, final:true }; hostedCache.points[key] = v; return v; }
    }catch(e){}
  }

  const p = (async ()=>{
    const qs = PROJ_POSITIONS.map(pos=>'position[]='+pos).join('&');
    const rows = await sleeperData(`/stats/nfl/${season}/${week}?season_type=regular&${qs}`);
    const byPid = {}, teamOf = {};
    (rows||[]).forEach(r=>{
      if(!r.player_id || !r.stats) return;
      byPid[r.player_id] = round2(projectedPoints(r.stats, scoring));
      if(r.team) teamOf[r.player_id] = r.team;
    });
    const value = { byPid, teamOf, final: !!final };
    hostedCache.points[key] = value;
    if(final){
      try{ localStorage.setItem(storageKey, JSON.stringify({ byPid, teamOf })); }catch(e){ /* storage full — memory cache still works */ }
    }
    return value;
  })().finally(()=>{ delete hostedCache.pointsPromise[key]; });
  hostedCache.pointsPromise[key] = p;
  return p;
}

/* Season-long projections, ordered by PPR average draft position, for the draft room. */
function ensureSeasonProjections(season){
  if(hostedCache.seasonProj[season]) return Promise.resolve(hostedCache.seasonProj[season]);
  if(hostedCache.seasonProjPromise[season]) return hostedCache.seasonProjPromise[season];
  const qs = PROJ_POSITIONS.map(p=>'position[]='+p).join('&');
  hostedCache.seasonProjPromise[season] = sleeperData(`/projections/nfl/${season}?season_type=regular&${qs}&order_by=adp_ppr`)
    .then(rows=>{
      const list = (rows||[]).filter(r=>r.player_id && r.stats).map(r=>({
        pid: r.player_id,
        adp: (r.stats.adp_ppr && r.stats.adp_ppr < 999) ? r.stats.adp_ppr : 9999,
        pts: r.stats.pts_ppr || 0,
        pos: (r.player && r.player.position) || positionOf(r.player_id)
      }));
      list.sort((a,b)=> a.adp - b.adp || b.pts - a.pts);
      hostedCache.seasonProj[season] = list;
      return list;
    })
    .catch(e=>{ delete hostedCache.seasonProjPromise[season]; throw e; });
  return hostedCache.seasonProjPromise[season];
}

/* ============================ SCORING ENGINE ============================ */

function startingSlots(settings){ return (settings.roster_slots||[]).filter(s=>s !== 'BN'); }

function snapshotsByTeam(history){
  const by = {};
  (history||[]).forEach(h=>{
    (by[h.team_id] = by[h.team_id] || []).push({ t: Date.parse(h.created_at), id: Number(h.id), starters: h.starters || [] });
  });
  Object.values(by).forEach(list=> list.sort((a,b)=> a.t - b.t || a.id - b.id));
  return by;
}

function fitLineup(arr, n){
  const out = new Array(n).fill('');
  (arr||[]).slice(0, n).forEach((p,i)=>{ out[i] = p || ''; });
  return out;
}

/* Replays one team's lineup history across a week's kickoffs.
   kickoffOf(pid) returns that player's kickoff time this week, or null (bye). */
function replayWeekLineup(snaps, nSlots, kickoffOf, kickoffTimes, now){
  now = now || Date.now();
  const first = kickoffTimes.length ? kickoffTimes[0] : Infinity;
  let eff = new Array(nSlots).fill('');
  let i = 0;
  // Before the first kickoff of the week nothing is locked; the latest lineup simply applies.
  while(i < snaps.length && snaps[i].t < first){ eff = fitLineup(snaps[i].starters, nSlots); i++; }

  const locked = new Array(nSlots).fill(false);
  const events = kickoffTimes.map(t=>({ t, kind:0 }));
  for(; i < snaps.length; i++) events.push({ t: snaps[i].t, kind:1, snap: snaps[i] });
  // At the same instant, the kickoff wins: a lineup saved exactly at kickoff is too late.
  events.sort((a,b)=> a.t - b.t || a.kind - b.kind);

  for(const ev of events){
    if(ev.t > now) break;
    if(ev.kind === 0){
      for(let s=0; s<nSlots; s++){
        if(locked[s] || !eff[s]) continue;
        const k = kickoffOf(eff[s]);
        if(k != null && k <= ev.t) locked[s] = true;
      }
      continue;
    }
    const want = fitLineup(ev.snap.starters, nSlots);
    const next = eff.slice();
    for(let s=0; s<nSlots; s++){
      if(locked[s]) continue;                          // his game started: he stays
      const cand = want[s];
      if(cand === eff[s]) continue;
      if(cand){
        const k = kickoffOf(cand);
        if(k != null && k <= ev.t) continue;           // can't start someone whose game already began
      }
      next[s] = cand;
    }
    // A rejected move can leave one player in two spots; keep the one that was requested.
    const seenAt = {};
    for(let s=0; s<nSlots; s++){
      const p = next[s];
      if(!p) continue;
      if(seenAt[p] == null){ seenAt[p] = s; continue; }
      const other = seenAt[p];
      const keepOther = locked[other] || want[other] === p;
      const clear = keepOther ? s : other;
      if(!locked[clear]) next[clear] = '';
      if(!keepOther) seenAt[p] = s;
    }
    eff = next;
  }
  return { starters: eff, locked };
}

/* Everything the engine needs about one hosted division. */
function buildHostedCtx(state, history, division){
  const settings = state.settings || {};
  const ctx = {
    state, history, division, settings,
    slots: startingSlots(settings),
    snaps: snapshotsByTeam(history),
    teamsById: {}, teamBySlot: {},
    serverOffset: state.server_time ? Date.parse(state.server_time) - Date.now() : 0
  };
  (state.teams||[]).forEach(t=>{ ctx.teamsById[t.id] = t; ctx.teamBySlot[t.slot] = t; });
  return ctx;
}

function currentLineupFor(ctx, teamId){
  const list = ctx.snaps[teamId] || [];
  return fitLineup(list.length ? list[list.length-1].starters : [], ctx.slots.length);
}

function seasonWeeks(settings){
  const weeks = [];
  for(let w = settings.start_week; w < settings.start_week + settings.regular_season_weeks; w++) weeks.push(w);
  return weeks;
}

/* Which week to show by default: the current NFL week, kept inside this season. */
function hostedCurrentWeek(ctx, nfl){
  const s = ctx.settings;
  const end = s.start_week + s.regular_season_weeks - 1;
  if(!nfl) return s.start_week;
  if(String(nfl.season) !== String(s.season)) return Number(nfl.season) > Number(s.season) ? end : s.start_week;
  if(nfl.season_type !== 'regular') return s.start_week;
  return Math.min(end, Math.max(s.start_week, Number(nfl.week) || s.start_week));
}

/* Round-robin schedule (circle method), fixed by team slot so every browser agrees. */
function hostedSchedule(ctx){
  const ids = (ctx.state.teams||[]).slice().sort((a,b)=>a.slot-b.slot).map(t=>t.id);
  if(ids.length % 2) ids.push(null);
  const n = ids.length, rounds = n - 1, weeks = {};
  const rest = ids.slice(1);
  seasonWeeks(ctx.settings).forEach((week, w)=>{
    const k = w % rounds;
    const rotated = rest.slice(rest.length - k).concat(rest.slice(0, rest.length - k));
    const order = [ids[0], ...rotated];
    const pairs = [];
    for(let i=0; i<n/2; i++){
      const a = order[i], b = order[n-1-i];
      if(a && b) pairs.push([a, b]);
      else if(a || b) pairs.push([a || b, null]);
    }
    weeks[week] = pairs;
  });
  return weeks;
}

/* Scores every team for one week. */
async function hostedWeekResults(ctx, week, force){
  const season = ctx.settings.season;
  const kick = await ensureKickoffs(season, week, force);
  const pts = await ensureWeekPoints(season, week, ctx.settings.scoring || {}, kick.final, force);
  const kickoffOf = pid => {
    const team = pts.teamOf[pid] || nflTeamOf(pid);
    return team && kick.byTeam[team] != null ? kick.byTeam[team] : null;
  };
  const byTeam = {};
  (ctx.state.teams||[]).forEach(t=>{
    const r = replayWeekLineup(ctx.snaps[t.id] || [], ctx.slots.length, kickoffOf, kick.times, Date.now() + ctx.serverOffset);
    const points = r.starters.map((pid, i)=>
      pid && slotEligible(ctx.slots[i], positionOf(pid)) ? (pts.byPid[pid] || 0) : 0);
    byTeam[t.id] = { starters: r.starters, starters_points: points, points: round2(sum(points)), locked: r.locked };
  });
  return { byTeam, kick, pts, kickoffOf };
}

/* Wins, losses and points for every team, from finished weeks only. */
async function computeHostedStandings(ctx, nfl){
  const rec = {};
  (ctx.state.teams||[]).forEach(t=>{ rec[t.id] = { wins:0, losses:0, ties:0, pf:0, pa:0, results:[] }; });
  const draft = ctx.state.draft;
  if(!draft || draft.status !== 'complete') return rec;
  const draftDone = Date.parse(draft.completed_at);
  const current = hostedCurrentWeek(ctx, nfl);
  const schedule = hostedSchedule(ctx);
  const weeks = seasonWeeks(ctx.settings).filter(w=> w <= current);

  const results = await Promise.all(weeks.map(async week=>{
    try{
      const kick = await ensureKickoffs(ctx.settings.season, week);
      if(!kick.final || kick.first < draftDone) return null;   // unfinished, or played before the draft
      return { week, res: await hostedWeekResults(ctx, week) };
    }catch(e){ return null; }
  }));

  results.filter(Boolean).forEach(({week, res})=>{
    (schedule[week]||[]).forEach(([a, b])=>{
      if(!b) return;
      const pa = res.byTeam[a].points, pb = res.byTeam[b].points;
      rec[a].pf += pa; rec[a].pa += pb; rec[b].pf += pb; rec[b].pa += pa;
      if(pa > pb){ rec[a].wins++; rec[b].losses++; }
      else if(pb > pa){ rec[b].wins++; rec[a].losses++; }
      else { rec[a].ties++; rec[b].ties++; }
      rec[a].results.push({ week, opp:b, pf:pa, pa:pb });
      rec[b].results.push({ week, opp:a, pf:pb, pa:pa });
    });
  });
  return rec;
}

/* ============================ HOSTED DATA ============================ */

async function loadHostedDivision(division){
  const [state, history] = await Promise.all([
    rpc('hosted_division_state', { p_division_id: division.id }),
    rpc('hosted_lineup_history', { p_division_id: division.id })
  ]);
  return { state, history };
}

/* Shapes a hosted division like a Sleeper league in divCache, so the existing
   standings table, super league rankings and bracket work on it unchanged. */
function installHostedInCache(division, ctx, standings){
  const c = divCache(division.id);
  const s = ctx.settings;
  c.hosted = { ctx, standings };
  c.info = {
    name: division.name,
    scoring_settings: s.scoring || {},
    roster_positions: s.roster_slots || [],
    settings: { playoff_week_start: s.start_week + s.regular_season_weeks }
  };
  c.users = (ctx.state.teams||[]).map(t=>({
    user_id: 'team:' + t.id,
    display_name: t.owner_name || 'Open team',
    metadata: { team_name: t.name }
  }));
  c.rosters = (ctx.state.teams||[]).map(t=>{
    const r = standings[t.id] || { wins:0, losses:0, ties:0, pf:0, pa:0 };
    return {
      roster_id: t.slot, owner_id: 'team:' + t.id,
      settings: {
        wins:r.wins, losses:r.losses, ties:r.ties,
        fpts: Math.floor(r.pf), fpts_decimal: Math.round((r.pf - Math.floor(r.pf)) * 100),
        fpts_against: Math.floor(r.pa), fpts_against_decimal: Math.round((r.pa - Math.floor(r.pa)) * 100)
      },
      players: (t.roster||[]).map(x=>x.player_id),
      starters: currentLineupFor(ctx, t.id).filter(Boolean),
      reserve: []
    };
  });
  return c;
}

async function ensureHostedBasics(division, force){
  const c = divCache(division.id);
  if(c.hosted && !force) return c;
  const [{state, history}, nfl] = await Promise.all([
    loadHostedDivision(division),
    ensureNflState().catch(()=>null),
    ensurePlayers('nfl').catch(()=>null)
  ]);
  const ctx = buildHostedCtx(state, history, division);
  const standings = await computeHostedStandings(ctx, nfl);
  return installHostedInCache(division, ctx, standings);
}

/* ============================ HOSTED DIVISION PAGE ============================ */

const HOSTED_TABS = [
  { id:'matchups', label:'Matchups' },
  { id:'team',     label:'My Team' },
  { id:'players',  label:'Players' },
  { id:'trades',   label:'Trades' },
  { id:'draft',    label:'Draft' },
  { id:'league',   label:'League' },
  { id:'playoffs', label:'Playoffs', singleOnly:true },
  { id:'activity', label:'Activity' },
  { id:'settings', label:'Settings', commishOnly:true }
];

function hostedBaseHref(league, division){
  return league.format === 'single' ? `#/league/${league.slug}` : `#/league/${league.slug}/division/${division.id}`;
}

async function renderHostedDivision(app, league, divisions, division, tab){
  const single = league.format === 'single';
  const base = hostedBaseHref(league, division);
  const isLeagueCommish = session && session.user_id === league.commissioner_id;
  const manageBtn = isLeagueCommish ? `<a class="secondary-btn" href="#/league/${league.slug}/manage">Manage League</a>` : '';
  const nav = single ? '' : leagueNavHtml(league, divisions, 'div:' + division.id);
  const title = single ? league.name : division.name;

  app.innerHTML = topbarHtml(single ? '#/' : `#/league/${league.slug}`, manageBtn) + nav
    + `<div class="state-msg">Loading ${escapeHtml(title)}…</div>`;

  let data, nfl;
  try{
    [data, nfl] = await Promise.all([
      loadHostedDivision(division),
      ensureNflState().catch(()=>null),
      ensurePlayers('nfl')
    ]);
  }catch(err){
    const privateLeague = /private/i.test(err.message);
    app.innerHTML = topbarHtml('#/') + nav + `
      <div class="hero" style="margin:10px 0;"><h1 style="font-size:26px;">${escapeHtml(title)}</h1></div>
      <div class="alert ${privateLeague ? 'info' : 'error'}">${escapeHtml(err.message)}
        ${privateLeague && !session ? ` <a href="${loginHref()}" style="text-decoration:underline;">Log in</a> if you're already a member.` : ''}
      </div>`;
    return;
  }

  const ctx = buildHostedCtx(data.state, data.history, division);
  ctx.league = league; ctx.divisions = divisions; ctx.nfl = nfl; ctx.base = base;
  const state = ctx.state;
  const me = state.me || {};
  const draft = state.draft || {};

  const standings = await computeHostedStandings(ctx, nfl);
  ctx.standings = standings;
  installHostedInCache(division, ctx, standings);

  const tabs = HOSTED_TABS.filter(t=> (!t.singleOnly || single) && (!t.commishOnly || me.is_commissioner));
  if(!tab || !tabs.some(t=>t.id === tab)) tab = draft.status === 'complete' ? 'matchups' : 'draft';

  const myTeam = me.team_id ? ctx.teamsById[me.team_id] : null;
  const openTeams = (state.teams||[]).filter(t=>!t.owner_id);
  const incomingTrades = (state.trades||[]).filter(t=> t.status==='pending' && myTeam && t.to_team === myTeam.id).length;
  const s = ctx.settings;
  const presetLabel = (SCORING_PRESETS[s.scoring_preset] || {}).label || 'Custom scoring';

  let banner = '';
  if(!myTeam && openTeams.length){
    if(!session) banner = `<div class="alert info">${openTeams.length} team${openTeams.length===1?' is':'s are'} still open. <a href="${loginHref()}" style="text-decoration:underline;">Log in</a> to claim one.</div>`;
    else if(me.is_member || state.league.is_public) banner = `<div class="alert info">You don't have a team here yet — ${openTeams.length} ${openTeams.length===1?'is':'are'} open. <a href="${base}/league" style="text-decoration:underline;">Claim a team</a>.</div>`;
  }

  const badge = t => {
    if(t.id === 'trades' && incomingTrades) return ` <span class="tab-badge">${incomingTrades}</span>`;
    if(t.id === 'draft' && draft.status === 'drafting') return ` <span class="tab-badge live">LIVE</span>`;
    return '';
  };

  app.innerHTML = topbarHtml(single ? '#/' : `#/league/${league.slug}`, manageBtn) + nav + `
    <div class="hero" style="margin:10px 0 4px;">
      <h1 style="font-size:clamp(24px,4vw,32px);">${escapeHtml(title)}</h1>
      <p style="margin-top:4px;">${single ? '' : escapeHtml(league.name) + ' &middot; '}${state.teams.length}-team ${escapeHtml(presetLabel)} &middot; Weeks ${s.start_week}–${s.start_week + s.regular_season_weeks - 1}
        ${me.is_commissioner ? ' &middot; <span class="commish-badge">&#9819; Commissioner</span>' : ''}
        ${myTeam ? ` &middot; You manage <b>${escapeHtml(myTeam.name)}</b>` : ''}</p>
    </div>
    ${banner}
    <div class="hosted-tabs">${tabs.map(t=>`<a href="${base}/${t.id}" class="${t.id===tab?'active':''}">${t.label}${badge(t)}</a>`).join('')}</div>
    <div id="hostedAlert">${flashHtml()}</div>
    <div id="hostedBody"></div>`;

  const body = document.getElementById('hostedBody');
  const renderers = {
    matchups: hostedMatchupsTab, team: hostedTeamTab, players: hostedPlayersTab, trades: hostedTradesTab,
    draft: hostedDraftTab, league: hostedLeagueTab, playoffs: hostedPlayoffsTab, activity: hostedActivityTab,
    settings: hostedSettingsTab
  };
  const hostedTabsEl = app.querySelector('.hosted-tabs');
  const activeTab = hostedTabsEl && hostedTabsEl.querySelector('a.active');
  if(activeTab && hostedTabsEl.scrollWidth > hostedTabsEl.clientWidth){
    hostedTabsEl.scrollLeft = Math.max(0, activeTab.offsetLeft - (hostedTabsEl.clientWidth - activeTab.offsetWidth)/2);
  }
  await renderers[tab](body, ctx);
}

function hostedAlertEl(){ return document.getElementById('hostedAlert'); }

function teamRecordText(ctx, teamId){
  const r = (ctx.standings||{})[teamId];
  if(!r) return '0-0';
  return `${r.wins}-${r.losses}${r.ties ? '-' + r.ties : ''}`;
}

function draftNotDoneHtml(ctx, what){
  return `<div class="state-msg">${what} open once the draft is complete. <a href="${ctx.base}/draft" style="text-decoration:underline;">Go to the draft</a>.</div>`;
}

/* ---------------------------- Matchups ---------------------------- */

async function hostedMatchupsTab(body, ctx){
  const { state, settings } = ctx;
  if(!state.draft || state.draft.status !== 'complete'){
    body.innerHTML = draftNotDoneHtml(ctx, 'Matchups and standings');
    return;
  }
  const weeks = seasonWeeks(settings);
  const current = hostedCurrentWeek(ctx, ctx.nfl);
  let week = current;

  body.innerHTML = `
    <div class="week-tabs" id="weekTabs">${weeks.map(w=>`<button class="week-tab ${w===week?'active':''}" data-week="${w}">Wk ${w}</button>`).join('')}</div>
    <div class="live-bar">
      <div class="live-pill" id="liveStatus"></div>
      <button class="refresh-btn" id="liveRefreshBtn">Refresh now</button>
    </div>
    <div id="matchups"><div class="state-msg">Scoring week ${week}…</div></div>
    <div class="section-label">Standings</div>
    <div id="standBody"></div>
    <div class="footnote" style="text-align:left;">Records update when every game in a week is final. Scores come from live NFL stats under this league's scoring rules, replayed against each lineup as it stood at kickoff.</div>
    <div class="section-label">Injury Report</div>
    <div id="injuryReport"></div>`;

  const teamsForTable = (state.teams||[]).map(t=>{
    const r = ctx.standings[t.id] || {};
    return { roster_id:t.slot, teamName:t.name, ownerName:t.owner_name||'Open team', avatar:null,
      wins:r.wins||0, losses:r.losses||0, ties:r.ties||0, ptsFor:r.pf||0, ptsAgainst:r.pa||0, divisionId:ctx.division.id, divisionName:'' };
  });
  renderStandingsTable(document.getElementById('standBody'), teamsForTable.slice().sort(compareTeams), false);
  document.querySelectorAll('#standBody .div-chip').forEach(el=>el.remove());
  renderInjuryReport(document.getElementById('injuryReport'), (state.teams||[]).map(t=>({
    teamName: t.name, players:(t.roster||[]).map(r=>r.player_id), starters: currentLineupFor(ctx, t.id).filter(Boolean)
  })));

  const byRoster = {};
  teamsForTable.forEach(t=>{ byRoster[t.roster_id] = t; });
  const schedule = hostedSchedule(ctx);

  const container = document.getElementById('matchups');
  function entriesFor(week, res){
    const data = [];
    (schedule[week]||[]).forEach(([a, b], i)=>{
      const ea = res.byTeam[a];
      data.push({ roster_id: ctx.teamsById[a].slot, matchup_id: i+1, starters: ea.starters, starters_points: ea.starters_points, points: ea.points });
      if(b){
        const eb = res.byTeam[b];
        data.push({ roster_id: ctx.teamsById[b].slot, matchup_id: i+1, starters: eb.starters, starters_points: eb.starters_points, points: eb.points });
      }
    });
    return data;
  }

  async function loadWeek(w){
    stopLive();
    week = w;
    container.innerHTML = `<div class="state-msg">Scoring week ${w}…</div>`;
    let res;
    try{
      await Promise.all([
        refreshScores(settings.season, w, true).catch(()=>null),
        ensureProjections(settings.season, w).catch(()=>null)
      ]);
      res = await hostedWeekResults(ctx, w, true);
    }catch(e){
      container.innerHTML = `<div class="state-msg error">Couldn't load NFL stats for week ${w}. Try again in a moment.</div>`;
      return;
    }
    if(week !== w) return;
    buildMatchupCards(container, entriesFor(w, res), byRoster);
    paintLive(container, ctx.division, settings.season, w);

    const isCurrent = w === current && String((ctx.nfl||{}).season) === String(settings.season);
    startLive({
      anchor: container,
      pollable: isCurrent && !res.kick.final,
      idleText: res.kick.final ? `Week ${w} final` : 'Not started',
      refresh: async ()=>{
        // Lineups can change up to each kickoff, so re-read them along with the stats.
        const history = await rpc('hosted_lineup_history', { p_division_id: ctx.division.id });
        ctx.history = history; ctx.snaps = snapshotsByTeam(history);
        await refreshScores(settings.season, w, true).catch(()=>null);
        const fresh = await hostedWeekResults(ctx, w, true);
        if(!document.body.contains(container) || week !== w) return;
        rebindMatchupEntries(container, entriesFor(w, fresh));
        paintLive(container, ctx.division, settings.season, w);
      }
    });
  }

  document.querySelectorAll('#weekTabs .week-tab').forEach(btn=> btn.addEventListener('click', ()=>{
    document.querySelectorAll('#weekTabs .week-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    loadWeek(parseInt(btn.dataset.week, 10));
  }));
  document.getElementById('liveRefreshBtn').addEventListener('click', ()=> tickLive(true));
  const activeWeek = document.querySelector('#weekTabs .week-tab.active');
  if(activeWeek) activeWeek.scrollIntoView({ block:'nearest', inline:'center' });
  await loadWeek(week);
}

/* ---------------------------- My Team ---------------------------- */

function claimTeamsHtml(ctx){
  const { state } = ctx;
  const me = state.me || {};
  const open = (state.teams||[]).filter(t=>!t.owner_id);
  if(!session){
    return `<div class="state-msg">Log in to manage a team. <a href="${loginHref()}" style="text-decoration:underline;">Log in or sign up</a>.</div>`;
  }
  if(!open.length) return `<div class="state-msg">Every team in this ${ctx.league.format==='single'?'league':'division'} already has a manager.</div>`;
  if(!me.is_member && !state.league.is_public){
    return `<div class="state-msg">Join this league with its invite link before claiming a team.</div>`;
  }
  return `<div class="section-label">Claim a Team</div>
    <div class="claim-grid">${open.map(t=>`<div class="claim-card">
      <div><div class="team-name">${escapeHtml(t.name)}</div><div class="owner-name">Open</div></div>
      <button class="primary-btn small" data-claim="${t.id}">Claim</button>
    </div>`).join('')}</div>`;
}

function wireClaimButtons(root){
  root.querySelectorAll('[data-claim]').forEach(btn=> btn.addEventListener('click', ()=>
    hostedAction(btn, hostedAlertEl(), ()=> rpc('claim_hosted_team', { p_team_id: btn.dataset.claim }), 'Team claimed — welcome to the league!')));
}

async function hostedTeamTab(body, ctx){
  const { state, settings, slots } = ctx;
  const me = state.me || {};
  const team = me.team_id ? ctx.teamsById[me.team_id] : null;
  if(!team){
    body.innerHTML = claimTeamsHtml(ctx);
    wireClaimButtons(body);
    return;
  }

  const draftDone = state.draft && state.draft.status === 'complete';
  const week = hostedCurrentWeek(ctx, ctx.nfl);
  const season = settings.season;
  const maxRoster = (settings.roster_slots||[]).length;
  const roster = (team.roster||[]).map(r=>r.player_id);
  let lineup = currentLineupFor(ctx, team.id);

  let kick = null, proj = null;
  if(draftDone){
    try{
      [kick, proj] = await Promise.all([
        ensureKickoffs(season, week),
        ensureProjections(season, week).catch(()=>null),
        refreshScores(season, week).catch(()=>null)
      ]);
    }catch(e){ /* lineup still editable; locks just can't be shown */ }
  }
  const now = Date.now() + ctx.serverOffset;
  const kickoffOf = pid => { const t = nflTeamOf(pid); return kick && t && kick.byTeam[t] != null ? kick.byTeam[t] : null; };
  const started = pid => { const k = kickoffOf(pid); return k != null && k <= now; };
  const projOf = pid => proj && proj[pid] ? projectedPoints(proj[pid], settings.scoring) : 0;
  const gameText = pid => {
    if(!kick) return '';
    const k = kickoffOf(pid);
    if(k == null) return '<span class="hp-game bye">BYE</span>';
    if(k <= now){
      const g = gameForPlayer(pid);
      const label = g ? gameStateLabel(g) : '';
      return `<span class="hp-game locked">&#128274; ${escapeHtml(label || 'Locked')}</span>`;
    }
    return `<span class="hp-game">${escapeHtml(kickoffText(k))}</span>`;
  };

  let selected = null;   // { kind:'starter', index } | { kind:'bench', pid }

  function selectedPid(){ return !selected ? null : selected.kind === 'starter' ? lineup[selected.index] : selected.pid; }

  function isDestination(kind, indexOrPid){
    if(!selected) return false;
    const pid = selectedPid();
    if(!pid || started(pid)) return false;
    if(kind === 'starter'){
      const i = indexOrPid;
      if(selected.kind === 'starter' && selected.index === i) return false;
      if(!slotEligible(slots[i], positionOf(pid))) return false;
      if(lineup[i] && started(lineup[i])) return false;
      return true;
    }
    return selected.kind === 'starter';   // a starter can always go to the bench
  }

  function applyMove(dest){
    const next = lineup.slice();
    const pid = selectedPid();
    if(selected.kind === 'bench' && dest.kind === 'starter'){
      next[dest.index] = pid;
    }else if(selected.kind === 'starter' && dest.kind === 'bench'){
      next[selected.index] = '';
    }else if(selected.kind === 'starter' && dest.kind === 'starter'){
      const occupant = next[dest.index];
      next[dest.index] = pid;
      next[selected.index] = occupant && slotEligible(slots[selected.index], positionOf(occupant)) ? occupant : '';
    }
    return next;
  }

  async function saveLineup(next, btn){
    const alertEl = hostedAlertEl();
    try{
      if(btn) btn.disabled = true;
      await rpc('set_hosted_lineup', { p_team_id: team.id, p_starters: next });
      lineup = next;
      selected = null;
      alertEl.innerHTML = '';
      paint();
    }catch(err){
      alertEl.innerHTML = `<div class="alert error">${escapeHtml(err.message)}</div>`;
      if(btn) btn.disabled = false;
    }
  }

  function autoLineup(){
    const next = lineup.slice();
    const used = new Set(next.filter((pid,i)=> pid && started(pid)));
    const order = slots.map((s,i)=>i).sort((a,b)=> (/FLEX/.test(slots[a])?1:0) - (/FLEX/.test(slots[b])?1:0));
    order.forEach(i=>{ if(!(next[i] && started(next[i]))) next[i] = ''; });
    order.forEach(i=>{
      if(next[i]) return;
      const best = roster
        .filter(pid=> !used.has(pid) && !started(pid) && slotEligible(slots[i], positionOf(pid)))
        .sort((a,b)=> projOf(b) - projOf(a))[0];
      if(best){ next[i] = best; used.add(best); }
    });
    return next;
  }

  function paint(){
    const bench = roster.filter(pid=> !lineup.includes(pid));
    const starterPts = sum(lineup.map(pid=> pid ? projOf(pid) : 0));
    const record = teamRecordText(ctx, team.id);
    const claims = (state.claims||[]);

    const row = (kind, i, pid, slot) => {
      const dest = isDestination(kind, kind==='starter' ? i : pid);
      const isSel = selected && ((kind==='starter' && selected.kind==='starter' && selected.index===i) || (kind==='bench' && selected.kind==='bench' && selected.pid===pid));
      const lockedPid = pid && started(pid);
      const canSelect = draftDone && pid && !lockedPid;
      return `<div class="lineup-row ${dest?'dest':''} ${isSel?'selected':''}" ${dest?`data-dest-kind="${kind}" data-dest="${kind==='starter'?i:escapeHtml(pid||'')}"`:''}>
        <span class="slot-tag ${slot==='BN'?'bench':''}" title="${escapeHtml(SLOT_HINT[slot]||'')}">${escapeHtml(SLOT_LABEL[slot]||slot)}</span>
        <div class="lineup-player">${pid ? hPlayerChip(pid) : '<span class="empty-slot">Empty</span>'}${pid ? gameText(pid) : ''}</div>
        <span class="lineup-proj num">${pid && proj ? fmt1(projOf(pid)) : ''}</span>
        <div class="lineup-actions">
          ${dest ? `<button class="primary-btn small" data-place>Here</button>`
            : canSelect ? `<button class="ghost-btn small" data-select-kind="${kind}" data-select="${kind==='starter'?i:escapeHtml(pid)}">${isSel?'Cancel':'Move'}</button>` : ''}
          ${pid && draftDone && kind==='bench' && !selected ? `<button class="ghost-btn small danger" data-drop="${escapeHtml(pid)}">Drop</button>` : ''}
        </div>
      </div>`;
    };

    body.innerHTML = `
      <div class="team-head">
        <div>
          <div class="team-title" id="teamTitle">${escapeHtml(team.name)} <button class="linklike" id="renameBtn">rename</button></div>
          <div class="owner-name">${record} &middot; waiver priority #${team.waiver_priority} &middot; ${roster.length}/${maxRoster} players</div>
        </div>
        ${draftDone ? `<div class="team-head-actions">
          <span class="form-hint">Week ${week} projection <b class="num">${fmt1(starterPts)}</b></span>
          <button class="secondary-btn" id="autoLineupBtn">Auto-set lineup</button>
        </div>` : ''}
      </div>
      <form id="renameForm" class="rename-form" hidden>
        <input class="form-input" id="renameInput" maxlength="40" value="${escapeHtml(team.name)}">
        <button class="primary-btn small" type="submit">Save</button>
        <button class="ghost-btn small" type="button" id="renameCancel">Cancel</button>
      </form>
      ${!draftDone ? `<div class="alert info">Lineups open once the draft is complete. Here's your roster so far.</div>` : ''}
      ${selected ? `<div class="alert info move-hint">Choose where to put <b>${escapeHtml(playerNameOf(selectedPid()))}</b>, or press Cancel.</div>` : ''}
      <div class="lineup-card">
        <div class="lineup-head"><span>Starters</span><span>Proj</span></div>
        ${slots.map((slot,i)=> row('starter', i, lineup[i], slot)).join('')}
        <div class="lineup-head bench-head ${selected && selected.kind==='starter' ? 'dest' : ''}" ${selected && selected.kind==='starter' ? 'data-dest-kind="bench" data-dest=""' : ''}>
          <span>Bench${selected && selected.kind==='starter' ? ' — tap to bench this player' : ''}</span><span></span>
        </div>
        ${bench.length ? bench.map(pid=> row('bench', null, pid, 'BN')).join('') : '<div class="state-msg">No bench players.</div>'}
      </div>
      ${claims.length ? `<div class="section-label">Waiver Claims</div>
        <div class="claim-list">${claims.map(c=>`<div class="claim-row">
          <div>Add ${hPlayerChip(c.add_player)}${c.drop_player ? ` <span class="form-hint">drop</span> ${hPlayerChip(c.drop_player)}` : ''}
            ${c.note ? `<div class="form-hint">${escapeHtml(c.note)}</div>` : ''}</div>
          <div class="claim-status ${c.status}">${c.status === 'pending' ? `Pending <button class="ghost-btn small" data-cancel-claim="${c.id}">Cancel</button>` : escapeHtml(c.status)}</div>
        </div>`).join('')}</div>` : ''}
      <div class="footnote" style="text-align:left;">Players lock when their game kicks off. <a href="${ctx.base}/players" style="text-decoration:underline;">Find free agents</a> &middot; <a href="${ctx.base}/trades" style="text-decoration:underline;">Propose a trade</a></div>`;

    body.querySelectorAll('[data-select]').forEach(btn=> btn.addEventListener('click', ()=>{
      const kind = btn.dataset.selectKind;
      const value = btn.dataset.select;
      const same = selected && selected.kind === kind && (kind==='starter' ? selected.index === +value : selected.pid === value);
      selected = same ? null : (kind === 'starter' ? { kind, index:+value } : { kind, pid:value });
      paint();
    }));
    body.querySelectorAll('[data-dest-kind]').forEach(el=> el.addEventListener('click', (e)=>{
      const kind = el.dataset.destKind;
      const dest = kind === 'starter' ? { kind, index: +el.dataset.dest } : { kind };
      saveLineup(applyMove(dest), e.target.closest('button'));
    }));
    const autoBtn = document.getElementById('autoLineupBtn');
    if(autoBtn) autoBtn.addEventListener('click', ()=>{
      if(!proj){ hostedAlertEl().innerHTML = `<div class="alert error">Projections aren't available right now, so the lineup can't be auto-set.</div>`; return; }
      saveLineup(autoLineup(), autoBtn);
    });
    body.querySelectorAll('[data-drop]').forEach(btn=> btn.addEventListener('click', ()=>{
      const pid = btn.dataset.drop;
      if(!confirm(`Drop ${playerNameOf(pid)}? ${settings.waiver_hours ? `He'll go on waivers for ${settings.waiver_hours} hours.` : 'He becomes a free agent immediately.'}`)) return;
      hostedAction(btn, hostedAlertEl(), ()=> rpc('hosted_drop_player', { p_team_id: team.id, p_player: pid }), `${playerNameOf(pid)} dropped.`);
    }));
    body.querySelectorAll('[data-cancel-claim]').forEach(btn=> btn.addEventListener('click', ()=>
      hostedAction(btn, hostedAlertEl(), ()=> rpc('hosted_cancel_claim', { p_claim_id: +btn.dataset.cancelClaim }), 'Claim cancelled.')));

    const renameForm = document.getElementById('renameForm');
    document.getElementById('renameBtn').addEventListener('click', ()=>{ renameForm.hidden = false; document.getElementById('renameInput').focus(); });
    document.getElementById('renameCancel').addEventListener('click', ()=>{ renameForm.hidden = true; });
    renameForm.addEventListener('submit', (e)=>{
      e.preventDefault();
      hostedAction(renameForm.querySelector('button[type=submit]'), hostedAlertEl(),
        ()=> rpc('rename_hosted_team', { p_team_id: team.id, p_name: document.getElementById('renameInput').value }), 'Team renamed.');
    });
  }
  paint();
}

/* ---------------------------- Players (free agents & waivers) ---------------------------- */

let tradePrefill = null;   // set by "Trade" on the players tab, read by the trades tab

async function hostedPlayersTab(body, ctx){
  const { state, settings } = ctx;
  const me = state.me || {};
  const team = me.team_id ? ctx.teamsById[me.team_id] : null;
  const draftDone = state.draft && state.draft.status === 'complete';
  const week = hostedCurrentWeek(ctx, ctx.nfl);
  const maxRoster = (settings.roster_slots||[]).length;

  body.innerHTML = `<div class="state-msg">Loading players…</div>`;
  let proj = null;
  try{ proj = await ensureProjections(settings.season, week); }catch(e){ /* sort by name instead */ }

  const owner = {};
  (state.teams||[]).forEach(t=> (t.roster||[]).forEach(r=>{ owner[r.player_id] = t; }));
  const locks = {};
  (state.locks||[]).forEach(l=>{ locks[l.player_id] = l.clears_at; });
  const projOf = pid => proj && proj[pid] ? projectedPoints(proj[pid], settings.scoring) : null;

  const pool = [];
  const players = sleeperCache.players || {};
  for(const pid in players){
    const p = players[pid];
    if(!PROJ_POSITIONS.includes(p.position)) continue;
    if(!p.team && !owner[pid]) continue;                 // not on an NFL roster, and nobody here has him
    pool.push({ pid, p, proj: projOf(pid), name: playerDisplayName(p, pid) });
  }

  const filter = { pos:'ALL', show:'available', q:'' };
  let actionFor = null;   // pid with an open add/claim panel

  body.innerHTML = `
    ${!draftDone ? `<div class="alert info">Free agency opens once the draft is complete.</div>` : ''}
    ${draftDone && !team ? `<div class="alert info">Claim a team to add players. <a href="${ctx.base}/league" style="text-decoration:underline;">See open teams</a>.</div>` : ''}
    <div class="players-controls">
      <input class="form-input" id="playerSearch" placeholder="Search players…" autocomplete="off">
      <select class="form-select" id="playerShow">
        <option value="available">Available</option>
        <option value="fa">Free agents only</option>
        <option value="waivers">On waivers</option>
        <option value="all">All players</option>
      </select>
    </div>
    <div class="fa-controls" id="posTabs">${['ALL', ...PROJ_POSITIONS].map((p,i)=>`<button class="fa-tab ${i===0?'active':''}" data-pos="${p}">${p}</button>`).join('')}
      <span class="fa-note">Week ${week} projections</span></div>
    <div id="playerList"></div>`;

  const listEl = document.getElementById('playerList');

  function statusOf(pid){
    if(owner[pid]) return { kind:'rostered', team: owner[pid] };
    if(locks[pid] && Date.parse(locks[pid]) > Date.now()) return { kind:'waivers', clears: locks[pid] };
    return { kind:'fa' };
  }

  function paintList(){
    const q = filter.q.toLowerCase();
    let rows = pool.filter(r=>{
      if(filter.pos !== 'ALL' && r.p.position !== filter.pos) return false;
      if(q && !r.name.toLowerCase().includes(q) && !(r.p.team||'').toLowerCase().startsWith(q)) return false;
      const st = statusOf(r.pid).kind;
      if(filter.show === 'available' && st === 'rostered') return false;
      if(filter.show === 'fa' && st !== 'fa') return false;
      if(filter.show === 'waivers' && st !== 'waivers') return false;
      return true;
    });
    rows.sort((a,b)=> (b.proj == null ? -1 : b.proj) - (a.proj == null ? -1 : a.proj) || a.name.localeCompare(b.name));
    rows = rows.slice(0, 75);
    if(!rows.length){ listEl.innerHTML = `<div class="state-msg">No players match.</div>`; return; }

    const myRoster = team ? (team.roster||[]).map(r=>r.player_id) : [];
    const rosterFull = myRoster.length >= maxRoster;

    listEl.innerHTML = `<div class="table-scroll"><table class="standings fa-table players-table">
      <thead><tr><th>Player</th><th class="num">Proj</th><th class="col-status">Status</th><th></th></tr></thead>
      <tbody>${rows.map(r=>{
        const st = statusOf(r.pid);
        let statusHtml, action = '';
        if(st.kind === 'rostered'){
          const mine = team && st.team.id === team.id;
          statusHtml = `<span class="owner-name">${mine ? 'Your team' : escapeHtml(st.team.name)}</span>`;
          if(!mine && team && draftDone) action = `<button class="ghost-btn small" data-trade="${escapeHtml(r.pid)}" data-team="${st.team.id}">Trade</button>`;
        }else if(st.kind === 'waivers'){
          statusHtml = `<span class="waiver-tag">Waivers · ${escapeHtml(timeUntilText(st.clears))}</span>`;
          if(team && draftDone) action = `<button class="secondary-btn small" data-open="${escapeHtml(r.pid)}" data-mode="claim">Claim</button>`;
        }else{
          statusHtml = `<span class="fa-tag">Free agent</span>`;
          if(team && draftDone) action = `<button class="primary-btn small" data-open="${escapeHtml(r.pid)}" data-mode="add">Add</button>`;
        }
        const panel = actionFor && actionFor.pid === r.pid ? `<tr class="action-row"><td colspan="4">
          <div class="action-panel">
            <span>${actionFor.mode === 'add' ? 'Add' : 'Claim'} <b>${escapeHtml(r.name)}</b>${rosterFull ? ' — your roster is full, so choose someone to drop:' : ''}</span>
            <select class="form-select" id="dropSelect">
              ${rosterFull ? '' : '<option value="">Don\'t drop anyone</option>'}
              ${myRoster.map(pid=>`<option value="${escapeHtml(pid)}">Drop ${escapeHtml(positionOf(pid))} ${escapeHtml(playerNameOf(pid))}</option>`).join('')}
            </select>
            <button class="primary-btn small" id="confirmAction">${actionFor.mode === 'add' ? 'Add player' : 'Submit claim'}</button>
            <button class="ghost-btn small" id="cancelAction">Cancel</button>
          </div>
          ${actionFor.mode === 'claim' ? `<div class="form-hint">Claims resolve when his waiver period ends. If several teams claim him, the best waiver priority wins (you're #${team.waiver_priority}).</div>` : ''}
        </td></tr>` : '';
        return `<tr>
          <td>${hPlayerChip(r.pid)}<div class="status-inline">${statusHtml}</div></td>
          <td class="num fa-proj">${r.proj == null ? '—' : fmt1(r.proj)}</td>
          <td class="col-status">${statusHtml}</td>
          <td class="num">${action}</td>
        </tr>${panel}`;
      }).join('')}</tbody></table></div>
      ${pool.length > 75 ? `<div class="footnote">Showing the top 75 — search to find anyone else.</div>` : ''}`;

    listEl.querySelectorAll('[data-open]').forEach(btn=> btn.addEventListener('click', ()=>{
      actionFor = { pid: btn.dataset.open, mode: btn.dataset.mode };
      paintList();
    }));
    listEl.querySelectorAll('[data-trade]').forEach(btn=> btn.addEventListener('click', ()=>{
      tradePrefill = { team: btn.dataset.team, receive: [btn.dataset.trade] };
      location.hash = `${ctx.base}/trades`;
    }));
    const confirmBtn = document.getElementById('confirmAction');
    if(confirmBtn){
      document.getElementById('cancelAction').addEventListener('click', ()=>{ actionFor = null; paintList(); });
      confirmBtn.addEventListener('click', ()=>{
        const drop = document.getElementById('dropSelect').value || null;
        const pid = actionFor.pid;
        const args = { p_team_id: team.id, p_add: pid, p_add_position: positionOf(pid) || null, p_drop: drop };
        if(actionFor.mode === 'add'){
          hostedAction(confirmBtn, hostedAlertEl(), ()=> rpc('hosted_add_player', args), `${playerNameOf(pid)} added to your roster.`);
        }else{
          hostedAction(confirmBtn, hostedAlertEl(), ()=> rpc('hosted_submit_claim', args), `Waiver claim for ${playerNameOf(pid)} submitted.`);
        }
      });
    }
  }

  let searchTimer;
  document.getElementById('playerSearch').addEventListener('input', (e)=>{
    clearTimeout(searchTimer);
    searchTimer = setTimeout(()=>{ filter.q = e.target.value.trim(); paintList(); }, 150);
  });
  document.getElementById('playerShow').addEventListener('change', (e)=>{ filter.show = e.target.value; paintList(); });
  body.querySelectorAll('#posTabs .fa-tab').forEach(btn=> btn.addEventListener('click', ()=>{
    body.querySelectorAll('#posTabs .fa-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); filter.pos = btn.dataset.pos; paintList();
  }));
  paintList();
}

/* ---------------------------- Trades ---------------------------- */

function tradeSideHtml(pids){
  return pids.length ? pids.map(pid=>`<div class="trade-player">${hPlayerChip(pid)}</div>`).join('') : '<div class="form-hint">Nothing</div>';
}

async function hostedTradesTab(body, ctx){
  const { state } = ctx;
  const me = state.me || {};
  const team = me.team_id ? ctx.teamsById[me.team_id] : null;
  const draftDone = state.draft && state.draft.status === 'complete';
  const trades = state.trades || [];
  const name = id => (ctx.teamsById[id] || {}).name || 'Unknown team';

  const card = (t, perspective, actions) => {
    // perspective: which team is "you" for labelling
    const youAreFrom = perspective === t.from_team;
    const youGet = youAreFrom ? t.receive : t.give;
    const youGive = youAreFrom ? t.give : t.receive;
    const other = youAreFrom ? t.to_team : t.from_team;
    const neutral = !perspective;
    return `<div class="trade-card">
      <div class="trade-head">
        <span>${neutral ? `${escapeHtml(name(t.from_team))} &harr; ${escapeHtml(name(t.to_team))}` : `With <b>${escapeHtml(name(other))}</b>`}</span>
        <span class="trade-status ${t.status}">${escapeHtml(t.status)}</span>
      </div>
      <div class="trade-sides">
        <div><div class="roster-col-head">${neutral ? escapeHtml(name(t.from_team)) + ' sends' : 'You get'}</div>${tradeSideHtml(neutral ? t.give : youGet)}</div>
        <div><div class="roster-col-head">${neutral ? escapeHtml(name(t.to_team)) + ' sends' : 'You give'}</div>${tradeSideHtml(neutral ? t.receive : youGive)}</div>
      </div>
      ${t.message ? `<div class="trade-msg">&ldquo;${escapeHtml(t.message)}&rdquo;</div>` : ''}
      ${t.note ? `<div class="form-hint">${escapeHtml(t.note)}</div>` : ''}
      ${actions ? `<div class="trade-actions">${actions}</div>` : ''}
    </div>`;
  };

  const incoming = team ? trades.filter(t=> t.status==='pending' && t.to_team === team.id) : [];
  const outgoing = team ? trades.filter(t=> t.status==='pending' && t.from_team === team.id) : [];
  const review = me.is_commissioner ? trades.filter(t=> t.status==='pending' && (!team || (t.to_team !== team.id && t.from_team !== team.id))) : [];
  const recent = trades.filter(t=> t.status !== 'pending');

  const otherTeams = team ? (state.teams||[]).filter(t=> t.id !== team.id) : [];
  const prefill = tradePrefill; tradePrefill = null;

  body.innerHTML = `
    ${!draftDone ? `<div class="alert info">Trading opens once the draft is complete.</div>` : ''}
    ${draftDone && !team ? `<div class="alert info">Claim a team to trade. <a href="${ctx.base}/league" style="text-decoration:underline;">See open teams</a>.</div>` : ''}
    ${incoming.length ? `<div class="section-label">Offers for You</div>${incoming.map(t=> card(t, team.id,
      `<button class="primary-btn small" data-accept="${t.id}">Accept</button><button class="ghost-btn small" data-decline="${t.id}">Decline</button>`)).join('')}` : ''}
    ${outgoing.length ? `<div class="section-label">Your Offers</div>${outgoing.map(t=> card(t, team.id,
      `<button class="ghost-btn small" data-cancel-trade="${t.id}">Withdraw</button>`)).join('')}` : ''}
    ${review.length ? `<div class="section-label">Pending Trades (Commissioner)</div>${review.map(t=> card(t, null,
      `<button class="ghost-btn small danger" data-veto="${t.id}">Veto</button>`)).join('')}` : ''}
    ${team && draftDone ? `<div class="section-label">Propose a Trade</div>
      <div class="trade-builder">
        <div class="form-group"><label class="form-label">Trade With</label>
          <select class="form-select" id="tradeTeam">${otherTeams.map(t=>`<option value="${t.id}" ${prefill && prefill.team===t.id?'selected':''}>${escapeHtml(t.name)}${t.owner_name?' — '+escapeHtml(t.owner_name):''}</option>`).join('')}</select></div>
        <div class="trade-sides" id="tradePick"></div>
        <div class="form-group"><label class="form-label">Message (optional)</label>
          <input class="form-input" id="tradeMsg" maxlength="280" placeholder="Sell them on it…"></div>
        <button class="primary-btn" id="sendTrade">Send Offer</button>
      </div>` : ''}
    ${recent.length ? `<div class="section-label">Recent</div>${recent.map(t=> card(t, team && (t.from_team===team.id || t.to_team===team.id) ? team.id : null, '')).join('')}` : ''}
    ${!incoming.length && !outgoing.length && !review.length && !recent.length && !(team && draftDone) ? `<div class="state-msg">No trades yet.</div>` : ''}`;

  const alertEl = hostedAlertEl();
  body.querySelectorAll('[data-accept]').forEach(btn=> btn.addEventListener('click', ()=>
    hostedAction(btn, alertEl, async ()=>{
      const res = await rpc('hosted_respond_trade', { p_trade_id: +btn.dataset.accept, p_accept: true });
      if(res && res.status === 'failed') throw new Error(res.note || 'That trade could no longer go through.');
    }, 'Trade accepted — rosters updated.')));
  body.querySelectorAll('[data-decline]').forEach(btn=> btn.addEventListener('click', ()=>
    hostedAction(btn, alertEl, ()=> rpc('hosted_respond_trade', { p_trade_id: +btn.dataset.decline, p_accept: false }), 'Trade declined.')));
  body.querySelectorAll('[data-veto]').forEach(btn=> btn.addEventListener('click', ()=>{
    if(!confirm('Veto this trade? Both managers will see it was vetoed by the commissioner.')) return;
    hostedAction(btn, alertEl, ()=> rpc('hosted_respond_trade', { p_trade_id: +btn.dataset.veto, p_accept: false }), 'Trade vetoed.');
  }));
  body.querySelectorAll('[data-cancel-trade]').forEach(btn=> btn.addEventListener('click', ()=>
    hostedAction(btn, alertEl, ()=> rpc('hosted_cancel_trade', { p_trade_id: +btn.dataset.cancelTrade }), 'Offer withdrawn.')));

  const teamSel = document.getElementById('tradeTeam');
  if(!teamSel) return;
  const pick = document.getElementById('tradePick');
  const chosen = { give: new Set(), receive: new Set(prefill ? prefill.receive : []) };
  function paintPick(){
    const other = ctx.teamsById[teamSel.value];
    const side = (label, pids, set, key) => `<div>
      <div class="roster-col-head">${label}</div>
      ${pids.length ? pids.map(pid=>`<label class="trade-check"><input type="checkbox" data-side="${key}" value="${escapeHtml(pid)}" ${set.has(pid)?'checked':''}> ${hPlayerChip(pid)}</label>`).join('') : '<div class="form-hint">Empty roster</div>'}
    </div>`;
    pick.innerHTML = side('You give', (team.roster||[]).map(r=>r.player_id), chosen.give, 'give')
      + side(`You get from ${escapeHtml(other ? other.name : '')}`, other ? (other.roster||[]).map(r=>r.player_id) : [], chosen.receive, 'receive');
    pick.querySelectorAll('input[type=checkbox]').forEach(cb=> cb.addEventListener('change', ()=>{
      const set = chosen[cb.dataset.side];
      if(cb.checked) set.add(cb.value); else set.delete(cb.value);
    }));
  }
  teamSel.addEventListener('change', ()=>{ chosen.receive.clear(); paintPick(); });
  paintPick();
  document.getElementById('sendTrade').addEventListener('click', (e)=>{
    const btn = e.currentTarget;
    if(!chosen.give.size && !chosen.receive.size){
      alertEl.innerHTML = `<div class="alert error">Pick at least one player to trade.</div>`;
      return;
    }
    hostedAction(btn, alertEl, ()=> rpc('hosted_propose_trade', {
      p_from_team: team.id, p_to_team: teamSel.value,
      p_give: [...chosen.give], p_receive: [...chosen.receive],
      p_message: document.getElementById('tradeMsg').value || null
    }), 'Trade offer sent.');
  });
}

/* ---------------------------- Draft ---------------------------- */

function draftTeamForPick(draft, pickNo){
  const n = draft.order_team_ids.length;
  const round = Math.floor((pickNo - 1) / n) + 1;
  let idx = (pickNo - 1) % n;
  if(draft.draft_type === 'snake' && round % 2 === 0) idx = n - 1 - idx;
  return draft.order_team_ids[idx];
}

async function hostedDraftTab(body, ctx){
  const { state, settings } = ctx;
  const me = state.me || {};
  const myTeamId = me.team_id;
  let draft = state.draft;
  const nameOf = id => (ctx.teamsById[id] || {}).name || 'Team';

  if(draft.status === 'scheduled'){
    let order = draft.order_team_ids.slice();
    const claimed = (state.teams||[]).filter(t=>t.owner_id).length;
    const paintScheduled = ()=>{
      const changed = order.join() !== draft.order_team_ids.join();
      body.innerHTML = `
        <div class="draft-summary">
          <div><b>${draft.rounds}</b> rounds</div>
          <div><b>${escapeHtml(draft.draft_type === 'snake' ? 'Snake' : 'Linear')}</b> order</div>
          <div><b>${escapeHtml(countdownText(draft.pick_seconds*1000))}</b> per pick</div>
          <div><b>${claimed}/${state.teams.length}</b> teams claimed</div>
        </div>
        ${me.is_commissioner ? `
          <div class="alert info">Set the draft order, then start the draft when everyone's ready. Open teams can still be drafted for — by you, or by any manager once that team's clock runs out.</div>
        ` : `<div class="alert info">Waiting for the commissioner to start the draft.</div>`}
        <div class="section-label">Draft Order</div>
        <div class="order-list">${order.map((id,i)=>`<div class="order-row">
          <span class="bseed">${i+1}</span>
          <span class="team-name">${escapeHtml(nameOf(id))}</span>
          <span class="owner-name">${escapeHtml(ctx.teamsById[id].owner_name || 'Open')}</span>
          ${me.is_commissioner ? `<span class="order-move">
            <button class="ghost-btn small" data-up="${i}" ${i===0?'disabled':''} aria-label="Move up">&uarr;</button>
            <button class="ghost-btn small" data-down="${i}" ${i===order.length-1?'disabled':''} aria-label="Move down">&darr;</button>
          </span>` : ''}
        </div>`).join('')}</div>
        ${me.is_commissioner ? `<div class="button-row">
          <button class="secondary-btn" id="randomizeBtn">Randomize</button>
          ${changed ? `<button class="primary-btn" id="saveOrderBtn">Save Order</button>` : ''}
          <button class="primary-btn" id="startDraftBtn" ${changed?'disabled title="Save the order first"':''}>Start Draft</button>
        </div>` : ''}`;
      body.querySelectorAll('[data-up]').forEach(b=> b.addEventListener('click', ()=>{ const i=+b.dataset.up; [order[i-1],order[i]]=[order[i],order[i-1]]; paintScheduled(); }));
      body.querySelectorAll('[data-down]').forEach(b=> b.addEventListener('click', ()=>{ const i=+b.dataset.down; [order[i+1],order[i]]=[order[i],order[i+1]]; paintScheduled(); }));
      const alertEl = hostedAlertEl();
      const r = document.getElementById('randomizeBtn');
      if(r) r.addEventListener('click', ()=> hostedAction(r, alertEl, ()=> rpc('hosted_draft_randomize', { p_division_id: ctx.division.id }), 'Draft order randomized.'));
      const s = document.getElementById('saveOrderBtn');
      if(s) s.addEventListener('click', ()=> hostedAction(s, alertEl, ()=> rpc('hosted_draft_set_order', { p_division_id: ctx.division.id, p_team_ids: order }), 'Draft order saved.'));
      const st = document.getElementById('startDraftBtn');
      if(st) st.addEventListener('click', ()=>{
        if(!confirm('Start the draft now? The draft order locks and the first pick\'s clock begins.')) return;
        hostedAction(st, alertEl, ()=> rpc('hosted_draft_start', { p_division_id: ctx.division.id }), 'The draft is live!');
      });
    };
    paintScheduled();
    return;
  }

  // Drafting or complete
  body.innerHTML = `<div class="state-msg">Loading the draft room…</div>`;
  let ranked = [];
  try{ ranked = await ensureSeasonProjections(settings.season); }catch(e){ /* the board still works */ }

  const view = { tab: draft.status === 'drafting' ? 'players' : 'board', pos:'ALL', q:'' };
  body.innerHTML = `
    <div id="clockBanner"></div>
    <div class="fa-controls">
      <button class="fa-tab" data-view="players">Available Players</button>
      <button class="fa-tab" data-view="board">Draft Board</button>
      ${me.is_commissioner && draft.status === 'drafting' ? `<button class="ghost-btn small danger" id="undoPickBtn" style="margin-left:auto;">Undo last pick</button>` : ''}
    </div>
    <div id="draftPlayersControls" class="players-controls">
      <input class="form-input" id="draftSearch" placeholder="Search players…" autocomplete="off">
      <select class="form-select" id="draftPos">${['ALL', ...PROJ_POSITIONS].map(p=>`<option value="${p}">${p==='ALL'?'All positions':p}</option>`).join('')}</select>
    </div>
    <div id="draftMain"></div>`;

  const banner = document.getElementById('clockBanner');
  const main = document.getElementById('draftMain');
  const controls = document.getElementById('draftPlayersControls');
  let clockTimer = null;

  function onClock(){
    const pickNo = draft.picks.length + 1;
    const total = draft.rounds * draft.order_team_ids.length;
    if(draft.status !== 'drafting' || pickNo > total) return null;
    const teamId = draftTeamForPick(draft, pickNo);
    const deadline = Date.parse(draft.current_pick_started_at) + draft.pick_seconds*1000;
    return { pickNo, total, teamId, round: Math.floor((pickNo-1)/draft.order_team_ids.length)+1, deadline };
  }

  function canPick(clock){ return clock && (clock.teamId === myTeamId || me.is_commissioner); }
  function canAutopick(clock){
    return clock && !canPick(clock) && myTeamId && (Date.now() + ctx.serverOffset) > clock.deadline;
  }

  function paintBanner(){
    const clock = onClock();
    if(!clock){
      banner.innerHTML = `<div class="clock-banner done"><div><div class="clock-label">Draft complete</div>
        <div class="clock-team">${draft.picks.length} picks made</div></div>
        <a class="secondary-btn" href="${ctx.base}/team">Set your lineup &rarr;</a></div>`;
      return;
    }
    const remaining = clock.deadline - (Date.now() + ctx.serverOffset);
    const yours = clock.teamId === myTeamId;
    const best = bestAvailable();
    banner.innerHTML = `<div class="clock-banner ${yours?'yours':''} ${remaining<=0?'expired':''}">
      <div>
        <div class="clock-label">Round ${clock.round} &middot; Pick ${clock.pickNo} of ${clock.total}${yours ? ' &middot; You\'re on the clock' : ''}</div>
        <div class="clock-team">${escapeHtml(nameOf(clock.teamId))}</div>
      </div>
      <div class="clock-right">
        <div class="clock-time num">${remaining > 0 ? countdownText(remaining) : 'Time\'s up'}</div>
        ${canAutopick(clock) && best ? `<button class="secondary-btn small" id="autopickBtn">Autopick ${escapeHtml(playerNameOf(best.pid))}</button>` : ''}
      </div>
    </div>`;
    const ap = document.getElementById('autopickBtn');
    if(ap) ap.addEventListener('click', ()=> makePick(best.pid, ap, true));
  }

  function taken(){ return new Set(draft.picks.map(p=>p.player_id)); }
  function bestAvailable(){
    const t = taken();
    return ranked.find(r=> !t.has(r.pid) && playerRecord(r.pid) && r.adp < 9999) || null;
  }

  function paintPlayers(){
    const clock = onClock();
    const t = taken();
    const q = view.q.toLowerCase();
    let rows = ranked.filter(r=> !t.has(r.pid) && playerRecord(r.pid)
      && (view.pos === 'ALL' || positionOf(r.pid) === view.pos)
      && (!q || playerNameOf(r.pid).toLowerCase().includes(q)));
    rows = rows.slice(0, 100);
    const allow = draft.status === 'drafting' && canPick(clock);
    main.innerHTML = rows.length ? `<div class="table-scroll"><table class="standings fa-table">
      <thead><tr><th class="num">ADP</th><th>Player</th><th class="num col-optional">Season Proj</th><th></th></tr></thead>
      <tbody>${rows.map(r=>`<tr>
        <td class="num rank-cell">${r.adp < 9999 ? fmt1(r.adp) : '—'}</td>
        <td>${hPlayerChip(r.pid)}</td>
        <td class="num fa-proj col-optional">${fmt1(r.pts)}</td>
        <td class="num">${allow ? `<button class="primary-btn small" data-draft="${escapeHtml(r.pid)}">Draft</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="state-msg">${ranked.length ? 'No players match.' : 'Rankings are unavailable right now.'}</div>`;
    main.querySelectorAll('[data-draft]').forEach(btn=> btn.addEventListener('click', ()=> makePick(btn.dataset.draft, btn, false)));
  }

  function paintBoard(){
    const n = draft.order_team_ids.length;
    const byPick = {};
    draft.picks.forEach(p=>{ byPick[p.pick_no] = p; });
    const clock = onClock();
    let html = `<div class="table-scroll"><table class="draft-board"><thead><tr><th></th>${draft.order_team_ids.map(id=>`<th class="${id===myTeamId?'mine':''}">${escapeHtml(nameOf(id))}</th>`).join('')}</tr></thead><tbody>`;
    for(let r=1; r<=draft.rounds; r++){
      html += `<tr><th>R${r}</th>`;
      for(let col=0; col<n; col++){
        // Column = team's position in round-1 order; find this team's pick in round r.
        const idxInRound = draft.draft_type === 'snake' && r % 2 === 0 ? n - 1 - col : col;
        const pickNo = (r-1)*n + idxInRound + 1;
        const p = byPick[pickNo];
        const current = clock && clock.pickNo === pickNo;
        html += `<td class="${current?'current':''} ${p?'pos-'+escapeHtml(positionOf(p.player_id)):''}">
          <div class="board-pick">${pickNo}</div>
          ${p ? `<div class="board-name">${escapeHtml(playerNameOf(p.player_id))}</div><div class="board-meta">${escapeHtml(positionOf(p.player_id))} &middot; ${escapeHtml(nflTeamOf(p.player_id)||'')}</div>` : current ? '<div class="board-meta">On the clock</div>' : ''}
        </td>`;
      }
      html += `</tr>`;
    }
    main.innerHTML = html + `</tbody></table></div>`;
  }

  function paintMain(){
    body.querySelectorAll('[data-view]').forEach(b=> b.classList.toggle('active', b.dataset.view === view.tab));
    controls.hidden = view.tab !== 'players';
    if(view.tab === 'players') paintPlayers(); else paintBoard();
  }

  async function makePick(pid, btn, autopick){
    const alertEl = hostedAlertEl();
    if(btn) btn.disabled = true;
    try{
      await rpc('hosted_draft_pick', { p_division_id: ctx.division.id, p_player_id: pid, p_position: positionOf(pid) || null, p_autopick: !!autopick });
      alertEl.innerHTML = '';
      await reload();
    }catch(err){
      alertEl.innerHTML = `<div class="alert error">${escapeHtml(err.message)}</div>`;
      if(btn) btn.disabled = false;
      await reload();
    }
  }

  async function reload(){
    const fresh = await rpc('hosted_division_state', { p_division_id: ctx.division.id });
    const wasDrafting = draft.status === 'drafting';
    ctx.state = fresh; draft = fresh.draft;
    (fresh.teams||[]).forEach(t=>{ ctx.teamsById[t.id] = t; });
    if(wasDrafting && draft.status === 'complete'){ await hostedRefresh('The draft is complete! Lineups were filled in automatically — check yours.'); return; }
    paintBanner();
    paintMain();
  }

  body.querySelectorAll('[data-view]').forEach(b=> b.addEventListener('click', ()=>{ view.tab = b.dataset.view; paintMain(); }));
  let draftSearchTimer;
  document.getElementById('draftSearch').addEventListener('input', (e)=>{
    clearTimeout(draftSearchTimer);
    draftSearchTimer = setTimeout(()=>{ view.q = e.target.value.trim(); paintPlayers(); }, 150);
  });
  document.getElementById('draftPos').addEventListener('change', (e)=>{ view.pos = e.target.value; paintPlayers(); });
  const undo = document.getElementById('undoPickBtn');
  if(undo) undo.addEventListener('click', ()=>{
    if(!confirm('Undo the most recent pick? That player goes back into the pool.')) return;
    undo.disabled = true;
    rpc('hosted_draft_undo', { p_division_id: ctx.division.id })
      .then(()=> reload())
      .catch(err=>{ hostedAlertEl().innerHTML = `<div class="alert error">${escapeHtml(err.message)}</div>`; })
      .finally(()=>{ undo.disabled = false; });
  });

  paintBanner();
  paintMain();

  if(draft.status === 'drafting'){
    clockTimer = setInterval(()=>{
      if(!document.body.contains(banner)){ clearInterval(clockTimer); return; }
      const t = banner.querySelector('.clock-time');
      const clock = onClock();
      if(t && clock){
        const remaining = clock.deadline - (Date.now() + ctx.serverOffset);
        t.textContent = remaining > 0 ? countdownText(remaining) : "Time's up";
        if(remaining <= 0 && !banner.querySelector('.expired')) paintBanner();
      }
    }, 1000);
    startLive({
      anchor: main,
      pollable: true,
      interval: 3000,
      idleText: 'Draft live',
      refresh: async ()=>{ if(document.body.contains(main)) await reload(); }
    });
    live.anyLive = true;
    updateLiveStatus();
  }
}

/* ---------------------------- League (teams) ---------------------------- */

async function hostedLeagueTab(body, ctx){
  const { state, settings } = ctx;
  const me = state.me || {};
  const canClaim = session && !me.team_id && (me.is_member || state.league.is_public);
  const d = state.division || {};

  body.innerHTML = `
    ${ctx.league.format !== 'single' && d.commissioner_name ? `<div class="form-hint" style="margin-bottom:10px;">Division commissioner: <b>${escapeHtml(d.commissioner_name)}</b></div>` : ''}
    ${!session ? `<div class="alert info"><a href="${loginHref()}" style="text-decoration:underline;">Log in</a> to claim an open team.</div>` : ''}
    ${session && !me.team_id && !me.is_member && !state.league.is_public ? `<div class="alert info">This is a private league. Ask the commissioner for the invite link to join.</div>` : ''}
    <div class="team-list">${(state.teams||[]).map(t=>{
      const players = (t.roster||[]).map(r=>r.player_id);
      const lineup = currentLineupFor(ctx, t.id);
      return `<details class="team-row">
        <summary>
          <span class="bseed">${t.slot}</span>
          <span class="team-row-name"><span class="team-name">${escapeHtml(t.name)}</span>
            <span class="owner-name">${t.owner_id ? escapeHtml(t.owner_name || 'Manager') : 'Open team'}${t.id === me.team_id ? ' &middot; you' : ''}</span></span>
          <span class="num team-row-record">${teamRecordText(ctx, t.id)}</span>
          <span class="num owner-name">${players.length}/${(settings.roster_slots||[]).length}</span>
          ${!t.owner_id && canClaim ? `<button class="primary-btn small" data-claim="${t.id}">Claim</button>` : ''}
        </summary>
        <div class="team-row-roster">
          ${players.length ? `
            <div class="roster-section-head">Starters</div>
            ${ctx.slots.map((slot,i)=>`<div class="roster-row"><div class="rp-name"><span class="slot-tag">${escapeHtml(SLOT_LABEL[slot]||slot)}</span>${lineup[i] ? hPlayerChip(lineup[i]) : '<span class="empty-slot">Empty</span>'}</div></div>`).join('')}
            <div class="roster-section-head">Bench</div>
            ${players.filter(p=>!lineup.includes(p)).map(pid=>`<div class="roster-row"><div class="rp-name"><span class="slot-tag bench">BN</span>${hPlayerChip(pid)}</div></div>`).join('') || '<div class="form-hint">Nobody on the bench.</div>'}
          ` : '<div class="form-hint">No players yet.</div>'}
        </div>
      </details>`;
    }).join('')}</div>
    <div class="section-label">Rules</div>
    <div class="rules-grid">
      <div><span class="form-label">Scoring</span>${escapeHtml((SCORING_PRESETS[settings.scoring_preset]||{}).label || 'Custom')}</div>
      <div><span class="form-label">Roster</span>${escapeHtml(describeRoster(settings.roster_slots||[]))}</div>
      <div><span class="form-label">Season</span>${settings.season}, weeks ${settings.start_week}–${settings.start_week + settings.regular_season_weeks - 1}</div>
      <div><span class="form-label">Waivers</span>${settings.waiver_hours ? `${settings.waiver_hours} hours after a drop, rolling priority` : 'None — instant pickups'}</div>
      <div><span class="form-label">Playoffs</span>Top ${state.league.playoff_advance_count}, ${state.league.playoff_length_weeks} week${state.league.playoff_length_weeks===1?'':'s'}</div>
    </div>`;
  wireClaimButtons(body);
  body.querySelectorAll('[data-claim]').forEach(btn=> btn.addEventListener('click', e=> e.preventDefault(), { capture:true }));
}

/* ---------------------------- Playoffs (single leagues) ---------------------------- */

async function hostedPlayoffsTab(body, ctx){
  body.innerHTML = `<div id="bracketBody"><div class="state-msg">Building bracket…</div></div>`;
  await renderBracketInto(document.getElementById('bracketBody'), ctx.league, ctx.divisions);
}

/* ---------------------------- Activity ---------------------------- */

async function hostedActivityTab(body, ctx){
  body.innerHTML = `<div class="state-msg">Loading activity…</div>`;
  let list;
  try{ list = await rpc('hosted_transactions_list', { p_division_id: ctx.division.id, p_limit: 100 }); }
  catch(err){ body.innerHTML = `<div class="state-msg error">${escapeHtml(err.message)}</div>`; return; }
  const name = id => escapeHtml((ctx.teamsById[id] || {}).name || 'A team');
  const players = pids => (pids||[]).map(pid=> hPlayerChip(pid)).join(' ');
  if(!list || !list.length){ body.innerHTML = `<div class="state-msg">No transactions yet.</div>`; return; }
  body.innerHTML = `<div class="activity-list">${list.map(t=>{
    let text;
    if(t.kind === 'draft') text = `The draft finished (${(t.details||{}).picks || ''} picks).`;
    else if(t.kind === 'trade') text = `<b>${name(t.team_id)}</b> traded ${players(t.drops)} to <b>${name(t.other_team_id)}</b> for ${players(t.adds)}`;
    else if(t.kind === 'waiver') text = `<b>${name(t.team_id)}</b> won ${players(t.adds)} on waivers${t.drops.length ? ` and dropped ${players(t.drops)}` : ''}`;
    else if(t.kind === 'add') text = `<b>${name(t.team_id)}</b> added ${players(t.adds)}${t.drops.length ? ` and dropped ${players(t.drops)}` : ''}`;
    else if(t.kind === 'drop') text = `<b>${name(t.team_id)}</b> dropped ${players(t.drops)}`;
    else text = escapeHtml(t.kind);
    return `<div class="activity-row"><span class="activity-kind ${escapeHtml(t.kind)}">${escapeHtml(t.kind)}</span>
      <div class="activity-text">${text}</div>
      <span class="owner-name">${escapeHtml(new Date(t.created_at).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}))}</span></div>`;
  }).join('')}</div>`;
}

/* ---------------------------- Settings (commissioners) ---------------------------- */

async function hostedSettingsTab(body, ctx){
  const { state, settings } = ctx;
  const draft = state.draft;
  const scheduled = draft.status === 'scheduled';
  const optionList = (pairs, selected) => pairs.map(([v,l])=>`<option value="${v}" ${String(v)===String(selected)?'selected':''}>${escapeHtml(l)}</option>`).join('');
  const isLeagueCommish = session && session.user_id === state.league.commissioner_id;

  body.innerHTML = `
    <div class="section-label">Rules</div>
    <div class="form-row2">
      <div class="form-group"><label class="form-label">Waiver Period After a Drop</label>
        <select class="form-select" id="s_waivers">${optionList([[0,'No waivers — instant pickups'],[12,'12 hours'],[24,'24 hours'],[48,'48 hours'],[72,'72 hours'],[168,'1 week']], settings.waiver_hours)}</select></div>
      <div class="form-group"><label class="form-label">Draft Pick Timer</label>
        <select class="form-select" id="s_pick" ${draft.status==='complete'?'disabled':''}>${optionList([[30,'30 seconds'],[60,'60 seconds'],[90,'90 seconds'],[120,'2 minutes'],[300,'5 minutes'],[28800,'8 hours'],[86400,'24 hours']], draft.pick_seconds)}</select></div>
    </div>
    <div class="form-row2">
      <div class="form-group"><label class="form-label">First Week of the Season</label>
        <select class="form-select" id="s_start" ${scheduled?'':'disabled'}>${optionList(Array.from({length:18},(_,i)=>[i+1,`NFL Week ${i+1}`]), settings.start_week)}</select></div>
      <div class="form-group"><label class="form-label">Regular Season Length</label>
        <select class="form-select" id="s_weeks" ${scheduled?'':'disabled'}>${optionList(Array.from({length:18},(_,i)=>[i+1,`${i+1} week${i?'s':''}`]), settings.regular_season_weeks)}</select>
        ${scheduled ? '' : '<div class="form-hint">Locked once the draft starts.</div>'}</div>
    </div>
    <button class="primary-btn" id="saveRulesBtn">Save Rules</button>

    <div class="section-label">Teams</div>
    <div class="settings-teams">${(state.teams||[]).map(t=>`<div class="settings-team">
      <input class="form-input" value="${escapeHtml(t.name)}" maxlength="40" data-team-name="${t.id}" aria-label="Team name">
      <span class="owner-name">${t.owner_id ? escapeHtml(t.owner_name || 'Manager') : 'Open'}</span>
      <button class="ghost-btn small" data-save-name="${t.id}">Rename</button>
      ${t.owner_id ? `<button class="ghost-btn small danger" data-release="${t.id}">Remove manager</button>` : ''}
    </div>`).join('')}</div>
    ${ctx.league.format !== 'single' ? `<div class="footnote" style="text-align:left;">${isLeagueCommish ? `Division commissioner invites are on the <a href="#/league/${ctx.league.slug}/manage" style="text-decoration:underline;">Manage League</a> page.` : 'The league commissioner manages division commissioners.'}</div>` : ''}`;

  const alertEl = hostedAlertEl();
  document.getElementById('saveRulesBtn').addEventListener('click', (e)=>{
    const payload = { waiver_hours: +document.getElementById('s_waivers').value };
    if(draft.status !== 'complete') payload.pick_seconds = +document.getElementById('s_pick').value;
    if(scheduled){
      payload.start_week = +document.getElementById('s_start').value;
      payload.regular_season_weeks = +document.getElementById('s_weeks').value;
    }
    hostedAction(e.currentTarget, alertEl, ()=> rpc('hosted_update_settings', { p_division_id: ctx.division.id, p: payload }), 'Rules saved.');
  });
  body.querySelectorAll('[data-save-name]').forEach(btn=> btn.addEventListener('click', ()=>{
    const input = body.querySelector(`[data-team-name="${btn.dataset.saveName}"]`);
    hostedAction(btn, alertEl, ()=> rpc('rename_hosted_team', { p_team_id: btn.dataset.saveName, p_name: input.value }), 'Team renamed.');
  }));
  body.querySelectorAll('[data-release]').forEach(btn=> btn.addEventListener('click', ()=>{
    if(!confirm('Remove this manager? Their team and roster stay; the team becomes open for someone else to claim.')) return;
    hostedAction(btn, alertEl, ()=> rpc('release_hosted_team', { p_team_id: btn.dataset.release }), 'Manager removed — the team is now open.');
  }));
}

/* ============================ PLAYOFFS (real results) ============================
   When every division is hosted, playoff games are scored for real: each round
   is one NFL week after the regular season, using the same lineup replay as the
   regular season. Rounds that haven't finished fall back to the record-based
   projection the super league bracket already used.                          */

async function resolveHostedPlayoffGame(a, b, week){
  if(!a || !b || !a.hostedTeamId || !b.hostedTeamId) return null;
  const ca = divCache(a.divisionId).hosted, cb = divCache(b.divisionId).hosted;
  if(!ca || !cb) return null;
  const season = ca.ctx.settings.season;
  if(String(season) !== String(cb.ctx.settings.season) || week > 18) return null;
  const kick = await ensureKickoffs(season, week);
  if(Date.now() < kick.first) return null;           // not started: keep the projection
  const [ra, rb] = await Promise.all([hostedWeekResults(ca.ctx, week), hostedWeekResults(cb.ctx, week)]);
  const sa = ra.byTeam[a.hostedTeamId].points, sb = rb.byTeam[b.hostedTeamId].points;
  // Ties go to the higher seed.
  const winner = sa > sb ? a : sb > sa ? b : (a.seed < b.seed ? a : b);
  return { scoreA: sa, scoreB: sb, final: kick.final, winner };
}
