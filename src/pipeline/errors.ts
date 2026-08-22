export class EmptyReplyError extends Error {
  constructor(message = 'Groq returned empty reply') {
    super(message);
    this.name = 'EmptyReplyError';
  }
}

/** Drafts scored too low on conversation gravity — skip instead of posting mush. */
export class GravitySkipError extends Error {
  constructor(message = 'Conversation gravity below threshold') {
    super(message);
    this.name = 'GravitySkipError';
  }
}
