// v3_engine_full.js
// Full V3 Engine — PDF Machine Learner + Accuracy Booster + Blocks 1..8 + 9->8 mapping
// WARNING: Test on demo account. autotradeLive must be set explicitly to true to use real money.

(function(window){
  'use strict';

  /************************************************************************
   * Helper: addLog (centralized logging)
   ************************************************************************/
  function addLog(msg){
    try{
      const el = document.getElementById('log');
      const t = new Date().toLocaleTimeString();
      const line = `[${t}] ${msg}`;
      if(el) el.textContent = line + '\n' + el.textContent;
      else console.log(line);
    }catch(e){ console.log('log error', e); }
  }

  /************************************************************************
   * ACCURACY BOOSTER ENGINE (ruleWeights)
   ************************************************************************/
  let ruleWeights = {}; // { ruleId: { wins, losses, weight } }

  function updateRuleWeight(ruleId, correct){
    if(!ruleId) return;
    if(!ruleWeights[ruleId]) ruleWeights[ruleId] = { wins:0, losses:0, weight:1.0 };
    if(correct) ruleWeights[ruleId].wins++;
    else ruleWeights[ruleId].losses++;
    const meta = ruleWeights[ruleId];
    const total = meta.wins + meta.losses;
    if(total === 0) { meta.weight = 1; return; }
    meta.weight = Math.max(0.1, meta.wins / total);
  }

  function applyRuleWeighting(signal){
    if(!signal || !signal.reason) return signal;
    const ruleId = signal.reason;
    const meta = ruleWeights[ruleId];
    if(!meta) return signal;
    const weight = meta.weight;
    const boosted = Math.round(signal.confidence * (0.5 + weight));
    return { decision: signal.decision, reason: signal.reason + ' +weighted', confidence: boosted };
  }

  /************************************************************************
   * CORE ENGINE: state, worm, predict, fallback
   ************************************************************************/
  let recentDigits = [];
  let pdfEngineState = { active:false, built:null, strict:false };
  let lastPrediction = null; // { decision, prev, reason }
  let predictionCounter = 0;

  function wormEngine(prev, current){
    if(current > prev) return { worm:1, color:'UP' };
    if(current < prev) return { worm:-1, color:'DOWN' };
    return { worm:0, color:'NEUTRAL' };
  }

  function predictNext(digits, window){
    if(!digits || digits.length===0) return { digit:null, conf:0 };
    const w = Math.min(window || 12, digits.length);
    const last = digits.slice(-w);
    const freq = Array(10).fill(0);
    last.forEach(d => freq[d]++);
    const mx = Math.max(...freq);
    const digit = freq.indexOf(mx);
    const conf = Math.round((mx / last.length) * 100);
    return { digit, conf };
  }

  function ruleEngineFallback(digits){
    if(!digits || digits.length < 2) return { decision:null, reason:'no-signal', confidence:0 };
    const last = digits[digits.length-1], prev = digits[digits.length-2];
    const wrap = (prev===9 && last===0) || (prev===0 && last===9);
    if(Math.abs(last - prev) === 1 || wrap){
      const direction = (last>prev || (prev===9 && last===0)) ? 'UP' : 'DOWN';
      return { decision: direction, reason: 'fallback-diff1', confidence:55 };
    }
    return { decision:null, reason:'fallback-none', confidence:20 };
  }

  /************************************************************************
   * PDF RULE ENGINE WRAPPER (calls compiled ruleFunctions)
   ************************************************************************/
  window.ruleEngine = function(digits){
    if(pdfEngineState.active && pdfEngineState.built && pdfEngineState.built.ruleFunctions){
      const funcs = pdfEngineState.built.ruleFunctions;
      // priority maintained by buildExecutableRules earlier
      for(const fnObj of funcs){
        try{
          const out = fnObj.fn(digits);
          if(out && out.decision){
            out.reason = fnObj.id || out.reason || 'pdf-rule';
            return applyRuleWeighting(out);
          }
        }catch(e){
          console.warn('pdf rule error', fnObj.id, e);
        }
      }
    }
    const fallback = ruleEngineFallback(digits);
    return applyRuleWeighting(fallback);
  };

  /************************************************************************
   * AUTO-LEARNING (5-tick outcome)
   ************************************************************************/
  function recordPrediction(pred){
    lastPrediction = pred;
    predictionCounter = 5; // check after 5 ticks
  }
  function checkPredictionOutcome(latestDigit){
    if(!lastPrediction) return;
    predictionCounter--;
    if(predictionCounter <= 0){
      try{
        const correctDirection = (latestDigit > lastPrediction.prev) ? 'UP' : (latestDigit < lastPrediction.prev) ? 'DOWN' : null;
        const correct = (correctDirection && lastPrediction.decision === correctDirection);
        updateRuleWeight(lastPrediction.reason, !!correct);
      }catch(e){ console.warn('checkOutcome err', e); }
      lastPrediction = null;
    }
  }

  /************************************************************************
   * PUBLIC API: processDigit
   ************************************************************************/
  window.processDigit = function(digit){
    // push digit
    recentDigits.push(digit);
    if(recentDigits.length > 500) recentDigits.shift();

    // run rule engine (pdf + fallback + weighting)
    const sig = window.ruleEngine(recentDigits);

    if(sig && sig.decision){
      // record prediction for 5-tick evaluation
      recordPrediction({ decision: sig.decision, prev: recentDigits[recentDigits.length-2], reason: sig.reason });
    }

    // run check (this will reduce counter and update weights when time)
    checkPredictionOutcome(digit);

    return sig;
  };

  /************************************************************************
   * BLOCK X — DIGIT MAPPING (9 -> 8)
   ************************************************************************/
  let digitMappingEnabled = true;
  let mapNineToEight = true;

  function mapDigit(d){
    if(!digitMappingEnabled) return d;
    if(mapNineToEight && d === 9) return 8;
    return d;
  }

  /************************************************************************
   * BLOCK 1 — PDF Reader + Parser + Rule Builder (uses pdf.js if present)
   ************************************************************************/
  async function readPdfFile(file){
    if(!file) throw new Error('No PDF provided');
    if(typeof pdfjsLib === 'undefined') throw new Error('pdfjsLib not loaded');
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = '';
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map(it => it.str);
      fullText += strings.join(' ') + '\n';
    }
    return fullText;
  }

  function parsePdfTextToRules(text){
    const t = (text||'').replace(/\s+/g,' ').trim();
    const sentences = t.split(/\.|\n/).map(s=>s.trim()).filter(Boolean);
    const rules = [];
    // mapping rule: e.g. "0 > 9 = red" or "0 < 9 green"
    const mappingRegex = /(\d)\s*([<>])\s*(\d)[^a-zA-Z0-9]*(green|red|up|down|rise|fall)?/i;
    for(const s of sentences){
      const m = s.match(mappingRegex);
      if(m){
        rules.push({ type:'mapping', from: Number(m[1]), op: m[2], to: Number(m[3]), tag: (m[4]||'').toLowerCase(), raw: s });
      }
    }
    if(/diff(?:erence)?[- ]?1|adjacent.*1|differ by 1/i.test(t)) rules.push({ type:'diff-one', raw:'diff-1' });
    if(/dominant.*even|dominant.*odd|count.*even|count.*odd/i.test(t)) rules.push({ type:'dominant-even-odd', raw:'dominant-even-odd' });
    if(/breakout|local high|local low/i.test(t)) rules.push({ type:'breakout', raw:'breakout' });
    if(/5[-\s]?tick|five tick|predict.*5/i.test(t)) rules.push({ type:'five-tick', raw:'five-tick' });
    return { rules, rawText: t };
  }

  function buildExecutableRules(parsed){
    const ruleFunctions = [];
    parsed.rules.forEach((r, idx) => {
      if(r.type === 'mapping'){
        ruleFunctions.push({
          id: `pdf_map_${idx}`,
          type: 'exact-mapping',
          meta: r,
          fn: function(recent){
            if(!recent || recent.length < 2) return null;
            const prev = recent[recent.length-2], last = recent[recent.length-1];
            if(prev === r.from && last === r.to){
              const tag = (r.tag||'').toLowerCase();
              const decision = (tag.includes('green')||tag.includes('up')||tag.includes('rise')) ? 'UP' : (tag.includes('red')||tag.includes('down')||tag.includes('fall')) ? 'DOWN' : null;
              if(decision) return { decision, confidence:90, reason: `pdf_map_${idx}` };
            }
            return null;
          }
        });
      }
      if(r.type === 'diff-one'){
        ruleFunctions.push({
          id: `pdf_diffone_${idx}`,
          type: 'diff-one',
          meta: r,
          fn: function(recent){
            if(!recent || recent.length<2) return null;
            const prev = recent[recent.length-2], last = recent[recent.length-1];
            const wrap = (prev===9 && last===0) || (prev===0 && last===9);
            if(Math.abs(last - prev) === 1 || wrap){
              const decision = (last>prev || (prev===9 && last===0)) ? 'UP' : 'DOWN';
              return { decision, confidence:80, reason: `pdf_diffone_${idx}`};
            }
            return null;
          }
        });
      }
      if(r.type === 'dominant-even-odd'){
        ruleFunctions.push({
          id: `pdf_dom_${idx}`,
          type:'dominant-even-odd',
          meta:r,
          fn:function(recent){
            if(!recent || recent.length<5) return null;
            const lastN = recent.slice(-7);
            let even=0, odd=0;
            lastN.forEach(d=> (d%2===0)?even++:odd++);
            if(even>odd+1) return { decision:'UP', confidence:70, reason:`pdf_dom_${idx}` };
            if(odd>even+1) return { decision:'DOWN', confidence:70, reason:`pdf_dom_${idx}` };
            return null;
          }
        });
      }
      if(r.type === 'breakout'){
        ruleFunctions.push({
          id:`pdf_break_${idx}`,
          type:'breakout',
          meta:r,
          fn:function(recent){
            if(!recent || recent.length<5) return null;
            const last5 = recent.slice(-5);
            const mx = Math.max(...last5), mn = Math.min(...last5);
            const last = last5[last5.length-1];
            if(last >= mx) return { decision:'UP', confidence:75, reason:`pdf_break_${idx}` };
            if(last <= mn) return { decision:'DOWN', confidence:75, reason:`pdf_break_${idx}` };
            return null;
          }
        });
      }
      if(r.type === 'five-tick'){
        ruleFunctions.push({
          id:`pdf_5tick_${idx}`,
          type:'five-tick',
          meta:r,
          fn:function(recent){
            // placeholder - can be extended with more logic
            return null;
          }
        });
      }
    });
    return { ruleFunctions, priority: ['exact-mapping','diff-one','breakout','dominant-even-odd','five-tick','mapping'] };
  }

  window.parsePdfAndBuild = async function(file){
    try{
      const txt = await readPdfFile(file);
      const parsed = parsePdfTextToRules(txt);
      parsed.built = buildExecutableRules(parsed);
      window._lastParsedPdf = parsed;
      addLog('Parsed PDF → ' + parsed.rules.length + ' candidate rules.');
      return parsed;
    }catch(e){
      addLog('parsePdf error: ' + (e.message||e));
      throw e;
    }
  };

  window.applyParsedPdf = function(opts){
    opts = opts || {};
    if(!window._lastParsedPdf || !window._lastParsedPdf.built){
      addLog('No parsed PDF in memory. Parse first.');
      return;
    }
    pdfEngineState.active = true;
    pdfEngineState.built = window._lastParsedPdf.built;
    pdfEngineState.strict = !!opts.strict;
    addLog('Applied parsed PDF rules. strict=' + pdfEngineState.strict);
  };

  /************************************************************************
   * BLOCK 2 — WebSocket + Tick Stream Handler
   ************************************************************************/
  let ws = null;
  let isAuthorized = false;
  let currentServer = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

  window.derivConnect = function(url){
    try{
      if(ws) { try{ ws.close(); }catch(e){} ws=null; }
      currentServer = url || currentServer;
      ws = new WebSocket(currentServer);
      ws.onopen = () => addLog('WS Connected: ' + currentServer);
      ws.onclose = () => addLog('WS Disconnected');
      ws.onerror = (e) => addLog('WS Error: ' + (e && e.message?e.message:JSON.stringify(e)));
      ws.onmessage = (msg) => {
        try{
          const data = JSON.parse(msg.data);
          // Authorization ack
          if(data.authorize) { isAuthorized = true; addLog('Authorized'); }
          // Ticks
          if(data.tick && data.tick.quote !== undefined){
            const rawDigit = Number(String(data.tick.quote).slice(-1));
            const mapped = mapDigit(rawDigit);
            const signal = window.processDigit(mapped);
            addLog(`Tick ${rawDigit} (mapped:${mapped}) → ${JSON.stringify(signal)}`);
          }
          // proposals, buys, contracts handled by other hooks (see below)
          if(data.proposal) {
            // automatically buy if autotrade is enabled and proposal matches last desired
            try{ if(window._autoBuyOnProposal && autotradeEnabled){ buyFromProposal(data); } }catch(e){}
          }
          if(data.buy) {
            try{ handleBuy(data); }catch(e){}
          }
          if(data.contract) {
            try{ handleContractResult({ contract: data.contract }); }catch(e){}
          }
        }catch(e){ console.warn('ws msg parse err', e); }
      };
    }catch(e){
      addLog('derivConnect error: ' + (e.message||e));
    }
  };

  window.derivAuthorize = function(token){
    if(!ws || ws.readyState !== 1) { addLog('WS not ready. Connect first.'); return; }
    if(!token) { addLog('No token provided'); return; }
    ws.send(JSON.stringify({ authorize: token }));
    addLog('Authorize request sent (token hidden)');
  };

  window.subscribeTicks = function(symbol){
    if(!ws || ws.readyState !== 1){ addLog('WS not ready'); return; }
    ws.send(JSON.stringify({ ticks: symbol }));
    addLog('Subscribed to ticks: ' + symbol);
  };

  /************************************************************************
   * BLOCK 3 — Proposal + Buy Auto-Trade Engine
   ************************************************************************/
  let lastContractId = null;
  let autotradeEnabled = false;
  let autotradeDemo = true;      // if true use demo; if false allow live buys but require explicit setting autotradeLive=true
  let autotradeLive = false;     // must be explicitly set true by user to enable live buys
  let _autoBuyOnProposal = true; // auto-buy when we receive a proposal (use cautiously)

  window.sendProposal = function(params){
    if(!ws || ws.readyState !== 1){ addLog('WS not ready to send proposal'); return; }
    const p = {
      // binaryws v3: request structure for proposal (older style). This example is "proposal" wrapper to get a price.
      proposal: 1,
      amount: params.amount || 1,
      basis: 'stake',
      contract_type: params.type, // 'RISE' or 'FALL' or CALL/PUT depending on API
      symbol: params.symbol || 'R_100',
      duration: params.duration || 5,
      duration_unit: params.duration_unit || 't',
      currency: params.currency || 'USD'
    };
    ws.send(JSON.stringify(p));
    addLog('Proposal sent → ' + JSON.stringify({type:p.contract_type, amount:p.amount, dur:p.duration}));
  };

  function buyFromProposal(data){
    try{
      if(!data.proposal) return;
      const pid = data.proposal.id;
      // decide whether to buy: we will buy automatically only in demo mode or if autotradeLive is true
      if(!autotradeEnabled) { addLog('Autotrade disabled — ignoring proposal'); return; }
      if(autotradeDemo){
        const buyReq = { buy: pid };
        ws.send(JSON.stringify(buyReq));
        addLog('Auto-buy (demo) sent for proposal id: ' + pid);
      }else{
        if(autotradeLive){
          const buyReq = { buy: pid };
          ws.send(JSON.stringify(buyReq));
          addLog('Auto-buy (live) sent for proposal id: ' + pid);
        }else{
          addLog('Autotrade live disabled — not buying live proposals.');
        }
      }
    }catch(e){ addLog('buyFromProposal err: ' + e.message); }
  }

  function handleBuy(data){
    try{
      if(!data.buy) return;
      lastContractId = data.buy.contract_id || data.buy.transaction_id || null;
      addLog('Bought contract: ' + lastContractId);
      // store for monitor
      window.lastBoughtContract = lastContractId;
    }catch(e){ addLog('handleBuy err: ' + e.message); }
  }

  window.runAutoTrade = function(decision){
    if(!autotradeEnabled) { addLog('Autotrade disabled'); return; }
    if(!checkRiskLimits()) { addLog('Risk limits prevent trading'); return; }
    const stake = risk.lastStake || 1;
    const type = (decision === 'UP') ? 'RISE' : 'FALL';
    window.sendProposal({ type: type, amount: stake, duration: risk.defaultDuration || 5, duration_unit:'t', symbol: risk.symbol || 'R_100' });
    addLog('runAutoTrade → ' + decision + ' (stake=' + stake + ')');
  };

  /************************************************************************
   * BLOCK 4 — Worm Renderer Engine
   ************************************************************************/
  let wormCanvas = null, wormCtx = null, wormX = 0, wormY = 40, wormTrail = [];
  function initWormCanvas(){
    try{
      wormCanvas = document.getElementById('wormCanvas');
      if(!wormCanvas) return;
      wormCtx = wormCanvas.getContext('2d');
      wormCanvas.width = wormCanvas.clientWidth || 600;
      wormCanvas.height = wormCanvas.clientHeight || 140;
      wormX = 0;
      wormY = wormCanvas.height/2;
      wormTrail = [];
    }catch(e){ console.warn('initWormCanvas', e); }
  }
  function drawWormFrame(direction){
    try{
      if(!wormCtx) return;
      wormX += 4;
      if(wormX > wormCanvas.width) { wormX = 0; wormTrail = []; wormCtx.clearRect(0,0,wormCanvas.width,wormCanvas.height); }
      if(direction === 'UP') wormY -= 3;
      else if(direction === 'DOWN') wormY += 3;
      wormY = Math.max(10, Math.min(wormCanvas.height-10, wormY));
      wormTrail.push({x:wormX, y:wormY, dir:direction});
      wormCtx.clearRect(0,0,wormCanvas.width,wormCanvas.height);
      wormTrail.forEach(p=>{
        wormCtx.beginPath();
        wormCtx.fillStyle = (p.dir==='UP')? '#10b981' : (p.dir==='DOWN')? '#ef4444' : '#94a3b8';
        wormCtx.arc(p.x, p.y, 3, 0, Math.PI*2);
        wormCtx.fill();
      });
    }catch(e){ console.warn('drawWorm', e); }
  }
  // wrap processDigit to draw worm
  (function(){
    const original = window.processDigit;
    window.processDigit = function(d){
      const sig = original(d);
      try{
        if(sig && sig.decision) drawWormFrame(sig.decision);
        else drawWormFrame('NEUTRAL');
      }catch(e){}
      return sig;
    };
  })();
  setTimeout(initWormCanvas, 300);

  /************************************************************************
   * BLOCK 5 — Multi-Layer Prediction Engine
   ************************************************************************/
  function layer_pdfRules(digits){
    if(pdfEngineState.active && pdfEngineState.built && pdfEngineState.built.ruleFunctions){
      for(const r of pdfEngineState.built.ruleFunctions){
        try{
          const out = r.fn(digits);
          if(out && out.decision) return { src: r.id, dec: out.decision, conf: out.confidence || 70 };
        }catch(e){}
      }
    }
    return null;
  }
  function layer_frequency(digits){
    if(!digits || digits.length < 5) return null;
    const last = digits.slice(-20);
    const freq = Array(10).fill(0);
    last.forEach(d=> freq[d]++);
    const mx = Math.max(...freq);
    const idx = freq.indexOf(mx);
    // heuristic: digits >5 bias UP, <=5 bias DOWN (simple)
    return { src:'freq', dec: (idx>5)?'UP':'DOWN', conf: Math.round(50 + (mx/last.length)*40) };
  }
  function layer_momentum(digits){
    if(!digits || digits.length < 3) return null;
    const a = digits[digits.length-1], b = digits[digits.length-2], c = digits[digits.length-3];
    const up = (a>b) && (b>c);
    const down = (a<b) && (b<c);
    if(up) return { src:'momentum', dec:'UP', conf:60 };
    if(down) return { src:'momentum', dec:'DOWN', conf:60 };
    return null;
  }
  function layer_wormBias(digits){
    if(!digits || digits.length < 2) return null;
    const prev = digits[digits.length-2], last = digits[digits.length-1];
    if(last>prev) return { src:'worm', dec:'UP', conf:45 };
    if(last<prev) return { src:'worm', dec:'DOWN', conf:45 };
    return null;
  }
  function blendLayers(outputs){
    const valid = outputs.filter(Boolean);
    if(!valid.length) return null;
    const scores = { UP:0, DOWN:0 };
    valid.forEach(o=>{
      const weight = o.conf || 50;
      scores[o.dec] += weight;
    });
    const final = (scores.UP >= scores.DOWN) ? 'UP' : 'DOWN';
    const conf = Math.round(Math.max(scores.UP, scores.DOWN) / valid.length);
    return { decision: final, confidence: conf };
  }
  // provide a merged processDigit that blends
  (function(){
    const oldPD = window.processDigit;
    window.processDigit = function(digit){
      // call original to preserve learning and pdf rule calls
      const base = oldPD(digit);
      try{
        const d = recentDigits;
        const L1 = layer_pdfRules(d);
        const L2 = layer_frequency(d);
        const L3 = layer_momentum(d);
        const L4 = layer_wormBias(d);
        const blend = blendLayers([L1,L2,L3,L4]);
        return blend || base;
      }catch(e){
        return base;
      }
    };
  })();

  /************************************************************************
   * BLOCK 6 — Auto-Trade Evaluator + Contract Monitor + Learning
   ************************************************************************/
  let contractResults = [];
  let lastBoughtContract = null;
  let contractCheckInterval = null;

  function checkContractResult(contractId){
    if(!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ contract: contractId })); // request contract details
  }
  function handleContractResult(data){
    if(!data || !data.contract) return;
    const status = data.contract.status;
    const profit = Number(data.contract.profit) || 0;
    contractResults.push({ status, profit, time: Date.now() });
    if(contractResults.length > 200) contractResults.shift();
    addLog('Contract result → ' + status + ' | Profit: ' + profit);
    // learning: compare lastPrediction to actual direction (won/lost)
    if(lastPrediction && lastPrediction.reason){
      const won = (status === 'won' || status === 'won' /* API may vary */);
      updateRuleWeight(lastPrediction.reason, !!won);
      // clear lastPrediction to avoid double-count
      lastPrediction = null;
    }
  }
  // extend ws.onmessage if possible
  // start simple interval to poll lastBoughtContract (best-effort)
  function startContractMonitor(){ if(contractCheckInterval) clearInterval(contractCheckInterval); contractCheckInterval = setInterval(()=>{ if(window.lastBoughtContract) checkContractResult(window.lastBoughtContract); }, 1500); }
  startContractMonitor();

  /************************************************************************
   * BLOCK 7 — Risk Management
   ************************************************************************/
  let risk = {
    stopLoss: -10,   // session USD
    takeProfit: 20,  // session USD
    maxTrades: 30,   // per session
    martingale: false,
    mFactor: 1.5,
    sessionPL: 0,
    tradeCount: 0,
    lastStake: 1,
    defaultDuration: 5,
    symbol: 'R_100'
  };

  window.setRiskConfig = function(cfg){ Object.assign(risk, cfg); addLog('Risk updated → ' + JSON.stringify(risk)); };

  function checkRiskLimits(){
    if(risk.sessionPL <= risk.stopLoss){ autotradeEnabled = false; addLog('AUTO-STOP: Stop-loss hit'); return false; }
    if(risk.sessionPL >= risk.takeProfit){ autotradeEnabled = false; addLog('AUTO-STOP: Take-profit reached'); return false; }
    if(risk.tradeCount >= risk.maxTrades){ autotradeEnabled = false; addLog('AUTO-STOP: Max trades reached'); return false; }
    return true;
  }

  // wrap handleBuy to update counts
  (function(){
    const _h = window.handleBuy || function(){};
    window.handleBuy = function(data){
      try{ _h(data); }catch(e){}
      try{ risk.tradeCount++; }catch(e){}
    };
  })();

  (function(){
    const _hc = handleContractResult;
    window.handleContractResult = function(data){
      try{ _hc(data); }catch(e){}
      try{
        if(data && data.contract){
          const profit = Number(data.contract.profit) || 0;
          risk.sessionPL += profit;
          addLog('Session P/L = ' + risk.sessionPL);
          checkRiskLimits();
        }
      }catch(e){}
    };
  })();

  // extend runAutoTrade to observe martingale and stake
  (function(){
    const _old = window.runAutoTrade;
    window.runAutoTrade = function(dec){
      if(!checkRiskLimits()) return;
      if(risk.martingale && lastPrediction){
        if(lastPrediction.correct === false) risk.lastStake = (risk.lastStake || 1) * risk.mFactor;
        else risk.lastStake = 1;
      }
      // use lastStake and symbol
      const stake = risk.lastStake || 1;
      window.sendProposal({ type: dec==='UP' ? 'RISE' : 'FALL', amount: stake, duration: risk.defaultDuration, duration_unit:'t', symbol: risk.symbol });
    };
  })();

  /************************************************************************
   * BLOCK 8 — UI Control Panel (floating)
   ************************************************************************/
  (function createControlPanel(){
    try{
      const panel = document.createElement('div');
      panel.style.position = 'fixed';
      panel.style.bottom = '18px';
      panel.style.right = '18px';
      panel.style.width = '220px';
      panel.style.padding = '10px';
      panel.style.background = 'rgba(0,0,0,0.62)';
      panel.style.color = '#fff';
      panel.style.borderRadius = '10px';
      panel.style.fontSize = '12px';
      panel.style.zIndex = 99999;
      panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
      panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Deriv Worm — Controls</div>`;

      // Autotrade on/off
      const atOn = document.createElement('button');
      atOn.textContent = 'Autotrade ON';
      atOn.style.width = '100%';
      atOn.style.marginBottom = '6px';
      const atOff = document.createElement('button');
      atOff.textContent = 'Autotrade OFF';
      atOff.style.width = '100%';
      atOff.style.marginBottom = '6px';

      atOn.onclick = ()=>{
        autotradeEnabled = true;
        addLog('Autotrade ENABLED');
      };
      atOff.onclick = ()=>{
        autotradeEnabled = false;
        addLog('Autotrade DISABLED');
      };

      // Martingale toggles
      const mOn = document.createElement('button');
      mOn.textContent = 'Martingale ON';
      mOn.style.width = '48%';
      const mOff = document.createElement('button');
      mOff.textContent = 'Martingale OFF';
      mOff.style.width = '48%';
      mOn.onclick = ()=>{ risk.martingale = true; addLog('Martingale ON'); };
      mOff.onclick = ()=>{ risk.martingale = false; addLog('Martingale OFF'); };

      // Stake input
      const stLabel = document.createElement('div'); stLabel.textContent = 'Stake:'; stLabel.style.marginTop = '8px';
      const stakeInput = document.createElement('input'); stakeInput.type='number'; stakeInput.value = risk.lastStake||1; stakeInput.style.width='100%';
      stakeInput.onchange = (e)=>{ const v = Number(e.target.value)||1; risk.lastStake = v; addLog('Stake set to ' + v); };

      // Mapping controls
      const mapLabel = document.createElement('div'); mapLabel.textContent = 'Digit Mapping (9→8):'; mapLabel.style.marginTop='8px';
      const mapOn = document.createElement('button'); mapOn.textContent = 'Map ON'; mapOn.style.width='48%';
      const mapOff = document.createElement('button'); mapOff.textContent = 'Map OFF'; mapOff.style.width='48%';
      mapOn.onclick = ()=>{ digitMappingEnabled = true; mapNineToEight = true; addLog('Digit mapping ENABLED (9→8)'); };
      mapOff.onclick = ()=>{ digitMappingEnabled = false; addLog('Digit mapping DISABLED'); };

      // Live/demo toggle
      const liveLabel = document.createElement('div'); liveLabel.textContent='Trade Mode:'; liveLabel.style.marginTop='8px';
      const demoBtn = document.createElement('button'); demoBtn.textContent = 'Demo'; demoBtn.style.width='48%';
      const liveBtn = document.createElement('button'); liveBtn.textContent = 'Live'; liveBtn.style.width='48%';
      demoBtn.onclick = ()=>{ autotradeDemo = true; autotradeLive = false; addLog('Mode: DEMO'); };
      liveBtn.onclick = ()=>{ autotradeDemo = false; autotradeLive = true; addLog('Mode: LIVE (use with caution)'); };

      // Append elements
      panel.appendChild(atOn); panel.appendChild(atOff);
      const row1 = document.createElement('div'); row1.style.display='flex'; row1.style.justifyContent='space-between'; row1.style.gap='4px';
      row1.appendChild(mOn); row1.appendChild(mOff);
      panel.appendChild(row1);
      panel.appendChild(stLabel); panel.appendChild(stakeInput);
      panel.appendChild(mapLabel);
      const row2 = document.createElement('div'); row2.style.display='flex'; row2.style.justifyContent='space-between'; row2.style.gap='4px';
      row2.appendChild(mapOn); row2.appendChild(mapOff);
      panel.appendChild(row2);
      panel.appendChild(liveLabel);
      const row3 = document.createElement('div'); row3.style.display='flex'; row3.style.gap='4px';
      row3.appendChild(demoBtn); row3.appendChild(liveBtn);
      panel.appendChild(row3);

      // Add small readout
      const info = document.createElement('div'); info.style.marginTop='8px'; info.style.fontSize='11px'; info.textContent = 'Autotrade: OFF • Mode: DEMO';
      panel.appendChild(info);

      // Update readout periodically
      setInterval(()=>{ info.textContent = 'Autotrade: ' + (autotradeEnabled? 'ON':'OFF') + ' • Mode: ' + (autotradeDemo? 'DEMO':'LIVE') + ' • Mapping: ' + (digitMappingEnabled? '9→8 ON':'OFF'); }, 900);

      document.body.appendChild(panel);
    }catch(e){ console.warn('createControlPanel err', e); }
  })();

  /************************************************************************
   * Export some controls to window for convenience
   ************************************************************************/
  window._engine = {
    version: 'v3-full-merged-1',
    ruleWeights: ruleWeights,
    recentDigits: recentDigits,
    pdfState: pdfEngineState,
    setMapping: function(enabled, nineToEight){
      digitMappingEnabled = !!enabled;
      mapNineToEight = !!nineToEight;
      addLog('Mapping set → enabled:' + digitMappingEnabled + ' map9to8:' + mapNineToEight);
    },
    setAutotrade: function(on){
      autotradeEnabled = !!on;
      addLog('Autotrade set → ' + autotradeEnabled);
    },
    setLiveMode: function(isLive){
      autotradeLive = !!isLive;
      autotradeDemo = !autotradeLive;
      addLog('Live mode set → ' + autotradeLive);
    },
    getState: function(){ return { ruleWeights, recentDigits, pdfEngineState, risk }; }
  };

  addLog('v3_engine_full.js loaded (merged). Test on demo first.');

  // End IIFE
})(window);


