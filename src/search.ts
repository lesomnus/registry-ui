import { ClientV2, ext } from "@lesomnus/oci-client";
import type { ClientInit } from "@lesomnus/oci-client";

/**
 * Asking the registry, for the registries that can be asked.
 *
 * Searching is not in the distribution spec, so there is no one endpoint: zot
 * serves GraphQL, Docker Hub and friends serve `/v1/search`, and plenty serve
 * neither. oci-client has both shapes behind one interface; which one a given
 * registry answers is not something it can be asked, so it is found out by
 * trying.
 *
 * The answer is remembered, including "neither" -- a registry that cannot
 * search must not be asked twice per keystroke.
 */

const Zot = ClientV2.with(ext.Catalog, ext.search.Zot);
const V1 = ClientV2.with(ext.Catalog, ext.search.V1);

type Flavour = "zot" | "v1" | "none";

/** One result, as much of it as the registry chose to report. */
export type RepoSummary = ext.search.RepoSummary;

export type Found = {
  repositories: RepoSummary[];
  /** Which shape answered, or none. Shown so a person knows what they are seeing. */
  flavour: Flavour;
};

export class Search {
  private readonly zot: InstanceType<typeof Zot>;
  private readonly v1: InstanceType<typeof V1>;
  private flavour: Flavour | undefined;

  /** Built on the same transport as the browsing client, so it is the same connection. */
  constructor(domain: string, init: ClientInit) {
    this.zot = new Zot(domain, init);
    this.v1 = new V1(domain, init);
  }

  /** Whether this registry has been found to search, once anything has asked. */
  get supported(): boolean {
    return this.flavour !== undefined && this.flavour !== "none";
  }

  async find(query: string, limit = 100): Promise<Found> {
    if (query === "") {
      return { repositories: [], flavour: this.flavour ?? "none" };
    }

    // A known answer, including that there is none.
    if (this.flavour === "none") {
      return { repositories: [], flavour: "none" };
    }
    if (this.flavour !== undefined) {
      const client = this.flavour === "zot" ? this.zot : this.v1;
      return { repositories: await this.ask(client, query, limit), flavour: this.flavour };
    }

    for (const [flavour, client] of [
      ["zot", this.zot],
      ["v1", this.v1],
    ] as const) {
      try {
        const repositories = await this.ask(client, query, limit);
        this.flavour = flavour;
        return { repositories, flavour };
      } catch {
        // Not this shape. The next one, or none.
      }
    }

    this.flavour = "none";
    return { repositories: [], flavour: "none" };
  }

  private async ask(
    client: InstanceType<typeof Zot> | InstanceType<typeof V1>,
    query: string,
    limit: number,
  ): Promise<RepoSummary[]> {
    const res = await client.search(query, { n: limit }).unwrap();
    return res.repositories ?? [];
  }
}
