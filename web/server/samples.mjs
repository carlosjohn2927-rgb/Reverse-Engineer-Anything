import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Growable little-endian byte writer. */
const createWriter = (size) => {
  let buffer = Buffer.alloc(size);
  let offset = 0;
  const ensure = (extra) => {
    if (offset + extra <= buffer.length) return;
    const grown = Buffer.alloc(Math.max(buffer.length * 2, offset + extra));
    buffer.copy(grown, 0, 0, offset);
    buffer = grown;
  };
  return {
    u8(value) {
      ensure(1);
      buffer.writeUInt8(value & 0xff, offset);
      offset += 1;
    },
    u16(value) {
      ensure(2);
      buffer.writeUInt16LE(value & 0xffff, offset);
      offset += 2;
    },
    u32(value) {
      ensure(4);
      buffer.writeUInt32LE(value >>> 0, offset);
      offset += 4;
    },
    bytes(values) {
      ensure(values.length);
      Buffer.from(values).copy(buffer, offset);
      offset += values.length;
    },
    ascii(text) {
      ensure(text.length);
      buffer.write(text, offset, "latin1");
      offset += text.length;
    },
    zeros(count) {
      ensure(count);
      buffer.fill(0, offset, offset + count);
      offset += count;
    },
    padTo(target) {
      if (offset > target)
        throw new Error(
          `layout passed ${target.toString(16)} at ${offset.toString(16)}`,
        );
      while (offset < target) this.u8(0);
    },
    get offset() {
      return offset;
    },
    result() {
      return buffer.subarray(0, offset);
    },
  };
};

/** A NUL-terminated metadata stream name padded to a four-byte boundary. */
const streamName = (name) => {
  const length = name.length + 1;
  const out = Buffer.alloc((length + 3) & ~3);
  out.write(name, 0, "latin1");
  return out;
};

/**
 * A minimal, valid ECMA-335 assembly: `Demo.Sample` with a static `Main`
 * method, an `AssemblyRef` to System.Console, and a `#~` tables stream carrying
 * Module, TypeRef, TypeDef, MethodDef, Assembly and AssemblyRef rows.
 */
export const buildManagedAssembly = () => {
  const strings = createWriter(256);
  const offsets = new Map();
  const add = (value) => {
    if (offsets.has(value)) return offsets.get(value);
    const index = strings.offset;
    strings.ascii(value);
    strings.u8(0);
    offsets.set(value, index);
    return index;
  };
  add("");
  const moduleName = add("ReaWebSample.dll");
  const moduleType = add("<Module>");
  const sampleNamespace = add("Demo");
  const sampleType = add("Sample");
  const systemNamespace = add("System");
  const objectType = add("Object");
  const consoleType = add("Console");
  const mainMethod = add("Main");
  const assemblyName = add("ReaWebSample");
  const consoleAssembly = add("System.Console");

  const guids = createWriter(16);
  guids.bytes([
    0x6d, 0x1f, 0x2a, 0x3b, 0x4c, 0x5d, 0x6e, 0x7f, 0x80, 0x91, 0xa2, 0xb3,
    0xc4, 0xd5, 0xe6, 0xf7,
  ]);

  // #Blob heap: index 0 is empty; index 1 holds the static Main signature
  // (default calling convention, one return value, zero parameters).
  const blobs = createWriter(16);
  blobs.u8(0);
  blobs.u8(0x03);
  blobs.u8(0x00);
  blobs.u8(0x00);
  blobs.u8(0x01);

  // #~ stream: header, one row-count word per set bit in the valid mask, then
  // rows in table order. Row sizes with two-byte heap indexes:
  //   Module 10, TypeRef 6, TypeDef 14, MethodDef 14, Assembly 20,
  //   AssemblyRef 24.
  // Valid mask: Module(0), TypeRef(1), TypeDef(2), MethodDef(6), Assembly(32),
  // AssemblyRef(35) -> 0x47 in the low word and bits 0 and 3 of the high word.
  const valid = [0x0000_0047, 0x0000_0009];
  const tables = createWriter(512);
  tables.u32(0); // Reserved
  tables.u8(2); // MajorVersion
  tables.u8(0); // MinorVersion
  tables.u8(0); // HeapSizes: every heap index is two bytes
  tables.u8(1); // Reserved
  tables.u32(valid[0] ?? 0);
  tables.u32(valid[1] ?? 0); // bits 32 and 35 map to high-word bits 0 and 3
  tables.u32(0); // Sorted (low word)
  tables.u32(0); // Sorted (high word)
  for (const rows of [1, 2, 2, 1, 1, 1]) tables.u32(rows);

  // Module: Generation, Name, Mvid, EncId, EncBaseId
  tables.u16(0);
  tables.u16(moduleName);
  tables.u16(1);
  tables.u16(0);
  tables.u16(0);
  // TypeRef: ResolutionScope (AssemblyRef row 1 << 2 | tag 2), Name, Namespace
  for (const [namespace, name] of [
    [systemNamespace, objectType],
    [systemNamespace, consoleType],
  ]) {
    tables.u16(0x09);
    tables.u16(name);
    tables.u16(namespace);
  }
  // TypeDef: Flags, Name, Namespace, Extends, FieldList, MethodList
  tables.u32(0);
  tables.u16(moduleType);
  tables.u16(0);
  tables.u16(0);
  tables.u16(1);
  tables.u16(1);
  tables.u32(0x00100001);
  tables.u16(sampleType);
  tables.u16(sampleNamespace);
  tables.u16(0x05);
  tables.u16(1);
  tables.u16(1);
  // MethodDef: Rva, ImplFlags, Flags, Name, Signature, ParamList
  tables.u32(0x380);
  tables.u16(0);
  tables.u16(0x16);
  tables.u16(mainMethod);
  tables.u16(1); // Signature: #Blob[1]
  tables.u16(1);
  // Assembly: HashAlgId(4), Major(2), Minor(2), Build(2), Revision(2),
  // Flags(4), PublicKey, Name, Culture
  tables.u32(1);
  tables.u16(0);
  tables.u16(0);
  tables.u16(0);
  tables.u16(0);
  tables.u32(0);
  tables.u16(0);
  tables.u16(assemblyName);
  tables.u16(0);
  // AssemblyRef: Major, Minor, Build, Revision, Flags(4), PublicKeyOrToken,
  // Name, Culture, HashValue
  tables.u16(4);
  tables.u16(0);
  tables.u16(0);
  tables.u16(0);
  tables.u32(0);
  tables.u16(0);
  tables.u16(consoleAssembly);
  tables.u16(0);
  tables.u16(0);
  const tablesBytes = tables.result();
  const guidsBytes = guids.result();
  const stringsBytes = strings.result();
  const blobsBytes = blobs.result();

  // Metadata root: signature, versions, reserved, version length, version
  // string, flags, stream count, then stream headers (offset, size, name).
  const streams = ["#~", "#Strings", "#GUID", "#Blob"];
  const headersSize = streams.reduce(
    (total, name) => total + 8 + streamName(name).length,
    0,
  );
  const tablesOffset = 32 + headersSize;
  const stringsOffset = tablesOffset + tablesBytes.length;
  const guidsOffset = stringsOffset + stringsBytes.length;
  const blobsOffset = guidsOffset + guidsBytes.length;
  const metadata = createWriter(1024);
  metadata.u32(0x424a_5342);
  metadata.u16(1);
  metadata.u16(1);
  metadata.u32(0);
  metadata.u32(10); // version length
  metadata.ascii("v4.0.30319");
  // 16 + version-length 10 reaches 26; the reader aligns to 28 and puts flags
  // and the stream count there, so emit two pad bytes first.
  metadata.padTo(28);
  metadata.u16(0); // flags
  metadata.u16(streams.length);
  if (metadata.offset !== 32)
    throw new Error(`metadata root drift at ${metadata.offset.toString(16)}`);
  const placements = [
    [tablesOffset, tablesBytes.length],
    [stringsOffset, stringsBytes.length],
    [guidsOffset, guidsBytes.length],
    [blobsOffset, blobsBytes.length],
  ];
  for (const [index, name] of streams.entries()) {
    const placement = placements[index] ?? [0, 0];
    metadata.u32(placement[0]);
    metadata.u32(placement[1]);
    metadata.bytes(streamName(name));
  }
  if (metadata.offset !== tablesOffset)
    throw new Error(`metadata layout drift at ${metadata.offset.toString(16)}`);
  metadata.bytes(tablesBytes);
  metadata.bytes(stringsBytes);
  metadata.bytes(guidsBytes);
  metadata.bytes(blobsBytes);
  const metadataBytes = metadata.result();

  // PE layout: DOS header, PE signature, COFF header, PE32+ optional header
  // (0x58..0x148), one section header (0x148..0x170), CLI header at RVA 0x200
  // and metadata at RVA 0x300 inside a single .text section.
  const file = createWriter(1024);
  file.ascii("MZ");
  file.zeros(0x3a);
  file.u32(0x40);
  file.ascii("PE\u0000\u0000");
  file.u16(0x8664); // Machine: AMD64
  file.u16(1); // Section count
  file.u32(0);
  file.u32(0);
  file.u32(0);
  file.u16(0xf0); // Optional header size
  file.u16(0x0022); // Executable image, large address aware
  file.u16(0x20b); // PE32+
  file.u8(0x30);
  file.u8(0);
  file.u32(0x800); // SizeOfCode
  file.u32(0x800); // SizeOfInitializedData
  file.u32(0); // SizeOfUninitializedData
  file.u32(0); // AddressOfEntryPoint
  file.u32(0x200); // BaseOfCode
  file.u32(0x00400000); // ImageBase low
  file.u32(0); // ImageBase high
  file.u32(0x1000); // SectionAlignment
  file.u32(0x200); // FileAlignment
  file.u16(4); // MajorOperatingSystemVersion
  file.u16(0);
  file.u16(0);
  file.u16(0);
  file.u16(4); // MajorSubsystemVersion
  file.u16(0);
  file.u32(0); // Win32VersionValue
  file.u32(0xa00); // SizeOfImage
  file.u32(0x200); // SizeOfHeaders
  file.u32(0); // CheckSum
  file.u16(3); // Subsystem: Windows console
  file.u16(0); // DllCharacteristics
  file.u32(0x100000); // SizeOfStackReserve low
  file.u32(0);
  file.u32(0x1000); // SizeOfStackCommit low
  file.u32(0);
  file.u32(0x100000); // SizeOfHeapReserve low
  file.u32(0);
  file.u32(0x1000); // SizeOfHeapCommit low
  file.u32(0);
  file.u32(0); // LoaderFlags
  file.u32(16); // NumberOfRvaAndSizes
  for (let index = 0; index < 16; index += 1) {
    file.u32(index === 14 ? 0x200 : 0); // CLI directory RVA
    file.u32(index === 14 ? 0x48 : 0); // CLI directory size
  }
  if (file.offset !== 0x148)
    throw new Error(`optional header drift at ${file.offset.toString(16)}`);
  file.ascii(".text");
  file.zeros(3);
  file.u32(0x800); // VirtualSize
  file.u32(0x200); // VirtualAddress
  file.u32(0x800); // SizeOfRawData
  file.u32(0x200); // PointerToRawData
  file.u32(0);
  file.u32(0);
  file.u16(0);
  file.u16(0);
  file.u32(0x60000020); // Code | Execute | Read
  if (/** @type {number} */ (file.offset) !== 0x170)
    throw new Error(`section table drift at ${file.offset.toString(16)}`);
  file.padTo(0x200);
  file.u32(0x48); // cb
  file.u16(2); // runtime major
  file.u16(5); // runtime minor
  file.u32(0x300); // MetaData RVA
  file.u32(metadataBytes.length);
  file.u32(1); // COMIMAGE_FLAGS_ILONLY
  file.u32(0x06000001); // EntryPointToken: MethodDef 1
  file.zeros(6 * 8); // resources, strong name, vtable fixups, export jumps, managed native header, reserved
  file.padTo(0x300);
  file.bytes(metadataBytes);
  file.u8(0x2a); // IL: ret at RVA 0x380
  file.padTo(0xa00);
  return file.result();
};

/** A valid WebAssembly module exporting `add(i32,i32)->i32` and `memory`. */
export const buildWasmModule = () =>
  Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60,
    0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x05, 0x03, 0x01,
    0x00, 0x01, 0x07, 0x0a, 0x02, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x06,
    0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x0a, 0x09, 0x01, 0x07,
    0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]);

/** Zero blocks, random blocks and text: a clean block-entropy demonstration. */
export const buildEntropySample = () => {
  const zeros = Buffer.alloc(2048);
  const noise = randomBytes(2048);
  const text = Buffer.from(
    "REA web sample: compressible text\n".repeat(32),
    "latin1",
  );
  return Buffer.concat([zeros, noise, zeros, text]);
};

/** Build a SQLite database with the sqlite3 CLI or Python's sqlite3 module. */
export const buildSqliteSample = async (destination) => {
  const script = [
    "PRAGMA journal_mode=DELETE;",
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, started_at TEXT, duration_ms INTEGER);",
    "CREATE INDEX IF NOT EXISTS users_role ON users(role);",
    "CREATE VIEW IF NOT EXISTS admins AS SELECT id, name FROM users WHERE role = 'admin';",
    "DELETE FROM sessions;",
    "DELETE FROM users;",
    "INSERT INTO users (name, role) VALUES ('ada','admin'),('grace','engineer'),('linus','ops'),('margaret','engineer');",
    "INSERT INTO sessions (user_id, started_at, duration_ms) VALUES (1,'2026-11-01T09:12:00Z',41200),(2,'2026-11-01T09:20:00Z',864000),(3,'2026-11-02T14:02:00Z',1500);",
  ].join("\n");
  /** @type {Array<[string, string[]]>} */
  const attempts = [
    ["sqlite3", [destination]],
    [
      "python3",
      [
        "-c",
        "import sqlite3,sys\nconnection=sqlite3.connect(sys.argv[1])\nconnection.executescript(sys.stdin.read())\nconnection.commit()",
        destination,
      ],
    ],
  ];
  for (const [command, args] of attempts) {
    /** @type {boolean} */
    const ok = await new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.stdin?.end(script);
    });
    if (ok) return true;
  }
  return false;
};

/** Generate the built-in samples into a directory. */
export const generateSamples = async (directory) => {
  await mkdir(directory, { recursive: true });
  const results = [];
  const write = async (id, name, bytes) => {
    const path = join(directory, name);
    await writeFile(path, bytes);
    results.push({ id, path });
  };
  await write("managed", "rea-web-sample-dotnet.dll", buildManagedAssembly());
  await write("wasm", "rea-web-sample.wasm", buildWasmModule());
  await write("entropy", "rea-web-entropy.bin", buildEntropySample());
  const sqlite = join(directory, "rea-web-sample.sqlite");
  if (await buildSqliteSample(sqlite))
    results.push({ id: "sqlite", path: sqlite });
  return results;
};
