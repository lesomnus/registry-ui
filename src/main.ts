import "./style.css";
import { listRepositories } from "./catalog";
import { loadConfig, type PageConfig } from "./config";
import { listAnchor, renderList, scrollListTo } from "./render/list";
import { ancestorsOf, buildTree, flattenTree } from "./render/tree";
import { listTags } from "./tags";
import { connect, type Connection, type RegistryClient } from "./registry";
import { element } from "./render/dom";
import { renderImage } from "./render/image";

const el = {
  form: document.getElementById("connection") as HTMLFormElement,
  domain: document.getElementById("domain") as HTMLInputElement,
  username: document.getElementById("username") as HTMLInputElement,
  password: document.getElementById("password") as HTMLInputElement,
  direct: document.getElementById("direct") as HTMLInputElement,
  insecure: document.getElementById("insecure") as HTMLInputElement,
  forwarder: document.getElementById("forwarder") as HTMLInputElement,
  status: document.getElementById("status") as HTMLElement,
  repositoryList: document.getElementById("repository-list") as HTMLElement,
  repositoryCount: document.getElementById("repository-count") as HTMLElement,
  filter: document.getElementById("repository-filter") as HTMLInputElement,
  view: document.getElementById("view-toggle") as HTMLButtonElement,
  tagList: document.getElementById("tag-list") as HTMLElement,
  tagCount: document.getElementById("tag-count") as HTMLElement,
  detail: document.getElementById("detail") as HTMLElement,
};

const state: {
  client?: RegistryClient;
  repositories: string[];
  repository?: string;
  tags: string[];
  tag?: string;
  /** Bumped on every selection, so a slow answer for an old one is dropped. */
  generation: number;
  tree: boolean;
  /** Which groups are open, by path. Kept across a switch to the list and back. */
  expanded: Set<string>;
} = { repositories: [], tags: [], generation: 0, tree: false, expanded: new Set() };

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
function fillForm(config: PageConfig): void {
  let saved: Partial<Connection> = {};
  try {
    saved = JSON.parse(localStorage.getItem(remembered) ?? "{}") as Partial<Connection>;
  } catch {
    // Nothing remembered, which is the same as nothing to restore.
  }

  el.domain.value = saved.domain ?? config.domain ?? "";
  el.username.value = saved.username ?? "";
  el.forwarder.value = saved.forwarder ?? config.forwarder ?? "";
  // On unless told otherwise. A page served from a plain file server -- GitHub
  // Pages, an S3 bucket -- has no forwarder to reach, so talking to the registry
  // directly is the only thing that can work there. A deployment that does have
  // one says so: the bundled server answers /config.json with `direct: false`.
  el.direct.checked = saved.direct ?? config.direct ?? true;
  el.insecure.checked = saved.insecure ?? config.insecure ?? false;
}

function renderRepositories(): void {
  const filter = el.filter.value.trim().toLowerCase();
  const shown = filter ? state.repositories.filter((name) => name.toLowerCase().includes(filter)) : state.repositories;

  el.repositoryCount.textContent =
    shown.length === state.repositories.length ? `${shown.length}` : `${shown.length}/${state.repositories.length}`;

  const empty = filter ? "Nothing matches." : "No repositories.";
  if (!state.tree) {
    renderList(
      el.repositoryList,
      shown.map((name) => ({
        key: name,
        label: name,
        current: name === state.repository,
        onSelect: () => void selectRepository(name),
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
      (repository) => repository === state.repository,
      (repository) => void selectRepository(repository),
      (path) => {
        // Toggling moves everything below it, and the thing that was clicked is
        // what the eye is on -- so it is held exactly where it is rather than
        // the top row being held, which would lift it to the top.
        //
        // A group that is also a repository is keyed by its own path, not the
        // path with the slash, so both are looked for.
        const held = listAnchor(el.repositoryList, path) ?? listAnchor(el.repositoryList, path.replace(/\/$/, ""));
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

function renderTags(): void {
  el.tagCount.textContent = `${state.tags.length}`;
  renderList(
    el.tagList,
    state.tags.map((tag) => ({
      key: tag,
      label: tag,
      current: tag === state.tag,
      onSelect: () => void selectTag(tag),
    })),
    "No tags.",
  );
}

async function selectTag(tag: string): Promise<void> {
  if (!state.client || !state.repository) {
    return;
  }

  state.tag = tag;
  const generation = ++state.generation;
  renderTags();
  el.detail.replaceChildren(element("p", "loading", "Reading manifest..."));

  try {
    const rendered = await renderImage(state.client, state.repository, tag);
    if (generation !== state.generation) {
      return;
    }

    el.detail.replaceChildren(rendered);
  } catch (error) {
    if (generation !== state.generation) {
      return;
    }

    el.detail.replaceChildren(element("p", "error", String((error as Error).message ?? error)));
  }
}

async function selectRepository(name: string): Promise<void> {
  if (!state.client) {
    return;
  }

  state.repository = name;
  state.tags = [];
  state.tag = undefined;
  const generation = ++state.generation;

  renderRepositories();
  el.tagList.replaceChildren(element("p", "loading", "Loading..."));
  el.tagCount.textContent = "";
  el.detail.replaceChildren(element("p", "empty", "Pick a tag."));

  try {
    const tags = await listTags(state.client, name);
    if (generation !== state.generation) {
      return;
    }

    state.tags = tags.sort();
    renderTags();
  } catch (error) {
    if (generation !== state.generation) {
      return;
    }

    el.tagList.replaceChildren(element("p", "error", String((error as Error).message ?? error)));
  }
}

async function open(connection: Connection): Promise<void> {
  el.status.textContent = `Connecting to ${connection.domain}...`;
  el.status.className = "status";
  state.repositories = [];
  state.repository = undefined;
  state.tags = [];
  state.tag = undefined;
  el.repositoryList.replaceChildren(element("p", "loading", "Loading..."));
  el.tagList.replaceChildren(element("p", "empty", "Pick a repository."));
  el.detail.replaceChildren(element("p", "empty", "Pick a tag."));

  const client = connect(connection);
  state.client = client;

  try {
    // The version probe first: it is the one call whose failure means "this is
    // not a registry, or you cannot reach it", rather than "it will not list".
    await client.ping().unwrap();
  } catch (error) {
    el.status.textContent = `${connection.domain} did not answer as a registry: ${String((error as Error).message ?? error)}`;
    el.status.className = "status error";
    el.repositoryList.replaceChildren();
    return;
  }

  saveConnection(connection);

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
      el.status.textContent = `${connection.domain} — ${state.repositories.length} repositories`;
      renderRepositories();
      if (held !== undefined) {
        scrollListTo(el.repositoryList, held);
      }
    });

    el.status.textContent = `${connection.domain} — ${state.repositories.length} repositories`;
    renderRepositories();
  } catch (error) {
    // A registry that will not list is still one whose images can be opened,
    // if you know their names -- so this is a note rather than a failure.
    el.status.textContent = `${connection.domain} — no repository list: ${String((error as Error).message ?? error)}`;
    el.status.className = "status warn";
    el.repositoryList.replaceChildren(element("p", "empty", "This registry does not list its repositories."));
  }
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const domain = el.domain.value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) {
    return;
  }

  void open({
    domain,
    username: el.username.value.trim() || undefined,
    password: el.password.value || undefined,
    direct: el.direct.checked,
    insecure: el.insecure.checked,
    forwarder: el.forwarder.value.trim() || undefined,
  });
});

el.filter.addEventListener("input", renderRepositories);
el.view.addEventListener("click", toggleView);

void loadConfig().then((config) => {
  fillForm(config);

  // A deployment that names a registry means to be opened on it, rather than to
  // ask the person to press the button that was already filled in for them.
  if (el.domain.value) {
    el.form.requestSubmit();
  }
});
