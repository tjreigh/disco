// Registers the precaching service worker and shows a non-blocking "reload to
// update" toast when a new version is waiting. Registration failure is
// non-fatal — the app runs fine online without a worker.

const TOAST_ID = 'disco-update-toast';

// Guards against a reload loop from repeated controllerchange events.
let reloading = false;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      // Module worker: tsc emits an ES module (the repo is "type": "module").
      .register('/service-worker.js', { type: 'module' })
      .then(registration => {
        // An update parked in "waiting" from a previous session.
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdateToast(registration.waiting);
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // A controller already exists => this is an update, not first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast(installing);
            }
          });
        });
      })
      .catch(() => {});
  });
}

function showUpdateToast(worker: ServiceWorker): void {
  if (document.getElementById(TOAST_ID)) return;

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.className = 'update-toast';
  toast.setAttribute('role', 'status');

  const message = document.createElement('span');
  message.className = 'update-toast__message';
  message.textContent = 'Update available';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'update-toast__action';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => {
    reload.disabled = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'update-toast__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss update notice');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(message, reload, dismiss);
  document.body.append(toast);

  // Only wired up once the toast is shown, so first activation never reloads.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
