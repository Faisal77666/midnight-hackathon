import { notify } from './toast.js';
import { decryptWitnessPackage, witnessPackageFromLink } from './witness-package.js';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const form = document.querySelector<HTMLFormElement>('#verify-form')!;
const unlocked = document.querySelector<HTMLElement>('#unlocked')!;
const statementContent = document.querySelector<HTMLParagraphElement>('#statement-content')!;
const aiForm = document.querySelector<HTMLFormElement>('#ai-form')!;
const aiAnswer = document.querySelector<HTMLParagraphElement>('#ai-answer')!;
const unlockedPdfFrame = document.querySelector<HTMLIFrameElement>('#unlocked-pdf-frame')!;
const sendUnlockedStatement = document.querySelector<HTMLButtonElement>('#send-unlocked-statement')!;
const sendUnlockedStatus = document.querySelector<HTMLParagraphElement>('#send-unlocked-status')!;
const reference = new URLSearchParams(window.location.search).get('ref');
const witnessPackageLinkValue = new URLSearchParams(window.location.hash.slice(1)).get('w');
let statement: string | undefined;
let pdfUrl: string | undefined;

if (!reference || !witnessPackageLinkValue) {
  form.hidden = true;
  status.textContent = 'This verification link is incomplete. Ask the bank to send a new locked statement.';
}

async function showPdf(value: string) {
  const response = await fetch('/api/unlocked-statement-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement: value }),
  });
  if (!response.ok) throw new Error('Could not generate the verified PDF.');
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(await response.blob());
  unlockedPdfFrame.src = pdfUrl;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!reference) return;
  const values = new FormData(form);
  const identityKey = String(values.get('identityKey')).trim();
  status.textContent = 'Generating and submitting your private Midnight proof…';
  notify('Submitting private ownership proof to Midnight…');
  try {
    const encrypted = witnessPackageFromLink(witnessPackageLinkValue!);
    const witness = await decryptWitnessPackage(encrypted, identityKey);
    statement = witness.statement;
    const response = await fetch('/api/midnight/prove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference,
        statement,
        identityKey,
        nonce: witness.nonce,
      }),
    });
    const result = await response.json() as { ownershipProved?: boolean; error?: string };
    if (!response.ok || !result.ownershipProved) throw new Error(result.error ?? 'Ownership proof was not accepted.');
    statementContent.textContent = statement;
    await showPdf(statement);
    unlocked.hidden = false;
    form.reset();
    form.hidden = true;
    status.textContent = 'Ownership proved on Midnight. Your verified statement is unlocked.';
    notify('Ownership proved — statement unlocked.', 'success');
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Midnight ownership proof failed.';
    notify('Ownership proof failed.', 'error');
  }
});

sendUnlockedStatement.addEventListener('click', async () => {
  if (!statement || unlocked.hidden) return;
  sendUnlockedStatement.disabled = true;
  sendUnlockedStatus.hidden = false;
  sendUnlockedStatus.textContent = 'Sending verified statement PDF…';
  notify('Sending verified statement PDF…');
  try {
    const response = await fetch('/api/send-unlocked-statement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement }),
    });
    const result = await response.json() as { message?: string; error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Email request failed.');
    sendUnlockedStatus.textContent = result.message ?? 'Unlocked statement PDF sent.';
    notify('Verified statement PDF sent.', 'success');
  } catch (error) {
    sendUnlockedStatus.textContent = error instanceof Error ? error.message : 'Email request failed.';
    notify('Verified statement email failed.', 'error');
  } finally {
    sendUnlockedStatement.disabled = false;
  }
});

aiForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!statement || unlocked.hidden) return;
  const question = String(new FormData(aiForm).get('question')).trim();
  aiAnswer.hidden = false;
  aiAnswer.textContent = 'Thinking…';
  notify('AI is analyzing your unlocked statement…');
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement, question }),
    });
    const result = await response.json() as { answer?: string; error?: string };
    if (!response.ok) throw new Error(result.error ?? 'AI request failed.');
    aiAnswer.textContent = result.answer ?? 'No answer returned.';
    notify('AI answer ready.', 'success');
  } catch (error) {
    aiAnswer.textContent = error instanceof Error ? error.message : 'AI request failed.';
    notify('AI request failed.', 'error');
  }
});
