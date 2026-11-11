// View -> Even Hub SDK calls. Layout changes rebuild the page; text-only
// changes go through the flicker-free textContainerUpgrade path. Renders are
// serialized and coalesced to the latest view because the BLE queue is slow.

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { MenuId } from './machine.ts';
import { HEADER_HEIGHT, ITEM_MAX_BYTES, LIST_MAX_ITEMS, PADDING, TEXT_MAX_BYTES, clipBytes, sanitize } from './pages.ts';
import { MENU_LABELS } from './view.ts';
import type { View } from './view.ts';

export const MENU_IDS: Record<MenuId, number> = { stop: 1, latest: 2, unread: 3, list: 4, status: 6, redo: 7 };
export const menuById = (id: number): MenuId | null =>
  (Object.entries(MENU_IDS).find(([, v]) => v === id)?.[0] as MenuId | undefined) ?? null;

const HEADER = { id: 1, name: 'hdr' };
const BODY = { id: 2, name: 'body' };
const LIST = { id: 3, name: 'list' };
const BODY_HEIGHT = 288 - HEADER_HEIGHT;

// Protobuf drops empty strings, so the host ignores an update to ""; a space clears the container.
const clean = (s: string, max = TEXT_MAX_BYTES) => clipBytes(sanitize(s), max) || ' ';

function header(text: string) {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: HEADER_HEIGHT,
    borderWidth: 0, paddingLength: PADDING, containerID: HEADER.id, containerName: HEADER.name,
    content: clean(text), isEventCapture: 0, textColor: 3,
  });
}

function pageOf(v: View) {
  const menuObject = v.menu.length
    ? new MenuContainerProperty({ menuItems: v.menu.map(id => new MenuItemProperty({ itemID: MENU_IDS[id], itemName: MENU_LABELS[id] })) })
    : undefined;
  const textObject = [header(v.header)];
  if (v.kind === 'text') {
    textObject.push(
      new TextContainerProperty({
        xPosition: 0, yPosition: HEADER_HEIGHT, width: 576, height: BODY_HEIGHT,
        borderWidth: 0, paddingLength: PADDING, containerID: BODY.id, containerName: BODY.name,
        content: clean(v.body), isEventCapture: 1,
      }),
    );
    return { containerTotalNum: 2, textObject, menuObject };
  }
  const items = v.items.slice(0, LIST_MAX_ITEMS).map(i => clean(i, ITEM_MAX_BYTES));
  const listObject = [
    new ListContainerProperty({
      xPosition: 0, yPosition: HEADER_HEIGHT, width: 576, height: BODY_HEIGHT,
      borderWidth: 0, paddingLength: PADDING, containerID: LIST.id, containerName: LIST.name, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 568, isItemSelectBorderEn: 1, itemName: items }),
    }),
  ];
  return { containerTotalNum: 2, textObject, listObject, menuObject };
}

const layoutKey = (v: View) => `${v.kind}|${v.menu.join(',')}|${v.kind === 'list' ? v.items.join('\n') : ''}`;

export class Glasses {
  private shown: View | null = null;
  private wanted: View | null = null;
  private busy = false;
  private readonly bridge: EvenAppBridge;
  private readonly onError: (e: unknown) => void;

  constructor(bridge: EvenAppBridge, onError: (e: unknown) => void) {
    this.bridge = bridge;
    this.onError = onError;
  }

  show(v: View): void {
    this.wanted = v;
    if (!this.busy) void this.flush();
  }

  private async flush(): Promise<void> {
    this.busy = true;
    try {
      while (this.wanted) {
        const v = this.wanted;
        this.wanted = null;
        await this.apply(v).catch(this.onError);
      }
    } finally {
      this.busy = false;
    }
  }

  private async apply(v: View): Promise<void> {
    const prev = this.shown;
    if (!prev) {
      // The host allows one startup page per session; after a WebView reload it answers 1 and wants a rebuild.
      const r = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(pageOf(v)));
      if (r !== 0 && !(await this.bridge.rebuildPageContainer(new RebuildPageContainer(pageOf(v)))))
        throw new Error(`createStartUpPageContainer failed: ${JSON.stringify(r)}`);
    } else if (layoutKey(prev) !== layoutKey(v)) {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(pageOf(v)));
      if (!ok) throw new Error(`rebuildPageContainer failed for ${v.kind}`);
    } else {
      if (prev.header !== v.header)
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: clean(v.header) }));
      if (v.kind === 'text' && prev.kind === 'text' && prev.body !== v.body)
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: BODY.id, containerName: BODY.name, content: clean(v.body) }));
    }
    this.shown = v;
  }
}
