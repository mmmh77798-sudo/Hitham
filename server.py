#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""خادم «قسم العباقرة» — لغز هيثم.

منافسة بين لاعبين، سؤال بسؤال:
  * ينشئ اللاعب الأول غرفة فيحصل على كود دعوة من ٦ أحرف.
  * يدخل المنافس بالكود من هاتفه الثاني.
  * يُعرض السؤال على صاحب الدور فقط، مع فترة قراءة ثم مؤقت إجابة.
  * الإجابة الصحيحة داخل الوقت = نقاط (١٠ + ثانية لكل ثانية متبقية).
  * الخطأ أو انتهاء الوقت = يعود السؤال للمنافس بوقته الكامل.
  * إن أخفق الاثنان تُكشف الإجابة والشرح ثم يبدأ السؤال التالي.

التشغيل:  python3 server.py        (يستمع على 0.0.0.0:8083)
الواجهة:   http://localhost:8083/  (أو رابط النفق العام)
"""
import json
import os
import random
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BASE, 'questions.json'), encoding='utf-8') as f:
    QUESTIONS = json.load(f)

PORT = int(os.environ.get('PORT', os.environ.get('DUEL_PORT', '8083')))
LOCK = threading.RLock()
MATCHES = {}
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
READ_SECONDS = 5
REVEAL_SECONDS = 5
MAX_AGE = 2 * 60 * 60


def ar(n):
    return ''.join('٠١٢٣٤٥٦٧٨٩'[int(c)] for c in str(n))


def now():
    return time.time()


def norm_code(s):
    s = (s or '').strip().upper()
    trans = str.maketrans('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '0123456789' * 2)
    s = s.translate(trans)
    return ''.join(c for c in s if c in CODE_CHARS + '0123456789 ')


def push(m, text):
    m['events'].append({'t': int(now() * 1000), 'text': text})
    m['events'] = m['events'][-6:]


def player(m, pid):
    for p in m['players']:
        if p['id'] == pid:
            return p
    return None


def other(m, pid):
    for p in m['players']:
        if p['id'] != pid:
            return p
    return None


def new_match(code, rounds, answer_seconds):
    return {
        'code': code,
        'created': now(),
        'touched': now(),
        'players': [],
        'phase': 'lobby',
        'rounds': rounds,
        'answerSeconds': answer_seconds,
        'readSeconds': READ_SECONDS,
        'qorder': [],
        'qi': 0,
        'holder': None,
        'tried': [],
        'sub': 'reading',
        'deadline': 0.0,
        'reveal': None,
        'events': [],
        'winner': None,
    }


def event_name(m, pid):
    p = player(m, pid)
    return p['name'] if p else 'المنافس'


def begin_reading(m, pid, message=None):
    m['holder'] = pid
    m['sub'] = 'reading'
    m['deadline'] = now() + m['readSeconds']
    m['reveal'] = None
    if message:
        push(m, message)


def begin_answering(m):
    m['sub'] = 'answering'
    m['deadline'] = now() + m['answerSeconds']


def do_reveal(m, winner_pid, points, reason):
    q = QUESTIONS[m['qorder'][m['qi']]]
    m['reveal'] = {
        'correctIndex': q['a'],
        'explanation': q['e'],
        'points': points,
        'winner': winner_pid,
        'reason': reason,
    }
    m['sub'] = 'reveal'
    m['deadline'] = now() + REVEAL_SECONDS
    push(m, reason)


def fail(m, pid, reason):
    if pid not in m['tried']:
        m['tried'].append(pid)
    if len(m['tried']) >= len(m['players']):
        do_reveal(m, None, 0, reason + ' — أخفق المنافسان، الإجابة الصحيحة ظهرت')
    else:
        nxt = None
        for p in m['players']:
            if p['id'] not in m['tried']:
                nxt = p['id']
                break
        begin_reading(m, nxt, reason + ' — يعود السؤال إلى ' + event_name(m, nxt))


def advance(m):
    if m['qi'] + 1 >= m['rounds']:
        m['phase'] = 'finished'
        m['sub'] = 'done'
        m['deadline'] = 0.0
        ps = sorted(m['players'], key=lambda p: -p['score'])
        if len(ps) == 2 and ps[0]['score'] == ps[1]['score']:
            m['winner'] = {'tie': True, 'name': 'تعادل', 'score': ps[0]['score'], 'id': None}
        else:
            m['winner'] = {'tie': False, 'name': ps[0]['name'], 'score': ps[0]['score'], 'id': ps[0]['id']}
        push(m, 'انتهت المنافسة: ' + ('تعادل' if m['winner']['tie'] else 'فاز ' + m['winner']['name']))
        return
    m['qi'] += 1
    m['tried'] = []
    nxt = m['players'][m['qi'] % len(m['players'])]['id']
    begin_reading(m, nxt, 'السؤال ' + ar(m['qi'] + 1) + ' مع ' + event_name(m, nxt))


def start_match(m):
    m['qorder'] = random.sample(range(len(QUESTIONS)), min(m['rounds'], len(QUESTIONS)))
    m['qi'] = 0
    m['tried'] = []
    m['phase'] = 'playing'
    first = m['players'][0]['id']
    begin_reading(m, first, 'بدأت المنافسة! السؤال الأول مع ' + event_name(m, first))


def tick(m):
    """تُستدعى من كل طلب ومن خيط الخلفية، فتتقدم الحالة حتى لو صمت أحد اللاعبين."""
    if m['phase'] != 'playing' or not m['deadline']:
        return
    t = now()
    if t < m['deadline']:
        return
    if m['sub'] == 'reading':
        begin_answering(m)
    elif m['sub'] == 'answering':
        fail(m, m['holder'], 'انتهى الوقت')
    elif m['sub'] == 'reveal':
        advance(m)


def question_view(m, pid):
    if m['phase'] != 'playing' or not m['qorder']:
        return None
    q = QUESTIONS[m['qorder'][m['qi']]]
    is_holder = m['holder'] == pid
    visible = is_holder or m['sub'] in ('reveal', 'done')
    if not visible:
        return None
    v = {'text': q['q'], 'options': q['o'], 'chapter': q['c'], 'difficulty': q['d']}
    if m['sub'] == 'reveal' and m['reveal']:
        v['correctIndex'] = m['reveal']['correctIndex']
        v['explanation'] = m['reveal']['explanation']
    return v


def state_view(m, pid):
    tick(m)
    me = player(m, pid)
    opp = other(m, pid)
    is_holder = m['holder'] == pid and m['phase'] == 'playing'
    if m['phase'] == 'lobby':
        return_lobby = True
    else:
        return_lobby = False
    if return_lobby:
        status = 'بانتظار دخول المنافس'
        timer_total = 0
    elif m['sub'] == 'reading':
        status = 'اقرأ السؤال ثم ابدأ المؤقت' if is_holder else 'المنافس يقرأ السؤال الآن'
        timer_total = m['readSeconds'] * 1000
    elif m['sub'] == 'answering':
        status = 'أجب قبل انتهاء الوقت!' if is_holder else 'بانتظار إجابة المنافس'
        timer_total = m['answerSeconds'] * 1000
    elif m['sub'] == 'reveal':
        status = 'نتيجة هذا السؤال'
        timer_total = REVEAL_SECONDS * 1000
    else:
        status = ''
        timer_total = 0
    return {
        'ok': True,
        'code': m['code'],
        'serverNow': int(now() * 1000),
        'phase': m['phase'],
        'sub': m['sub'],
        'status': status,
        'round': m['qi'] + 1 if m['phase'] == 'playing' else m['qi'],
        'total': m['rounds'],
        'answerSeconds': m['answerSeconds'],
        'readSeconds': m['readSeconds'],
        'yourTurn': is_holder,
        'you': {'id': me['id'], 'name': me['name'], 'score': me['score'],
                'isHost': m['players'][0]['id'] == me['id']},
        'opponent': ({'id': opp['id'], 'name': opp['name'], 'score': opp['score'],
                      'online': now() - opp['seen'] < 12} if opp else None),
        'players': [{'id': p['id'], 'name': p['name'], 'score': p['score'],
                     'isHost': m['players'][0]['id'] == p['id'],
                     'online': now() - p['seen'] < 12} for p in m['players']],
        'question': question_view(m, pid),
        'remainingMs': max(0, int((m['deadline'] - now()) * 1000)) if m['deadline'] else 0,
        'timerTotalMs': timer_total,
        'reveal': m['reveal'] if m['sub'] == 'reveal' else None,
        'winner': m['winner'] if m['phase'] == 'finished' else None,
        'events': [e['text'] for e in m['events'][-4:]],
    }


def err(msg):
    return {'ok': False, 'error': msg}


def handle(path, body):
    global MATCHES
    with LOCK:
        if path == '/api/health':
            return {'ok': True, 'matches': len(MATCHES), 'questions': len(QUESTIONS)}

        if path == '/api/create':
            name = (body.get('name') or '').strip()[:24] or 'لاعب'
            rounds = int(body.get('rounds') or 10)
            secs = int(body.get('answerSeconds') or 15)
            rounds = max(5, min(20, rounds))
            secs = max(8, min(30, secs))
            code = ''.join(random.choice(CODE_CHARS) for _ in range(6))
            while code in MATCHES:
                code = ''.join(random.choice(CODE_CHARS) for _ in range(6))
            m = new_match(code, rounds, secs)
            pid, token = uuid.uuid4().hex[:12], uuid.uuid4().hex[:16]
            m['players'].append({'id': pid, 'token': token, 'name': name,
                                 'score': 0, 'seen': now()})
            MATCHES[code] = m
            push(m, 'أُنشئت الغرفة. شارك الكود مع منافسك.')
            out = state_view(m, pid)
            out['pid'] = pid
            out['token'] = token
            return out

        if path == '/api/join':
            code = norm_code(body.get('code'))
            m = MATCHES.get(code)
            if not m:
                return err('الكود غير صحيح أو انتهت صلاحية الغرفة.')
            if m['phase'] != 'lobby':
                return err('بدأت المنافسة بالفعل، لا يمكن الدخول الآن.')
            if len(m['players']) >= 2:
                return err('الغرفة ممتلئة بلاعبين.')
            name = (body.get('name') or '').strip()[:24] or 'منافس'
            pid, token = uuid.uuid4().hex[:12], uuid.uuid4().hex[:16]
            m['players'].append({'id': pid, 'token': token, 'name': name,
                                 'score': 0, 'seen': now()})
            push(m, 'انضم ' + name + ' إلى المنافسة.')
            out = state_view(m, pid)
            out['pid'] = pid
            out['token'] = token
            return out

        code = norm_code(body.get('code'))
        m = MATCHES.get(code)
        if not m:
            return err('الغرفة غير موجودة. اطلب كودًا جديدًا من منافسك.')
        pid = body.get('pid') or ''
        token = body.get('token') or ''
        p = player(m, pid)
        if not p or p['token'] != token:
            return err('جلسة غير صالحة. أعد الدخول بالكود.')
        p['seen'] = now()
        m['touched'] = now()

        if path == '/api/start':
            if m['players'][0]['id'] != pid:
                return err('صاحب الغرفة فقط يبدأ المنافسة.')
            if len(m['players']) < 2:
                return err('بانتظار دخول المنافس بالكود.')
            if m['phase'] != 'lobby':
                return err('المنافسة جارية بالفعل.')
            start_match(m)
            return state_view(m, pid)

        if path == '/api/begin':
            tick(m)
            if m['phase'] != 'playing' or m['sub'] != 'reading' or m['holder'] != pid:
                return err('ليس وقت بدء المؤقت.')
            begin_answering(m)
            return state_view(m, pid)

        if path == '/api/answer':
            tick(m)
            if m['phase'] != 'playing':
                return err('المنافسة غير جارية.')
            if m['sub'] != 'answering' or m['holder'] != pid:
                return err('ليس دورك للإجابة الآن.')
            if int(body.get('qi', -1)) != m['qi']:
                return err('انتهى هذا السؤال، انتظر السؤال التالي.')
            try:
                idx = int(body.get('option'))
            except (TypeError, ValueError):
                return err('اختر أحد الخيارات.')
            if idx < 0 or idx > 3:
                return err('اختيار غير صالح.')
            q = QUESTIONS[m['qorder'][m['qi']]]
            if idx == q['a']:
                left = max(0, int(m['deadline'] - now()))
                points = 10 + min(left, m['answerSeconds'])
                p['score'] += points
                do_reveal(m, pid, points,
                          'إجابة صحيحة! ' + p['name'] + ' حصد ' + ar(points) + ' نقطة')
            else:
                fail(m, pid, 'إجابة خاطئة من ' + p['name'])
            return state_view(m, pid)

        if path == '/api/leave':
            if m['phase'] == 'lobby' and m['players'][0]['id'] == pid:
                del MATCHES[code]
            return {'ok': True, 'left': True}

        if path == '/api/state':
            return state_view(m, pid)

        return err('طلب غير معروف: ' + path)


def cleanup():
    while True:
        time.sleep(30)
        with LOCK:
            t = now()
            for c in list(MATCHES):
                m = MATCHES[c]
                # تقدّم الحالة حتى مع غياب الاستطلاع
                tick(m)
                if t - m['touched'] > MAX_AGE:
                    del MATCHES[c]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')

    def _send(self, code, payload, ctype='application/json; charset=utf-8'):
        data = payload if isinstance(payload, bytes) else json.dumps(
            payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self._send(204, b'')

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/'):
            self._send(200, handle(path, {}))
            return
        try:
            with open(os.path.join(BASE, 'client.html'), encoding='utf-8') as f:
                html = f.read()
            html = html.replace('__SERVER__', 'location.origin')
            self._send(200, html.encode('utf-8'), 'text/html; charset=utf-8')
        except OSError:
            self._send(404, err('الواجهة غير موجودة.'))

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            n = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(n) if n else b'{}'
            body = json.loads(raw.decode('utf-8'))
            if not isinstance(body, dict):
                body = {}
        except (ValueError, UnicodeDecodeError):
            body = {}
        self._send(200, handle(path, body))


if __name__ == '__main__':
    threading.Thread(target=cleanup, daemon=True).start()
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    srv.daemon_threads = True
    print('قسم العباقرة — الخادم يعمل على 0.0.0.0:%d' % PORT, flush=True)
    print('الأسئلة: %d · الغرف: %d' % (len(QUESTIONS), len(MATCHES)), flush=True)
    srv.serve_forever()
