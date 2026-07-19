type ToastTone = 'info' | 'success' | 'error';

let container: HTMLElement | undefined;

function toastContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  container.setAttribute('aria-live', 'polite');
  document.body.append(container);
  return container;
}

export function notify(message: string, tone: ToastTone = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  toastContainer().append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}
