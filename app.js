/* 识字消消乐 · TV 版
 * 功能、界面元素、文案、状态机、判定规则、音频资源均按原版 APK
 * (com.littlestar.literacy, 识字消消乐 V2) 一比一还原。
 * 原版类对应关系：
 *   Content          -> MODES / HANZI / buildRound()
 *   GameSession      -> S / newRound() / start() / tap() / advanceToNextTarget()
 *   GameBoardView    -> renderBoard() / layoutBoard() / 卡片绘制
 *   MainActivity     -> renderState() / onCellTapped() / 各按钮回调
 *   AudioEngine      -> Audio
 *   FeedbackPicker   -> pickDifferent()
 *   VoiceMap         -> VOICE_GROUPS
 * TV 适配层为新增：焦点导航、DPAD/OK/返回键、overscan 安全区、横屏布局。
 */
(function () {
  'use strict';

  var HANZI = window.HANZI_DATA || [];
  var GRADES = window.GRADES || [{ id: 'all', label: '全部' }];
  var PACK_ITEMS = window.PACK_ITEMS || {};
  var K12_BANK = window.K12_BANK || [];
  var MODES = window.PACKS || {
    NUMBER: { label: '数字', count: 20 },
    LETTER: { label: '字母', count: 10 },
    HANZI:  { label: '汉字', count: 10 }
  };
  MODES.K12 = { label: '题库', count: 10 };
  var MODE_ORDER = ['NUMBER', 'LETTER', 'HANZI', 'MATH', 'ENGLISH', 'PINYIN', 'COMMON', 'K12'];

  /* ── 跨科学习档案：错题库 / 掌握度（localStorage 不可用时退化为内存） ── */
  var STORE_KEY = 'literacyTV.progress.v1';
  var PROGRESS = {};
  try { PROGRESS = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { PROGRESS = {}; }
  function saveProgress() { try { localStorage.setItem(STORE_KEY, JSON.stringify(PROGRESS)); } catch (e) {} }
  function itemKey(mode, it) { return mode + ':' + (it.id || it.text); }
  function statOf(mode, it) { return PROGRESS[itemKey(mode, it)] || { right: 0, wrong: 0, last: 0, streak: 0 }; }
  function recordAnswer(mode, it, correct) {
    if (!it) return;
    var k = itemKey(mode, it);
    var st = PROGRESS[k] || { right: 0, wrong: 0, last: 0, streak: 0 };
    if (correct) { st.right++; st.streak++; } else { st.wrong++; st.streak = 0; }
    st.last = Date.now();
    PROGRESS[k] = st;
    saveProgress();
  }
  function weightOf(mode, it) {
    var st = statOf(mode, it);
    var days = (Date.now() - (st.last || 0)) / 86400000;
    return (st.wrong || 0) * 2.5 + Math.min(days, 7) * 0.35
      + (st.streak >= 3 ? -3 : 0) + Math.random() * 5;
  }

  /* 原版 GameBoardView.CARD_COLORS —— 10 色按索引循环 */
  var CARD_COLORS = [
    '#FFE0B2', '#B3E5FC', '#C8E6C9', '#FFCDD2', '#E1BEE7',
    '#FFF9C4', '#B2DFDB', '#CCFFBC', '#D1C4E9', '#C5CAE9'
  ];

  /* 原版 VoiceMap 的反馈音频分组 */
  var VOICE_GROUPS = {
    winVoice:  ['win_1.mp3', 'win_2.mp3', 'win_3.mp3', 'win_4.mp3'],
    loseVoice: ['lose_1.mp3', 'lose_2.mp3', 'lose_3.mp3'],
    doneVoice: ['done_1.mp3'],
    winChime:  ['chime_win_1.wav', 'chime_win_2.wav', 'chime_win_3.wav'],
    loseChime: ['chime_lose_1.wav', 'chime_lose_2.wav'],
    doneChime: ['chime_done.wav']
  };

  var TXT = {
    hintIdleReady: '准备好了吗？点一下开始吧！',
    hintStartAdvanced: '专心听！点出刚才说的那个～',
    hintStartNormal: '仔细听，点出刚才说的那个～',
    hintWrongAdvanced: '不是这个，再听一遍试试～',
    hintWrongNormal: '哎呀，不是这个，再听一次试试～',
    hintRight: '答对啦！你真棒！🎉',
    hintFinish: '太棒了！点「再来一局」继续玩吧',
    hintAdvancedOn: '进阶模式：只看耳朵，专心听哦！',
    hintAdvancedOff: '普通模式：看着字就能找～',
    targetAdvanced: '👂 听声音，找出它',
    targetNormal: '🔊 找出它',
    targetIdle: '👆 点「开始」，我来告诉你找哪个～',
    targetDone: '🎉 全部完成啦！'
  };

  /* ── 音频引擎（对应 AudioEngine：MediaPlayer 语音 + SoundPool 音效） ── */
  var Audio = (function () {
    var unlocked = false;
    var token = 0;
    var current = null;
    var muted = false;

    function unlock() {
      if (unlocked) return;
      unlocked = true;
      try {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) { var ctx = new C(); ctx.resume(); }
      } catch (e) { /* 忽略：HTMLAudioElement 通常仍可播放 */ }
      if (window.AndroidTV && window.AndroidTV.onUserGesture) window.AndroidTV.onUserGesture();
    }

    function playFile(name) {
      if (!name) return null;
      var a = new window.Audio('audio/' + name);
      a.preload = 'auto';
      try {
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
      return a;
    }

    function speakTTS(text, done, lang) {
      if (!text || !window.speechSynthesis) { if (done) done(); return; }
      try {
        speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = lang || (/[a-zA-Z]/.test(text) && !/[\u4e00-\u9fa5]/.test(text) ? 'en-US' : 'zh-CN');
        u.rate = 0.9;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
        setTimeout(done, 6500);
      } catch (e) { if (done) done(); }
    }
    /* 直接朗读纯文本（题库题干没有配套录音时用系统 TTS） */
    function speakText(text, done, lang) {
      this.stopSpeech();
      if (muted) { setTimeout(function () { if (done) done(); }, 60); return; }
      speakTTS(text, done, lang);
    }

    return {
      unlock: unlock,
      speakText: speakText,
      setMuted: function (v) { muted = v; if (v) this.stopSpeech(); },
      isMuted: function () { return muted; },
      stopSpeech: function () {
        token++;
        if (current) {
          try { current.pause(); current.currentTime = 0; } catch (e) {}
          current = null;
        }
        if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
      },
      playChime: function (name) { if (!muted) playFile(name); },
      /* 原版 playFeedback(voice, chime)：语音与提示音同时播放 */
      playFeedback: function (voice, chime) {
        this.playChime(chime);
        this.speak(voice);
      },
      /* 原版 speakThen(resId, runnable)：语音播完后执行回调 */
      speak: function (name, done, fallbackText) {
        this.stopSpeech();
        var my = ++token;
        var finished = false;
        var timer = null;
        var self = this;
        function finish() {
          if (finished || my !== token) return;
          finished = true;
          if (timer) clearTimeout(timer);
          if (done) done();
        }
        if (muted) { setTimeout(finish, 60); return; }
        var a = playFile(name);
        if (!a) { timer = setTimeout(finish, 200); return; }
        current = a;
        a.onended = finish;
        a.onerror = function () { speakTTS(fallbackText, finish); };
        timer = setTimeout(finish, 6000); /* 加载失败/无音频设备时保底，避免流程卡死 */
      }
    };
  })();

  /* ── FeedbackPicker：随机挑选且不与上一次重复 ── */
  var lastPick = {
    winVoice: -1, loseVoice: -1, doneVoice: -1,
    winChime: -1, loseChime: -1, doneChime: -1
  };
  function pick(group) {
    var arr = VOICE_GROUPS[group];
    var last = lastPick[group];
    if (!arr || !arr.length) return '';
    var i;
    if (arr.length === 1) i = 0;
    else {
      i = Math.floor(Math.random() * arr.length);
      if (i === last) i = (i + 1 + Math.floor(Math.random() * (arr.length - 1))) % arr.length;
    }
    lastPick[group] = i;
    return arr[i];
  }

  /* ── Content / GameSession ── */
  var S = {
    mode: 'NUMBER', grade: 'all', advanced: false, phase: 'IDLE',
    round: [], removed: [], order: [], orderPos: 0,
    currentTarget: -1, awaitingFeedback: false
  };

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 字表第 4 列显式指定音频；缺省时按下标推算（2 位补零，支持任意数量） */
  function hanziVoice(i) {
    var row = HANZI[i];
    if (row[3]) return row[3];
    return 'v_chr_' + String(i + 1).padStart(2, '0') + '.mp3';
  }

  /* 原版 APK 的 100 字：按 v_chr_NN 编号恢复原版顺序，作为独立字库范围 */
  var ORIG_ITEMS = HANZI
    .filter(function (r) { return String(r[3]).indexOf('v_chr_') === 0; })
    .sort(function (a, b) { return parseInt(a[3].slice(6), 10) - parseInt(b[3].slice(6), 10); })
    .map(function (r) { return { text: r[0], voice: r[3], pinyin: r[1] }; });

  function gradeLabel(id) {
    for (var i = 0; i < GRADES.length; i++) if (GRADES[i].id === id) return GRADES[i].label;
    return '';
  }

  /* 通用出题：内容包 → 年级过滤 → 错题权重 → 答案去重 → 洗牌取 count */
  function buildRound(mode) {
    var all = [], i;
    if (PACK_ITEMS[mode]) {
      all = PACK_ITEMS[mode].slice();
    } else if (mode === 'NUMBER') {
      for (i = 1; i <= 100; i++) all.push({ text: String(i), voice: 'v_num_' + i + '.mp3', pinyin: null });
    } else if (mode === 'LETTER') {
      for (i = 0; i < 26; i++) {
        var c = String.fromCharCode(65 + i);
        all.push({ text: c, voice: 'v_let_' + c.toLowerCase() + '.mp3', pinyin: null });
      }
    } else if (S.grade === 'orig') {
      all = ORIG_ITEMS.slice();
    } else {
      for (i = 0; i < HANZI.length; i++) {
        if (S.grade !== 'all' && HANZI[i][2] !== S.grade) continue;
        all.push({ text: HANZI[i][0], voice: hanziVoice(i), pinyin: HANZI[i][1] });
      }
    }
    var count = Math.min(MODES[mode].count, all.length);
    all.forEach(function (it) { it._w = weightOf(mode, it); });
    all.sort(function (a, b) { return b._w - a._w; });
    var cand = shuffle(all.slice(0, Math.min(all.length, count * 3)));
    var chosen = [], seen = {};
    for (i = 0; i < cand.length && chosen.length < count; i++) {
      var it = cand[i];
      if (MODES[mode].uniqueText && seen[it.text]) continue;
      seen[it.text] = 1;
      chosen.push(it);
    }
    if (chosen.length < count && MODES[mode].uniqueText) {
      for (i = 0; i < all.length && chosen.length < count; i++) {
        var x = all[i];
        if (seen[x.text]) continue;
        seen[x.text] = 1;
        chosen.push(x);
      }
    }
    return shuffle(chosen);
  }

  function newRound() {
    S.round = buildRound(S.mode);
    S.removed = new Array(S.round.length).fill(false);
    S.order = S.round.map(function (_, i) { return i; });
    shuffle(S.order);
    S.orderPos = 0;
    S.currentTarget = -1;
    S.phase = 'IDLE';
  }

  function resetProgress() {
    S.removed = new Array(S.round.length).fill(false);
    S.orderPos = 0;
    S.currentTarget = -1;
  }

  function advanceToNextTarget() {
    while (S.orderPos < S.order.length && S.removed[S.order[S.orderPos]]) S.orderPos++;
    if (S.orderPos >= S.order.length) {
      S.currentTarget = -1;
      S.phase = 'CLEARED';
      return -1;
    }
    S.currentTarget = S.order[S.orderPos];
    return S.currentTarget;
  }

  function start() {
    if (S.phase === 'CLEARED') newRound();
    else if (S.phase === 'PLAYING') resetProgress();
    S.phase = 'PLAYING';
    S.awaitingFeedback = false;
    return advanceToNextTarget();
  }

  function tap(idx) {
    if (S.phase !== 'PLAYING' || S.currentTarget < 0 || S.awaitingFeedback) return 'IGNORED';
    if (idx < 0 || idx >= S.removed.length || S.removed[idx]) return 'IGNORED';
    if (idx !== S.currentTarget) return 'WRONG';
    S.removed[idx] = true;
    return 'CORRECT';
  }

  function remaining() { return S.removed.filter(function (r) { return !r; }).length; }
  function total() { return S.round.length; }

  /* ── K12 题库：按学科 / 年级 / 学期筛选的四选一答题 ──
   * 题库项 = [年级, 学期, 学科, 题干, [A,B,C,D], 正确项下标, 解析]
   * 筛选过窄时按 学科+年级+学期 → 放宽学期 → 放宽年级 → 同学科 → 全库 兜底。
   */
  var K12 = {
    subject: 'ALL', grade: 'all', term: 'all',
    pos: 0, right: 0, wrong: 0, answered: false, lock: false
  };
  function k12QuestionKey(q) {
    return 'K12:' + q[2] + ':' + q[0] + ':' + String(q[3]).slice(0, 24);
  }
  function k12Filtered(subject, grade, term) {
    return K12_BANK.filter(function (q) {
      if (subject !== 'ALL' && q[2] !== subject) return false;
      if (grade !== 'all' && String(q[0]) !== String(grade)) return false;
      if (term !== 'all' && q[1] !== term) return false;
      return true;
    });
  }
  function k12PickPool() {
    var s = K12.subject, g = K12.grade, t = K12.term;
    var pool = k12Filtered(s, g, t);
    if (pool.length < 4 && t !== 'all') pool = k12Filtered(s, g, 'all');
    if (pool.length < 4 && g !== 'all') pool = k12Filtered(s, 'all', 'all');
    if (pool.length < 4 && s !== 'ALL') pool = k12Filtered('ALL', 'all', 'all');
    return pool;
  }
  function buildK12Round() {
    var pool = k12PickPool().slice();
    if (!pool.length) return [];
    pool.forEach(function (q) {
      var st = statOf('K12', { id: k12QuestionKey(q) });
      var days = (Date.now() - (st.last || 0)) / 86400000;
      q._w = (st.wrong || 0) * 3 + Math.min(days, 7) * 0.4
        + (st.streak >= 3 ? -3 : 0) + Math.random() * 6;
    });
    pool.sort(function (a, b) { return b._w - a._w; });
    var cand = shuffle(pool.slice(0, Math.min(pool.length, 40)));
    var seen = {}, chosen = [];
    for (var i = 0; i < cand.length && chosen.length < (MODES.K12.count || 10); i++) {
      var key = k12QuestionKey(cand[i]);
      if (seen[key]) continue;
      seen[key] = 1; chosen.push(cand[i]);
    }
    return chosen;
  }
  function k12ScopeLabel() {
    var parts = [];
    parts.push(K12.subject === 'ALL' ? '全学科' : K12.subject);
    parts.push(K12.grade === 'all' ? '全年级' : gradeNumberLabel(K12.grade));
    parts.push(K12.term === 'all' ? '全学年' : (K12.term + '册'));
    return parts.join(' · ');
  }
  function gradeNumberLabel(g) {
    var names = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    return (names[Number(g)] || g) + '年级';
  }

  /* ── DOM ── */
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), board = $('board'), boardArea = $('boardArea');
  var tvTitle = $('tvTitle'), tvTarget = $('tvTarget'), tvTargetPinyin = $('tvTargetPinyin');
  var tvTargetLabel = $('tvTargetLabel'), tvProgress = $('tvProgress');
  var progressFill = $('progressFill'), tvHint = $('tvHint');
  var btnStart = $('btnStart'), btnReplay = $('btnReplay'), btnAdvanced = $('btnAdvanced');
  var modeBar = $('modeBar'), exitDialog = $('exitDialog'), toastEl = $('toast');
  var modeButtons = Array.prototype.slice.call(modeBar.querySelectorAll('.mode-btn'));
  var gradeBar = $('gradeBar');
  var gradeButtons = gradeBar
    ? Array.prototype.slice.call(gradeBar.querySelectorAll('.grade-btn')) : [];
  var k12Bar = $('k12Bar');
  var quizQuestion = $('quizQuestion'), quizExplain = $('quizExplain');
  var k12SubjectButtons = k12Bar ? Array.prototype.slice.call(k12Bar.querySelectorAll('[data-subject]')) : [];
  var k12TermButtons = k12Bar ? Array.prototype.slice.call(k12Bar.querySelectorAll('[data-term]')) : [];
  /* 8 个入口共用一行；其中 4 个学科包 + 档案按钮按 dataset 分派点击 */
  var packButtons = modeButtons.filter(function (b) {
    return b.dataset.pack || b.dataset.stats;
  });
  var statsPanel = $('statsPanel');
  var statsOpen = false;

  function k12GradeButtons() {
    return k12Bar ? Array.prototype.slice.call(k12Bar.querySelectorAll('[data-grade]')) : [];
  }
  function renderModeButtons() {
    modeButtons.forEach(function (b) {
      var sel = b.dataset.mode ? (b.dataset.mode === S.mode) : (b.dataset.pack === S.mode);
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
  }
  /* K12 三档筛选的选中态：焦点移开后仍保留明显高亮，方便看清最终选择 */
  function renderK12FilterButtons() {
    k12GradeButtons().forEach(function (b) {
      var sel = b.dataset.grade === String(K12.grade);
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
    k12SubjectButtons.forEach(function (b) {
      var sel = b.dataset.subject === K12.subject;
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
    k12TermButtons.forEach(function (b) {
      var sel = b.dataset.term === K12.term;
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
  }
  function setHint(t) { tvHint.textContent = t; }
  function toast(t) {
    toastEl.textContent = t;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  /* ── 棋盘渲染（对应 GameBoardView.onDraw） ── */
  function isK12() { return S.mode === 'K12'; }
  function layoutBoard() {
    var w = boardArea.clientWidth, h = boardArea.clientHeight;
    if (!w || !h) return;
    var gap;
    var size;
    if (isK12()) {
      /* 题库 2×2 大卡片，按可用区取短边 */
      gap = Math.max(14, Math.round(Math.min(w, h) / 40));
      size = Math.floor(Math.min((w - 3 * gap) / 2, (h - 3 * gap) / 2));
      size = Math.max(140, size);
    } else {
      var n = S.round.length || 20;
      var rows = Math.ceil((n + 4) / 5);
      gap = stage.classList.contains('classic') ? 12 : Math.max(12, Math.round(Math.min(w, h) / 55));
      var byW = (w - 6 * gap) / 5;
      var byH = (h - (rows + 1) * gap) / rows;
      size = Math.max(48, Math.floor(Math.min(byW, byH)));
    }
    board.style.setProperty('--card-size', size + 'px');
    board.style.setProperty('--card-gap', gap + 'px');
  }

  function renderBoard() {
    board.innerHTML = '';
    board.classList.toggle('quiz-board', isK12());
    if (isK12()) { renderK12Options(); return; }
    S.round.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'card focusable';
      el.dataset.focus = '';
      el.dataset.index = String(i);
      el.style.background = CARD_COLORS[i % CARD_COLORS.length];
      var glyph = document.createElement('div');
      glyph.className = 'glyph' + (item.pinyin ? ' with-pinyin' : '');
      glyph.textContent = item.text;
      var glen = item.text.length;
      /* 字号跟随卡片尺寸，避免电视上卡片变小时文字溢出重叠 */
      if (glen > 1) glyph.style.fontSize = 'calc(var(--card-size, 180px) * ' +
        (glen <= 2 ? '.32' : (glen <= 4 ? '.21' : '.15')) + ')';
      el.appendChild(glyph);
      if (item.pinyin) {
        var py = document.createElement('div');
        py.className = 'pinyin';
        py.textContent = item.pinyin;
        el.appendChild(py);
      }
      el.addEventListener('click', function () { onCellTapped(i); });
      el.addEventListener('mouseenter', function () { setFocus(el); });
      board.appendChild(el);
    });
    layoutBoard();
    /* 棋盘重建后，把焦点从已销毁的旧卡片移回「开始」按钮 */
    if (focusEl && (focusEl.classList.contains('card') || !document.body.contains(focusEl))) {
      focusEl.classList.remove('focused');
      setFocus(btnStart);
    }
  }

  function removeCell(i) {
    var el = cardAt(i);
    if (el) el.classList.add('removed');
  }
  function shakeCell(i) {
    var el = cardAt(i);
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(function () { el.classList.remove('shake'); }, 460);
  }
  function cardAt(i) { return board.querySelector('.card[data-index="' + i + '"]'); }

  /* ── K12 题库渲染与判定 ── */
  function k12Current() {
    return (S.phase !== 'IDLE' && K12.pos >= 0 && K12.pos < S.round.length) ? S.round[K12.pos] : null;
  }
  function renderK12Options() {
    var q = k12Current();
    if (!q) { layoutBoard(); return; }
    var keys = ['A', 'B', 'C', 'D'];
    q[4].forEach(function (opt, i) {
      var el = document.createElement('div');
      el.className = 'card focusable';
      el.dataset.focus = '';
      el.dataset.index = String(i);
      el.style.background = CARD_COLORS[(i + 1) % CARD_COLORS.length];
      var key = document.createElement('div');
      key.className = 'option-key';
      key.textContent = keys[i];
      el.appendChild(key);
      var glyph = document.createElement('div');
      glyph.className = 'glyph';
      glyph.textContent = opt;
      var len = String(opt).length;
      glyph.style.fontSize = 'calc(var(--card-size, 300px) * ' +
        (len <= 2 ? '.34' : (len <= 5 ? '.24' : (len <= 10 ? '.145' : (len <= 20 ? '.10' : '.075')))) + ')';
      el.appendChild(glyph);
      el.addEventListener('click', function () { onK12Option(i); });
      el.addEventListener('mouseenter', function () { setFocus(el); });
      board.appendChild(el);
    });
    layoutBoard();
  }
  function renderK12State() {
    var q = k12Current();
    quizQuestion.classList.remove('hidden');
    if (q) {
      var qlen = String(q[3]).length;
      quizQuestion.style.fontSize = qlen <= 12 ? '46px' : (qlen <= 24 ? '36px' :
        (qlen <= 48 ? '29px' : (qlen <= 80 ? '23px' : '19px')));
      quizQuestion.textContent = q[3];
    } else {
      quizQuestion.style.fontSize = '38px';
      quizQuestion.textContent = S.phase === 'CLEARED' ? '🎉 本轮完成！\n看看下面的成绩' :
        '📚 ' + k12ScopeLabel() + '\n点「开始」答题';
    }
  }
  var answerOverlay = $('answerOverlay'), answerVerdict = $('answerVerdict'),
      answerTarget = $('answerTarget'), answerExplain = $('answerExplain'),
      btnAnswerNext = $('btnAnswerNext'), btnAnswerReplay = $('btnAnswerReplay');
  var answerOpen = false;

  function showK12Explain() {
    var q = k12Current();
    if (!q) return;
    var right = q[5];
    var ansText = q[4][right];
    var letter = ['A', 'B', 'C', 'D'][right];
    var ex = String(q[6] || '').trim();
    answerVerdict.textContent = K12.lastCorrect ? '✅ 答对啦！' : '❌ 答错了';
    answerVerdict.classList.toggle('correct', !!K12.lastCorrect);
    answerVerdict.classList.toggle('wrong', !K12.lastCorrect);
    answerTarget.textContent = '正确答案：' + ansText + '（' + letter + '）';
    answerExplain.textContent = ex ? ('解析：\n' + ex) : ('这道题的正确答案是 ' + ansText + '。');
    answerExplain.scrollTop = 0;
    answerOverlay.classList.remove('hidden');
    answerOpen = true;
    /* 焦点交给浮层按钮，遥控器可直接操作 */
    if (btnAnswerNext) setFocus(btnAnswerNext);
  }
  function hideAnswerOverlay() {
    if (!answerOverlay) return;
    answerOverlay.classList.add('hidden');
    answerOpen = false;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clearK12Explain() {
    quizExplain.classList.add('hidden');
    quizExplain.classList.remove('correct', 'wrong');
    quizExplain.textContent = '';
    hideAnswerOverlay();
  }
  function speakK12Question() {
    var q = k12Current();
    if (!q) return;
    var lang = (q[2] === '英语') ? 'en-US' : 'zh-CN';
    Audio.speakText(String(q[3]), null, lang);
  }
  /* 朗读正确答案 + 解析：解析多为中文，按文本内容自动选中/英文发音 */
  function speakK12Explain() {
    var q = k12Current();
    if (!q) return;
    var right = q[5];
    var ansText = String(q[4][right]);
    var ex = String(q[6] || '').trim();
    var letter = ['A', 'B', 'C', 'D'][right];
    var text = (K12.lastCorrect ? '答对啦。正确答案是' : '答错了。正确答案是') +
      ansText + (K12.lastCorrect ? '。' : '，选项' + letter + '。') +
      (ex ? '解析：' + ex : '');
    var lang = /[\u4e00-\u9fa5]/.test(ex || ansText) ? 'zh-CN' : 'en-US';
    Audio.speakText(text, null, lang);
  }
  function onK12Option(i) {
    if (S.phase !== 'PLAYING' || K12.answered || K12.lock) return;
    var q = k12Current();
    if (!q) return;
    K12.answered = true;
    K12.lock = true;
    var correct = (i === q[5]);
    K12.lastCorrect = correct;
    recordAnswer('K12', { id: k12QuestionKey(q) }, correct);
    if (correct) K12.right++; else K12.wrong++;
    var picked = cardAt(i);
    if (picked) picked.classList.add(correct ? 'answer-right' : 'answer-wrong');
    if (!correct) {
      var rightCard = cardAt(q[5]);
      if (rightCard) rightCard.classList.add('answer-right');
    }
    Array.prototype.slice.call(board.querySelectorAll('.card')).forEach(function (c) {
      c.classList.add('locked');
    });
    Audio.playChime(pick(correct ? 'winChime' : 'loseChime'));
    showK12Explain();
    speakK12Explain();
    updateProgress();
    renderState();
    /* 不再自动跳题：解析浮层由用户看完后手动进入下一题，再长的解析也不会被跳过 */
    clearTimeout(K12._t);
  }
  function nextK12Question() {
    if (!isK12() || S.phase !== 'PLAYING') return;
    clearTimeout(K12._t);
    K12.pos++;
    if (K12.pos >= S.round.length) { finishK12(); return; }
    K12.answered = false;
    K12.lock = false;
    clearK12Explain();
    renderBoard();
    renderK12State();
    updateProgress();
    renderState();
    speakK12Question();
    var firstCard = board.querySelector('.card');
    if (firstCard) setFocus(firstCard);
  }
  function startK12() {
    S.round = buildK12Round();
    S.removed = new Array(S.round.length).fill(false);
    K12.pos = 0; K12.right = 0; K12.wrong = 0;
    K12.answered = false; K12.lock = false;
    clearK12Explain();
    if (!S.round.length) {
      S.phase = 'CLEARED';
      renderBoard(); renderK12State(); updateProgress(); renderState();
      setHint('题库加载失败，请检查数据');
      return;
    }
    S.phase = 'PLAYING';
    renderBoard(); renderK12State(); updateProgress(); renderState();
    setHint('看好题目，选出正确答案～');
    speakK12Question();
  }
  function finishK12() {
    S.phase = 'CLEARED';
    clearK12Explain();
    renderBoard(); renderK12State(); updateProgress(); renderState();
    setHint('答对 ' + K12.right + ' 题，答错 ' + K12.wrong + ' 题，真棒！');
    Audio.playFeedback(pick('doneVoice'), pick('doneChime'));
  }

  /* ── 状态渲染（对应 MainActivity.renderState） ── */
  function renderState() {
    if (gradeBar) {
      var wasOff = gradeBar.classList.contains('off');
      gradeBar.classList.toggle('off', S.mode !== 'HANZI');
      if (wasOff !== gradeBar.classList.contains('off')) layoutBoard();
    }
    if (k12Bar) k12Bar.classList.toggle('off', S.mode !== 'K12');
    tvTitle.textContent = isK12() ? '📚 K12 题库 · ' + k12ScopeLabel() :
      ('🎈 识字消消乐 · ' + MODES[S.mode].label +
      (S.mode === 'HANZI' && S.grade !== 'all' ? ' · ' + gradeLabel(S.grade) : ''));

    if (isK12()) {
      /* 题库模式隐藏消消乐的大字/提示，避免与题干挤在一起 */
      tvTarget.style.display = 'none';
      tvTargetPinyin.style.display = 'none';
      tvTargetLabel.style.display = 'none';
      renderK12State();
      updateProgress();
      btnStart.textContent = S.phase === 'PLAYING' ? '重新开始' :
        (S.phase === 'CLEARED' ? '再来一局' : '开始答题');
      btnReplay.textContent = K12.answered ? '🔊 听解析' : '🔊 读题';
      btnReplay.disabled = !k12Current();
      btnAdvanced.style.visibility = 'hidden';
      renderModeButtons();
      renderK12FilterButtons();
      return;
    }
    btnAdvanced.style.visibility = '';
    tvTarget.style.display = '';
    tvTargetPinyin.style.display = '';
    tvTargetLabel.style.display = '';
    quizQuestion.classList.add('hidden');
    clearK12Explain();

    /* 目标卡片 */
    var t = S.currentTarget;
    if (t >= 0) {
      if (S.advanced) {
        tvTarget.textContent = '🎧';
        tvTargetPinyin.classList.add('hidden');
        tvTargetLabel.textContent = TXT.targetAdvanced;
      } else {
        var shown = S.round[t].display || S.round[t].text;
        tvTarget.textContent = shown;
        tvTarget.style.fontSize = shown.length <= 2 ? '' :
          (shown.length <= 6 ? '64px' : (shown.length <= 12 ? '40px' : '28px'));
        if (S.mode === 'HANZI' && S.round[t].pinyin) {
          tvTargetPinyin.textContent = S.round[t].pinyin;
          tvTargetPinyin.classList.remove('hidden');
        } else {
          tvTargetPinyin.textContent = '';
          tvTargetPinyin.classList.add('hidden');
        }
        tvTargetLabel.textContent = TXT.targetNormal;
      }
    } else {
      tvTarget.textContent = S.phase === 'CLEARED' ? '🎊' : '?';
      tvTargetPinyin.textContent = '';
      tvTargetPinyin.classList.add('hidden');
      tvTargetLabel.textContent = S.phase === 'CLEARED' ? TXT.targetDone : TXT.targetIdle;
    }

    updateProgress();

    btnStart.textContent = S.phase === 'IDLE' ? '开始' : (S.phase === 'PLAYING' ? '重新开始' : '再来一局');
    btnStart.disabled = false;
    btnReplay.textContent = '再听一次';
    btnReplay.disabled = !(t >= 0 && !S.awaitingFeedback);

    renderModeButtons();

    gradeButtons.forEach(function (b) {
      var sel = b.dataset.grade === S.grade;
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });

    /* K12 年级按钮与汉字年级栏共用 dataset.grade，按当前模式决定高亮 */
    k12GradeButtons().forEach(function (b) {
      var sel = b.dataset.grade === String(K12.grade);
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
    k12SubjectButtons.forEach(function (b) {
      var sel = b.dataset.subject === K12.subject;
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });
    k12TermButtons.forEach(function (b) {
      var sel = b.dataset.term === K12.term;
      b.classList.toggle('selected', sel);
      b.style.color = sel ? '#FFFFFF' : '#6D4C41';
    });

    var adv = S.advanced;
    btnAdvanced.classList.toggle('selected', adv);
    btnAdvanced.textContent = adv ? '🎧 进阶中' : '🎧 进阶';
    btnAdvanced.style.color = adv ? '#FFFFFF' : '#6D4C41';
  }

  function updateProgress() {
    if (isK12()) {
      var n = S.round.length;
      var done = Math.min(K12.pos + (K12.answered ? 1 : 0), n);
      tvProgress.textContent = '第 ' + Math.min(K12.pos + 1, n) + ' / ' + n + ' 题 · 答对 ' + K12.right;
      progressFill.style.width = (n ? (done / n * 100) : 0) + '%';
      return;
    }
    var doneNormal = total() - remaining();
    tvProgress.textContent = '已消除 ' + doneNormal + ' / ' + total();
    progressFill.style.width = (total() ? (doneNormal / total() * 100) : 0) + '%';
  }

  /* ── 交互流程（对应 MainActivity 各回调） ── */
  function speakCurrentTarget() {
    if (isK12()) { speakK12Question(); return; }
    var t = S.currentTarget;
    if (t < 0) return;
    var item = S.round[t];
    Audio.speak(item.voice, null, item.promptText || item.text);
  }

  function onStartClicked() {
    Audio.stopSpeech();
    if (isK12()) { startK12(); return; }
    var t = start();
    if (t < 0) { renderState(); return; }
    renderBoard();
    renderState();
    setHint(S.advanced ? TXT.hintStartAdvanced : TXT.hintStartNormal);
    speakCurrentTarget();
  }

  function onReplayClicked() {
    if (isK12()) {
      if (!k12Current()) return;
      if (K12.answered) speakK12Explain();  /* 已作答：重听完整解析 */
      else speakK12Question();             /* 未作答：读题干 */
      return;
    }
    if (S.currentTarget >= 0) speakCurrentTarget();
  }

  function onAdvancedToggled() {
    S.advanced = !S.advanced;
    renderState();
    setHint(S.advanced ? TXT.hintAdvancedOn : TXT.hintAdvancedOff);
    if (S.phase === 'PLAYING' && S.currentTarget >= 0) speakCurrentTarget();
  }

  function switchMode(mode) {
    Audio.stopSpeech();
    clearTimeout(K12._t);
    S.mode = mode;
    if (isK12()) {
      S.round = buildK12Round();
      S.removed = new Array(S.round.length).fill(false);
      K12.pos = 0; K12.answered = false; K12.lock = false;
      S.phase = 'IDLE';
      clearK12Explain();
      renderBoard();
      renderState();
      setHint('已切换到题库 · ' + k12ScopeLabel() + '，点「开始答题」');
      return;
    }
    newRound();
    renderBoard();
    renderState();
    setHint('已切换到「' + MODES[mode].label + '」模式，点「开始」继续玩吧');
  }

  /* 题库筛选变更：学科 / 年级 / 学期 */
  function changeK12Filter(kind, value) {
    if (!isK12()) return;
    Audio.stopSpeech();
    clearTimeout(K12._t);
    if (kind === 'subject') K12.subject = value;
    else if (kind === 'grade') K12.grade = value;
    else if (kind === 'term') K12.term = value;
    S.round = buildK12Round();
    S.removed = new Array(S.round.length).fill(false);
    K12.pos = 0; K12.answered = false; K12.lock = false;
    S.phase = 'IDLE';
    clearK12Explain();
    renderBoard();
    renderState();
    setHint(k12ScopeLabel() + '，共 ' + S.round.length + ' 题 · 点「开始答题」');
  }

  function switchGrade(id) {
    Audio.stopSpeech();
    S.grade = id;
    if (S.mode === 'HANZI') {
      newRound();
      renderBoard();
      setHint('已切换到「' + gradeLabel(id) + '」，点「开始」继续玩吧');
    } else {
      setHint('已选择「' + gradeLabel(id) + '」，切到「汉字」模式即可开玩');
    }
    renderState();
  }

  function finishRound() {
    setHint(TXT.hintFinish);
    renderState();
    Audio.playFeedback(pick('doneVoice'), pick('doneChime'));
  }

  function onCellTapped(i) {
    if (isK12()) { onK12Option(i); return; }
    if (S.phase !== 'PLAYING') return;
    var r = tap(i);
    if (r === 'IGNORED') return;

    if (r === 'WRONG') {
      recordAnswer(S.mode, S.round[S.currentTarget], false);
      shakeCell(i);
      Audio.playChime(pick('loseChime'));
      setHint(S.advanced ? TXT.hintWrongAdvanced : TXT.hintWrongNormal);
      var v = pick('loseVoice');
      Audio.speak(v, function () {
        if (S.phase === 'PLAYING') speakCurrentTarget();
      });
      return;
    }

    /* CORRECT */
    recordAnswer(S.mode, S.round[S.currentTarget], true);
    removeCell(i);
    Audio.playChime(pick('winChime'));
    setHint(TXT.hintRight);
    updateProgress();
    S.awaitingFeedback = true;
    renderState();
    var wv = pick('winVoice');
    Audio.speak(wv, function () {
      S.awaitingFeedback = false;
      var t = advanceToNextTarget();
      renderState();
      if (t < 0) finishRound();
      else speakCurrentTarget();
    });
    moveFocusOffRemoved(i);
  }

  /* ── TV 焦点导航 ── */
  var focusEl = null;
  var dialogOpen = false;

  function focusables() {
    var scope = answerOpen ? (answerOverlay || stage) :
      (statsOpen ? (statsPanel || stage) : (dialogOpen ? exitDialog : stage));
    return Array.prototype.slice.call(scope.querySelectorAll('[data-focus]')).filter(function (el) {
      if (el.disabled) return false;
      if (el.classList.contains('removed')) return false;
      if (el.offsetParent === null) return false;
      return true;
    });
  }

  function setFocus(el) {
    if (!el) return;
    if (focusEl && focusEl !== el) focusEl.classList.remove('focused');
    focusEl = el;
    el.classList.add('focused');
  }

  function moveFocusOffRemoved(i) {
    if (!focusEl || !focusEl.classList.contains('card') || focusEl.classList.contains('removed')) {
      var next = board.querySelector('.card:not(.removed)') || btnStart;
      setFocus(next);
    }
  }

  function moveFocus(dx, dy) {
    var list = focusables();
    if (!list.length) return;
    var cur = (focusEl && list.indexOf(focusEl) >= 0) ? focusEl : list[0];
    var r0 = cur.getBoundingClientRect();
    var c0x = (r0.left + r0.right) / 2, c0y = (r0.top + r0.bottom) / 2;
    var best = null, bestScore = Infinity;
    list.forEach(function (el) {
      if (el === cur) return;
      var r = el.getBoundingClientRect();
      var cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      var along = dx !== 0 ? (cx - c0x) * dx : (cy - c0y) * dy;
      var across = dx !== 0 ? Math.abs(cy - c0y) : Math.abs(cx - c0x);
      if (along <= 6) return;
      var score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setFocus(best);
  }

  function activate(el) {
    if (!el || el.disabled) return;
    Audio.unlock();
    el.classList.add('pressed');
    setTimeout(function () { el.classList.remove('pressed'); }, 130);
    el.click();
  }

  function renderStats() {
    var body = $('statsBody');
    if (!body) return;
    var rows = [], totalRight = 0, totalWrong = 0;
    function addStatRow(label, prefix, totalItems) {
      var right = 0, wrong = 0, mastered = 0;
      Object.keys(PROGRESS).forEach(function (k) {
        if (k.indexOf(prefix) !== 0) return;
        var st = PROGRESS[k];
        right += st.right || 0;
        wrong += st.wrong || 0;
        if ((st.streak || 0) >= 3) mastered++;
      });
      totalRight += right; totalWrong += wrong;
      var acc = (right + wrong) ? Math.round(right * 100 / (right + wrong)) : 0;
      rows.push('<div class="stat-row"><span>' + label + '</span>' +
        '<span>已掌握 ' + mastered + ' / ' + totalItems + '</span>' +
        '<span>正确率 ' + acc + '%</span></div>');
    }
    function k12Count(subject) {
      return K12_BANK.filter(function (q) { return subject === 'ALL' || q[2] === subject; }).length;
    }
    ['数学', '英语', '语文', '物理', '科学'].forEach(function (sub) {
      addStatRow('题库·' + sub, 'K12:' + sub + ':', k12Count(sub));
    });
    MODE_ORDER.forEach(function (id) {
      if (!MODES[id] || id === 'K12') return;
      var pool = PACK_ITEMS[id] || (id === 'NUMBER' ? 100 : (id === 'LETTER' ? 26 : HANZI.length));
      var totalItems = typeof pool === 'number' ? pool : pool.length;
      addStatRow(MODES[id].label, id + ':', totalItems);
    });
    var accAll = (totalRight + totalWrong) ? Math.round(totalRight * 100 / (totalRight + totalWrong)) : 0;
    body.innerHTML = rows.join('') +
      '<div class="stat-total">累计答对 ' + totalRight + ' · 答错 ' + totalWrong + ' · 总正确率 ' + accAll + '%</div>';
  }
  function showStats() {
    if (!statsPanel) return;
    statsOpen = true;
    statsPanel.classList.remove('hidden');
    renderStats();
    setFocus($('btnStatsClose'));
  }
  function hideStats() {
    statsOpen = false;
    if (statsPanel) statsPanel.classList.add('hidden');
    setFocus(btnStart);
  }

  function showExit() {
    dialogOpen = true;
    exitDialog.classList.remove('hidden');
    setFocus($('btnStay'));
  }
  function hideExit() {
    dialogOpen = false;
    exitDialog.classList.add('hidden');
    setFocus(btnStart);
  }
  function onBack() {
    if (answerOpen) { nextK12Question(); return; }
    if (statsOpen) { hideStats(); return; }
    if (dialogOpen) { hideExit(); return; }
    if (window.AndroidTV && window.AndroidTV.exitApp) { showExit(); return; }
    showExit();
  }

  function toggleLayout() {
    stage.classList.toggle('classic');
    var isClassic = stage.classList.contains('classic');
    requestAnimationFrame(function () {
      layoutBoard();
      if (focusEl) setFocus(focusEl);
    });
    toast(isClassic ? '原版竖屏布局（1:1）' : 'TV 宽屏布局');
  }

  var FIT_KEY = 'literacyTV.fit.v1';
  var SAFE_AREA = 0.96; /* 电视 overscan 安全边：四周各留约 2% */
  try {
    var savedFit = parseFloat(localStorage.getItem(FIT_KEY));
    if (savedFit > 0.55 && savedFit <= 1.05) SAFE_AREA = savedFit;
  } catch (e) {}
  function adjustFit(delta) {
    SAFE_AREA = Math.max(0.55, Math.min(1.05, SAFE_AREA + delta));
    try { localStorage.setItem(FIT_KEY, String(SAFE_AREA)); } catch (e) {}
    fitStage();
    toast('画面缩放 ' + Math.round(SAFE_AREA * 100) + '%');
  }
  function fitStage() {
    var de = document.documentElement;
    /* 部分电视 WebView 的 innerWidth 与 clientWidth 不一致，取较小者，宁可留白也不裁切 */
    var w = Math.min(window.innerWidth || 1e9, de.clientWidth || 1e9);
    var h = Math.min(window.innerHeight || 1e9, de.clientHeight || 1e9);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return;
    var s = Math.min(w / 1920, h / 1080) * SAFE_AREA;
    stage.style.setProperty('--stage-scale', s);
  }

  /* ── 事件绑定 ── */
  btnStart.addEventListener('click', onStartClicked);
  btnReplay.addEventListener('click', onReplayClicked);
  btnAdvanced.addEventListener('click', onAdvancedToggled);
  if (btnAnswerNext) btnAnswerNext.addEventListener('click', function () { nextK12Question(); });
  if (btnAnswerReplay) btnAnswerReplay.addEventListener('click', function () { speakK12Explain(); });
  modeButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.mode) switchMode(b.dataset.mode);
      else if (b.dataset.pack) switchMode(b.dataset.pack);
      else showStats();
    });
  });
  gradeButtons.forEach(function (b) {
    b.addEventListener('click', function () { switchGrade(b.dataset.grade); });
  });
  k12SubjectButtons.forEach(function (b) {
    b.addEventListener('click', function () { changeK12Filter('subject', b.dataset.subject); });
  });
  k12GradeButtons().forEach(function (b) {
    b.addEventListener('click', function () { changeK12Filter('grade', b.dataset.grade); });
  });
  k12TermButtons.forEach(function (b) {
    b.addEventListener('click', function () { changeK12Filter('term', b.dataset.term); });
  });
  if ($('btnFitMinus')) $('btnFitMinus').addEventListener('click', function () { adjustFit(-0.03); });
  if ($('btnFitPlus')) $('btnFitPlus').addEventListener('click', function () { adjustFit(0.03); });
  if ($('btnStatsClose')) $('btnStatsClose').addEventListener('click', hideStats);
  $('btnStay').addEventListener('click', hideExit);
  $('btnExit').addEventListener('click', function () {
    if (window.AndroidTV && window.AndroidTV.exitApp) window.AndroidTV.exitApp();
    else { hideExit(); toast('在电视上按返回键即可退出应用'); }
  });

  /* 鼠标/触屏：与原版点击 1:1，同时同步焦点，便于电脑上操作 */
  Array.prototype.slice.call(document.querySelectorAll('[data-focus]')).forEach(function (el) {
    el.addEventListener('mouseenter', function () { if (!dialogOpen) setFocus(el); });
  });

  /* 遥控器 / 键盘 / Android TV 壳共用同一套按键处理 */
  function handleKey(k, code) {
    var up = k === 'ArrowUp' || code === 19 || code === 38;
    var down = k === 'ArrowDown' || code === 20 || code === 40;
    var left = k === 'ArrowLeft' || code === 21 || code === 37;
    var right = k === 'ArrowRight' || code === 22 || code === 39;
    var ok = k === 'Enter' || k === 'OK' || k === ' ' || k === 'Spacebar' || code === 13 || code === 23 || code === 62 || code === 66;
    var back = k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'Back' || code === 4 || code === 27;
    if (up) moveFocus(0, -1);
    else if (down) moveFocus(0, 1);
    else if (left) moveFocus(-1, 0);
    else if (right) moveFocus(1, 0);
    else if (ok) {
      activate(focusEl);
    }
    else if (back) onBack();
    else if (k === 'Menu' || k === 'l' || k === 'L' || code === 82) toggleLayout();  /* 菜单键 / L：切换布局 */
    else if (k === 'm' || k === 'M') {
      Audio.setMuted(!Audio.isMuted());
      toast(Audio.isMuted() ? '已静音' : '已开启声音');
    }
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key, code = e.keyCode;
    var handled = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' ||
                  k === 'Enter' || k === ' ' || k === 'Spacebar' || k === 'Escape' || k === 'Backspace' ||
                  code === 19 || code === 20 || code === 21 || code === 22 || code === 13 || code === 23 ||
                  code === 62 || code === 66 || code === 4 || code === 27 || code === 32;
    if (handled) e.preventDefault();
    Audio.unlock();
    handleKey(k, code);
  });

  document.addEventListener('contextmenu', function (e) { e.preventDefault(); toggleLayout(); });
  window.addEventListener('resize', function () { fitStage(); requestAnimationFrame(layoutBoard); });
  window.addEventListener('orientationchange', function () { setTimeout(function () { fitStage(); layoutBoard(); }, 120); });

  /* 供 Android TV WebView 壳调用 */
  window.TVApp = {
    key: function (k) { Audio.unlock(); handleKey(k, 0); },
    setGrade: switchGrade,
    openStats: showStats,
    onBack: onBack,
    toggleLayout: toggleLayout,
    pause: function () { Audio.stopSpeech(); },
    isDialogOpen: function () { return dialogOpen; }
  };

  /* ── 启动（对应 MainActivity.onCreate） ── */
  fitStage();
  newRound();
  renderBoard();
  renderState();
  setHint(TXT.hintIdleReady);
  setFocus(btnStart);
  /* 电视 WebView 往往在页面加载后才确定最终视口，多次补算避免右侧/底部被裁掉 */
  [50, 200, 600, 1200].forEach(function (t) { setTimeout(fitStage, t); });
  window.addEventListener('load', fitStage);
  if (window.ResizeObserver) {
    try { new ResizeObserver(fitStage).observe(document.body); } catch (e) {}
  }
  setTimeout(function () { $('remoteHint').classList.add('faded'); }, 9000);
})();
