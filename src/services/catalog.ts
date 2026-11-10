/** The models the runtime offers, asked for when needed (a remote runtime may come up later). */
import type { ModelInfo } from "../agents/ports.ts";
import type { AgentRuntimePort } from "../ports/runtime.ts";

export class ModelCatalog {
  constructor(private readonly runtime: AgentRuntimePort) {}

  async list(): Promise<{ models: ModelInfo[]; defaultModel: string | null }> {
    try {
      return await this.runtime.models();
    } catch {
      return { models: [], defaultModel: null };
    }
  }

  /** The asked-for model, or the default when the id is unknown (a stale UI, a removed key). */
  async pick(id?: string): Promise<ModelInfo> {
    const { models, defaultModel } = await this.list();
    const model = models.find((m) => m.id === id) ?? models.find((m) => m.id === defaultModel);
    if (!model) throw new Error("No model is configured. Set ANTHROPIC_API_KEY or AWS Bedrock credentials in .env.");
    return model;
  }

  /** The lightest model on offer, for background work like claim extraction. */
  async light(): Promise<string | undefined> {
    const { models, defaultModel } = await this.list();
    return (models.find((m) => /haiku/i.test(m.id)) ?? models.find((m) => m.id === defaultModel))?.id;
  }
}
