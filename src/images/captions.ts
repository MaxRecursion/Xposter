/**
 * Generates short, relatable first-person lifestyle captions for image posts.
 * Uses the existing Groq integration — same fallback pattern as reply generator.
 */
import { logger } from '../utils/logger.js';
import { getOptionalGroqClient } from '../pipeline/groq_client.js';
import { getGroqModel } from '../config.js';
import { identityCaptionHint, resolveIdentity } from './identity.js';
import type { Scene } from './generator.js';

const SYSTEM_PROMPT = `You write captions for lifestyle photos posted on X (Twitter) by a young Indian woman in her 20s living in an urban city (Pune/Mumbai).

Style rules:
- 1-2 sentences maximum, no more
- First person, casual and relatable
- Feels authentic, like a real person's thoughts — not an ad
- Optionally end with 1 emoji (natural, not forced)
- ZERO hashtags
- References the specific scene/vibe naturally
- Occasionally witty or self-aware, never cringe
- Do NOT mention "AI" or "generated" or anything meta
- Do NOT describe her face, expression or how she looks — the photo never shows her face

Output ONLY the caption text, nothing else.`;

export async function generateCaption(scene: Scene, recentCaptions: string[] = []): Promise<string> {
  const avoidHint = recentCaptions.length > 0
    ? `\n\nAvoid these recent captions:\n${recentCaptions.slice(0, 5).map((c) => `- ${c}`).join('\n')}`
    : '';

  // Give the writer the recurring props so a caption can't contradict the frame.
  const propsHint = `\n\nRecurring details in her photos: ${identityCaptionHint(resolveIdentity())}.`;

  const userPrompt = `Write a caption for a photo of: ${scene.description}.${propsHint}${avoidHint}`;

  try {
    const groq = getOptionalGroqClient();
    if (!groq) throw new Error('GROQ_API_KEY is not set');

    const resp = await groq.chat.completions.create({
      model: getGroqModel(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 80,
      temperature: 0.9,
    });

    const text = resp.choices[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('Empty caption from Groq');
    logger.info('Caption generated', { scene: scene.id, caption: text });
    return text;
  } catch (err) {
    logger.warn('Caption generation failed, using fallback', { err: String(err) });
    return FALLBACK_CAPTIONS[Math.floor(Math.random() * FALLBACK_CAPTIONS.length)];
  }
}

const FALLBACK_CAPTIONS = [
  'some days just hit different ✨',
  'this is my reset button',
  'finding my kind of peace in the chaos',
  'slow morning, fast city',
  'the city never stops but I needed to',
];
