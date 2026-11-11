// Dev-only: probes which page shapes the host accepts. Results go to the console.
import { CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty, RebuildPageContainer, TextContainerProperty, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
const bridge = await waitForEvenAppBridge();
const text = (id: number, name: string, y: number, h: number, content: string, cap: number) =>
  new TextContainerProperty({ xPosition: 0, yPosition: y, width: 576, height: h, borderWidth: 0, paddingLength: 4, containerID: id, containerName: name, content, isEventCapture: cap });
const list = (items: string[], extra: Record<string, unknown> = {}) =>
  new ListContainerProperty({ xPosition: 0, yPosition: 36, width: 576, height: 252, borderWidth: 0, paddingLength: 4, containerID: 3, containerName: 'list', isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 568, isItemSelectBorderEn: 1, itemName: items }), ...extra });
const log = (k: string, v: unknown) => console.log(`EXP ${k} => ${JSON.stringify(v)}`);
log('create empty header+body', await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [text(1, 'hdr', 0, 36, '', 0), text(2, 'body', 36, 252, '', 1)] })));
// log('create nonempty', await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [text(1, 'hdr', 0, 36, 'h', 0), text(2, 'body', 36, 252, 'b', 1)] })));
const mk = (items: string[]) => () => new RebuildPageContainer({ containerTotalNum: 2, textObject: [text(1, 'hdr', 0, 36, 'h', 0)], listObject: [list(items)] });
const tx = (body: string) => () => new RebuildPageContainer({ containerTotalNum: 2, textObject: [text(1, 'hdr', 0, 36, 'h', 0), text(2, 'body', 36, 252, body, 1)] });
const variants: [string, () => RebuildPageContainer][] = [];
variants.push(['base page', tx('あ')]);
for (const [k, f] of variants) log(k, await bridge.rebuildPageContainer(f()));
console.log('EXP done');
const { TextContainerUpgrade } = await import('@evenrealities/even_hub_sdk');
for (const n of [10, 100, 300, 333, 334, 500, 666, 667]) log(`upgrade jp ${n} (${n * 3}B)`, await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'body', content: 'い'.repeat(n) })));

