/**
 * What the page was deployed pointing at.
 *
 * A static build has no build-time configuration worth having -- one image that
 * only ever browses one registry is not much of an image -- so the defaults
 * arrive as a file the container writes at startup from its environment. See
 * docker-entrypoint.sh.
 *
 * Everything here is a *default*: it fills the form the first time, and what
 * the person typed afterwards wins. Nothing here is a credential, and there is
 * no environment variable to make it one.
 */
export type PageConfig = {
  domain?: string;
  forwarder?: string;
  insecure?: boolean;
  direct?: boolean;
};

/**
 * Reads `/config.json`, and treats every way of not finding one as "none".
 *
 * Absent is the normal case: `npm run dev` has no container to write it, and a
 * page served straight off a file server has whatever was put next to it. The
 * content type is checked because a single-page fallback answers a missing file
 * with `index.html` and a `200`, which would otherwise arrive here as a parse
 * error rather than as nothing.
 */
export async function loadConfig(): Promise<PageConfig> {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
      return {};
    }

    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as PageConfig) : {};
  } catch {
    return {};
  }
}
