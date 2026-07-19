export type EncryptedWitnessPackage = {
  version: 1;
  iv: string;
  ciphertext: string;
};

export type StatementWitness = {
  statement: string;
  nonce: string;
};

function toBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptionKey(identityKey: string) {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityKey));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function createWitnessPackage(witness: StatementWitness, identityKey: string): Promise<EncryptedWitnessPackage> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(identityKey),
    new TextEncoder().encode(JSON.stringify(witness)),
  );
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
}

export async function decryptWitnessPackage(encrypted: EncryptedWitnessPackage, identityKey: string): Promise<StatementWitness> {
  if (encrypted.version !== 1) throw new Error('Unsupported private witness package.');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(encrypted.iv) },
      await encryptionKey(identityKey),
      fromBase64(encrypted.ciphertext),
    );
    const witness = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<StatementWitness>;
    if (!witness.statement || !witness.nonce) throw new Error('Private witness package is incomplete.');
    return { statement: witness.statement, nonce: witness.nonce };
  } catch {
    throw new Error('Could not decrypt the witness package. Check that the identity key is correct.');
  }
}

export function witnessPackageAttachment(value: EncryptedWitnessPackage) {
  return toBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function witnessPackageFromLink(value: string): EncryptedWitnessPackage {
  return JSON.parse(new TextDecoder().decode(fromBase64(value))) as EncryptedWitnessPackage;
}
