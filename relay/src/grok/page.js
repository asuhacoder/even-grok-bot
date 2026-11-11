// Injected into the Grok Bot renderer through CDP Runtime.evaluate.
// Every assumption about Grok Bot's DOM and React tree lives in this file,
// so an app update that breaks reading or acting is fixed here only.
(() => {
  const VERSION = 5;
  if (window.__evenGrok && window.__evenGrok.version === VERSION) return 'ready';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fiberOf = el => el && el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
  const propsUp = (el, pred, limit = 60) => {
    let f = fiberOf(el);
    for (let i = 0; f && i < limit; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && pred(p)) return p;
    }
    return null;
  };
  const botButtons = () => [...document.querySelectorAll('button[data-agent-id]')];
  const transcriptAnchor = () => document.querySelector('.sand-virtual-transcript__row') || document.querySelector('[role=log]');
  const transcriptProps = () => propsUp(transcriptAnchor(), p => 'isAgentRunning' in p && Array.isArray(p.entries));
  const jumpProps = () => propsUp(transcriptAnchor(), p => typeof p.onJumpToEntry === 'function');
  const composer = () => document.querySelector('[aria-label="プロンプト"][contenteditable="true"]');
  const label = b => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim();

  function bots() {
    return botButtons().map(b => {
      const row = propsUp(b, p => 'lastEntryPreview' in p && p.agent) || {};
      const item = propsUp(b, p => 'isWorking' in p) || {};
      const aria = b.getAttribute('aria-label') || '';
      return {
        id: b.dataset.agentId,
        name: (row.agent && row.agent.name) || aria.split(', ')[0],
        preview: typeof row.lastEntryPreview === 'string' ? row.lastEntryPreview : b.getAttribute('aria-description') || '',
        awaiting: b.dataset.awaiting !== undefined,
        working: !!item.isWorking,
        unread: aria.includes('未読'),
        current: b.getAttribute('aria-current') === 'page',
      };
    });
  }

  function currentId() {
    const b = document.querySelector('button[data-agent-id][aria-current="page"]');
    return b ? b.dataset.agentId : null;
  }

  function transcript() {
    const p = transcriptProps();
    if (!p) return null;
    return {
      agentId: p.currentAgentId,
      loadState: typeof p.loadState === 'string' ? p.loadState : JSON.stringify(p.loadState),
      running: !!p.isAgentRunning,
      hasOlder: !!p.hasOlder,
      unreadAnchor: p.windowEdge ? p.windowEdge.unreadAnchor : null,
      entries: JSON.parse(JSON.stringify(p.entries)),
    };
  }

  async function waitFor(pred, ms = 8000) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const v = pred();
      if (v) return v;
      await sleep(40);
    }
    return null;
  }

  async function open(agentId) {
    const ready = () => {
      const p = transcriptProps();
      return p && p.currentAgentId === agentId && p.loadState === 'ready';
    };
    if (ready()) return true;
    const b = botButtons().find(x => x.dataset.agentId === agentId);
    if (!b) return false;
    b.click();
    return !!(await waitFor(ready));
  }

  function composerText() {
    const c = composer();
    return c ? c.innerText.trim() : null;
  }

  function focusComposer() {
    const c = composer();
    if (!c) return false;
    c.focus();
    return document.activeElement === c || c.contains(document.activeElement);
  }

  const showing = agentId => {
    const p = transcriptProps();
    return !!p && p.currentAgentId === agentId && currentId() === agentId;
  };

  // The Bot check and the click run in one task, so a human switching Bots on the Mac cannot slip in between.
  async function clickSend(agentId) {
    const btn = await waitFor(() => {
      const form = composer() && composer().closest('form');
      return form && [...form.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'メッセージを送信' && !b.disabled);
    }, 3000);
    if (!btn) return 'no-button';
    if (!showing(agentId)) return 'switched';
    btn.click();
    return 'sent';
  }

  // Removes text the relay typed, only if the composer still holds exactly that text.
  function clearComposer(text) {
    const c = composer();
    if (!c || c.innerText.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return false;
    c.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    return c.innerText.trim() === '';
  }

  function rowFor(entryId) {
    return [...document.querySelectorAll('.sand-virtual-transcript__row')].find(r => {
      const k = r.dataset.rowKey || '';
      return (k === entryId || k.startsWith(entryId + '@')) && !k.endsWith(':timestamp');
    });
  }

  async function reveal(entryId) {
    let row = rowFor(entryId);
    if (row) return row;
    const j = jumpProps();
    if (j) j.onJumpToEntry(entryId);
    return waitFor(() => rowFor(entryId), 3000);
  }

  const collapsed = s => (s || '').replace(/\s+/g, ' ').trim();

  // Option buttons prefix a shortcut letter and may append a description.
  // The choice is the first visible leaf, not the button's full text.
  function optionLabel(button) {
    const leaf = firstVisibleLeaf(button);
    if (!leaf || leaf === button) return '';
    return collapsed(leaf.innerText || '');
  }

  function firstVisibleLeaf(el) {
    if (!el || el.getAttribute('aria-hidden') === 'true') return null;
    const kids = [...(el.children || [])];
    if (kids.length === 0) return el;
    for (const kid of kids) {
      const found = firstVisibleLeaf(kid);
      if (found) return found;
    }
    return null;
  }

  function matchesLabel(button, want) {
    if (!want) return false;
    if (collapsed(button.getAttribute('aria-label')) === want) return true;
    if (collapsed(button.innerText) === want) return true;
    return optionLabel(button) === want;
  }

  async function clickInRow(entryId, labels) {
    const row = await reveal(entryId);
    if (!row) return { ok: false, fixture: null };
    const buttons = [...row.querySelectorAll('button,[role=button],[role=radio],[role=option]')];
    for (const want of labels) {
      const b = buttons.find(x => !x.disabled && x.getAttribute('aria-disabled') !== 'true' && matchesLabel(x, want));
      if (b) {
        b.click();
        return { ok: true, label: want };
      }
    }
    return { ok: false, fixture: row.outerHTML.slice(0, 20000), buttons: buttons.map(label) };
  }

  // Stop controls Grok Bot 0.71.2 shows for a running Bot: cloud-agent cards in the transcript
  // ("<title>を停止") and the computer-use control ("停止"). Calls and routines are excluded.
  function stopControls() {
    const inTranscript = [...document.querySelectorAll('[role=log] button')].filter(b => /を停止$/.test(label(b)) && !/通話|ルーティン|一時停止/.test(label(b)));
    const computer = [...document.querySelectorAll('[role=region][data-phase] button')].filter(b => label(b) === '停止');
    return [...inTranscript, ...computer].filter(b => !b.disabled);
  }

  function stop() {
    const b = stopControls()[0];
    if (!b) return false;
    b.click();
    return true;
  }

  async function loadOlder() {
    const p = transcriptProps();
    if (!p || !p.hasOlder) return false;
    const scroller = document.querySelector('[role=log]') && document.querySelector('[role=log]').closest('[data-native-scrollbar]');
    if (!scroller) return false;
    const before = p.entries.length;
    scroller.scrollTop = 0;
    return !!(await waitFor(() => {
      const q = transcriptProps();
      return q && q.entries.length > before;
    }, 5000));
  }

  function health() {
    return { signedIn: !!document.querySelector('button[data-agent-id]'), focused: document.hasFocus(), hidden: document.hidden };
  }

  window.__evenGrok = {
    version: VERSION,
    bots,
    currentId,
    transcript,
    open,
    composerText,
    focusComposer,
    clickSend,
    clearComposer,
    showing,
    clickInRow,
    canStop: () => stopControls().length > 0,
    stop,
    loadOlder,
    health,
  };
  return 'installed';
})();
