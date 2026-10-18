import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export async function promptText(prompt) {
  const prompts = createInterface({ input: stdin, output: stdout });
  try {
    return await prompts.question(prompt);
  } finally {
    prompts.close();
  }
}

export function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal so the password can be hidden.'));
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    let value = '';
    stdout.write(prompt);

    const finish = (result) => {
      stdin.off('data', handleInput);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };

    const handleInput = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(null);
        if (character === '\r' || character === '\n') return finish(value);
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', handleInput);
  });
}

export async function promptPasswordPair() {
  const password = await readHidden('Password (minimum 12 characters; input hidden): ');
  if (password === null) return null;
  if (password.length < 12) throw new Error('Choose a password with at least 12 characters.');

  const confirmation = await readHidden('Confirm password (input hidden): ');
  if (confirmation === null) return null;
  if (confirmation !== password) throw new Error('Passwords did not match; no changes were made.');
  return password;
}
