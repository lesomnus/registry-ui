import "./style.css";
import { isDigest } from "./cache";
import { listRepositories } from "./catalog";
import { loadConfig, usableLogo, type PageConfig } from "./config";
import { cache } from "./manifest";
import { listAnchor, renderList, rowHeight, scrollListTo } from "./render/list";
import { ancestorsOf, buildTree, flattenTree } from "./render/tree";
import { listTags } from "./tags";
import { connect, connectionOf, type Connection, type RegistryClient } from "./registry";
import { Search, type RepoSummary } from "./search";
import { rawPane } from "./render/blob";
import { element } from "./render/dom";
import { renderImage } from "./render/image";
import { formatRoute, parseRoute, type Route } from "./route";

const el = {
  form: document.getElementById("connection") as HTMLFormElement,
  domain: document.getElementById("domain") as HTMLInputElement,
  username: document.getElementById("username") as HTMLInputElement,
  password: document.getElementById("password") as HTMLInputElement,
  direct: document.getElementById("direct") as HTMLInputElement,
  insecure: document.getElementById("insecure") as HTMLInputElement,
  forwarder: document.getElementById("forwarder") as HTMLInputElement,
  open: document.getElementById("open") as HTMLButtonElement,
  reset: document.getElementById("reset") as HTMLButtonElement,
  slot: document.getElementById("connection-slot") as HTMLElement,
  more: document.getElementById("connection-more") as HTMLElement,
  scrim: document.getElementById("scrim") as HTMLElement,
  insecureLabel: document.getElementById("insecure-label") as HTMLElement,
  directLabel: document.getElementById("direct-label") as HTMLElement,
  brand: document.getElementById("brand") as HTMLElement,
  logo: document.getElementById("logo") as HTMLImageElement,
  title: document.getElementById("title") as HTMLElement,
  status: document.getElementById("status") as HTMLElement,
  repositoryList: document.getElementById("repository-list") as HTMLElement,
  repositoryCount: document.getElementById("repository-count") as HTMLElement,
  filter: document.getElementById("repository-filter") as HTMLInputElement,
  view: document.getElementById("view-toggle") as HTMLButtonElement,
  tagList: document.getElementById("tag-list") as HTMLElement,
  tagCount: document.getElementById("tag-count") as HTMLElement,
  detail: document.getElementById("detail") as HTMLElement,
  manifest: document.getElementById("manifest") as HTMLElement,
  manifestType: document.getElementById("manifest-type") as HTMLElement,
};

const state: {
  client?: RegistryClient;
  /** The registry the client is for, which is also what goes in the address. */
  domain?: string;
  /** The deployment fixed the registry, so the address may not change it. */
  locked: boolean;
  repositories: string[];
  repository?: string;
  tags: string[];
  /** What the image pane shows: a tag, or the digest of something below one. */
  reference?: string;
  /**
   * The tag a digest was opened from, when it was.
   *
   * Carried in the history entry rather than derived from what is selected, so
   * it is only there when the drill-down actually happened -- going back to a
   * digest that was reached by its own link says nothing about a tag, because
   * there was none.
   */
  via?: string;
  /** Bumped on every selection, so a slow answer for an old one is dropped. */
  generation: number;
  tree: boolean;
  /** Which groups are open, by path. Kept across a switch to the list and back. */
  expanded: Set<string>;
  search?: Search;
  /** What the registry answered for the current query, by name. */
  found: Map<string, RepoSummary>;
  /** The query those results are for, so a stale answer can be recognised. */
  foundFor: string;
} = {
  locked: false,
  repositories: [],
  tags: [],
  generation: 0,
  // Grouped by default. Two hundred repositories flat is a list you scroll
  // looking for a prefix you already know; the same names as thirty groups is
  // one you read. The flat list is a click away and the choice is not kept,
  // because the tree is the better answer for the next registry too.
  tree: true,
  expanded: new Set(),
  found: new Map(),
  foundFor: "",
};

/**
 * Where every occurrence of `needle` is in `haystack`, case-insensitively.
 *
 * Every occurrence rather than the first, because a name is a path and the
 * thing typed is often in more than one of its segments.
 */
function matchesIn(haystack: string, needle: string): [number, number][] {
  if (needle === "") {
    return [];
  }

  const ranges: [number, number][] = [];
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let at = lower.indexOf(target);
  while (at >= 0) {
    ranges.push([at, at + target.length]);
    at = lower.indexOf(target, at + target.length);
  }

  return ranges;
}

/**
 * Ranges of a tree row's label, whose label is a run of path segments rather
 * than the whole name -- so the offsets have to be found in the label itself.
 */
const labelMatches = (label: string, filter: string): [number, number][] => matchesIn(label, filter);

/** What the last connection was, so a reload does not mean typing it again. */
const remembered = "registry-ui.connection";

function saveConnection(connection: Connection): void {
  try {
    // The password is deliberately not among these. A registry credential in
    // localStorage outlives the tab, the session and the person's attention.
    const { domain, username, direct, insecure, forwarder } = connection;
    localStorage.setItem(remembered, JSON.stringify({ domain, username, direct, insecure, forwarder }));
  } catch {
    // A browser that refuses storage is one that still browses a registry.
  }
}

/**
 * Fills the form: what the deployment points at, then what the person last used.
 *
 * The saved value wins, which is the order that makes both useful -- an operator
 * says where to start and a person can go somewhere else and have it stick. The
 * cost is that changing the deployment's default does not move somebody who has
 * already typed a registry into this browser, which is worth knowing before
 * wondering why.
 */
/**
 * Puts the deployment's name and mark in the corner, if it has them.
 *
 * The tab takes the name too: several of these open at once, against several
 * registries, is the case this exists for.
 */
function applyBranding(config: PageConfig): void {
  const logo = usableLogo(config.logo);
  const title = config.title?.trim();

  if (logo !== undefined) {
    el.logo.src = logo;
    el.logo.alt = title ?? "";
    el.logo.hidden = false;
  }

  if (title) {
    el.title.textContent = title;
    document.title = title;
  }

  el.brand.hidden = logo === undefined && !title;
}

/**
 * Fixes the connection, for a deployment that exists to browse one registry.
 *
 * The registry becomes something to read rather than something to type, and
 * everything about how to reach it goes with it. Credentials stay -- which
 * registry to read is a decision the deployment made, and who is reading is not
 * -- unless it is also marked anonymous, in which case there is nothing left to
 * fill in and the form has nothing to open.
 *
 * Worth being plain about: this is presentation. The page runs in a browser and
 * anybody who opens the console can ask any registry anything their network and
 * their credentials already allow. It stops somebody wondering what the box is
 * for, not somebody who means to use it.
 */
function applyLock(config: PageConfig): void {
  if (config.locked !== true) {
    return;
  }

  el.domain.readOnly = true;
  for (const node of [el.forwarder, el.insecureLabel, el.directLabel]) {
    node.hidden = true;
  }

  if (config.anonymous === true) {
    el.more.hidden = true;
  }
}

/**
 * Whether the form has anything to show beyond the registry it is already
 * showing. A locked, anonymous deployment does not, so nothing opens.
 */
const openable = (): boolean => !el.more.hidden;

/**
 * Opens and shuts the connection form.
 *
 * It cannot be shut before there is a connection: an empty page behind a
 * dismissed form is a dead end, and the form is the only thing on it worth
 * touching. So this is also what states the initial condition -- not connected
 * means open, and no separate flag says so.
 */
function showConnection(open: boolean): void {
  const wanted = open && openable();
  el.form.classList.toggle("open", wanted);
  el.scrim.hidden = !wanted;
  el.domain.setAttribute("aria-expanded", String(wanted));

  if (wanted) {
    (el.domain.readOnly ? el.username : el.domain).focus();
  }
}

const connectionIsOpen = (): boolean => el.form.classList.contains("open");

/** Shut only when there is something behind it to look at. */
function closeConnection(): void {
  if (state.client !== undefined) {
    showConnection(false);
  }
}

/**
 * Forgets what this browser remembers, and starts again from the deployment.
 *
 * The remembered values are a convenience that outlives its usefulness: a
 * registry typed once looks exactly like a default the page came with, and
 * there was no way to tell the two apart or to get rid of the first. There is
 * now, and it is the same button either way.
 *
 * The page is reloaded rather than the fields cleared, so what comes back is
 * the deployment's own answer -- including opening a configured registry by
 * itself, which is what a fresh visitor would see.
 *
 * The address goes with it. It names a registry too, and a reset that put you
 * straight back on the one you were trying to leave would not be one.
 */
function forget(): void {
  try {
    localStorage.removeItem(remembered);
  } catch {
    // A browser that refuses storage has nothing to forget.
  }

  location.replace(`${location.pathname}${location.search}`);
}

function fillForm(config: PageConfig): void {
  let saved: Partial<Connection> = {};
  try {
    saved = JSON.parse(localStorage.getItem(remembered) ?? "{}") as Partial<Connection>;
  } catch {
    // Nothing remembered, which is the same as nothing to restore.
  }

  // A locked deployment ignores what was remembered for the parts it fixes:
  // somebody who browsed elsewhere before it was locked would otherwise keep
  // going there, from a page that no longer offers a way back.
  const fixed = config.locked === true;

  el.domain.value = (fixed ? config.domain : (saved.domain ?? config.domain)) ?? "";
  sizeDomain();
  el.username.value = saved.username ?? "";
  el.forwarder.value = (fixed ? config.forwarder : (saved.forwarder ?? config.forwarder)) ?? "";

  // direct is on unless told otherwise. A page served from a plain file server
  // -- GitHub Pages, an S3 bucket -- has no forwarder to reach, so talking to
  // the registry directly is the only thing that can work there. A deployment
  // that does have one says so: the bundled server answers /config.json with
  // `direct: false`.
  el.direct.checked = (fixed ? config.direct : (saved.direct ?? config.direct)) ?? true;
  el.insecure.checked = (fixed ? config.insecure : (saved.insecure ?? config.insecure)) ?? false;
}

function renderRepositories(): void {
  const filter = el.filter.value.trim();
  const lower = filter.toLowerCase();
  const local = filter ? state.repositories.filter((name) => name.toLowerCase().includes(lower)) : state.repositories;

  // What the registry found and this browser does not have. Appended rather
  // than merged in order: the local matches are already on screen, and an
  // answer arriving must not move what somebody is reading.
  const known = new Set(state.repositories);
  const remoteOnly =
    filter && state.foundFor === filter ? [...state.found.keys()].filter((name) => !known.has(name)).sort() : [];

  const shown = [...local, ...remoteOnly];

  el.repositoryCount.textContent =
    shown.length === state.repositories.length ? `${shown.length}` : `${shown.length}/${state.repositories.length}`;

  const empty = filter ? "Nothing matches." : "No repositories.";
  if (!state.tree) {
    renderList(
      el.repositoryList,
      shown.map((name) => ({
        key: name,
        label: name,
        kind: "repository" as const,
        matches: matchesIn(name, filter),
        note: known.has(name) ? undefined : "found",
        current: name === state.repository,
        onSelect: () => go({ repository: name }),
      })),
      empty,
    );
    return;
  }

  renderList(
    el.repositoryList,
    flattenTree(
      buildTree(shown),
      state.expanded,
      (label) => labelMatches(label, filter),
      (repository) => repository === state.repository,
      (repository) => go({ repository }),
      (path) => {
        // Toggling moves everything below it, and the thing that was clicked is
        // what the eye is on -- so it is held exactly where it is rather than
        // the top row being held, which would lift it to the top.
        const held = listAnchor(el.repositoryList, path);
        if (state.expanded.has(path)) {
          state.expanded.delete(path);
        } else {
          state.expanded.add(path);
        }

        renderRepositories();
        if (held !== undefined) {
          scrollListTo(el.repositoryList, held);
        }
      },
    ),
    empty,
  );
}

/**
 * Switches between the flat list and the tree, keeping the eye where it was.
 *
 * The two views are the same names in a different arrangement, so a switch that
 * jumps to the top makes somebody find their place again -- which is most of
 * the reason not to switch. So the row at the top of the viewport is noted, the
 * view is rebuilt, and that row is put back under the same pixel.
 *
 * Going to the tree, the row is a repository whose groups may be closed: they
 * are opened, or there would be nothing to scroll back to. Going to the list,
 * the row may be a group, which is not in the list at all -- the first
 * repository under it stands in, being the thing that was about to be read.
 */
function toggleView(): void {
  const before = listAnchor(el.repositoryList);
  state.tree = !state.tree;
  el.view.textContent = state.tree ? "list" : "tree";
  el.view.setAttribute("aria-pressed", String(state.tree));

  let target = before;
  if (before !== undefined) {
    if (state.tree) {
      for (const group of ancestorsOf(before.key)) {
        state.expanded.add(group);
      }
    } else if (before.key.endsWith("/")) {
      const first = state.repositories.find((name) => name.startsWith(before.key));
      target = first === undefined ? undefined : { key: first, offset: before.offset };
    }
  }

  renderRepositories();
  if (target !== undefined) {
    scrollListTo(el.repositoryList, target);
  }
}

/**
 * Which tag the list marks: the one being shown, or the one a digest was opened
 * from. Drilling into a platform should not lose your place in the tag list.
 */
function selectedTag(): string | undefined {
  const { reference, via } = state;
  return reference !== undefined && !isDigest(reference) ? reference : via;
}

function renderTags(): void {
  el.tagCount.textContent = `${state.tags.length}`;
  const current = selectedTag();
  renderList(
    el.tagList,
    state.tags.map((tag) => ({
      key: tag,
      label: tag,
      current: tag === current,
      onSelect: () => go({ repository: state.repository, reference: tag }),
    })),
    "No tags.",
  );
}

const message = (error: unknown): string => String((error as Error).message ?? error);

/**
 * Says something in the corner, or takes the corner back.
 *
 * There is nothing to report about a registry that answered: how many
 * repositories it has is written on the pane that lists them, and saying it
 * again up here is what made a whole row not worth its height. So success is
 * silence, and the corner is for the things that need somewhere to be said.
 */
function setStatus(text: string | undefined, kind: "info" | "warn" | "error" = "info"): void {
  el.status.hidden = text === undefined;
  el.status.textContent = text ?? "";
  el.status.className = kind === "info" ? "status" : `status ${kind}`;
}

/**
 * Redraws the repository list with `name` selected, and puts it where it can be
 * seen if it is not already.
 *
 * A pasted link names a repository the list has never been scrolled to, and in
 * the tree it may be inside groups nobody has opened -- so the groups above it
 * are opened and the list is scrolled to it. Only when it was not already on
 * screen: clicking a row you can see should not move it.
 */
function revealRepository(name: string): void {
  const held = listAnchor(el.repositoryList, name);
  const onScreen = held !== undefined && held.offset >= 0 && held.offset <= el.repositoryList.clientHeight - rowHeight;

  if (state.tree) {
    for (const group of ancestorsOf(name)) {
      state.expanded.add(group);
    }
  }

  renderRepositories();
  if (!onScreen) {
    scrollListTo(el.repositoryList, { key: name, offset: 96 });
  }
}

/**
 * What is on screen, said as the reference it is.
 *
 * A manifest opened from an index would otherwise be an unlabelled table of
 * layers: the tag is no longer what is being shown, and the tag list has no way
 * to say so. When the digest was opened from a tag, that tag is a link back to
 * the index it came from.
 */
function trail(repository: string, reference: string): Node {
  const line = element("div", "trail");
  line.append(element("span", "trail-name", repository));

  const { via } = state;
  if (via !== undefined && via !== reference) {
    const back = element("button", "linklike", `:${via}`);
    back.title = `Back to ${repository}:${via}`;
    back.addEventListener("click", () => go({ repository, reference: via }));
    line.append(back, element("span", "trail-sep", "\u203a"));
  }

  line.append(element("span", "trail-ref", `${isDigest(reference) ? "@" : ":"}${reference}`));
  return line;
}

async function loadTags(repository: string, generation: number): Promise<void> {
  const client = state.client;
  if (client === undefined) {
    return;
  }

  el.tagList.replaceChildren(element("p", "loading", "Loading..."));
  el.tagCount.textContent = "";

  try {
    const tags = await listTags(client, repository);
    if (generation !== state.generation) {
      return;
    }

    state.tags = tags.sort();
    renderTags();
  } catch (error) {
    if (generation !== state.generation) {
      return;
    }

    el.tagList.replaceChildren(element("p", "error", message(error)));
  }
}

async function showDetail(generation: number): Promise<void> {
  const { client, repository, reference } = state;
  if (client === undefined || repository === undefined) {
    return;
  }

  if (reference === undefined) {
    showManifest();
    el.detail.replaceChildren(element("p", "empty", "Pick a tag."));
    return;
  }

  showManifest();
  el.detail.replaceChildren(element("p", "loading", "Reading manifest..."));

  try {
    // A child of an index is opened by navigating to its digest, not by
    // replacing part of this view: it is a manifest of its own, it deserves the
    // whole pane, and it should have an address like everything else here.
    const rendered = await renderImage(client, repository, reference, (digest) =>
      go({ repository, reference: digest }, isDigest(reference) ? state.via : reference),
    );
    if (generation !== state.generation) {
      return;
    }

    el.detail.replaceChildren(trail(repository, reference), rendered.view);
    showManifest(rendered.body, rendered.mediaType);
  } catch (error) {
    if (generation !== state.generation) {
      return;
    }

    el.detail.replaceChildren(trail(repository, reference), element("p", "error", message(error)));
    showManifest();
  }
}

/**
 * Fills the manifest pane, which is the same bytes the image was read from.
 *
 * Given rather than read: a manifest asked for by tag is not cached, since a
 * tag is a name somebody can move, so asking a second time here would be
 * fetching it a second time.
 */
function showManifest(body?: string, mediaType?: string): void {
  el.manifestType.textContent = body === undefined ? "" : (mediaType ?? "");
  el.manifest.replaceChildren(body === undefined ? element("p", "empty", "Pick a tag.") : rawPane(body, mediaType));
}

/**
 * Goes somewhere, by saying where in the address bar.
 *
 * Nothing in this page changes what it is showing by hand: a click writes the
 * address and `applyRoute` reads it. So the back button, a pasted link and a
 * click are one path rather than three, and there is no way to be on a page the
 * address does not name.
 *
 * `via` rides in the history entry rather than in the address, because it is
 * not part of what is being shown -- it is how it was reached, and going back
 * to it later should recover the same answer.
 */
function go(route: Route, via?: string): void {
  const hash = formatRoute({ domain: state.domain, ...route });
  if (hash === (location.hash || "#")) {
    return;
  }

  history.pushState({ via }, "", hash);
  void refresh();
}

/**
 * Makes the page show what the address says, changing only what differs.
 *
 * Diffing rather than rebuilding is what makes this usable as the single entry
 * point: opening a tag in the repository already open must not reload the tag
 * list, and pressing back from a digest to its tag must not reload anything.
 */
async function applyRoute(): Promise<void> {
  const route = parseRoute(location.hash);
  const via = (history.state as { via?: string } | null)?.via;

  // A link into another registry opens it. Not for a deployment that fixed one:
  // the lock is presentation rather than enforcement, but an address that walks
  // around it would make it presentation of nothing.
  if (route.domain !== undefined && !state.locked && route.domain !== state.domain) {
    el.domain.value = route.domain;
    const connection = connectionFromForm();
    if (connection === undefined || !(await open(connection))) {
      return;
    }
  }

  const generation = ++state.generation;

  if (route.repository !== state.repository) {
    state.repository = route.repository;
    state.tags = [];
    state.reference = undefined;
    state.via = undefined;
    el.detail.replaceChildren(element("p", "empty", "Pick a tag."));

    if (route.repository === undefined) {
      renderRepositories();
      el.tagList.replaceChildren(element("p", "empty", "Pick a repository."));
      el.tagCount.textContent = "";
      return;
    }

    revealRepository(route.repository);

    await loadTags(route.repository, generation);
    if (generation !== state.generation) {
      return;
    }
  }

  if (route.reference === state.reference && via === state.via) {
    return;
  }

  state.reference = route.reference;
  state.via = via;
  renderTags();
  await showDetail(generation);
}

/**
 * One at a time. A fragment typed into the address bar fires two events, and
 * both of them mean the same thing; running them in order makes the second a
 * comparison against the state the first arrived at, which is nothing to do.
 */
let pending: Promise<void> = Promise.resolve();

function refresh(): Promise<void> {
  pending = pending.catch(() => undefined).then(() => applyRoute());
  return pending;
}

function connectionFromForm(): Connection | undefined {
  const domain = el.domain.value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!domain) {
    return undefined;
  }

  return {
    domain,
    username: el.username.value.trim() || undefined,
    password: el.password.value || undefined,
    direct: el.direct.checked,
    insecure: el.insecure.checked,
    forwarder: el.forwarder.value.trim() || undefined,
  };
}

/** Connects, then lets the address say what to open on the other side. */
async function reconnect(connection: Connection, route: Route): Promise<void> {
  if (!(await open(connection))) {
    // Left open, and on the registry that did not answer: the next thing to do
    // is to correct it, and that is the field somebody is already looking at.
    showConnection(true);
    return;
  }

  showConnection(false);

  history.replaceState({}, "", formatRoute({ ...route, domain: connection.domain }));
  await refresh();
}

/** Connects. Answers whether the registry is one, which is all a caller needs. */
async function open(connection: Connection): Promise<boolean> {
  setStatus(`Connecting to ${connection.domain}...`);
  state.repositories = [];
  state.repository = undefined;
  state.tags = [];
  state.reference = undefined;
  state.via = undefined;
  el.repositoryList.replaceChildren(element("p", "loading", "Loading..."));
  el.tagList.replaceChildren(element("p", "empty", "Pick a repository."));
  el.detail.replaceChildren(element("p", "empty", "Pick a tag."));

  // A different registry, so nothing read from the last one still applies: the
  // key holds the domain, but a stale entry is dead weight either way.
  cache.clear();

  const [domain, init] = connectionOf(connection);
  const client = connect(connection);
  state.client = client;
  state.domain = domain;
  state.search = new Search(domain, init);
  state.found = new Map();
  state.foundFor = "";

  try {
    // The version probe first: it is the one call whose failure means "this is
    // not a registry, or you cannot reach it", rather than "it will not list".
    await client.ping().unwrap();
  } catch (error) {
    // Not connected, and said so in the one place that decides whether the
    // connection form may be dismissed: a form shut onto a page with nothing
    // behind it is a dead end.
    state.client = undefined;
    setStatus(`${connection.domain} did not answer as a registry: ${message(error)}`, "error");
    el.repositoryList.replaceChildren();
    return false;
  }

  saveConnection(connection);

  // Listed in the background rather than waited for. A link straight to an
  // image should open the image; the catalog of a large registry takes seconds
  // and fills the pane it belongs to while that happens.
  void list(client);
  return true;
}

/**
 * Fills the repository pane, outliving the call that started it.
 *
 * Nobody waits for this, so somebody may have connected elsewhere before it
 * finishes: every write to the page is behind the same check that the client it
 * was started for is still the one in use.
 */
async function list(client: RegistryClient): Promise<void> {
  try {
    // Drawn as the pages arrive. The scroll position is held across each
    // redraw, so a list growing underneath somebody does not move what they are
    // reading -- new names arrive below, which is where they belong.
    await listRepositories(client, (repositories) => {
      if (state.client !== client) {
        return;
      }

      const held = listAnchor(el.repositoryList);
      state.repositories = [...repositories].sort();
      renderRepositories();
      if (held !== undefined) {
        scrollListTo(el.repositoryList, held);
      }
    });

    if (state.client !== client) {
      return;
    }

    setStatus(undefined);
    renderRepositories();
  } catch (error) {
    if (state.client !== client) {
      return;
    }

    // A registry that will not list is still one whose images can be opened,
    // if you know their names -- so this is a note rather than a failure.
    setStatus(`no repository list: ${message(error)}`, "warn");
    el.repositoryList.replaceChildren(element("p", "empty", "This registry does not list its repositories."));
  }
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const connection = connectionFromForm();
  if (connection === undefined) {
    return;
  }

  // Reconnecting to the same registry -- a credential typed in, a checkbox
  // changed -- keeps your place. A different registry has different
  // repositories, so what the address names does not survive the change.
  const route = parseRoute(location.hash);
  const same = route.domain === undefined || route.domain === connection.domain;
  void reconnect(connection, same ? route : {});
});

/**
 * Asks the registry what the local list may not have.
 *
 * The local filter runs on every keystroke and is instant, because the names
 * are already here. This runs behind it: debounced, because a keystroke is not
 * a question, and only when the registry has been found to answer at all.
 *
 * Its results are appended rather than merged in, so an answer arriving does
 * not move what is already on screen. Anything the local list already has is
 * dropped -- the same name twice, once marked "found", would be a worse answer
 * than either.
 */
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onFilterInput(): void {
  renderRepositories();

  const query = el.filter.value.trim();
  if (searchTimer !== undefined) {
    clearTimeout(searchTimer);
  }

  if (query === "" || state.search === undefined) {
    state.found = new Map();
    state.foundFor = "";
    return;
  }

  searchTimer = setTimeout(() => {
    const search = state.search;
    if (search === undefined) {
      return;
    }

    void search.find(query).then(({ repositories }) => {
      // The query may have moved on while this was in flight.
      if (el.filter.value.trim() !== query) {
        return;
      }

      state.found = new Map(repositories.map((repository) => [repository.name, repository]));
      state.foundFor = query;

      const held = listAnchor(el.repositoryList);
      renderRepositories();
      if (held !== undefined) {
        scrollListTo(el.repositoryList, held);
      }
    });
  }, 250);
}

/**
 * The field is as wide as what is in it.
 *
 * Which is what keeps the domain still when the form opens: everything below it
 * is the width of the card, and this one is the width of the registry's name,
 * so the card appearing behind it changes nothing about where it is.
 */
function sizeDomain(): void {
  el.domain.size = Math.min(40, Math.max(12, el.domain.value.length + 1));
}

el.domain.addEventListener("input", sizeDomain);
el.domain.addEventListener("focus", () => showConnection(true));
el.domain.addEventListener("mousedown", (event) => {
  // A read-only registry is a label. Clicking it opens the form for the parts
  // that are still yours to change, and does not put a caret in it.
  if (el.domain.readOnly) {
    event.preventDefault();
    showConnection(!connectionIsOpen());
  }
});

el.scrim.addEventListener("mousedown", closeConnection);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && connectionIsOpen()) {
    closeConnection();
  }
});

el.filter.addEventListener("input", onFilterInput);
el.view.textContent = state.tree ? "list" : "tree";
el.view.setAttribute("aria-pressed", String(state.tree));
el.view.addEventListener("click", toggleView);
el.reset.addEventListener("click", forget);

window.addEventListener("popstate", () => void refresh());
window.addEventListener("hashchange", () => void refresh());

void loadConfig().then(async (config) => {
  applyBranding(config);
  fillForm(config);

  // After filling, so what it hides has already been given its value: a locked
  // deployment still connects with the domain the operator set.
  applyLock(config);
  state.locked = config.locked === true;

  // The address wins over both the deployment's default and what this browser
  // remembers: it is the most recent thing anyone said about where to look, and
  // a link that opened somewhere else would not be a link.
  const route = parseRoute(location.hash);
  if (route.domain !== undefined && !state.locked) {
    el.domain.value = route.domain;
  }

  // A deployment that names a registry means to be opened on it, rather than to
  // ask the person to press the button that was already filled in for them.
  const connection = connectionFromForm();
  if (connection === undefined) {
    showConnection(true);
    return;
  }

  await reconnect(connection, route);
});
