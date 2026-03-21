import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelListItem } from './types.js';

export class ClaudeBackend {
  async listModels(): Promise<ModelListItem[]> {
    const stream = query({
      prompt: emptyPromptStream(),
      options: {
        settingSources: ['user'],
      },
    });

    try {
      const models = await stream.supportedModels();
      const items: ModelListItem[] = [];
      models.forEach((model, index) => {
        const value = typeof model.value === 'string' ? model.value.trim() : '';
        if (!value) {
          return;
        }
        const displayName =
          typeof model.displayName === 'string' && model.displayName.trim().length > 0
            ? model.displayName.trim()
            : value;
        const description =
          typeof model.description === 'string' && model.description.trim().length > 0
            ? model.description.trim()
            : '';
        items.push({
          id: value,
          backend: 'claude',
          model: value,
          displayName,
          description,
          hidden: false,
          isDefault: index === 0,
        });
      });
      return items;
    } finally {
      stream.close();
    }
  }
}

async function* emptyPromptStream(): AsyncGenerator<never, void, unknown> {
  return;
}
