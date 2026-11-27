// Pack files are small enough to compress and assemble the archive in memory.
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
    let c = i;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

    return c >>> 0;
});

function crc32(data) {
    let crc = 0xffffffff;

    for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);

    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const d = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const t = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);

    return { date: d, time: t };
}

function listFiles(dir, prefix) {
    const files = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name);
        // Do not include source-control placeholders, even if a user stages them.
        if (entry.name === ".gitkeep") continue;

        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) files.push(...listFiles(file, name));
        else if (entry.isFile()) files.push({ source: file, name: name.replaceAll("\\", "/") });
    }

    return files;
}

export function writeAddonZip(outputFile, folders) {
    const entries = folders.flatMap(([directory, archiveName]) => listFiles(directory, archiveName));
    const fileParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { source, name } of entries) {
        const nameBuffer = Buffer.from(name, "utf8");
        const original = fs.readFileSync(source);
        const compressed = deflateRawSync(original, { level: 6 });
        const checksum = crc32(original);
        const { date, time } = dosDateTime(fs.statSync(source).mtime);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // Use UTF-8 file names.
        local.writeUInt16LE(8, 8); // Use DEFLATE compression.
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(original.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        local.writeUInt16LE(0, 28);
        fileParts.push(local, nameBuffer, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(original.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuffer);
        offset += local.length + nameBuffer.length + compressed.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    if (entries.length > 65535 || offset + centralSize >= 0xffffffff) {
        throw new Error("ZIP64 archives are not supported by this small build script.");
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, Buffer.concat([...fileParts, ...centralParts, end]));

    return entries.length;
}
