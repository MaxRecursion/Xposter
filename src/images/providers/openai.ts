/** OpenAI DALL-E 3 (~$0.04/image). Opt-in via OPENAI_API_KEY. */
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { getOpenAiApiKey } from '../../config.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
/** DALL-E 3 standard quality — must match costPerImageUsd and costUsd on success. */
export const OPENAI_COST_USD = 0.04;

export function openAiProvider(): ImageProvider {
  return {
    name: 'openai',
    isAvailable: () => !!getOpenAiApiKey(),
    // DALL-E 3 standard quality, 1024x1024 / 1024x1792.
    costPerImageUsd: () => OPENAI_COST_USD,
    supportsReferences: false,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const apiKey = getOpenAiApiKey();
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');

      // DALL-E 3 only accepts a fixed set of sizes; 1024x1792 is its portrait
      // option and the closest match to our 4:5 target.
      const size = req.height > req.width ? '1024x1792' : '1024x1024';

      const response = await axios.post(
        ENDPOINT,
        { model: 'dall-e-3', prompt: req.prompt, n: 1, size, response_format: 'url', quality: 'standard' },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 60_000,
        },
      );

      const imageUrl: string | undefined = response.data?.data?.[0]?.url;
      const revisedPrompt: string | undefined = response.data?.data?.[0]?.revised_prompt;
      // A 200 has already billed — surface spend even when the URL is missing.
      if (!imageUrl) {
        throw Object.assign(new Error('DALL-E 3 returned no image URL'), { billedUsd: OPENAI_COST_USD });
      }

      try {
        const img = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30_000 });
        logger.info('Image generated (DALL-E 3)', { size });
        return {
          buffer: Buffer.from(img.data),
          model: 'openai:dall-e-3',
          revisedPrompt,
          costUsd: OPENAI_COST_USD,
        };
      } catch (err) {
        throw Object.assign(
          new Error(`DALL-E 3 image download failed: ${String(err).slice(0, 160)}`),
          { billedUsd: OPENAI_COST_USD },
        );
      }
    },
  };
}
