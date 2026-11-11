// Drives the Grok Bot desktop app through CDP. Every UI operation runs on one
// serial queue so Bot switches never interleave, and after each operation the
// desktop goes back to the Bot it was showing before.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalChoice } from '../../../shared/protocol.ts';
import { Cdp } from '../cdp.ts';
import type { BotRow } from '../watch.ts';
import type { RawTranscript } from './normalize.ts';

const PAGE_JS = readFileSync(new URL('./page.js', import.meta.url), 'utf8');

/** Button labels Grok Bot 0.71.2 renders on approval cards (from its ja catalog), matched exactly within the card's row. */
const APPROVAL_LABELS: Record<ApprovalChoice, string[]> = {
  once: ['1回のみ許可', '一度だけ許可', '許可'],
  always: ['常に許可'],
  deny: ['拒否', '1回のみ拒否', '1回のみ拒否（Esc）', '拒否する', 'スキップ', '今はしない'],
};

export class GrokError extends Error {}

export class GrokClient {
  private cdp: Cdp | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly port: number;
  private readonly fixtureDir: string;

  constructor(port: number, fixtureDir: string) {
    this.port = port;
    this.fixtureDir = fixtureDir;
  }

  get connected(): boolean {
    return this.cdp !== null;
  }

  private async page(): Promise<Cdp> {
    if (this.cdp) return this.cdp;
    const cdp = await Cdp.connect(this.port);
    cdp.closed.then(() => {
      if (this.cdp === cdp) this.cdp = null;
    });
    this.cdp = cdp;
    return cdp;
  }

  private async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const cdp = await this.page();
    const argList = args.map(a => JSON.stringify(a)).join(',');
    try {
      return await cdp.evaluate<T>(`${PAGE_JS}\n;window.__evenGrok.${fn}(${argList})`);
    } catch (e) {
      if (!this.cdp) throw new GrokError('Grok Botに接続できません');
      throw e;
    }
  }

  /** Serialize UI work. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Switch to `botId`, run `op`, then put back whatever the desktop showed. */
  private withBot<T>(botId: string, op: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      const before = await this.call<string | null>('currentId');
      if (!(await this.call<boolean>('open', botId))) throw new GrokError('Botを開けませんでした');
      try {
        return await op();
      } finally {
        // Put the desktop back only if nobody at the Mac moved it meanwhile.
        const now = await this.call<string | null>('currentId').catch(() => null);
        if (before && before !== botId && now === botId) await this.call<boolean>('open', before).catch(() => false);
      }
    });
  }

  rows(): Promise<BotRow[]> {
    return this.run(() => this.call<BotRow[]>('bots'));
  }

  /** Transcript of the Bot the desktop is showing, without switching. */
  currentTranscript(): Promise<RawTranscript | null> {
    return this.run(() => this.call<RawTranscript | null>('transcript'));
  }

  read(botId: string): Promise<{ transcript: RawTranscript; canStop: boolean }> {
    return this.withBot(botId, async () => {
      const transcript = await this.call<RawTranscript | null>('transcript');
      if (!transcript || transcript.agentId !== botId) throw new GrokError('会話を読み込めませんでした');
      return { transcript, canStop: await this.call<boolean>('canStop') };
    });
  }

  /** Loads older entries and reads the result in the same visit, before the desktop switches back. */
  loadOlder(botId: string): Promise<{ transcript: RawTranscript; canStop: boolean } | null> {
    return this.withBot(botId, async () => {
      if (!(await this.call<boolean>('loadOlder'))) return null;
      const transcript = await this.call<RawTranscript | null>('transcript');
      if (!transcript || transcript.agentId !== botId) return null;
      return { transcript, canStop: await this.call<boolean>('canStop') };
    });
  }

  send(botId: string, text: string): Promise<string> {
    return this.withBot(botId, async () => {
      const draft = await this.call<string | null>('composerText');
      if (draft === null) throw new GrokError('入力欄が見つかりません');
      if (draft !== '') throw new GrokError('Macでこの Bot への下書きが入力中のため送れません');
      if (!(await this.call<boolean>('focusComposer'))) throw new GrokError('入力欄にフォーカスできません');
      const cdp = await this.page();
      if (!(await this.call<boolean>('showing', botId))) throw new GrokError('Macで別のBotに切り替えられたため送りませんでした');
      await cdp.send('Input.insertText', { text });
      try {
        const typed = await this.call<string | null>('composerText');
        if (typed?.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) throw new GrokError('入力内容を確認できませんでした');
        const r = await this.call<string>('clickSend', botId);
        if (r === 'switched') throw new GrokError('Macで別のBotに切り替えられたため送りませんでした');
        if (r !== 'sent') throw new GrokError('送信ボタンが押せません（作業中は送れない可能性があります）');
        return '送信しました';
      } catch (e) {
        await this.call<boolean>('clearComposer', text).catch(() => false);
        throw e;
      }
    });
  }

  answer(botId: string, entryId: string, label: string): Promise<string> {
    return this.withBot(botId, () => this.clickCard(botId, entryId, [label], '回答しました'));
  }

  approve(botId: string, entryId: string, choice: ApprovalChoice): Promise<string> {
    const done = { once: '一回だけ許可しました', always: '常に許可しました', deny: '拒否しました' }[choice];
    return this.withBot(botId, () => this.clickCard(botId, entryId, APPROVAL_LABELS[choice], done));
  }

  stop(botId: string): Promise<string> {
    return this.withBot(botId, async () =>
      (await this.call<boolean>('stop')) ? '停止しました' : 'デスクトップアプリにこのBotの停止操作がありません',
    );
  }

  health(): Promise<{ signedIn: boolean; focused: boolean; hidden: boolean }> {
    return this.run(() => this.call('health'));
  }

  private async clickCard(botId: string, entryId: string, labels: string[], done: string): Promise<string> {
    const r = await this.call<{ ok: boolean; fixture?: string | null; buttons?: string[] }>('clickInRow', entryId, labels);
    if (r.ok) return done;
    if (r.fixture) {
      await mkdir(this.fixtureDir, { recursive: true });
      await writeFile(join(this.fixtureDir, `${Date.now()}-${botId.slice(0, 8)}-${entryId}.html`), r.fixture);
    }
    throw new GrokError(`ボタンが見つかりません（${(r.buttons ?? []).join('/') || '表示なし'}）`);
  }
}
