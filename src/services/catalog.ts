/** The models this server can offer, which is whichever adapters had their keys set. */
import type { ChatModel, ModelInfo } from "../agents/ports.ts";

export class ModelCatalog {
  private readonly byId: Map<string, ChatModel>;

  constructor(models: ChatModel[], private readonly preferred?: string) {
    this.byId = new Map(models.map((m) => [m.info.id, m]));
  }

  list(): ModelInfo[] {
    return [...this.byId.values()].map((m) => m.info);
  }

  get defaultId(): string | undefined {
    // DEFAULT_MODEL may be a full id ("bedrock:...") or a bare model name ("claude-opus-5-5").
    const match = this.preferred && [...this.byId.keys()].find((id) => id === this.preferred || id.endsWith(`:${this.preferred}`));
    if (match) return match;
    return this.byId.keys().next().value;
  }

  /** The asked-for model, or the default when the id is unknown (a stale UI, a removed key). */
  pick(id?: string): ChatModel {
    const model = (id && this.byId.get(id)) || (this.defaultId && this.byId.get(this.defaultId));
    if (!model) throw new Error("No model is configured. Set ANTHROPIC_API_KEY in .env.");
    return model;
  }
}
