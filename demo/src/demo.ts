type BankStatementValues = {
  statement: string;
  identityKey: string;
  bankKey: string;
  nonce: string;
};

import { notify } from './toast.js';
import { createWitnessPackage, witnessPackageAttachment } from './witness-package.js';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const issueStatement = document.querySelector<HTMLButtonElement>('#bank-form button[type="submit"]')!;
const sendStatement = document.querySelector<HTMLButtonElement>('#send-statement')!;
const sendStatus = document.querySelector<HTMLParagraphElement>('#send-status')!;
let verificationUrl: string | undefined;
let issuedWitness: Pick<BankStatementValues, 'statement' | 'identityKey' | 'nonce'> | undefined;

function values(form: HTMLFormElement): BankStatementValues {
  const data = new FormData(form);
  return {
    statement: String(data.get('statement')).trim(),
    identityKey: String(data.get('identityKey')).trim(),
    bankKey: String(data.get('bankKey')).trim(),
    nonce: String(data.get('nonce')).trim(),
  };
}

document.querySelector<HTMLFormElement>('#bank-form')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const statement = values(form);
  issueStatement.disabled = true;
  status.textContent = 'Issuing the private commitment on Midnight devnet…';
  notify('Issuing statement commitment on Midnight…');
  try {
    const response = await fetch('/api/midnight/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statement),
    });
    const result = await response.json() as { verifyUrl?: string; error?: string };
    if (!response.ok || !result.verifyUrl) throw new Error(result.error ?? 'Midnight issue transaction failed.');
    verificationUrl = result.verifyUrl;
    issuedWitness = { statement: statement.statement, identityKey: statement.identityKey, nonce: statement.nonce };
    form.reset();
    sendStatement.disabled = false;
    sendStatus.hidden = true;
    status.textContent = 'Commitment issued on Midnight. Send the locked PDF; its verification link opens the private proof flow.';
    notify('Statement commitment issued on Midnight.', 'success');
  } catch (error) {
    sendStatement.disabled = true;
    verificationUrl = undefined;
    status.textContent = error instanceof Error ? error.message : 'Midnight issue transaction failed.';
    notify('Midnight statement issuance failed.', 'error');
  } finally {
    issueStatement.disabled = false;
  }
});

sendStatement.addEventListener('click', async () => {
  if (!verificationUrl || !issuedWitness) return;
  sendStatement.disabled = true;
  sendStatus.hidden = false;
  sendStatus.textContent = 'Creating and sending locked PDF…';
  notify('Sending locked statement PDF…');
  try {
    const witnessPackage = await createWitnessPackage(
      { statement: issuedWitness.statement, nonce: issuedWitness.nonce },
      issuedWitness.identityKey,
    );
    const verificationLink = `${verificationUrl}#w=${encodeURIComponent(witnessPackageAttachment(witnessPackage))}`;
    const response = await fetch('/api/send-locked-statement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountHolder: 'Jane Doe',
        verificationUrl: verificationLink,
      }),
    });
    const data = await response.json() as { message?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? 'Email request failed.');
    sendStatus.textContent = data.message ?? 'Locked statement PDF sent.';
    notify('Locked statement PDF sent.', 'success');
  } catch (error) {
    sendStatus.textContent = error instanceof Error ? error.message : 'Email request failed.';
    notify('Locked statement email failed.', 'error');
  } finally {
    sendStatement.disabled = false;
  }
});
