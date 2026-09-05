import type { Row } from "./list";

/**
 * Repository names as a tree, since that is what they are.
 *
 * `dist/hday/kamino` and `dist/hday/lens` share a prefix that means something --
 * a namespace, a team, a stage -- and a flat list of a few hundred of them
 * hides it. The tree is the same names with the shared parts drawn once.
 *
 * A group's key ends in `/` and a repository's does not, which is what tells
 * them apart and what lets a row in one view be found in the other.
 */

export type TreeRow = Row & {
  /** The full path: `dist/hday/` for a group, `dist/hday/kamino` for a repository. */
  path: string;
  group: boolean;
};

type Node = {
  segment: string;
  path: string;
  children: Map<string, Node>;
  /** Set when a repository is named by exactly this path. */
  leaf: boolean;
};

function emptyNode(segment: string, path: string): Node {
  return { segment, path, children: new Map(), leaf: false };
}

/**
 * Builds the tree.
 *
 * A name can be both a repository and a prefix -- `hello` next to
 * `hello/world` -- so a node carries `leaf` rather than being decided by
 * whether it has children.
 */
export function buildTree(names: string[]): Node {
  const root = emptyNode("", "");
  for (const name of names) {
    let node = root;
    const segments = name.split("/").filter((segment) => segment !== "");
    for (const [index, segment] of segments.entries()) {
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.get(segment);
      if (child === undefined) {
        child = emptyNode(segment, path);
        node.children.set(segment, child);
      }

      node = child;
    }

    node.leaf = true;
  }

  return root;
}

/**
 * The rows a tree shows, in order, given what is expanded.
 *
 * A group with one child and nothing of its own is folded into its child --
 * `dist/external/docker.io/library` is four clicks to say one thing otherwise.
 * The label carries the whole run and the path stays exact.
 *
 * A name that is both a repository and a prefix -- `hello` beside
 * `hello/world` -- gets **two rows**, the image and then the folder that
 * happens to share its name. It was one row doing two things, where the name
 * opened the image and a caret beside it opened the group, and the only way to
 * know that was to have been told. Two rows say it: one has the image icon and
 * opens an image, the other has a folder, a trailing slash, and opens.
 */
export function flattenTree(
  root: Node,
  expanded: Set<string>,
  matchesOf: (label: string) => [number, number][],
  isCurrent: (repository: string) => boolean,
  onSelectRepository: (repository: string) => void,
  onToggleGroup: (path: string) => void,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (node: Node, depth: number) => {
    for (const child of [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment))) {
      let folded = child;
      let label = child.segment;
      while (!folded.leaf && folded.children.size === 1) {
        const [only] = folded.children.values();
        if (only === undefined) {
          break;
        }

        folded = only;
        label = `${label}/${only.segment}`;
      }

      // The image, if this path names one. First, so that a folder sharing the
      // name is followed by its own contents rather than by something that is
      // not in it.
      if (folded.leaf) {
        rows.push({
          key: folded.path,
          path: folded.path,
          group: false,
          label,
          kind: "repository",
          matches: matchesOf(label),
          depth,
          current: isCurrent(folded.path),
          onSelect: () => onSelectRepository(folded.path),
        });
      }

      if (folded.children.size === 0) {
        continue;
      }

      // The folder. Its whole row opens it -- there is nothing else it could
      // mean -- and the slash on the label is what distinguishes `hello/` from
      // the `hello` that may be sitting right above it.
      const groupPath = `${folded.path}/`;
      const open = expanded.has(groupPath);
      rows.push({
        key: groupPath,
        path: groupPath,
        group: true,
        label: `${label}/`,
        kind: "group",
        matches: matchesOf(label),
        depth,
        expanded: open,
        current: false,
        onSelect: () => onToggleGroup(groupPath),
      });

      if (open) {
        walk(folded, depth + 1);
      }
    }
  };

  walk(root, 0);
  return rows;
}

/** Every group that has to be open for `repository` to be a row. */
export function ancestorsOf(repository: string): string[] {
  const segments = repository.split("/").filter((segment) => segment !== "");
  return segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);
}
