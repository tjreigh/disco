import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

test.describe('private Score Race', () => {
  test('two players play, reconnect, and render the same winner', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await host.goto('/?multiplayer=create');
      await expect(host).toHaveURL(/\?room=[A-Z2-9]{8}$/);
      await expect(host.getByRole('heading', { name: 'ROOM CODE' })).toBeVisible();
      const inviteUrl = host.url();

      await guest.goto(inviteUrl);
      await expect(guest.getByRole('heading', { name: 'ROOM CODE' })).toBeVisible();
      await expect(guest.locator('.multiplayer-room__code')).toHaveText(
        await host.locator('.multiplayer-room__code').textContent() ?? '',
      );

      await host.getByRole('button', { name: 'READY', exact: true }).click();
      await guest.getByRole('button', { name: 'READY', exact: true }).click();
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('MATCH LIVE', {
        timeout: 6_000,
      });
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('MATCH LIVE', {
        timeout: 6_000,
      });

      await Promise.all([
        playOneTurn(host),
        playOneTurn(guest),
      ]);
      await expect(host.locator('.multiplayer-hud__opponent')).toContainText('OPPONENT');
      await expect(guest.locator('.multiplayer-hud__opponent')).toContainText('OPPONENT');

      await disconnectLiveSocket(host);
      await expect(host.locator('.multiplayer-hud__status')).toHaveText(
        /CONNECTION LOST|RECONNECTING/,
      );
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('MATCH LIVE', {
        timeout: 6_000,
      });

      // Complete through the same public protocol so this test proves results
      // without waiting for the three-minute production deadline.
      await finishThroughLiveSocket(host, 1_000);
      await finishThroughLiveSocket(guest, 0);

      await expect(host.getByRole('heading', { name: 'YOU WIN' })).toBeVisible();
      await expect(guest.getByRole('heading', { name: 'YOU LOSE' })).toBeVisible();
      await expect(host.locator('.multiplayer-hud__result')).toContainText('YOU WIN');
      await expect(guest.locator('.multiplayer-hud__result')).toContainText('YOU LOSE');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

async function multiplayerContext(browser: Browser) {
  const context = await browser.newContext();
  await installSocketObserver(context);
  return context;
}

async function installSocketObserver(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const observed = {
      sockets: [] as WebSocket[],
      incoming: [] as any[],
      outgoing: [] as any[],
    };
    Object.defineProperty(window, '__discoMultiplayerTest', {
      value: observed,
      configurable: false,
    });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = new target(...args as ConstructorParameters<typeof WebSocket>);
        observed.sockets.push(socket);
        const nativeSend = socket.send.bind(socket);
        socket.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === 'string') {
            try {
              observed.outgoing.push(JSON.parse(data));
            } catch {
              // The production transport will reject malformed data.
            }
          }
          nativeSend(data);
        }) as typeof socket.send;
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          try {
            observed.incoming.push(JSON.parse(event.data));
          } catch {
            // The production transport owns validation.
          }
        });
        return socket;
      },
    });
  });
}

async function playOneTurn(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Multiplayer board is not visible');
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect.poll(async () => await page.evaluate(() => {
    const observed = (window as any).__discoMultiplayerTest;
    return observed.outgoing.some((message: any) => message.type === 'publish-progress');
  })).toBe(true);
}

async function finishThroughLiveSocket(page: Page, scoreBonus: number): Promise<void> {
  await page.evaluate((bonus) => {
    const observed = (window as any).__discoMultiplayerTest;
    const progressMessage = [...observed.outgoing]
      .reverse()
      .find((message: any) => message.type === 'publish-progress');
    if (!progressMessage) throw new Error('No accepted multiplayer turn was published');
    const socket = [...observed.sockets]
      .reverse()
      .find((candidate: WebSocket) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No live multiplayer socket');
    socket.send(JSON.stringify({
      protocolVersion: progressMessage.protocolVersion,
      roomId: progressMessage.roomId,
      playerId: progressMessage.playerId,
      type: 'finish-match',
      matchId: progressMessage.matchId,
      progress: {
        ...progressMessage.progress,
        sequence: progressMessage.progress.sequence + 1,
        score: progressMessage.progress.score + bonus,
      },
    }));
  }, scoreBonus);
}

async function disconnectLiveSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observed = (window as any).__discoMultiplayerTest;
    const socket = [...observed.sockets]
      .reverse()
      .find((candidate: WebSocket) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error('No live multiplayer socket');
    socket.close(4000, 'E2E reconnect check');
  });
}
