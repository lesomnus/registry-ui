import "./style.css";
import { listRepositories } from "./catalog";
import { loadConfig, type PageConfig } from "./config";
import { renderList } from "./render/list";
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
} = { repositories: [], tags: [], generation: 0 };

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

  renderList(
    el.repositoryList,
    shown.map((name) => ({
      key: name,
      label: name,
      current: name === state.repository,
      onSelect: () => void selectRepository(name),
    })),
    filter ? "Nothing matches." : "No repositories.",
  );
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
    state.repositories = (await listRepositories(client)).sort();
    el.status.textContent = `${connection.domain}`;
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

void loadConfig().then((config) => {
  fillForm(config);

  // A deployment that names a registry means to be opened on it, rather than to
  // ask the person to press the button that was already filled in for them.
  if (el.domain.value) {
    el.form.requestSubmit();
  }
});
