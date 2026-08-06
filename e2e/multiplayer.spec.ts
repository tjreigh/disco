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
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', {
        timeout: 6_000,
      });
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE', {
        timeout: 6_000,
      });
      await expect(host.locator('.multiplayer-room')).toBeHidden();
      await expect(guest.locator('.multiplayer-room')).toBeHidden();
      await expectHudLayout(host);
      await expectHudLayout(guest);
      await host.setViewportSize({ width: 393, height: 852 });
      await expectHudLayout(host);

      await Promise.all([
        playOneTurn(host),
        playOneTurn(guest),
      ]);
      await expect(host.locator('.multiplayer-hud__opponent-value')).toHaveText(/^\d/);
      await expect(guest.locator('.multiplayer-hud__opponent-value')).toHaveText(/^\d/);
      await expect(host.locator('.multiplayer-hud__local-value')).toHaveText(/^\d/);
      await expect(guest.locator('.multiplayer-hud__local-value')).toHaveText(/^\d/);
      await expectHudLayout(host);
      await expectHudLayout(guest);

      await disconnectLiveSocket(host);
      await expect(host.locator('.multiplayer-hud__status')).toHaveText(
        /OFFLINE|REJOINING/,
      );
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', {
        timeout: 6_000,
      });

      // Complete through the same public protocol so this test proves results
      // without waiting for the three-minute production deadline.
      await finishThroughLiveSocket(host, 1_000);
      await finishThroughLiveSocket(guest, 0);

      await expect(host.getByRole('heading', { name: 'YOU WIN' })).toBeVisible();
      await expect(guest.getByRole('heading', { name: 'YOU LOSE' })).toBeVisible();
      await expect(host.getByRole('button', { name: 'PLAY AGAIN', exact: true })).toBeVisible();
      await expect(guest.getByRole('button', { name: 'PLAY AGAIN', exact: true })).toBeVisible();
      await expect(host.locator('[data-multiplayer-action="copy"]')).toBeHidden();
      await expect(guest.locator('[data-multiplayer-action="copy"]')).toBeHidden();
      await expect(host.locator('.multiplayer-hud__result')).toContainText('YOU WIN');
      await expect(guest.locator('.multiplayer-hud__result')).toContainText('YOU LOSE');

      await host.getByRole('button', { name: 'PLAY AGAIN', exact: true }).click();
      await expect(host.getByRole('button', { name: 'CANCEL REMATCH', exact: true }))
        .toBeVisible();
      await expect(host.locator('.multiplayer-room__message')).toContainText(
        'Waiting for your opponent',
      );
      await expect(guest.locator('.multiplayer-room__message')).toContainText(
        'opponent wants another round',
      );

      await guest.getByRole('button', { name: 'PLAY AGAIN', exact: true }).click();
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', {
        timeout: 6_000,
      });
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE', {
        timeout: 6_000,
      });
      await expect(host.locator('.multiplayer-room')).toBeHidden();
      await expect(guest.locator('.multiplayer-room')).toBeHidden();
      await expect.poll(async () => await receivedMatchIds(host)).toHaveLength(2);
      await expect.poll(async () => await receivedMatchIds(guest)).toHaveLength(2);
      await expect(host.locator('.multiplayer-hud__local-value')).toHaveText('0');
      await expect(guest.locator('.multiplayer-hud__local-value')).toHaveText('0');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

test.describe('private Score Race pause menu', () => {
  test('pausing freezes the match for both players, and forfeiting ends it', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await host.goto('/?multiplayer=create');
      await expect(host).toHaveURL(/\?room=[A-Z2-9]{8}$/);
      const inviteUrl = host.url();
      await guest.goto(inviteUrl);

      await host.getByRole('button', { name: 'READY', exact: true }).click();
      await guest.getByRole('button', { name: 'READY', exact: true }).click();
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 6_000 });
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 6_000 });

      // Host opens the pause menu.
      await host.getByRole('button', { name: 'Game menu' }).click();
      await expect(host.getByRole('heading', { name: 'MENU' })).toBeVisible();

      // The guest sees the passive paused banner and cannot play while paused.
      await expect(guest.locator('.multiplayer-room')).toHaveAttribute('data-state', 'paused');
      await expect(guest.getByText('Your opponent paused the match.')).toBeVisible();
      const outgoingBeforePause = await countOutgoing(guest, 'publish-progress');
      const canvas = guest.locator('canvas');
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error('Multiplayer board is not visible');
      // The paused overlay visually covers the board, so a real click can't
      // land at all — force the click to prove the server-side rejection
      // (not just the overlay's own coverage) is what's actually blocking play.
      await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 }, force: true });
      await guest.waitForTimeout(300);
      expect(await countOutgoing(guest, 'publish-progress')).toBe(outgoingBeforePause);

      // Resuming clears the banner and re-enables play on both sides.
      await host.getByRole('button', { name: 'RESUME', exact: true }).click();
      await expect(host.getByRole('heading', { name: 'MENU' })).toBeHidden();
      await expect(guest.locator('.multiplayer-room')).toBeHidden();
      await playOneTurn(guest);

      // Host forfeits — the guest is declared the winner regardless of score.
      await host.getByRole('button', { name: 'Game menu' }).click();
      await host.getByRole('button', { name: 'FORFEIT MATCH', exact: true }).click();
      await host.getByRole('button', { name: 'FORFEIT', exact: true }).click();

      await expect(host.getByRole('heading', { name: 'YOU LOSE' })).toBeVisible();
      await expect(guest.getByRole('heading', { name: 'YOU WIN' })).toBeVisible();
      await expect(host.locator('.multiplayer-room__badge')).toHaveText('YOU FORFEITED');
      await expect(guest.locator('.multiplayer-room__badge')).toHaveText('OPPONENT FORFEITED');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

async function countOutgoing(page: Page, type: string): Promise<number> {
  return await page.evaluate((messageType) => {
    const observed = (window as any).__discoMultiplayerTest;
    return observed.outgoing.filter((message: any) => message.type === messageType).length;
  }, type);
}

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

async function receivedMatchIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const observed = (window as any).__discoMultiplayerTest;
    return [...new Set<string>(observed.incoming
      .filter((message: any) => message.type === 'match-countdown')
      .map((message: any) => message.matchId))];
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

async function expectHudLayout(page: Page): Promise<void> {
  await expect.poll(async () => {
    const multiplayer = await page.locator('.multiplayer-hud').boundingBox();
    const canvas = await page.locator('canvas').boundingBox();
    const turns = await page.locator('.game-hud__turns').boundingBox();
    const bottom = await page.locator('.game-hud__bottom').boundingBox();
    const queue = await page.locator('.game-hud__queue').boundingBox();
    const timer = await page.locator('.multiplayer-hud__timer').boundingBox();
    if (!multiplayer || !canvas || !turns || !bottom || !queue || !timer) {
      return 'missing HUD region';
    }
    const viewport = page.viewportSize();
    if (!viewport) return 'missing viewport';
    if (Math.abs(turns.x + turns.width / 2 - viewport.width / 2) > 1) {
      return 'game HUD is not centered';
    }
    if (Math.abs(multiplayer.x + multiplayer.width / 2 - viewport.width / 2) > 1) {
      return 'multiplayer HUD is not centered';
    }
    if (overlaps(multiplayer, turns)) return 'multiplayer HUD overlaps turns';
    if (overlaps(multiplayer, bottom)) return 'multiplayer HUD overlaps bottom HUD';
    if (timer.x < multiplayer.x
      || timer.x + timer.width > multiplayer.x + multiplayer.width) {
      return 'timer overflows multiplayer HUD';
    }
    const contentFits = await page.locator('.multiplayer-hud').evaluate(
      element => element.scrollWidth <= element.clientWidth,
    );
    if (!contentFits) return 'multiplayer HUD content overflows';
    const gridWidth = await page.locator('.game-stage').evaluate(element =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue('--game-grid-width')));
    const boardBottom = canvas.y + 96 + 8 + (gridWidth / 7) * 7.5;
    const bottomGap = queue.y - boardBottom;
    if (bottomGap < 0) return 'bottom HUD overlaps board';
    if (bottomGap > 50) return 'bottom HUD leaves excessive space below board';
    return 'clear';
  }, {
    message: 'game and multiplayer HUD regions should be centered, distinct, and content-safe',
  }).toBe('clear');
}

function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}
