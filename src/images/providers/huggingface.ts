/** Hugging Face Inference API, FLUX.1-schnell. Opt-in via HF_API_KEY. */
import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { getHfApiKey } from '../../config.js';
import type { GenerateRequest, GenerateResult, ImageProvider } from './types.js';

const ENDPOINT = 'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell';
const TIMEOUT_MS = 90_000;

export function huggingFaceProvider(): ImageProvider {
  return {
    name: 'huggingface',
    isAvailable: () => !!getHfApiKey(),
    // Free-tier inference credits; not metered per image by us.
    costPerImageUsd: () => 0,
    supportsReferences: false,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const apiKey = getHfApiKey();
      if (!apiKey) throw new Error('HF_API_KEY not set');

      logger.info('Calling Hugging Face Inference API', { model: 'FLUX.1-schnell' });

      const response = await axios.post(
        ENDPOINT,
        {
          inputs: req.prompt,
          parameters: { width: req.width, height: req.height, seed: req.seed },
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer',
          timeout: TIMEOUT_MS,
        },
      );

      return { buffer: Buffer.from(response.data), model: 'hf:flux.1-schnell' };
    },
  };
}
