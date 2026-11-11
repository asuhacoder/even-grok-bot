// Model -> what the glasses show. Pure; the driver turns a View into SDK calls.

import type { BotStatus } from '../../shared/protocol.ts';
import { cardChoices, cardPages, menuFor, top } from './machine.ts';
import type { MenuId, Model } from './machine.ts';
import { ITEM_MAX_BYTES, LINES_PER_PAGE, clipBytes, fitLine, lastTop, lines, paginate, windowLines } from './pages.ts';

export type View =
  | { kind: 'text'; header: string; body: string; menu: MenuId[] }
  | { kind: 'list'; header: string; items: string[]; menu: MenuId[] };

export const MENU_LABELS: Record<MenuId, string> = {
  stop: '停止',
  latest: '最新へ移動',
  unread: '最初の未読へ移動',
  list: 'Bot一覧へ',
  status: '接続状態を表示',
  redo: '録り直し',
};

const STATUS_LABEL: Record<BotStatus, string> = {
  'needs-action': '要対応',
  working: '作業中',
  unread: '未読',
  idle: '',
};

/** List rows: one screen line, within the host's 63-byte item cap. */
const row = (s: string) => clipBytes(fitLine(s), ITEM_MAX_BYTES);

function healthy(m: Model): boolean {
  return m.connected && m.health.relay === 'ok' && m.health.grok === 'ok';
}

export function view(m: Model): View {
  const s = top(m);
  const menu = menuFor(s);
  const pendingMark = s.name !== 'notice' && m.notices.length > 0 ? ` ●${m.notices.length}` : '';
  const head = (title: string) => fitLine([title + pendingMark, m.toast].filter(Boolean).join('  '));
  const botName = (id: string) => m.bots.find(b => b.id === id)?.name ?? m.conversation?.botName ?? '';

  switch (s.name) {
    case 'notice': {
      const i = m.notices.findIndex(n => n.id === s.id);
      const n = m.notices[i];
      if (!n) return { kind: 'text', header: '', body: '', menu };
      const kind = n.kind === 'needs-action' ? '要対応' : n.kind === 'done' ? '完了' : '新着';
      const count = m.notices.length > 1 ? `  ${i + 1}/${m.notices.length}` : '';
      return { kind: 'text', header: fitLine(`［${kind}］${n.botName}${count}`), body: paginate(n.text, LINES_PER_PAGE)[0]!, menu };
    }

    case 'list': {
      const items = s.rows.map(b => {
        const st = STATUS_LABEL[b.status];
        return row(`${b.name}${st ? `｜${st}` : ''}｜${b.preview}`);
      });
      const empty = m.connected ? '（Botがありません）' : '接続中…';
      return { kind: 'list', header: head(healthy(m) ? 'Bot一覧' : `！ ${m.health.detail}`), items: items.length ? items : [empty], menu };
    }

    case 'conversation': {
      const c = m.conversation?.botId === s.botId ? m.conversation : null;
      if (!c || s.top === null) return { kind: 'text', header: head(botName(s.botId)), body: '読み込み中…', menu };
      const t = Math.min(s.top, lastTop(c));
      const total = lines(c).length;
      const pct = Math.floor((Math.min(total, t + LINES_PER_PAGE) / total) * 100);
      const state = c.pending ? '要対応・タップで回答' : c.running ? '作業中' : '';
      const title = `${pct}% ${c.botName}${state ? `｜${state}` : ''}`;
      return { kind: 'text', header: head(title), body: windowLines(c, t).map(l => l.text).join('\n'), menu };
    }

    case 'recording':
      return { kind: 'text', header: head(`録音中｜${botName(s.botId)}`), body: '話してください\nタップで終了／ダブルタップで破棄', menu };

    case 'transcribing':
      return { kind: 'text', header: head('文字起こし中'), body: '…', menu };

    case 'confirm':
      return { kind: 'text', header: head(`送信確認｜${botName(s.botId)}`), body: `${clipBytes(s.text, 900)}\n\nタップで送信／ダブルタップで破棄`, menu };

    case 'question':
    case 'approval': {
      const title = s.name === 'question' ? '質問' : '承認依頼';
      if (s.phase === 'choices') {
        // Numbers match the numbered options on the question screen; the voice row has none.
        const items = cardChoices(m, s).map((c, i) => row(s.name === 'question' && c.pick !== 'voice' ? `${i + 1}. ${c.label}` : c.label));
        const what = s.name === 'question' ? '回答' : '操作';
        return { kind: 'list', header: head(`${what}を選ぶ｜上下で移動・タップで決定`), items, menu };
      }
      const ps = cardPages(m, s);
      const p = Math.min(s.page, ps.length - 1);
      const next = s.name === 'question' ? 'タップで回答を選ぶ' : 'タップで許可・拒否を選ぶ';
      const more = p + 1 < ps.length ? '\n\n▼下へスワイプで続き' : `\n\n${next}`;
      return { kind: 'text', header: head(`${title}｜${botName(s.botId)}  ${p + 1}/${ps.length}`), body: ps[p]! + more, menu };
    }

    case 'always-confirm':
      return {
        kind: 'text',
        header: head('常に許可の確認'),
        body: '同じ種類の操作を今後も自動で許可します。\nタップで確定／ダブルタップで戻る',
        menu,
      };

    case 'status': {
      const mark = (v: string) => (v === 'ok' ? '正常' : v === 'signed-out' ? '未ログイン' : '停止');
      return {
        kind: 'text',
        header: head('接続状態'),
        body: [
          `G2とMac mini: ${m.connected ? '接続中' : '切断'}`,
          `中継: ${mark(m.health.relay)}`,
          `Grok Bot: ${mark(m.health.grok)}`,
          `音声認識: ${mark(m.health.asr)}`,
          m.health.detail,
        ].join('\n'),
        menu,
      };
    }
  }
}
