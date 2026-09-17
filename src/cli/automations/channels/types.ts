/**
 * automations/channels/types.ts — the publish seam (ADR-0037 §F2).
 *
 * F2 ships DRY-RUN adapters only: `publish` never touches the network and the
 * result always carries `dryRun: true`. Real adapters (OAuth, HTTP) land in a
 * later phase behind this same interface so the runner never changes.
 */

/** Input passed to a channel's `publish`. */
export interface ChannelPublishInput {
  /** Final post text (post-approval edit, if any). */
  text: string;
  /** Local media paths to attach (best-effort; missing files were warned). */
  mediaPaths?: string[];
}

/** A successful (or DRY-RUN) publish outcome. */
export interface ChannelPublishResult {
  postId: string;
  url: string;
  dryRun: boolean;
  /** Evidence screenshot path, when the adapter captured one (F3.2 browser). */
  screenshotPath?: string;
  /** Non-fatal notes (e.g. a missing media selector). Never blocks a publish. */
  warnings?: string[];
}

/** One social channel adapter. `id` is the channel id from the spec. */
export interface ChannelAdapter {
  id: string;
  publish(input: ChannelPublishInput): Promise<ChannelPublishResult>;
}
