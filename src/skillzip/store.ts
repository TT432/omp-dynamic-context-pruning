import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillContract } from "./types";
import { sourceHash } from "./scanner";

export const MAX_SKILL_BYTES = 64 * 1024;
const SKILL_FILE = "SKILL.md";
const SIDECAR_FILE = ".skillzip.json";
const WAL_FILE = ".skillzip.wal.json";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillPaths {
  root: string;
  dir: string;
  skill: string;
  sidecar: string;
  wal: string;
}

interface WalRecord {
  version: 1;
  tx: string;
  phase: "prepared" | "installed";
  skill: string;
  oldSkill: string | null;
  oldSidecar: string | null;
  newSkill: string;
  newSidecar: string;
}

function rootPath(override?: string): string {
  return resolve(override ?? process.env.SKILLZIP_ROOT ?? join(homedir(), ".omp", "agent", "skillzip"));
}

export function validateSkillName(name: string): string {
  const value = name.trim();
  if (!NAME.test(value) || value.length > 64) throw new Error("Skill name must be 1-64 lowercase letters/digits separated by single hyphens");
  return value;
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel === "" && candidate !== root || resolve(root, rel) !== candidate) throw new Error("Skill path escapes the managed SkillZip root");
}

export function pathsFor(name: string, override?: string): SkillPaths {
  const safeName = validateSkillName(name);
  const root = rootPath(override);
  const dir = resolve(root, safeName);
  assertInside(root, dir);
  return { root, dir, skill: join(dir, SKILL_FILE), sidecar: join(dir, SIDECAR_FILE), wal: join(dir, WAL_FILE) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureNoSymlink(paths: SkillPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const rootInfo = await lstat(paths.root);
  if (rootInfo.isSymbolicLink()) throw new Error("SkillZip root must not be a symbolic link");
  if (await exists(paths.dir)) {
    const dirInfo = await lstat(paths.dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error("Managed skill path must be a real directory, not a symbolic link");
  }
  for (const path of [paths.skill, paths.sidecar, paths.wal]) {
    if (await exists(path)) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`${basename(path)} must not be a symbolic link`);
    }
  }
}

async function durableWrite(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function durableReplace(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await durableWrite(temp, content);
  await rm(path, { force: true });
  await rename(temp, path);
}

function isWalRecord(value: unknown): value is WalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WalRecord>;
  return record.version === 1 && typeof record.tx === "string" && (record.phase === "prepared" || record.phase === "installed") && typeof record.skill === "string" && typeof record.newSkill === "string" && typeof record.newSidecar === "string";
}

async function restoreText(path: string, content: string | null): Promise<void> {
  if (content === null) await rm(path, { force: true });
  else await durableReplace(path, content);
}

/** Recover a transaction interrupted between installing the two managed files. */
export async function recoverTransaction(paths: SkillPaths): Promise<void> {
  if (!(await exists(paths.wal))) return;
  const parsed = JSON.parse(await readFile(paths.wal, "utf8")) as unknown;
  if (!isWalRecord(parsed) || parsed.skill !== basename(paths.dir)) throw new Error("Malformed SkillZip WAL; refusing unsafe recovery");
  if (parsed.phase === "installed") {
    await restoreText(paths.skill, parsed.newSkill);
    await restoreText(paths.sidecar, parsed.newSidecar);
  } else {
    await restoreText(paths.skill, parsed.oldSkill);
    await restoreText(paths.sidecar, parsed.oldSidecar);
  }
  await rm(paths.wal, { force: true });
}

export interface LoadedSkill {
  paths: SkillPaths;
  text: string;
  contract: SkillContract;
}

export async function loadSkill(name: string, override?: string): Promise<LoadedSkill> {
  const paths = pathsFor(name, override);
  await ensureNoSymlink(paths);
  await recoverTransaction(paths);
  if (!(await exists(paths.skill)) || !(await exists(paths.sidecar))) throw new Error(`Managed skill "${name}" does not exist`);
  const [text, sidecar] = await Promise.all([readFile(paths.skill, "utf8"), readFile(paths.sidecar, "utf8")]);
  const contract = JSON.parse(sidecar) as SkillContract;
  if (contract.version !== 1 || contract.source?.name !== name || !Array.isArray(contract.blocks) || !Array.isArray(contract.coverage)) throw new Error("SkillZip sidecar is invalid or incompatible");
  if (contract.source.artifactSha256 && contract.source.artifactSha256 !== sourceHash(text)) throw new Error("SKILL.md changed outside SkillZip; refusing to overwrite divergent content");
  return { paths, text, contract };
}

const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}

export interface CommitOptions {
  overwrite?: boolean;
  expectedArtifactHash?: string;
  failpoint?: "after-wal" | "after-skill";
}

/** Two-file WAL transaction; a failed install restores the prior pair before returning. */
export async function commitSkill(name: string, text: string, contract: SkillContract, options: CommitOptions = {}, override?: string): Promise<SkillPaths> {
  if (!text.trim()) throw new Error("Rendered skill must not be empty");
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(`Rendered skill exceeds ${MAX_SKILL_BYTES} bytes`);
  const paths = pathsFor(name, override);
  return serialized(paths.dir, async () => {
    await ensureNoSymlink(paths);
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await ensureNoSymlink(paths);
    await recoverTransaction(paths);
    const oldSkill = await exists(paths.skill) ? await readFile(paths.skill, "utf8") : null;
    const oldSidecar = await exists(paths.sidecar) ? await readFile(paths.sidecar, "utf8") : null;
    if (oldSkill !== null && !options.overwrite) throw new Error(`Managed skill "${name}" already exists`);
    if (options.expectedArtifactHash && oldSkill !== null && sourceHash(oldSkill) !== options.expectedArtifactHash) throw new Error("SKILL.md changed during SkillZip operation; transaction aborted");

    contract.source.artifactSha256 = sourceHash(text);
    const newSidecar = `${JSON.stringify(contract, null, 2)}\n`;
    const wal: WalRecord = { version: 1, tx: randomUUID(), phase: "prepared", skill: name, oldSkill, oldSidecar, newSkill: text, newSidecar };
    await durableWrite(paths.wal, `${JSON.stringify(wal)}\n`);
    try {
      if (options.failpoint === "after-wal") throw new Error("Injected transaction failure after WAL");
      await durableReplace(paths.skill, text);
      if (options.failpoint === "after-skill") throw new Error("Injected transaction failure after skill install");
      await durableReplace(paths.sidecar, newSidecar);
      wal.phase = "installed";
      await durableReplace(paths.wal, `${JSON.stringify(wal)}\n`);
      await rm(paths.wal, { force: true });
      return paths;
    } catch (error) {
      await restoreText(paths.skill, oldSkill);
      await restoreText(paths.sidecar, oldSidecar);
      await rm(paths.wal, { force: true });
      throw error;
    }
  });
}

export async function listSkills(override?: string): Promise<Array<{ name: string; bytes: number; updatedAt: string }>> {
  const root = rootPath(override);
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("SkillZip root must not be a symbolic link");
  const entries = await readdir(root, { withFileTypes: true });
  const result: Array<{ name: string; bytes: number; updatedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const paths = pathsFor(entry.name, root);
      await ensureNoSymlink(paths);
      await recoverTransaction(paths);
      const info = await stat(paths.skill);
      result.push({ name: entry.name, bytes: info.size, updatedAt: info.mtime.toISOString() });
    } catch {
      // Invalid or partial directories are deliberately omitted from discovery.
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export function managedRoot(override?: string): string {
  return rootPath(override);
}
