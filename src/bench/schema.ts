import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const pathSchema = z.string().min(1).refine(p =>
  !/[\\:\x00-\x1f<>\"|?*]/.test(p) && p.split('/').every(s =>
    s.length > 0 && !['.', '..', '.git', '.unify', 'unify-bench'].includes(s.toLowerCase()) && !/[. ]$/.test(s)), '需要相对文件路径');
const file = z.object({ path: pathSchema, content: z.string(), executable: z.boolean().optional() }).strict();
export const repoSchema = z.object({
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, '需要完整 Git commit SHA'),
  paths: z.array(pathSchema).nonempty(),
}).strict();
export const taskSchema = z.object({
  title: nonempty, prompt: nonempty, files: z.array(file), repository: repoSchema.optional(),
}).strict();
export const graderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), expected: nonempty }).strict(),
  z.object({ kind: z.literal('javascript'), tests: z.array(z.object({ input: z.json(), expected: z.json() }).strict()).nonempty() }).strict(),
  z.object({
    kind: z.literal('patch'), image: z.string().regex(/^(?:[a-z0-9][a-z0-9._/:-]*@)?sha256:[a-f0-9]{64}$/, '镜像需要不可变 digest'),
    files: z.array(file), command: z.array(nonempty).nonempty(),
  }).strict(),
  z.object({ kind: z.literal('rubric'), criteria: z.array(nonempty).nonempty(), perCriterion: z.boolean().optional() }).strict(),
]);
export const reviewSchema = z.object({
  skill: nonempty, negative: z.string(), positive: z.string().refine(s => !!s.trim(), '参考解不能为空'), grader: graderSchema,
}).strict();
export const caseSchema = z.object({ version: z.literal(1), task: taskSchema, review: reviewSchema }).strict();
export type BenchCase = z.infer<typeof caseSchema>;
export type BenchTask = z.infer<typeof taskSchema>;
export type BenchKind = BenchCase['review']['grader']['kind'];
export type Repository = z.infer<typeof repoSchema>;

