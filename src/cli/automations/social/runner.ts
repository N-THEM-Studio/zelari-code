/**
 * automations/social/runner.ts — the social_post run state machine (F2).
 *
 *   drafting → [awaiting_approval] → publishing (dry-run) → completed|failed
 *
 * A `maxPostsPerDay` guardrail can short-circuit the run into `skipped`. Every
 * transition is persisted through the registry (atomic writes). Never throws
 * across the boundary: returns a process exit code (0 ok, 1 error, 4 pending).
 */
import { listRuns, newRunId, writeRun } from '../registry.js';
import { resolveAdapter, type ResolveAdapterOpts } from '../channels/registry.js';
import type { ChannelAdapter } from '../channels/types.js';
import { ReloginRequiredError } from '../browser/publisher.js';
import type { AutomationRun, AutomationSpec, RunPost } from '../types.js';
import type { ChatUsage } from '../../llm/oneShot.js';
import { draftSocialPost, type Draft } from './draft.js';
import { generateDraftWithLlm, LlmDraftError, type CompleteFn, type ResearchFn } from './generate.js';

/** Fallback approval TTL when a run/spec omits one. */
export const DEFAULT_TTL_MIN = 1440;

/** Injectable seam so the publish mapping is testable without a browser. */
export interface RunnerDeps {
  /** Adapter factory override. Default: channels/registry `resolveAdapter`. */
  createAdapter?: (channelId: string, opts: ResolveAdapterOpts) => ChannelAdapter;
  /**
   * One-shot completion seam for LLM drafting (tests inject a fake). Only
   * consulted when the spec sets `social_post.prompt`.
   */
  complete?: CompleteFn;
  /** Fresh-research seam for `researchQuery` specs (tests inject a fake). */
  research?: ResearchFn;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Local-time YYYY-MM-DD key (matches the human's "today", not UTC). */
function localDateKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Runs today (local date) that published or are publishing for this automation. */
export async function countTodayPosts(root: string, automationId: string): Promise<number> {
  const runs = await listRuns(root, automationId, 500);
  const today = localDateKey(new Date());
  return runs.filter((r) => {
    if (r.status !== 'completed' && r.status !== 'publishing') return false;
    const t = Date.parse(r.startedAt);
    return Number.isFinite(t) && localDateKey(new Date(t)) === today;
  }).length;
}

function failure(run: AutomationRun, reason: string): void {
  run.status = 'failed';
  run.exitCode = 1;
  run.reason = reason;
  run.finishedAt = nowIso();
}

/**
 * Publish over every requested channel (dry-run by default, browser for F3.2);
 * mutates + persists the run. `completed` (exit 0) requires EVERY requested
 * channel to be ok with a url; any failure ⇒ `failed` (exit 1). A typed
 * ReloginRequiredError (the session gate) is UNPROVEN ⇒ `relogin_required`
 * (exit 4), never a phantom failure.
 */
export async function publishDraft(
  root: string,
  run: AutomationRun,
  spec: AutomationSpec,
  deps: RunnerDeps = {},
): Promise<number> {
  const sp = spec.social_post;
  if (!sp) {
    failure(run, 'missing_social_post_spec');
    await writeRun(root, run);
    return 1;
  }

  run.status = 'publishing';
  await writeRun(root, run);

  const createAdapter = deps.createAdapter ?? resolveAdapter;
  const publishMode = sp.publishMode ?? 'dry-run';
  const posts: RunPost[] = [];
  let relogin = false;
  for (const channel of sp.channels) {
    try {
      const adapter = createAdapter(channel, {
        publishMode,
        runId: run.runId,
        automationId: run.automationId,
        cwd: root,
      });
      const res = await adapter.publish({
        text: run.draft?.text ?? '',
        mediaPaths: run.draft?.media,
      });
      posts.push({
        channel,
        ok: true,
        postId: res.postId,
        url: res.url,
        dryRun: res.dryRun,
        screenshot: res.screenshotPath,
      });
    } catch (e) {
      if (e instanceof ReloginRequiredError) {
        relogin = true;
        posts.push({ channel, ok: false, error: 'relogin_required' });
      } else {
        posts.push({
          channel,
          ok: false,
          // Honest evidence flag: only dry-run failures are "dry" — a browser
          // mode failure attempted the REAL network publish (live incident:
          // post-button timeouts were recorded as dryRun:true).
          dryRun: publishMode === 'dry-run',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  run.posts = posts;
  run.finishedAt = nowIso();
  if (relogin) {
    run.status = 'relogin_required';
    run.reason = 'relogin_required';
    run.exitCode = 4;
    await writeRun(root, run);
    return 4;
  }
  const allOk = posts.length > 0 && posts.every((p) => p.ok && !!p.url);
  run.status = allOk ? 'completed' : 'failed';
  run.exitCode = allOk ? 0 : 1;
  await writeRun(root, run);
  return run.exitCode;
}

/**
 * Run one social_post automation: guardrail → draft → (approve?) → dry-run
 * publish. Owns run creation and the FIRST persisted transition.
 */
export async function runSocialPost(
  root: string,
  spec: AutomationSpec,
  deps: RunnerDeps = {},
): Promise<number> {
  const run: AutomationRun = {
    runId: newRunId(),
    automationId: spec.id,
    startedAt: nowIso(),
    status: 'drafting',
    exitCode: 0,
  };

  const sp = spec.social_post;
  if (!sp) {
    failure(run, 'missing_social_post_spec');
    await writeRun(root, run);
    process.stderr.write(`[automation] ${spec.id}: social_post spec missing\n`);
    return 1;
  }

  if (sp.maxPostsPerDay !== undefined) {
    const today = await countTodayPosts(root, spec.id);
    if (today >= sp.maxPostsPerDay) {
      run.status = 'skipped';
      run.reason = 'max_posts_per_day';
      run.finishedAt = nowIso();
      run.exitCode = 0;
      await writeRun(root, run);
      process.stdout.write(
        `[automation] ${spec.id}: skipped — max_posts_per_day (${sp.maxPostsPerDay}) reached\n`,
      );
      return 0;
    }
  }

  await writeRun(root, run); // drafting

  let draft: Draft & { usage?: ChatUsage };
  if (sp.prompt && sp.prompt.trim()) {
    // Prompt set ⇒ LLM draft. A failure is a FAILED run (reason llm_*) — never
    // a silent static fallback (P1: unknown ≠ success).
    try {
      draft = await generateDraftWithLlm({
        spec: sp,
        root,
        modelRef: spec.model,
        complete: deps.complete,
        research: deps.research,
      });
      if (draft.usage?.totalTokens !== undefined) {
        draft.warnings.push(`llm_usage_tokens:${draft.usage.totalTokens}`);
      }
    } catch (e) {
      if (e instanceof LlmDraftError) {
        failure(run, e.reason);
        await writeRun(root, run);
        process.stderr.write(`[automation] ${spec.id}: LLM draft failed — ${e.reason}\n`);
        return 1;
      }
      throw e;
    }
  } else {
    draft = await draftSocialPost(sp, root);
    // researchQuery without a prompt has nothing to feed — record it, skip the search.
    if (sp.researchQuery?.trim()) draft.warnings.push('research_requires_prompt');
  }
  run.draft = {
    text: draft.text,
    media: draft.media,
    warnings: draft.warnings,
    generatedBy: draft.generatedBy,
    research: draft.research,
  };

  if (sp.requireApproval) {
    const ttlMin = sp.approvalTtlMin ?? DEFAULT_TTL_MIN;
    run.status = 'awaiting_approval';
    run.exitCode = 4;
    run.expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();
    await writeRun(root, run);
    process.stdout.write(
      `[automation] ${spec.id}: awaiting human approval — runId=${run.runId} ` +
        `(expires ${run.expiresAt})\n` +
        `  approve: zelari-code automation approve ${run.runId} --allow\n` +
        `  deny:    zelari-code automation approve ${run.runId} --deny\n` +
        `  edit:    zelari-code automation approve ${run.runId} --edit="<text>"\n`,
    );
    return 4;
  }

  return await publishDraft(root, run, spec, deps);
}
