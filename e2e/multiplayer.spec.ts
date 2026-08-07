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

test.describe('private Disco Duel sync and resilience', () => {
  test('HUD row stays within viewport bounds at a narrow mobile width', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);

      // Ready-up puts both HUDs in the LIVE/playing state, the widest
      // combination of visible fields either multiplayer-hud variant renders.
      await expectHudLayout(host);
      await expectHudLayout(guest);

      await host.setViewportSize({ width: 393, height: 852 });
      await guest.setViewportSize({ width: 393, height: 852 });
      await expectHudLayout(host);
      await expectHudLayout(guest);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('opponent ghost defaults to column 3 before any cursor move', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);

      // The very first duel-status pulse must carry activeColumn 3 for
      // whichever player acts first, and it must arrive before any
      // opponent-cursor relay — proving the ghost is correct by default,
      // not just correct once the active player moves.
      await expect.poll(
        async () => await countIncoming(guest, 'duel-status'),
        { message: 'guest should receive an initial duel-status' },
      ).toBeGreaterThan(0);
      const status = await guest.evaluate(() => {
        const observed = (window as any).__discoMultiplayerTest;
        return observed.incoming.find((m: any) => m.type === 'duel-status');
      });
      expect(status.activeColumn).toBe(3);

      const orderedTypes: string[] = await guest.evaluate(() => {
        const observed = (window as any).__discoMultiplayerTest;
        return observed.incoming
          .filter((m: any) => m.type === 'duel-status' || m.type === 'opponent-cursor')
          .map((m: any) => m.type);
      });
      const firstStatus = orderedTypes.indexOf('duel-status');
      const firstCursor = orderedTypes.indexOf('opponent-cursor');
      if (firstCursor !== -1) expect(firstStatus).toBeLessThan(firstCursor);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('reload mid-match restores authoritative state instead of resetting scores', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      const inviteUrl = await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);

      // Host always acts first (server assigns playerIds in join order).
      await waitForDuelTurn(host, true);
      await dropDuelTurn(host);
      await waitForDuelTurn(guest, true);
      await dropDuelTurn(guest);
      await waitForDuelTurn(host, true);

      const guestLocalBefore = await guest.locator('.multiplayer-hud__local-value').textContent();
      const guestOpponentBefore = await guest.locator('.multiplayer-hud__opponent-value').textContent();

      // A full reload tears down and reconstructs the transport/session from
      // scratch — this is the exact path that used to force both scores to 0.
      await host.reload();
      await host.goto(inviteUrl);
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 8_000 });

      await expect(host.locator('.multiplayer-hud__opponent-value')).toHaveText(guestLocalBefore ?? '');
      await expect(host.locator('.multiplayer-hud__local-value')).toHaveText(guestOpponentBefore ?? '');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('pause menu converges both players and resumes cleanly', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);

      await host.getByRole('button', { name: 'Game menu' }).click();
      await expect(host.getByRole('heading', { name: 'MENU' })).toBeVisible();
      await expect(guest.locator('.multiplayer-room')).toHaveAttribute('data-state', 'paused');
      await expect(guest.getByText('Your opponent paused the match.')).toBeVisible();

      // Pulses keep flowing while paused (they carry paused/pausedBy so a
      // reconnecting client can't get stuck on stale pause state).
      const pulsesWhilePaused = await countIncoming(guest, 'duel-status');
      await guest.waitForTimeout(1_200);
      await expect.poll(async () => await countIncoming(guest, 'duel-status'))
        .toBeGreaterThan(pulsesWhilePaused);

      await host.getByRole('button', { name: 'RESUME', exact: true }).click();
      await expect(host.getByRole('heading', { name: 'MENU' })).toBeHidden();
      await expect(guest.locator('.multiplayer-room')).toBeHidden();
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE');
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('disconnecting the pausing player auto-resumes and clears stale pause on reconnect', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);

      await host.getByRole('button', { name: 'Game menu' }).click();
      await expect(guest.locator('.multiplayer-room')).toHaveAttribute('data-state', 'paused');

      // Dropping the pausing player's connection must not permanently
      // freeze the room for whoever's left.
      await disconnectLiveSocket(host);
      await expect(guest.locator('.multiplayer-room')).toBeHidden({ timeout: 6_000 });

      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 8_000 });
      const lastStatus = await host.evaluate(() => {
        const observed = (window as any).__discoMultiplayerTest;
        return [...observed.incoming].reverse().find((m: any) => m.type === 'duel-status');
      });
      expect(lastStatus.paused).toBe(false);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('rapid repeated input does not duplicate a turn or break the connection', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);
      await waitForDuelTurn(host, true);

      const canvas = host.locator('canvas');
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error('Duel board is not visible');
      // Fire a burst of clicks well before the server can respond to the
      // first one — every click past the first should be rejected as a
      // recoverable duplicate-drop, not accepted or fatal.
      for (let i = 0; i < 6; i++) {
        await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 }, force: true });
      }

      await waitForDuelTurn(guest, true);
      const playTurnCount = await host.evaluate(() => {
        const observed = (window as any).__discoMultiplayerTest;
        return observed.outgoing.filter((m: any) => m.type === 'play-turn').length;
      });
      expect(playTurnCount).toBe(1);

      // The connection survived the burst — a further valid action still works.
      await dropDuelTurn(guest);
      await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE');
      await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

test.describe('private Disco Duel zoom', () => {
  // Duel constructs its own InputHandler instance independently of the
  // solo-mode one covered in e2e/zoom.spec.ts, so this proves the shared
  // zoom transform's hit-testing correctness holds there too, not just in
  // the solo mode's own controller.
  test('a zoomed-in tap still registers as a valid drop', async ({ browser }) => {
    const hostContext = await multiplayerContext(browser);
    const guestContext = await multiplayerContext(browser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await enterDuelRoom(host, guest);
      await readyUpDuel(host, guest);
      await waitForDuelTurn(host, true);

      // The zoom controls live in the pause menu, not floating on-screen
      // buttons — opening it also pauses the match for both players, which
      // conveniently avoids racing the turn timer while this test zooms in.
      await host.getByRole('button', { name: 'Game menu' }).click();
      await expect(host.locator('.game-menu')).toHaveClass(/game-menu--open/);
      await host.locator('[data-pause-menu-action="zoom-in"]').click();
      await host.locator('[data-pause-menu-action="zoom-in"]').click();
      // .zoom-layer, not the outer .game-stage, is what ZoomControls
      // transforms — .game-stage is the fixed, clipping viewport and is
      // never itself transformed. See the class doc comment on ZoomControls.
      const scale = await host.locator('.zoom-layer').evaluate(el => {
        const match = /scale\(([^)]+)\)/.exec(el.style.transform);
        return match ? Number.parseFloat(match[1]!) : 1;
      });
      expect(scale).toBeGreaterThan(1);
      // Button-driven zoom animates over 150ms (.zoom-layer--transitioning,
      // styles/zoom-controls.css) — wait it out before reading boundingBox()
      // below, or the computed transform (and so the click position) would
      // be read mid-transition instead of at its settled scale.
      await host.waitForTimeout(200);
      await host.getByRole('button', { name: 'RESUME', exact: true }).click();
      await expect(host.locator('.game-menu')).not.toHaveClass(/game-menu--open/);

      const canvas = host.locator('canvas');
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error('Duel board is not visible');
      // Off-center on purpose, and derived from the grid's own exposed
      // geometry (--game-canvas-width/--game-grid-width) rather than a
      // guessed fraction of the whole canvas — the grid is centered inside
      // a wider canvas on desktop, so a naive small fraction can land in
      // that empty margin instead of on the board, which would also never
      // send a play-turn message and look identical to a real hit-testing
      // regression from the zoom transform.
      const { canvasWidth, gridWidth } = await host.locator('.zoom-layer').evaluate(el => ({
        canvasWidth: Number.parseFloat(el.style.getPropertyValue('--game-canvas-width')),
        gridWidth: Number.parseFloat(el.style.getPropertyValue('--game-grid-width')),
      }));
      const cols = 7;
      const targetColumn = 1;
      const gridStartX = (canvasWidth - gridWidth) / 2;
      const cellWidth = gridWidth / cols;
      const fraction = (gridStartX + (targetColumn + 0.5) * cellWidth) / canvasWidth;
      await canvas.click({ position: { x: bounds.width * fraction, y: bounds.height / 2 } });

      await expect.poll(async () => await host.evaluate(() => {
        const observed = (window as any).__discoMultiplayerTest;
        return observed.outgoing.some((m: any) => m.type === 'play-turn');
      })).toBe(true);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

// "Reload during an in-flight animation" and "reload at a turn-timeout
// boundary" are deliberately not covered here: pinning either to a real
// browser reliably needs a precise, low-jitter timing race (landing a
// reload inside a ~1s animation window, or within a few hundred ms of a
// 15s server timeout) that would be flaky in CI. The client-side revision/
// discard-animation logic those scenarios exercise is already covered
// deterministically in src/test/app/shared-board-session-controller.test.ts.

async function enterDuelRoom(host: Page, guest: Page): Promise<string> {
  await host.goto('/?multiplayer=create&mode=shared-duel');
  await expect(host).toHaveURL(/\?room=[A-Z2-9]{8}&mode=shared-duel$/);
  const inviteUrl = host.url();
  await guest.goto(inviteUrl);
  await expect(guest.getByRole('heading', { name: 'ROOM CODE' })).toBeVisible();
  return inviteUrl;
}

async function readyUpDuel(host: Page, guest: Page): Promise<void> {
  await host.getByRole('button', { name: 'READY', exact: true }).click();
  await guest.getByRole('button', { name: 'READY', exact: true }).click();
  await expect(host.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 6_000 });
  await expect(guest.locator('.multiplayer-hud__status')).toHaveText('LIVE', { timeout: 6_000 });
}

async function isDuelTurn(page: Page): Promise<boolean> {
  return (await page.locator('.multiplayer-hud').getAttribute('data-turn')) === 'mine';
}

async function waitForDuelTurn(page: Page, expected: boolean): Promise<void> {
  await expect.poll(() => isDuelTurn(page), { timeout: 8_000 }).toBe(expected);
}

async function dropDuelTurn(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Duel board is not visible');
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect.poll(async () => await page.evaluate(() => {
    const observed = (window as any).__discoMultiplayerTest;
    return observed.outgoing.some((m: any) => m.type === 'play-turn');
  })).toBe(true);
}

async function countIncoming(page: Page, type: string): Promise<number> {
  return await page.evaluate((messageType) => {
    const observed = (window as any).__discoMultiplayerTest;
    return observed.incoming.filter((message: any) => message.type === messageType).length;
  }, type);
}

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
    // --game-grid-width is set on .zoom-layer (the content/transform layer
    // inside the fixed, clipping .game-stage viewport), not .game-stage itself.
    const gridWidth = await page.locator('.zoom-layer').evaluate(element =>
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
