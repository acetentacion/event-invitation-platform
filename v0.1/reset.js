'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

async function main() {
  const database = process.env.GATHERLY_DB_PATH ||
    path.join(__dirname, 'data', 'gatherly.sqlite');
  if (!path.isAbsolute(database) || path.extname(database).toLowerCase() !== '.sqlite' ||
      database === path.parse(database).root) {
    throw new Error('Reset refused: GATHERLY_DB_PATH must be an absolute .sqlite file path.');
  }
  const stat = fs.existsSync(database) ? fs.lstatSync(database) : null;
  if (stat?.isSymbolicLink() || stat?.isDirectory()) {
    throw new Error('Reset refused: database path must be a regular SQLite file.');
  }
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      `Delete local Gatherly database and all prototype data at ${database}? Type RESET to confirm: `
    );
    if (answer !== 'RESET') {
      console.log('Reset cancelled. No files were removed.');
      return;
    }
    for (const filename of [database, `${database}-wal`, `${database}-shm`]) {
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
    console.log('Local database removed. It will be recreated on next start.');
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
