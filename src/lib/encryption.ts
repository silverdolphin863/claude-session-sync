/**
 * E2E Encryption Module
 *
 * Uses TweetNaCl for encryption with keys derived from a recovery phrase.
 * The recovery phrase NEVER leaves the client - only derived auth tokens
 * are sent to the server.
 *
 * Security model:
 * - 6-word phrase = 66 bits entropy (millions of years to crack)
 * - Phrase derives separate keys for auth vs encryption
 * - Server only sees auth token, never encryption key
 */

import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = tweetnaclUtil;
import * as bip39 from 'bip39';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { EncryptedBlob } from '../types.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Storage paths
const PHRASE_PATH = path.join(os.homedir(), '.claude', 'sync-phrase.enc');
const KEYS_PATH = path.join(os.homedir(), '.claude', 'sync-keys.json');

// Key derivation constants
const AUTH_CONTEXT = 'claude-sync-auth-v1';
const ENCRYPT_CONTEXT = 'claude-sync-encrypt-v1';

interface DerivedKeys {
  authToken: string;      // Sent to server for authentication
  encryptionKey: Uint8Array;  // Never leaves client
  accountId: string;      // Public identifier derived from phrase
}

interface StoredKeys {
  authToken: string;
  encryptionKey: string;  // base64 encoded
  accountId: string;
  phraseHash: string;     // To verify phrase matches
}

/**
 * Generate a new 6-word recovery phrase
 * 6 words from BIP39 = 66 bits of entropy
 */
export function generateRecoveryPhrase(): string {
  // Generate 128 bits, take first 6 words (BIP39 gives 12 words for 128 bits)
  const mnemonic = bip39.generateMnemonic(128);
  const words = mnemonic.split(' ').slice(0, 6);
  return words.join(' ');
}

/**
 * Validate a recovery phrase
 */
export function validatePhrase(phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== 6) {
    return false;
  }
  // Check each word is in BIP39 wordlist
  const wordlist = bip39.wordlists.english;
  return words.every(word => wordlist.includes(word));
}

/**
 * Derive all keys from a recovery phrase
 * Uses HMAC-based key derivation for different purposes
 */
export function deriveKeys(phrase: string): DerivedKeys {
  const normalizedPhrase = phrase.trim().toLowerCase();

  // Convert phrase to seed bytes
  const phraseBytes = decodeUTF8(normalizedPhrase);

  // Derive auth token (sent to server)
  const authData = decodeUTF8(AUTH_CONTEXT);
  const authInput = new Uint8Array(phraseBytes.length + authData.length);
  authInput.set(phraseBytes);
  authInput.set(authData, phraseBytes.length);
  const authHash = nacl.hash(authInput);
  const authToken = encodeBase64(authHash.slice(0, 32));

  // Derive encryption key (NEVER sent to server)
  const encryptData = decodeUTF8(ENCRYPT_CONTEXT);
  const encryptInput = new Uint8Array(phraseBytes.length + encryptData.length);
  encryptInput.set(phraseBytes);
  encryptInput.set(encryptData, phraseBytes.length);
  const encryptHash = nacl.hash(encryptInput);
  const encryptionKey = encryptHash.slice(0, nacl.secretbox.keyLength);

  // Account ID is a short hash for identification
  const accountId = encodeBase64(authHash.slice(0, 12))
    .replace(/[+/=]/g, '')
    .substring(0, 16);

  return {
    authToken,
    encryptionKey,
    accountId,
  };
}

/**
 * Initialize sync with a recovery phrase
 * Call this during setup - stores derived keys locally
 */
export async function initializeWithPhrase(phrase: string): Promise<{
  accountId: string;
  authToken: string;
  isNew: boolean;
}> {
  if (!validatePhrase(phrase)) {
    throw new Error('Invalid recovery phrase. Must be 6 valid words.');
  }

  const keys = deriveKeys(phrase);
  const phraseHash = encodeBase64(nacl.hash(decodeUTF8(phrase)).slice(0, 16));

  // Check if we already have keys
  let isNew = true;
  try {
    const existing = await loadStoredKeys();
    if (existing && existing.phraseHash === phraseHash) {
      isNew = false;
    }
  } catch {
    // No existing keys
  }

  // Store derived keys (not the phrase itself for security)
  const stored: StoredKeys = {
    authToken: keys.authToken,
    encryptionKey: encodeBase64(keys.encryptionKey),
    accountId: keys.accountId,
    phraseHash,
  };

  await fs.mkdir(path.dirname(KEYS_PATH), { recursive: true });
  await fs.writeFile(KEYS_PATH, JSON.stringify(stored, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,  // Owner read/write only
  });

  return {
    accountId: keys.accountId,
    authToken: keys.authToken,
    isNew,
  };
}

/**
 * Load stored keys (after initialization)
 */
async function loadStoredKeys(): Promise<StoredKeys | null> {
  try {
    const content = await fs.readFile(KEYS_PATH, 'utf-8');
    return JSON.parse(content) as StoredKeys;
  } catch {
    return null;
  }
}

/**
 * Get encryption key for encrypt/decrypt operations
 */
async function getEncryptionKey(): Promise<Uint8Array> {
  const stored = await loadStoredKeys();
  if (!stored) {
    throw new Error('Sync not initialized. Run sync_setup first.');
  }
  return decodeBase64(stored.encryptionKey);
}

/**
 * Get auth token for API calls
 */
export async function getAuthToken(): Promise<string> {
  const stored = await loadStoredKeys();
  if (!stored) {
    throw new Error('Sync not initialized. Run sync_setup first.');
  }
  return stored.authToken;
}

/**
 * Get account ID
 */
export async function getAccountId(): Promise<string> {
  const stored = await loadStoredKeys();
  if (!stored) {
    throw new Error('Sync not initialized. Run sync_setup first.');
  }
  return stored.accountId;
}

/**
 * Check if sync is initialized
 */
export async function isInitialized(): Promise<boolean> {
  const stored = await loadStoredKeys();
  return stored !== null;
}

/**
 * Encrypt data using the derived encryption key
 */
export async function encrypt(data: string): Promise<EncryptedBlob> {
  const key = await getEncryptionKey();
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = decodeUTF8(data);

  const ciphertext = nacl.secretbox(messageBytes, nonce, key);

  return {
    version: 2,  // v2 = passphrase-derived keys
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

/**
 * Decrypt data using the derived encryption key
 */
export async function decrypt(blob: EncryptedBlob): Promise<string> {
  if (blob.version !== 2) {
    throw new Error(`Unsupported encryption version: ${blob.version}. Re-sync required.`);
  }

  const key = await getEncryptionKey();
  const nonce = decodeBase64(blob.nonce);
  const ciphertext = decodeBase64(blob.ciphertext);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);

  if (!decrypted) {
    throw new Error('Decryption failed - wrong recovery phrase or corrupted data');
  }

  return encodeUTF8(decrypted);
}

/**
 * Encrypt session data object (with compression)
 * Uses Buffer-based approach to handle large data
 */
export async function encryptSessionData(data: object): Promise<EncryptedBlob> {
  // Build JSON using buffers to handle large data
  const buffers: Buffer[] = [];
  const dataRecord = data as Record<string, unknown>;

  buffers.push(Buffer.from('{'));
  const keys = Object.keys(dataRecord);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = dataRecord[key];

    // For 'projects' field, serialize each project separately
    if (key === 'projects' && typeof value === 'object' && value !== null) {
      buffers.push(Buffer.from(`"${key}":{`));
      const projectEntries = Object.entries(value as Record<string, string>);
      for (let j = 0; j < projectEntries.length; j++) {
        const [projKey, projValue] = projectEntries[j];
        // Project values are already strings, just escape them
        const escapedValue = JSON.stringify(projValue);
        buffers.push(Buffer.from(`${JSON.stringify(projKey)}:${escapedValue}`));
        if (j < projectEntries.length - 1) buffers.push(Buffer.from(','));
      }
      buffers.push(Buffer.from('}'));
    } else {
      // Regular JSON stringify for smaller fields
      buffers.push(Buffer.from(`"${key}":${JSON.stringify(value)}`));
    }

    if (i < keys.length - 1) buffers.push(Buffer.from(','));
  }

  buffers.push(Buffer.from('}'));

  // Concatenate all buffers
  const jsonBuffer = Buffer.concat(buffers);

  // Compress before encrypting (text typically compresses 5-10x)
  const compressed = await gzip(jsonBuffer, { level: 9 });
  console.error(`Compressed to ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);

  // Encrypt the compressed bytes directly (not base64 encoded)
  const key = await getEncryptionKey();
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  // TweetNaCl expects Uint8Array
  const messageBytes = new Uint8Array(compressed);
  const ciphertext = nacl.secretbox(messageBytes, nonce, key);
  console.error(`Encrypted to ${(ciphertext.length / 1024 / 1024).toFixed(1)} MB`);

  // Use Node's Buffer for base64 encoding (handles large data better)
  const ciphertextBase64 = Buffer.from(ciphertext).toString('base64');
  console.error(`Base64 encoded to ${(ciphertextBase64.length / 1024 / 1024).toFixed(1)} MB`);

  return {
    version: 2,
    nonce: encodeBase64(nonce),
    ciphertext: ciphertextBase64,
    compressed: true,  // Flag to indicate compression
  } as EncryptedBlob;
}

/**
 * Decrypt session data object (with decompression)
 */
export async function decryptSessionData<T>(blob: EncryptedBlob): Promise<T> {
  const key = await getEncryptionKey();
  const nonce = decodeBase64(blob.nonce);

  // Use Node's Buffer for base64 decoding (handles large data better)
  const ciphertext = new Uint8Array(Buffer.from(blob.ciphertext, 'base64'));

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) {
    throw new Error('Decryption failed - wrong recovery phrase or corrupted data');
  }

  // Check if data is compressed (v2 with compressed flag, or detect gzip magic bytes)
  const isCompressed = (blob as { compressed?: boolean }).compressed ||
    (decrypted[0] === 0x1f && decrypted[1] === 0x8b);

  if (isCompressed) {
    const decompressed = await gunzip(Buffer.from(decrypted));
    return JSON.parse(decompressed.toString('utf-8')) as T;
  } else {
    // Legacy uncompressed data
    return JSON.parse(encodeUTF8(decrypted)) as T;
  }
}

/**
 * Generate checksum for data integrity
 */
export function generateChecksum(data: string): string {
  const bytes = decodeUTF8(data);
  const hash = nacl.hash(bytes);
  return encodeBase64(hash).substring(0, 16);
}
