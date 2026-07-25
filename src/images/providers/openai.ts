/** OpenAI DALL-E 3 (~$0.04/image). Opt-in via OPENAI_API_KEY. */
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';

export function openAiProvider(): ImageProvider {
  return {
    name: 'openai',
    isAvailable: () => !!process.env.OPENAI_API_KEY,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY not set');

      // DALL-E 3 only accepts a fixed set of sizes; 1024x1792 is its portrait
      // option and the closest match to our 4:5 target.
      const size = req.height > req.width ? '1024x1792' : '1024x1024';

      const response = await axios.post(
        ENDPOINT,
        { model: 'dall-e-3', prompt: req.prompt, n: 1, size, response_format: 'url', quality: 'standard' },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60_000 },
      );

      const imageUrl: string | undefined = response.data?.data?.[0]?.url;
      const revisedPrompt: string | undefined = response.data?.data?.[0]?.revised_prompt;
      if (!imageUrl) throw new Error('DALL-E 3 returned no image URL');

      const img = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      logger.info('Image generated (DALL-E 3)', { size });

      return { buffer: Buffer.from(img.data), model: 'openai:dall-e-3', revisedPrompt };
    },
  };
}
