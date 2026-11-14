import { DurableObject } from 'cloudflare:workers';
import QUESTIONS from './questions.json' with { type: 'json' };
import PAGE from './page.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const READ_SECONDS = 5;
const REVEAL_SECONDS = 5;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function ar(n) {
  return String(n).split('').map((c) => '٠١٢٣٤٥٦٧٨٩'[Number(c)]).join('');
}
function normCode(value) {
  const s = String(value || '').trim().toUpperCase()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  return [...s].filter((c) => CODE_CHARS.includes(c)).join('');
}
function randomHex(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomCode() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  });
}
function error(message) { return { ok: false, error: message }; }
async function bodyJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
function callDO(stub, action, payload) {
  return stub.fetch(`https://room/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({}, 204);
    if (url.pathname === '/api/health') {
      return json({ ok: true, questions: QUESTIONS.length, service: 'lughz-haitham-geniuses' });
    }
    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
      return new Response(PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

    const action = url.pathname.slice('/api/'.length);
    const payload = await bodyJson(request);
    if (action === 'create') {
      const name = String(payload.name || '').trim().slice(0, 24) || 'لاعب';
      const rounds = Math.max(5, Math.min(20, Number(payload.rounds) || 10));
      const answerSeconds = Math.max(8, Math.min(30, Number(payload.answerSeconds) || 15));
      for (let i = 0; i < 8; i++) {
        const code = randomCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const response = await callDO(stub, 'create', { code, name, rounds, answerSeconds });
        const result = await response.json();
        if (result.ok || result.error !== 'collision') return json(result);
      }
      return json(error('تعذر إنشاء كود فريد. أعد المحاولة.'), 503);
    }

    const code = normCode(payload.code);
    if (code.length !== 6) return json(error('أدخل كود دعوة صحيحًا من ٦ أحرف.'));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const response = await callDO(stub, action, { ...payload, code });
    const result = await response.json();
    return json(result);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async alarm() {
    await this.ctx.storage.delete('match');
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    const b = await bodyJson(request);
    const code = normCode(b.code);
    let m = await this.ctx.storage.get('match');

    if (action === 'create') {
      if (m) return json(error('collision'));
      const pid = randomHex(6);
      const token = randomHex(10);
      const rounds = Math.max(5, Math.min(20, Number(b.rounds) || 10));
      const answerSeconds = Math.max(8, Math.min(30, Number(b.answerSeconds) || 15));
      m = {
        code,
        created: Date.now(),
        players: [{ id: pid, token, name: String(b.name || '').trim().slice(0, 24) || 'لاعب', score: 0 }],
        phase: 'lobby', rounds, answerSeconds, readSeconds: READ_SECONDS,
        qorder: [], qi: 0, holder: null, tried: [], sub: 'reading', deadline: 0,
        reveal: null, events: [], winner: null, rematchVotes: [],
      };
      this.push(m, 'أُنشئت الغرفة. شارك الكود مع منافسك.');
      await this.ctx.storage.put('match', m);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      const out = this.view(m, pid);
      out.pid = pid; out.token = token;
      return json(out);
    }

    if (!m || m.code !== code) return json(error('الكود غير صحيح أو انتهت صلاحية الغرفة.'));

    if (action === 'join') {
      if (m.phase !== 'lobby') return json(error('بدأت المنافسة بالفعل، لا يمكن الدخول الآن.'));
      if (m.players.length >= 2) return json(error('الغرفة ممتلئة بلاعبين.'));
      const pid = randomHex(6);
      const token = randomHex(10);
      m.players.push({
        id: pid, token,
        name: String(b.name || '').trim().slice(0, 24) || 'منافس',
        score: 0,
      });
      this.push(m, 'انضم ' + m.players[1].name + ' إلى المنافسة.');
      await this.ctx.storage.put('match', m);
      const out = this.view(m, pid);
      out.pid = pid; out.token = token;
      return json(out);
    }

    const pid = String(b.pid || '');
    const token = String(b.token || '');
    const me = this.player(m, pid);
    if (!me || me.token !== token) return json(error('جلسة غير صالحة. أعد الدخول بالكود.'));

    if (action === 'state') {
      const was = JSON.stringify(m);
      this.tick(m);
      if (JSON.stringify(m) !== was) await this.ctx.storage.put('match', m);
      return json(this.view(m, pid));
    }

    if (action === 'start') {
      if (m.players[0].id !== pid) return json(error('صاحب الغرفة فقط يبدأ المنافسة.'));
      if (m.players.length < 2) return json(error('بانتظار دخول المنافس بالكود.'));
      if (m.phase !== 'lobby') return json(error('المنافسة جارية بالفعل.'));
      this.start(m);
      await this.ctx.storage.put('match', m);
      return json(this.view(m, pid));
    }

    if (action === 'rematch') {
      if (m.phase !== 'finished') {
        return json(error('يمكن طلب منافسة جديدة مع نفس الخصم بعد انتهاء المباراة فقط.'));
      }
      if (m.players.length < 2) return json(error('لا يوجد منافس محفوظ لإعادة المباراة.'));
      if (!Array.isArray(m.rematchVotes)) m.rematchVotes = [];
      if (!m.rematchVotes.includes(pid)) {
        m.rematchVotes.push(pid);
        this.push(m, 'طلب ' + me.name + ' متابعة المنافسة مع نفس الخصم.');
      }
      if (m.rematchVotes.length >= m.players.length) {
        m.rematchVotes = [];
        for (const player of m.players) player.score = 0;
        m.winner = null;
        m.created = Date.now();
        this.start(m);
        await this.ctx.storage.put('match', m);
        await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
        return json(this.view(m, pid));
      }
      await this.ctx.storage.put('match', m);
      return json(this.view(m, pid));
    }

    this.tick(m);
    if (action === 'begin') {
      if (m.phase !== 'playing' || m.sub !== 'reading' || m.holder !== pid) {
        await this.ctx.storage.put('match', m);
        return json(error('ليس وقت بدء المؤقت.'));
      }
      this.beginAnswering(m);
      await this.ctx.storage.put('match', m);
      return json(this.view(m, pid));
    }

    if (action === 'answer') {
      if (m.phase !== 'playing') return json(error('المنافسة غير جارية.'));
      if (m.sub !== 'answering' || m.holder !== pid) {
        await this.ctx.storage.put('match', m);
        return json(error('ليس دورك للإجابة الآن.'));
      }
      if (Number(b.qi) !== m.qi) return json(error('انتهى هذا السؤال، انتظر السؤال التالي.'));
      const option = Number(b.option);
      if (!Number.isInteger(option) || option < 0 || option > 3) return json(error('اختر أحد الخيارات.'));
      const q = QUESTIONS[m.qorder[m.qi]];
      if (option === q.a) {
        const left = Math.max(0, Math.floor((m.deadline - Date.now()) / 1000));
        const points = 10 + Math.min(left, m.answerSeconds);
        me.score += points;
        this.reveal(m, pid, points,
          'إجابة صحيحة! ' + me.name + ' حصد ' + ar(points) + ' نقطة');
      } else {
        this.fail(m, pid, 'إجابة خاطئة من ' + me.name);
      }
      await this.ctx.storage.put('match', m);
      return json(this.view(m, pid));
    }

    if (action === 'leave') {
      if (m.phase === 'lobby' && m.players[0].id === pid) {
        await this.ctx.storage.delete('match');
        await this.ctx.storage.deleteAlarm();
      } else if (m.phase === 'finished') {
        const votes = Array.isArray(m.rematchVotes) ? m.rematchVotes : [];
        m.rematchVotes = votes.filter((vote) => vote !== pid);
        this.push(m, me.name + ' اختار منافسًا جديدًا.');
        await this.ctx.storage.put('match', m);
      }
      return json({ ok: true, left: true });
    }

    await this.ctx.storage.put('match', m);
    return json(error('طلب غير معروف.'));
  }

  player(m, pid) { return m.players.find((p) => p.id === pid) || null; }
  other(m, pid) { return m.players.find((p) => p.id !== pid) || null; }
  push(m, text) {
    m.events.push({ t: Date.now(), text });
    m.events = m.events.slice(-6);
  }
  beginReading(m, pid, message) {
    m.holder = pid;
    m.sub = 'reading';
    m.deadline = Date.now() + m.readSeconds * 1000;
    m.reveal = null;
    if (message) this.push(m, message);
  }
  beginAnswering(m) {
    m.sub = 'answering';
    m.deadline = Date.now() + m.answerSeconds * 1000;
  }
  fail(m, pid, reason) {
    if (!m.tried.includes(pid)) m.tried.push(pid);
    if (m.tried.length >= m.players.length) {
      this.reveal(m, null, 0, reason + ' — أخفق المنافسان، ظهرت الإجابة الصحيحة');
      return;
    }
    const next = m.players.find((p) => !m.tried.includes(p.id));
    this.beginReading(m, next.id, reason + ' — يعود السؤال إلى ' + next.name);
  }
  reveal(m, winner, points, reason) {
    const q = QUESTIONS[m.qorder[m.qi]];
    m.reveal = { correctIndex: q.a, explanation: q.e, points, winner, reason };
    m.sub = 'reveal';
    m.deadline = Date.now() + REVEAL_SECONDS * 1000;
    this.push(m, reason);
  }
  advance(m) {
    if (m.qi + 1 >= m.rounds) {
      m.phase = 'finished';
      m.sub = 'done';
      m.deadline = 0;
      const sorted = [...m.players].sort((a, b) => b.score - a.score);
      if (sorted[0].score === sorted[1].score) {
        m.winner = { tie: true, name: 'تعادل', score: sorted[0].score, id: null };
      } else {
        m.winner = { tie: false, name: sorted[0].name, score: sorted[0].score, id: sorted[0].id };
      }
      this.push(m, 'انتهت المنافسة: ' + (m.winner.tie ? 'تعادل' : 'فاز ' + m.winner.name));
      return;
    }
    m.qi++;
    m.tried = [];
    const next = m.players[m.qi % m.players.length];
    this.beginReading(m, next.id, 'السؤال ' + ar(m.qi + 1) + ' مع ' + next.name);
  }
  tick(m) {
    if (m.phase !== 'playing' || !m.deadline || Date.now() < m.deadline) return;
    if (m.sub === 'reading') this.beginAnswering(m);
    else if (m.sub === 'answering') this.fail(m, m.holder, 'انتهى الوقت');
    else if (m.sub === 'reveal') this.advance(m);
  }
  start(m) {
    const all = Array.from({ length: QUESTIONS.length }, (_, i) => i);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    m.qorder = all.slice(0, Math.min(m.rounds, QUESTIONS.length));
    m.qi = 0;
    m.tried = [];
    m.phase = 'playing';
    this.beginReading(m, m.players[0].id, 'بدأت المنافسة! السؤال الأول مع ' + m.players[0].name);
  }
  questionView(m, pid) {
    if (m.phase !== 'playing' || !m.qorder.length) return null;
    const q = QUESTIONS[m.qorder[m.qi]];
    const visible = m.holder === pid || m.sub === 'reveal' || m.sub === 'done';
    if (!visible) return null;
    const v = { text: q.q, options: q.o, chapter: q.c, difficulty: q.d };
    if (m.sub === 'reveal' && m.reveal) {
      v.correctIndex = m.reveal.correctIndex;
      v.explanation = m.reveal.explanation;
    }
    return v;
  }
  view(m, pid) {
    const me = this.player(m, pid);
    const opp = this.other(m, pid);
    const isHolder = m.holder === pid && m.phase === 'playing';
    const rematchVotes = Array.isArray(m.rematchVotes) ? m.rematchVotes : [];
    let status = '';
    let timerTotal = 0;
    if (m.phase === 'lobby') status = 'بانتظار دخول المنافس';
    else if (m.sub === 'reading') {
      status = isHolder ? 'اقرأ السؤال ثم ابدأ المؤقت' : 'المنافس يقرأ السؤال الآن';
      timerTotal = m.readSeconds * 1000;
    } else if (m.sub === 'answering') {
      status = isHolder ? 'أجب قبل انتهاء الوقت!' : 'بانتظار إجابة المنافس';
      timerTotal = m.answerSeconds * 1000;
    } else if (m.sub === 'reveal') {
      status = 'نتيجة هذا السؤال';
      timerTotal = REVEAL_SECONDS * 1000;
    }
    return {
      ok: true, code: m.code, serverNow: Date.now(), phase: m.phase, sub: m.sub,
      status, round: m.phase === 'playing' ? m.qi + 1 : m.qi, total: m.rounds,
      answerSeconds: m.answerSeconds, readSeconds: m.readSeconds, yourTurn: isHolder,
      you: { id: me.id, name: me.name, score: me.score, isHost: m.players[0].id === me.id },
      opponent: opp ? { id: opp.id, name: opp.name, score: opp.score, online: true } : null,
      players: m.players.map((p) => ({ id: p.id, name: p.name, score: p.score,
        isHost: m.players[0].id === p.id, online: true })),
      question: this.questionView(m, pid),
      remainingMs: m.deadline ? Math.max(0, Math.floor(m.deadline - Date.now())) : 0,
      timerTotalMs: timerTotal,
      reveal: m.sub === 'reveal' ? m.reveal : null,
      winner: m.phase === 'finished' ? m.winner : null,
      youRequestedRematch: rematchVotes.includes(pid),
      opponentRequestedRematch: rematchVotes.some((vote) => vote !== pid),
      events: m.events.slice(-4).map((e) => e.text),
    };
  }
}
