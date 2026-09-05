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

  /**
   * Fix the connection: no box to type a different registry into.
   *
   * For a deployment that exists to browse one registry. **It is presentation,
   * not enforcement** -- the page runs in a browser, and anybody who opens the
   * console can ask any registry anything their network and their credentials
   * allow. What it stops is a person wondering what the box is for, not a
   * person who means to use it.
   */
  locked?: boolean;

  /** Hide the credential fields, for a registry that wants none. */
  anonymous?: boolean;

  /** An image for the corner: a URL, a path, or a `data:` URI. */
  logo?: string;

  /** What to call this deployment, beside the logo and in the tab. */
  title?: string;
};

/**
 * Whether a logo is something to put in `src`.
 *
 * `javascript:` in an `img` src does nothing in any browser still shipping, but
 * the value comes from a deployment's environment and lands in the DOM, and the
 * cost of naming the three things it may be is nothing.
 */
export function usableLogo(logo: string | undefined): string | undefined {
  if (logo === undefined || logo === "") {
    return undefined;
  }

  if (/^https?:\/\//i.test(logo) || /^data:image\//i.test(logo)) {
    return logo;
  }

  // A path to something served alongside the page.
  if (/^[./]/.test(logo) && !logo.includes(":")) {
    return logo;
  }

  console.warn(`logo is not a URL this will load: ${logo}`);
  return undefined;
}

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
