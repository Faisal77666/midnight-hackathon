type PrivateStatementValues = {
  statement: string;
  identityKey: string;
  bankKey?: string;
  nonce: string;
};

class InMemoryStatementStore {
  constructor(private values: PrivateStatementValues) {}
  read(): PrivateStatementValues { return this.values; }
}

class DemoStatementContract {
  private issued?: InMemoryStatementStore;

  bind(store: InMemoryStatementStore) {
    return {
      issueStatement: async () => { this.issued = store; },
      proveStatementOwnership: async () => {
        const issued = this.issued?.read();
        const supplied = store.read();
        if (!issued || issued.statement !== supplied.statement ||
            issued.identityKey !== supplied.identityKey || issued.nonce !== supplied.nonce) {
          throw new Error('The private statement, identity key, or nonce does not match the issued commitment.');
        }
        return issued.statement;
      },
    };
  }
}

const contract = new DemoStatementContract();
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const unlocked = document.querySelector<HTMLElement>('#unlocked')!;
const statementContent = document.querySelector<HTMLParagraphElement>('#statement-content')!;

function values(form: HTMLFormElement, includesBankKey = false): PrivateStatementValues {
  const data = new FormData(form);
  return {
    statement: String(data.get('statement')).trim(),
    identityKey: String(data.get('identityKey')).trim(),
    nonce: String(data.get('nonce')).trim(),
    ...(includesBankKey ? { bankKey: String(data.get('bankKey')).trim() } : {}),
  };
}

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab, .view').forEach((element) => element.classList.remove('active'));
    button.classList.add('active');
    document.querySelector(`#${button.dataset.view}`)?.classList.add('active');
  });
});

document.querySelector<HTMLFormElement>('#bank-form')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  const store = new InMemoryStatementStore(values(event.currentTarget, true));
  await contract.bind(store).issueStatement();
  unlocked.hidden = true;
  status.textContent = 'Commitment issued. Share the statement, identity key, and nonce privately with the holder.';
});

document.querySelector<HTMLFormElement>('#holder-form')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const store = new InMemoryStatementStore(values(event.currentTarget));
    const statement = await contract.bind(store).proveStatementOwnership();
    statementContent.textContent = statement;
    unlocked.hidden = false;
    status.textContent = 'Proof accepted — statement unlocked.';
  } catch (error) {
    unlocked.hidden = true;
    status.textContent = error instanceof Error ? error.message : 'Proof failed.';
  }
});
