import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyWindowsArchitectures(directory) {
  for (const [folder, expected] of [['win-unpacked', 0x8664], ['win-arm64-unpacked', 0xaa64]]) {
    const file = path.join(directory, folder, 'Ply.exe');
    const handle = await fs.open(file, 'r');
    try {
      const dos = Buffer.alloc(64);
      if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`Invalid executable: ${folder}`);
      const pe = Buffer.alloc(6);
      if ((await handle.read(pe, 0, pe.length, dos.readUInt32LE(0x3c))).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550) throw new Error(`Invalid PE header: ${folder}`);
      if (pe.readUInt16LE(4) !== expected) throw new Error(`Wrong executable architecture: ${folder}`);
    } finally { await handle.close(); }
  }
  console.log('Windows x64 and arm64 executable architectures verified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyWindowsArchitectures(process.argv[2] ?? 'dist-desktop');
