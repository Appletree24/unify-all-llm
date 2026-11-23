import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from '../core/atomic-write.js';
import { caseSchema, type BenchCase } from './schema.js';
import { filename, ids, idSchema, insert, read, withWriteLock } from './storage.js';

const collectionFields = z.object({ name: z.string().trim().min(1, '请填写案例集名称').max(100, '名称最多 100 个字'), caseIds: z.array(idSchema) });
const collectionSchema = collectionFields.extend({ id: idSchema });
const catalogSchema = z.object({ version: z.literal(1), collections: z.array(collectionSchema), active: z.record(idSchema, z.boolean()) });
export type Collection = z.infer<typeof collectionSchema>;
type Catalog = z.infer<typeof catalogSchema>;
export type Publication = { previousId?: string; collectionId?: string };

const library = (cwd: string) => join(cwd, 'unify-bench');
const revisions = (cwd: string) => join(library(cwd), 'versions');
const manifest = (cwd: string) => join(library(cwd), 'catalog.json');
export const caseId = (c: BenchCase) => createHash('sha256').update(JSON.stringify(caseSchema.parse(c))).digest('hex').slice(0, 24);

export function readCatalog(cwd: string): Catalog {
  return existsSync(manifest(cwd)) ? catalogSchema.parse(read(manifest(cwd))) : { version: 1, active: {}, collections: [] };
}

// Store complete content before exposing a revision. One atomic catalog write then
// switches both the library and every affected collection to the new version.
function changeCatalog<T>(cwd: string, change: (catalog: Catalog) => T): T {
  return withWriteLock(library(cwd), () => {
    const catalog = readCatalog(cwd);
    const before = JSON.stringify(catalog);
    const result = change(catalog);
    if (JSON.stringify(catalog) !== before) atomicWrite(manifest(cwd), JSON.stringify(catalog, null, 2) + '\n');
    return result;
  });
}


export function publishedIds(cwd: string, catalog = readCatalog(cwd)) {
  const result = new Set(ids(library(cwd)));
  for (const [id, active] of Object.entries(catalog.active)) {
    if (active) result.add(id);
    else result.delete(id);
  }
  return [...result].sort();
}

export function getCase(cwd: string, id: string) {
  const root = filename(library(cwd), id);
  const data = caseSchema.parse(read(existsSync(root) ? root : filename(revisions(cwd), id)));
  if (caseId(data) !== id) throw new Error('题目内容已改变，请重新校验并发布新版本');
  return data;
}

function requireActive(cwd: string, catalog: Catalog, id: string) {
  const root = filename(library(cwd), id);
  if (!(catalog.active[id] ?? existsSync(root))) throw new Error('案例已被修订或删除，请重新打开当前版本');
}

export function findCollection(collections: Collection[], id: string) {
  const collection = collections.find(c => c.id === id);
  if (!collection) throw new Error('案例集已删除或不存在，请刷新后重试');
  return collection;
}

function checkCollection(catalog: Catalog, expected: Collection) {
  const current = findCollection(catalog.collections, expected.id);
  if (current.name !== expected.name || JSON.stringify(current.caseIds) !== JSON.stringify(expected.caseIds)) {
    throw new Error('案例集已被修改，请重新打开后编辑');
  }
  return current;
}

export function saveCollection(cwd: string, name: string, caseIds: string[], expected?: Collection) {
  const fields = collectionFields.parse({ name, caseIds });
  return changeCatalog(cwd, catalog => {
    const current = expected && checkCollection(catalog, expected);
    if (catalog.collections.some(c => c.id !== current?.id && c.name.toLowerCase() === fields.name.toLowerCase())) throw new Error('已有同名案例集');
    const members = [...new Set(fields.caseIds)];
    for (const id of members) requireActive(cwd, catalog, id);
    const collection = { id: current?.id ?? randomUUID().replaceAll('-', '').slice(0, 24), name: fields.name, caseIds: members };
    if (current) Object.assign(current, collection);
    else catalog.collections.push(collection);
    return collection;
  });
}

export function deleteCollection(cwd: string, expected: Collection) {
  changeCatalog(cwd, catalog => {
    const current = checkCollection(catalog, expected);
    catalog.collections.splice(catalog.collections.indexOf(current), 1);
  });
}

function retireCase(catalog: Catalog, id: string, replacement?: string) {
  catalog.active[id] = false;
  for (const c of catalog.collections) {
    c.caseIds = [...new Set(c.caseIds.flatMap(member => member !== id ? [member] : replacement ? [replacement] : []))];
  }
}

export function deleteCase(cwd: string, id: string) {
  changeCatalog(cwd, catalog => { requireActive(cwd, catalog, id); retireCase(catalog, id); });
}

export function storeValidated(cwd: string, c: BenchCase, options: Publication = {}) {
  const data = caseSchema.parse(c), id = caseId(data);
  return changeCatalog(cwd, catalog => {
    const { previousId, collectionId } = options;
    if (previousId) requireActive(cwd, catalog, previousId);
    const collection = collectionId ? findCollection(catalog.collections, collectionId) : undefined;
    const root = filename(library(cwd), id);
    if (previousId && previousId !== id && (catalog.active[id] ?? existsSync(root))) {
      throw new Error('题库中已有相同内容的案例，请编辑原案例或调整本次修订');
    }
    const managed = !!previousId || !!collection || existsSync(filename(revisions(cwd), id));
    if (!existsSync(root)) insert(managed ? revisions(cwd) : library(cwd), id, data);
    getCase(cwd, id);
    if (previousId && previousId !== id) retireCase(catalog, previousId, id);
    if (existsSync(root)) delete catalog.active[id];
    else catalog.active[id] = true;
    if (collection && !collection.caseIds.includes(id)) collection.caseIds.push(id);
    return id;
  });
}
