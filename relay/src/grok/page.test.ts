import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

type DomNode = {
  tag: string;
  className: string;
  attrs: Record<string, string>;
  dataset: { rowKey?: string };
  innerText: string;
  disabled: boolean;
  children: DomNode[];
  clicked: boolean;
  click: () => void;
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => DomNode | null;
  querySelectorAll: (selector: string) => DomNode[];
  outerHTML: string;
};

function matches(node: DomNode, selector: string): boolean {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const role = /^\[role=(.+)\]$/.exec(selector);
  if (role) return node.attrs.role === role[1];
  return node.tag === selector;
}

function queryAll(node: DomNode, selector: string): DomNode[] {
  const parts = selector.split(',').map(s => s.trim());
  const out: DomNode[] = [];
  const walk = (n: DomNode) => {
    for (const child of n.children) {
      if (parts.some(p => matches(child, p))) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function el(tag: string, init: { className?: string; attrs?: Record<string, string>; text?: string; disabled?: boolean; children?: DomNode[] } = {}): DomNode {
  const node: DomNode = {
    tag,
    className: init.className ?? '',
    attrs: init.attrs ?? {},
    dataset: {},
    innerText: init.text ?? '',
    disabled: init.disabled ?? false,
    children: init.children ?? [],
    clicked: false,
    click() {
      this.clicked = true;
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    querySelector(selector) {
      return queryAll(this, selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return queryAll(this, selector);
    },
    outerHTML: '<row>',
  };
  return node;
}

function leaf(text: string, attrs?: Record<string, string>): DomNode {
  return el('span', { text, attrs });
}

/** Grok Bot 0.75 option button. Shortcut letter, then the label, then an optional description. */
function optionButton(letter: string, label: string, description?: string): DomNode {
  const body = description ? [leaf(label), leaf(description)] : [leaf(label)];
  const visible = description ? `${letter} ${label} ${description}` : `${letter} ${label}`;
  return el('button', {
    attrs: { type: 'button' },
    text: visible,
    children: [leaf(letter, { 'aria-hidden': 'true' }), el('span', { children: body })],
  });
}

function row(key: string, children: DomNode[]): DomNode {
  const node = el('div', { className: 'sand-virtual-transcript__row', children });
  node.dataset.rowKey = key;
  return node;
}

function install(rows: DomNode[]) {
  const document = el('body', { children: rows });
  const sandbox = {
    window: {} as { __evenGrok?: { clickInRow: (entryId: string, labels: string[]) => Promise<{ ok: boolean; label?: string }> } },
    document,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    Promise,
  };
  sandbox.window = sandbox as typeof sandbox.window;
  createContext(sandbox);
  runInContext(readFileSync(new URL('./page.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.__evenGrok!;
}

const LONG = 'これはグラスの一行には収まらないくらい長い選択肢のラベルです。デスクトップのボタンはその全文のままです。';

test('one option clicks the label leaf, not the shortcut letter', async () => {
  const button = optionButton('A', '設定済み');
  const api = install([row('entry-1@3', [button])]);
  const result = await api.clickInRow('entry-1', ['設定済み']);
  assert.equal(result.ok, true);
  assert.equal(button.clicked, true);
});

test('the clicked option is the one whose label matches, not a description that repeats it', async () => {
  const decoy = optionButton('A', '別案', '案B');
  const target = optionButton('B', '案B', '詳しい説明');
  const rest = [optionButton('C', '案C'), optionButton('D', '案D'), optionButton('E', '案E')];
  const api = install([row('entry-9@2', [decoy, target, ...rest])]);
  const result = await api.clickInRow('entry-9', ['案B']);
  assert.equal(result.ok, true);
  assert.equal(target.clicked, true);
  assert.equal(decoy.clicked, false);
  for (const button of rest) assert.equal(button.clicked, false);
});

test('a long label clicks the button that shows that full label', async () => {
  const button = optionButton('C', LONG);
  const api = install([row('entry-2@1', [button])]);
  const result = await api.clickInRow('entry-2', [LONG]);
  assert.equal(result.ok, true);
  assert.equal(button.clicked, true);
});

test('a disabled option and an aria-disabled option are not clicked', async () => {
  const disabled = optionButton('A', '設定済み');
  disabled.disabled = true;
  const aria = optionButton('B', 'これから');
  aria.attrs['aria-disabled'] = 'true';
  const api = install([row('entry-3@1', [disabled, aria])]);
  const blocked = await api.clickInRow('entry-3', ['設定済み']);
  const blockedAria = await api.clickInRow('entry-3', ['これから']);
  assert.equal(blocked.ok, false);
  assert.equal(blockedAria.ok, false);
  assert.equal(disabled.clicked, false);
  assert.equal(aria.clicked, false);
});

test('approval buttons still match the full label and not a longer label', async () => {
  const allow = el('button', { attrs: { 'aria-label': '許可' }, text: '許可' });
  const deny = el('button', { attrs: { 'aria-label': '許可しない' }, text: '許可しない' });
  const api = install([row('entry-4@8', [deny, allow])]);
  const result = await api.clickInRow('entry-4', ['許可']);
  assert.equal(result.ok, true);
  assert.equal(result.label, '許可');
  assert.equal(allow.clicked, true);
  assert.equal(deny.clicked, false);
});

test('a row keyed by the entry id is found, and a timestamp row is not', async () => {
  const stamp = optionButton('A', '案B');
  const real = optionButton('A', '案B');
  const api = install([row('entry-5:timestamp', [stamp]), row('entry-5', [real])]);
  const result = await api.clickInRow('entry-5', ['案B']);
  assert.equal(result.ok, true);
  assert.equal(real.clicked, true);
  assert.equal(stamp.clicked, false);
});
